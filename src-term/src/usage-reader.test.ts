import { expect, test } from "bun:test"
import { UsageReader, type UsageLane, type UsageRequest, type UsageResponse } from "./usage-reader.ts"
class Lane implements UsageLane {
  requests: UsageRequest[] = []
  completions: ((r: UsageResponse) => void)[] = []
  failures: ((e: Error) => void)[] = []
  disposed = 0
  request(r: UsageRequest) { this.requests.push(r); return new Promise<UsageResponse>((resolve, reject) => { this.completions.push(resolve); this.failures.push(reject) }) }
  dispose() { this.disposed++ }
  answer(i: number, error: string | null = null) { const r = this.requests[i]!; this.completions[i]!({ ...r, collected_at: i, window_start: 0, window_end: 1, utc_offset: 20700, data: error ? null : { totals: { cost: i } }, error, missing: false }) }
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
const selection = { scope: "global", range: "today", session_uuid: "test" }
test("usage refreshes coalesce, discard superseded responses, and retain successful results on error", async () => {
  const lane = new Lane(), reader = new UsageReader(lane)
  try {
    reader.select(selection)
    reader.refresh(); reader.refresh(); reader.refresh()
    reader.select({ ...selection, range: "week" })
    expect(lane.requests).toHaveLength(1)
    lane.answer(0); await flush()
    expect(reader.state.result).toBeNull()
    expect(lane.requests).toHaveLength(2)
    expect(lane.requests[1]!.range).toBe("week")
    lane.answer(1); await flush()
    const result = reader.state.result
    reader.refresh()
    expect(reader.state.result).toBe(result)
    expect(reader.state.refreshing).toBe(true)
    lane.answer(2, "corrupt ledger"); await flush()
    expect(reader.state.result).toBe(result)
    expect(reader.state.error).toBe("corrupt ledger")
    reader.refresh(); lane.failures[3]!(new Error("helper crashed")); await flush()
    expect(reader.state.result).toBe(result)
    expect(reader.state.error).toContain("helper crashed")
    reader.select(null); reader.refresh()
    expect(lane.requests).toHaveLength(4)
  } finally { reader.dispose() }
  expect(lane.disposed).toBe(1)
})
test("a close and reopen waits for the old request and rejects its late result", async () => {
  const lane = new Lane(), reader = new UsageReader(lane)
  try {
    reader.select(selection); reader.select(null); reader.select(selection)
    lane.answer(0); await flush()
    expect(reader.state.result).toBeNull()
    expect(lane.requests).toHaveLength(2)
    lane.answer(1); await flush()
    expect(reader.state.result?.request_id).toBe(lane.requests[1]!.request_id)
  } finally { reader.dispose() }
})
test("protocol/request mismatches cannot replace visible usage", async () => {
  const lane = new Lane(), reader = new UsageReader(lane)
  try {
    reader.select(selection)
    lane.completions[0]!({ ...lane.requests[0]!, scope: "session", collected_at: 0, window_start: 0, window_end: 1, utc_offset: 0, data: {}, error: null, missing: false })
    await flush()
    expect(reader.state.result).toBeNull()
    expect(reader.state.error).toContain("Mismatched")
  } finally { reader.dispose() }
})
