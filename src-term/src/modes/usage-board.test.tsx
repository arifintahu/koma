import { expect, test } from "bun:test"
import { act } from "react"
import { testRender } from "@opentui/react/test-utils"
import { ModeSurface } from "./surface.tsx"
import { themeFor } from "../theme.ts"

const offset = -new Date().getTimezoneOffset() * 60
const hour = Math.floor((Date.now() / 1000 + offset) / 86400) * 86400 - offset

test("the usage screen fills in the ledger, chart, and role split", async () => {
  const mode = { Usage: {
    view: "global",
    range: "today",
    metric: "cost",
    data: {
      totals: { cost: 0.1398, tokens_in: 7_569_983, tokens_cached: 34_944, tokens_out: 96_702, calls: 199 },
      top_models: [
        { model_id: "grok-4.7", total_cost: 0.1398, tokens_in: 95_820, tokens_cached: 34_944, tokens_out: 93, call_count: 2 },
        { model_id: "Cyber-Tiel", total_cost: 0, tokens_in: 7_474_083, tokens_cached: 0, tokens_out: 96_609, call_count: 197 },
      ],
      role_split: { main_cost: 0.1398, main_calls: 165, sub_cost: 0, sub_calls: 34 },
      heatmap_buckets: [
        { bucket_epoch: hour, cost: 0.02, tokens: 1000 },
        { bucket_epoch: hour + 3600, cost: 0.12, tokens: 8000 },
      ],
      session_models: [],
      session_hourly: [],
      session_calls: 0,
    },
  } }
  const view = await testRender(<ModeSurface mode={mode} theme={themeFor("dark")} columns={100} onMove={() => {}} send={() => {}} />, { width: 100, height: 40 })
  try {
    await act(async () => { await view.waitForVisualIdle() })
    const frame = view.captureCharFrame()
    expect(frame).toContain("Usage / Global / today")
    expect(frame).toContain("$0.1398")
    expect(frame).toContain("grok-4.7")
    expect(frame).toContain("Cyber-Tiel")
    expect(frame).toContain("Roles")
    expect(frame).toContain("Activity")
    expect(frame).toContain("Summary")
    expect(frame).toContain("█")
    expect(frame).toContain("Main")
    expect(frame).toContain("Subagents")
  } finally {
    await act(async () => { await view.dispose() })
  }
})
