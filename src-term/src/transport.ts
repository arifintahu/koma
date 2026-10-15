/** Byte transport shared by local daemon sockets and the headless SSH helper. */
export interface DaemonTransport {
  open(sessionId: string, receive: (bytes: Uint8Array) => void, close: () => void, error: (error: unknown) => void): Promise<void>
  write(bytes: Uint8Array): number
  end(): void
  usage?: import("./usage-reader.ts").UsageLane
  readonly remote: boolean
}
