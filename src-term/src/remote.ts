import type { UsageRequest, UsageResponse } from "./usage-reader.ts"
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
  | { ConnectionLost: { message: string } }
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
  private usagePending = new Map<number, { resolve: (r: UsageResponse) => void; reject: (e: Error) => void }>()
  readonly transport: DaemonTransport = {
    remote: true,
    usage: {
      request: (request: UsageRequest) => new Promise<UsageResponse>((resolve, reject) => {
        this.usagePending.set(request.request_id, { resolve, reject })
        this.write({ Usage: request })
      }),
      dispose: () => { for (const pending of this.usagePending.values()) pending.reject(new Error("Remote usage reader closed")); this.usagePending.clear() },
    },
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
    const executable = komaBin()
    const launchError = (error: unknown) => {
      if (!this.disposed) this.onEvent({ ConnectionLost: { message: `${executable}: ${error instanceof Error ? error.message : String(error)}` } })
    }
    try {
      this.child = spawn(executable, args, { stdio: "pipe", detached: process.platform !== "win32" })
    } catch (error) {
      launchError(error)
      return
    }
    this.child.stdin.on("error", () => {})
    let diagnostic = ""
    this.child.stderr.on("data", (bytes: Buffer) => { diagnostic = (diagnostic + bytes.toString()).slice(-2000) })
    this.child.stdout.on("data", (bytes: Buffer) => {
      try {
        for (const raw of this.reader.push(bytes)) {
          if (raw && typeof raw === "object" && "Usage" in raw) {
            const result = (raw as { Usage: UsageResponse }).Usage
            this.usagePending.get(result.request_id)?.resolve(result)
            this.usagePending.delete(result.request_id)
          } else if (raw && typeof raw === "object" && "UsageError" in raw) {
            const result = (raw as { UsageError: { request_id: number; message: string } }).UsageError
            this.usagePending.get(result.request_id)?.reject(new Error(result.message))
            this.usagePending.delete(result.request_id)
          } else if (raw && typeof raw === "object" && "Daemon" in raw) {
            this.daemonReceive?.(encodeFrame((raw as { Daemon: unknown }).Daemon))
          } else {
            const event = raw as RemoteEvent
            if (event && typeof event === "object" && "Error" in event) this.daemonError?.(new Error(event.Error.message))
            this.onEvent(event)
          }
        }
      } catch (error) { this.daemonError?.(error); this.onEvent({ ConnectionLost: { message: String(error) } }) }
    })
    this.child.on("error", launchError)
    this.child.on("close", () => {
      if (this.disposed) return
      const message = diagnostic.trim() || "Remote helper disconnected."
      this.daemonError?.(new Error(message))
      this.onEvent({ ConnectionLost: { message } })
    })
  }
  command(command: RemoteCommand): void { this.write(command) }
  private write(value: unknown): void { if (this.child?.stdin.writable && !this.child.stdin.destroyed) this.child.stdin.write(encodeFrame(value)) }
  dispose(): void {
    this.disposed = true
    this.transport.usage?.dispose()
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
