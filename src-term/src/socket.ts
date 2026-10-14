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
  private waiters: Array<(result: string) => void> = []
  snap: Snapshot | null = null

  constructor(
    private readonly onUpdate: (snap: Snapshot | null) => void,
    private readonly onControl: (control: Control) => void,
  ) {}

  async start(sessionId: string): Promise<void> {
    await this.attach(sessionId, false)
  }

  send(request: unknown): void {
    if (!this.socket || this.detached) return
    this.socket.write(encodeFrame(request))
  }

  /** Write one request and wait for its Ack, or the Error the daemon sends instead. */
  sendTracked(request: unknown): Promise<string> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve("timed out waiting for the daemon"), 2000)
      this.waiters.push((result) => {
        clearTimeout(timer)
        resolve(result)
      })
      this.send(request)
    })
  }

  private async attach(sessionId: string, restarted: boolean): Promise<void> {
    await ensureDaemon(sessionId)
    if (this.closed) return
    const hello = this.expectHello()
    await this.connect(sessionId)
    const version = await hello
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
    if (event && typeof event === "object" && "Hello" in (event as object)) {
      const version = String(((event as { Hello?: { version?: string } }).Hello ?? {}).version ?? "")
      this.helloResolve?.(version)
      return
    }
    if (event === "Ack") {
      this.waiters.shift()?.("ack")
      return
    }
    const control = controlOf(event)
    if (control.kind === "error" && this.waiters.length > 0) {
      this.waiters.shift()?.(control.text)
      this.onControl(control)
      return
    }
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
    this.socket = null
    this.onControl({ kind: "error", text: "daemon closed the connection" })
  }

  private fail(error: unknown): void {
    if (this.detached || this.restarting) return
    const text = error instanceof Error ? error.message : String(error)
    this.onControl({ kind: "error", text })
  }
}
