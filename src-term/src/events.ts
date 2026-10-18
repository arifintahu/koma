import type { Snapshot } from "./protocol.ts"

import type { DaemonMenuEvents } from "./modes/data.ts"
export type MenuResult = DaemonMenuEvents["MenuResult"]
export interface EventMap extends DaemonMenuEvents { Snapshot: Snapshot }

/** Routes replies independently of Snapshot/Delta folding, including future
 * additive domain replies. Unknown messages remain observable for diagnostics. */
export class EventDispatcher {
  readonly latest = new Map<string, unknown>()
  readonly catalogues = new Map<string, EventMap["ModelList"]>()
  readonly routes = new Map<string, EventMap["ModelRoutes"]>()
  readonly notifications = new Map<string, EventMap["Notifications"]["reply"]>()
  readonly operations = new Map<string, EventMap["ExtensionOpResult"]>()
  readonly values: Partial<{ [K in keyof EventMap]: EventMap[K] }> = {}
  constructor() {
    this.on("ModelList", (reply) => this.catalogues.set(reply.provider, reply))
    this.on("ModelRoutes", (reply) => this.routes.set(`${reply.provider}/${reply.model_id}`, reply))
    this.on("Notifications", ({ reply }) => this.notifications.set(reply.session ?? "app", reply))
    this.on("ExtensionOpResult", (reply) => this.operations.set(reply.id, reply))
    for (const name of ["SettingsValues","OAuthState","McpStatus","StoreCatalogue","StoreItemDetail","InstalledExtensions","AgentsValues","AgentOp","WebSearchValues","EffortOptions","PasteBody","AttachmentLocated"] as const) {
      this.on(name, (reply) => Object.assign(this.values, { [name]: reply }))
    }
  }
  private listeners = new Map<string, Set<(payload: unknown) => void>>()
  on<K extends keyof EventMap>(name: K, listener: (payload: EventMap[K]) => void): () => void {
    const set = this.listeners.get(name) ?? new Set()
    const handler = listener as (payload: unknown) => void
    set.add(handler)
    this.listeners.set(name, set)
    return () => { set.delete(handler) }
  }
  dispatch(event: unknown): void {
    if (!event || typeof event !== "object" || Array.isArray(event)) return
    for (const [name, payload] of Object.entries(event)) {
      this.latest.set(name, payload)
      for (const handler of this.listeners.get(name) ?? []) handler(payload)
    }
  }
}

/** Only the matching result can complete an operation. Legacy Ack is ignored. */
export class PendingOperations {
  private pending = new Map<string, { resolve: (error: string | null) => void; timer: ReturnType<typeof setTimeout> }>()
  get size() { return this.pending.size }
  wait(id: string, timeout = 10000): Promise<string | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve("Timed out waiting for the daemon. Your draft is retained.") }, timeout)
      this.pending.set(id, { resolve, timer })
    })
  }
  complete({ request_id, error }: Pick<MenuResult, "request_id" | "error">): boolean {
    const op = this.pending.get(request_id)
    if (!op) return false
    clearTimeout(op.timer)
    this.pending.delete(request_id)
    op.resolve(error)
    return true
  }
  close(error = "Connection closed. Your draft is retained."): void {
    for (const id of this.pending.keys()) this.complete({ request_id: id, error })
  }
}
