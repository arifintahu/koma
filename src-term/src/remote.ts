import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { encodeFrame, FrameReader, type RemoteHandoff } from "./protocol.ts"
import { komaBin } from "./paths.ts"
import type { DaemonTransport } from "./transport.ts"

export interface RemoteSession { session_id: string; name: string; pwd: string; working?: boolean; updated_at?: number }
export type RemoteEvent =
  | { Progress: { stage: string } }
  | { AuthRequired: { error: string | null } }
  | { Sessions: { live: RemoteSession[]; history: RemoteSession[] } }
  | { Directories: { path: string; entries: string[] } }
  | { Connected: { session_id: string } }
  | { Error: { message: string } }
  | "Disconnected"
export type RemoteCommand =
  | { Password: { value: string } }
  | { Directories: { path: string } }
  | { Open: { session_id: string | null; cwd: string | null } }
  | { Kill: { session_id: string } } | { Delete: { session_id: string } }
  | "Sessions" | "Disconnect" | "Cancel"

export class RemoteBridge {
  private child: ChildProcessWithoutNullStreams | null = null
  private reader = new FrameReader()
  private daemonReceive: ((bytes: Uint8Array) => void) | null = null
  private daemonClose: (() => void) | null = null
  private daemonError: ((error: unknown) => void) | null = null
  private disposed = false
  readonly transport: DaemonTransport = {
    remote: true,
    open: async (_id, receive, close, error) => {
      this.daemonReceive = receive
      this.daemonClose = close
      this.daemonError = error
    },
    write: (bytes) => {
      const frames = new FrameReader().push(bytes)
      for (const frame of frames) this.write({ Frame: frame })
      return bytes.length
    },
    end: () => { this.daemonReceive = null; this.daemonClose = null; this.daemonError = null },
  }
  constructor(private onEvent: (event: RemoteEvent) => void) {}
  start(remote: RemoteHandoff): void {
    const args = ["term-remote", "--target", remote.target]
    if (remote.key) args.push("--key", remote.key)
    if (remote.hostId) args.push("--host", remote.hostId)
    if (remote.sessionId) args.push("--session", remote.sessionId)
    if (remote.newSession) args.push("--new")
    this.child = spawn(komaBin(), args, { stdio: "pipe", detached: process.platform !== "win32" })
    this.child.stdin.on("error", () => {})
    let diagnostic = ""
    this.child.stderr.on("data", (bytes: Buffer) => { diagnostic = (diagnostic + bytes.toString()).slice(-2000) })
    this.child.stdout.on("data", (bytes: Buffer) => {
      try {
        for (const raw of this.reader.push(bytes)) {
          if (raw && typeof raw === "object" && "Daemon" in raw) {
            this.daemonReceive?.(encodeFrame((raw as { Daemon: unknown }).Daemon))
          } else {
            const event = raw as RemoteEvent
            if (event && typeof event === "object" && "Error" in event) this.daemonError?.(new Error(event.Error.message))
            this.onEvent(event)
          }
        }
      } catch (error) { this.onEvent({ Error: { message: String(error) } }) }
    })
    this.child.on("error", (error) => this.onEvent({ Error: { message: error.message } }))
    this.child.on("close", () => {
      if (this.disposed) return
      this.daemonClose?.()
      this.onEvent({ Error: { message: diagnostic.trim() || "Remote helper disconnected. Retry to reconnect." } })
    })
  }
  command(command: RemoteCommand): void { this.write(command) }
  private write(value: unknown): void { if (this.child?.stdin.writable && !this.child.stdin.destroyed) this.child.stdin.write(encodeFrame(value)) }
  dispose(): void {
    this.disposed = true
    this.write("Cancel")
    // The helper and its SSH children share a private process group. Cancellation
    // stops provisioning/discovery promptly without killing the remote daemon.
    const child = this.child
    if (child?.pid) {
      try { if (process.platform === "win32") child.kill(); else process.kill(-child.pid, "SIGTERM") } catch {}
    }
    this.child = null
  }
}
