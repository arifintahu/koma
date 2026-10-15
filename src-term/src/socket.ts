import type { DaemonTransport } from "./transport.ts"
import { EventDispatcher, PendingOperations } from "./events.ts"
import { controlOf, encodeFrame, fold, FrameReader, needsRestart, type Control, type Snapshot } from "./protocol.ts"
import { ensureDaemon, killSession, socketPath } from "./paths.ts"

type BunSocket = {
  write(data: Uint8Array): number
  end(): void
}

export class DaemonLink {
  private socket: BunSocket | null = null
  private reader = new FrameReader()
  private seq = -1
  private closed = false
  private detached = false
  private restarting = false
  private helloResolve: ((version: string) => void) | null = null
  readonly events = new EventDispatcher()
  readonly operations = new PendingOperations()
  menuVersion = 0

  snap: Snapshot | null = null

  constructor(
    private readonly onUpdate: (snap: Snapshot | null) => void,
    private readonly onControl: (control: Control) => void,
    private readonly transport?: DaemonTransport,
  ) {
    this.events.on("MenuCapabilities", ({ version, usage_reader }) => { this.menuVersion = version; this.usageReader = !!usage_reader && (!this.transport?.remote || !!this.transport.usage); if (this.usageReader) this.send({ SetUsageReader: { enabled: true } }) })
    this.events.on("MenuResult", (result) => this.operations.complete(result))
  }

  async start(sessionId: string): Promise<void> {
    await this.attach(sessionId, false)
  }

  send(request: unknown): void {
    if (!this.socket || this.detached) return
    this.socket.write(encodeFrame(request))
  }

  async sendMenu(mode: string, action: import("./modes/actions.ts").MenuAction): Promise<string | null> {
    if (!this.socket || this.detached) return "Not connected"
    if (this.menuVersion < 1) return "This daemon needs menu protocol v1. Restart the session daemon with the current Koma build."
    const request_id = crypto.randomUUID()
    const pending = this.operations.wait(request_id)
    this.send({ Menu: { request_id, mode, action } })
    return pending
  }

  /** Correlated composer flush; unrelated key Acks cannot submit stale text. */
  async sendTracked(request: unknown): Promise<string> {
    if (!this.socket || this.detached) return "not connected"
    if (this.menuVersion < 1) return "This daemon needs the current menu protocol. Restart it to enable editable inputs."
    if (!request || typeof request !== "object" || !("ReplaceInput" in request)) return "unsupported tracked operation"
    const request_id = crypto.randomUUID()
    const pending = this.operations.wait(request_id)
    this.send({ ReplaceInputTracked: { request_id, ...(request as { ReplaceInput: { text: string; cursor: number } }).ReplaceInput } })
    return (await pending) ?? "ack"
  }

  private async attach(sessionId: string, restarted: boolean): Promise<void> {
    if (!this.transport?.remote) await ensureDaemon(sessionId)
    if (this.closed) return
    const hello = this.expectHello()
    await this.connect(sessionId)
    const version = await hello
    if (this.transport?.remote) return
    if (!needsRestart(version, process.env.KOMA_BUILD, restarted) || this.closed) return
    this.restarting = true
    this.dropSocket()
    this.snap = null
    this.onUpdate(null)
    await killSession(sessionId)
    this.restarting = false
    if (this.closed) return
    await this.attach(sessionId, true)
  }

  onDisconnect: (() => void) | null = null
  usageReader = false

  private expectHello(): Promise<string | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.helloResolve) {
          this.helloResolve = null
          resolve(null)
        }
      }, 2000)
      this.helloResolve = (version) => {
        clearTimeout(timer)
        this.helloResolve = null
        resolve(version)
      }
    })
  }

  private async connect(sessionId: string): Promise<void> {
    this.usageReader = false
    this.reader = new FrameReader()
    this.seq = -1
    if (this.transport) {
      await this.transport.open(sessionId, (data) => this.onData(data), () => this.onClose(), (error) => this.fail(error))
      this.socket = this.transport
      this.send({ Attach: { foreground_id: null, cwd: null } })
      this.send("GetMenuCapabilities")
      return
    }
    const socket = await Bun.connect({
      unix: socketPath(sessionId),
      socket: {
        data: (_socket, data) => this.onData(data),
        open() {},
        close: () => this.onClose(),
        error: (_socket, error) => this.fail(error),
        connectError: (_socket, error) => this.fail(error),
      },
    })
    if (this.closed) {
      socket.end()
      return
    }
    this.socket = socket
    this.reader = new FrameReader()
    this.seq = -1
    this.send({
      Attach: { foreground_id: null, cwd: process.cwd() },
    })
    this.send("GetMenuCapabilities")
  }

  private dropSocket(): void {
    const socket = this.socket
    this.socket = null
    try {
      socket?.end()
    } catch {
      // The restart is about to kill the process anyway.
    }
  }

  detach(): void {
    if (this.detached) return
    this.operations.close()
    this.detached = true
    this.closed = true
    try {
      this.sendRaw("Detach")
    } catch {
      // The daemon drops us on a closed socket either way.
    }
    try {
      this.socket?.end()
    } catch {
      // Already gone.
    }
    this.socket = null
  }

  private sendRaw(request: unknown): void {
    this.socket?.write(encodeFrame(request))
  }

  private onData(data: Uint8Array | Buffer): void {
    let frames: unknown[]
    try {
      frames = this.reader.push(data instanceof Uint8Array ? data : new Uint8Array(data))
    } catch (error) {
      this.fail(error)
      return
    }
    for (const frame of frames) this.onFrame(frame)
  }

  private onFrame(frame: unknown): void {
    if (!frame || typeof frame !== "object") return
    const envelope = frame as { seq?: number; event?: unknown }
    if (typeof envelope.seq === "number") {
      if (this.seq >= 0 && envelope.seq !== this.seq + 1) this.send("Resync")
      this.seq = envelope.seq
    }
    const event = envelope.event
    this.events.dispatch(event)
    if (event && typeof event === "object" && "Hello" in (event as object)) {
      const version = String(((event as { Hello?: { version?: string } }).Hello ?? {}).version ?? "")
      this.helloResolve?.(version)
      return
    }
    if (event === "Ack") return
    const control = controlOf(event)
    if (control.kind !== "frame") {
      this.onControl(control)
      if (control.kind === "home" || control.kind === "new" || control.kind === "open") return
    }
    const next = fold(this.snap, event)
    if (next !== this.snap) {
      this.snap = next
      this.onUpdate(next)
    }
  }

  private onClose(): void {
    if (this.detached || this.restarting) return
    this.closed = true
    this.onDisconnect?.()
    this.operations.close()
    this.socket = null
    this.onControl({ kind: "error", text: this.menuVersion ? "daemon closed the connection" : "The daemon does not support terminal menu protocol v1. Update the host daemon, then reconnect." })
  }

  private fail(error: unknown): void {
    if (this.detached || this.restarting) return
    const text = error instanceof Error ? error.message : String(error)
    this.operations.close(text)
    this.onControl({ kind: "error", text })
  }
}
