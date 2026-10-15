import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createContext } from "react"
import { encodeFrame, FrameReader } from "./protocol.ts"
import { komaBin } from "./paths.ts"
import type { Rec } from "./modes/read.ts"

export interface UsageRequest { version: 1; request_id: number; scope: string; range: string; session_uuid: string }
export interface UsageResponse extends UsageRequest {
  collected_at: number; window_start: number; window_end: number; utc_offset: number
  data: Rec | null; error: string | null; missing: boolean
}
export interface UsageLane { request(request: UsageRequest): Promise<UsageResponse>; dispose(): void }
export class LocalUsageLane implements UsageLane {
  private child: ChildProcessWithoutNullStreams | null = null
  private pending: { id: number; resolve: (r: UsageResponse) => void; reject: (e: Error) => void } | null = null
  request(request: UsageRequest): Promise<UsageResponse> {
    if (!this.child) {
      const child = spawn(komaBin(), ["remote-usage"], { stdio: "pipe" })
      this.child = child
      const reader = new FrameReader()
      let diagnostic = ""
      child.stderr.on("data", (b: Buffer) => { diagnostic = (diagnostic + b.toString()).slice(-1000) })
      child.stdin.on("error", () => {})
      const fail = (error: Error) => {
        if (this.child !== child) return
        this.child = null
        child.kill()
        this.pending?.reject(error)
        this.pending = null
      }
      child.on("error", fail)
      child.on("close", () => fail(new Error(diagnostic || "Usage reader disconnected")))
      child.stdout.on("data", (bytes: Buffer) => {
        try {
          for (const raw of reader.push(bytes)) {
            const result = raw as UsageResponse
            if (result.version !== 1) throw new Error("Unsupported usage reader protocol")
            if (result.request_id === this.pending?.id) { this.pending.resolve(result); this.pending = null }
          }
        } catch (error) { fail(new Error(String(error))) }
      })
    }
    return new Promise((resolve, reject) => {
      this.pending = { id: request.request_id, resolve, reject }
      this.child!.stdin.write(encodeFrame(request))
    })
  }
  dispose() {
    const child = this.child
    this.child = null
    child?.stdin.end()
    child?.kill()
    this.pending?.reject(new Error("Usage reader closed"))
    this.pending = null
  }
}
let nextUsageRequest = 0

export interface UsageState { result: UsageResponse | null; refreshing: boolean; error: string; missing: boolean }
type Selection = Omit<UsageRequest, "version" | "request_id">
const keyOf = (selection: Selection) => `${selection.scope}/${selection.range}/${selection.session_uuid}`
/** One request in flight; timer/scope changes coalesce. Results belong to a selection, never a metric. */
export class UsageReader {
  private selection: Selection | null = null
  private inflight = false
  private pending = false
  private generation = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private listeners = new Set<() => void>()
  private cache = new Map<string, UsageResponse>()
  private disposed = false
  state: UsageState = { result: null, refreshing: false, error: "", missing: false }
  constructor(private lane: UsageLane) {}
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn) } }
  private update(state: UsageState) { this.state = state; for (const fn of this.listeners) fn() }
  select(selection: Selection | null) {
    if (selection && this.selection && keyOf(selection) === keyOf(this.selection)) return
    this.generation++
    this.selection = selection
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (!selection) { this.pending = false; return }
    this.update({ result: this.cache.get(keyOf(selection)) ?? null, refreshing: false, error: "", missing: false })
    this.refresh()
    this.timer = setInterval(() => this.refresh(), 1000)
  }
  refresh = () => {
    if (!this.selection || this.disposed) return
    if (this.inflight) { this.pending = true; return }
    this.inflight = true
    this.pending = false
    const selection = this.selection
    const generation = this.generation
    const request: UsageRequest = { ...selection, version: 1, request_id: ++nextUsageRequest }
    this.update({ ...this.state, refreshing: true })
    let timeout: ReturnType<typeof setTimeout>
    const expiry = new Promise<never>((_, reject) => { timeout = setTimeout(() => { this.lane.dispose(); reject(new Error("Usage reader timed out")) }, 5000) })
    Promise.race([this.lane.request(request), expiry]).then((result) => {
      if (generation !== this.generation || this.disposed) return
      if (result.version !== 1 || result.request_id !== request.request_id || keyOf(result) !== keyOf(selection)) throw new Error("Mismatched usage response")
      if (result.data) this.cache.set(keyOf(selection), result)
      this.update({ result: result.data ? result : this.state.result, refreshing: false, error: result.error ?? "", missing: result.missing })
    }).catch((error) => {
      if (generation === this.generation && !this.disposed) this.update({ ...this.state, refreshing: false, error: String(error), missing: false })
    }).finally(() => {
      clearTimeout(timeout!)
      this.inflight = false
      if (this.pending && this.selection && !this.disposed) this.refresh()
    })
  }
  dispose() { this.select(null); this.disposed = true; this.lane.dispose(); this.listeners.clear() }
}
export const UsageContext = createContext<{ reader: UsageReader; session: string } | null>(null)
