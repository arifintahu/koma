import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, expect, test } from "bun:test"
import { act } from "react"
import { testRender } from "@opentui/react/test-utils"
import { ModeSurface } from "./surface.tsx"
import { UsageContext, UsageReader, type UsageLane, type UsageResponse } from "../usage-reader.ts"
import { rgbToHex } from "@opentui/core"
import { PALETTE_NAMES, themeFor } from "../theme.ts"

const now = Date.UTC(2024, 2, 1, 9, 30) / 1000, offset = 20700
const midnight = Math.floor((now + offset) / 86400) * 86400 - offset
const models = Array.from({ length: 20 }, (_, i) => ({ model_id: i === 0 ? "Unicode 模型 🦜 with a very long model identifier for selection" : `model-${i}`, total_cost: i === 0 ? 0 : i * 1234.567, call_count: 100000 + i, tokens_in: 123456789, tokens_cached: 10000000, tokens_out: 99999 }))
const totals = { cost: models.reduce((s, r) => s + r.total_cost, 0), calls: models.reduce((s, r) => s + r.call_count, 0), tokens_in: 20 * 123456789, tokens_cached: 20 * 10000000, tokens_out: 20 * 99999 }
function fixture(scope: string, range: string): UsageResponse {
  const start = scope === "session" ? now - 1000 * 3600 : range === "today" ? midnight : now - (range === "week" ? 7 : 365) * 86400
  const step = scope === "session" || range === "today" ? 3600 : 86400
  const first = Math.floor((start + offset) / step) * step - offset
  const buckets = Array.from({ length: Math.ceil((now - first) / step) }, (_, i) => ({ bucket_epoch: first + i * step, cost: i % 5, tokens: i * 1000 }))
  return { version: 1, request_id: 0, scope, range, session_uuid: "fixture", collected_at: now, window_start: start, window_end: range === "today" && scope === "global" ? midnight + 86400 : now + 1, utc_offset: offset, data: { totals, top_models: models, session_models: models, heatmap_buckets: buckets, session_hourly: buckets, session_calls: totals.calls, role_split: { main_cost: 10000, main_calls: 20, sub_cost: 5000, sub_calls: 10 } }, error: null, missing: false }
}
const frames: string[] = []
const html: string[] = []
const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
function captureColors(view: Awaited<ReturnType<typeof testRender>>, name: string) {
  html.push(`<h2>${name}</h2><pre>${view.captureSpans().lines.map(line => line.spans.map(span => `<span style="color:${rgbToHex(span.fg)};background:${rgbToHex(span.bg)}">${escape(span.text)}</span>`).join("")).join("\n")}</pre>`)
}

for (const [width, height] of [[50, 24], [80, 18], [100, 40], [160, 45]] as const) {
  for (const [scope, range] of [["global", "today"], ["global", "week"], ["global", "year"], ["session", "today"]]) {
    test(`usage ${scope}/${range} at ${width}x${height} protects controls and selection`, async () => {
      const lane: UsageLane = { request: async r => ({ ...fixture(r.scope, r.range), request_id: r.request_id }), dispose() {} }
      const reader = new UsageReader(lane), sent: unknown[] = []
      const body = { view: scope, range, metric: "cost", data: {}, session_totals: totals }
      const view = await testRender(<UsageContext.Provider value={{ reader, session: "fixture" }}><ModeSurface mode={{ Usage: body }} theme={themeFor("dark")} columns={width} onMove={() => {}} send={r => sent.push(r)} /></UsageContext.Provider>, { width, height })
      try {
        await act(async () => { await view.waitForVisualIdle() })
        await act(async () => { await view.waitForVisualIdle() })
        let frame = view.captureCharFrame()
        captureColors(view, `${scope}/${range} ${width}×${height}`)
        frames.push(`\n${scope}/${range} ${width}x${height}\n${frame}`)
        expect(frame).toContain("Summary")
        expect(frame).toContain("esc back")
        expect(frame).toContain("Retry")
        expect(frame).toContain("tokens")
        expect(frame).toContain("Global")
        expect(frame).not.toContain("NaN")
        const before = frame.split("\n").find(l => l.includes(" – "))
        await act(async () => { view.mockInput.pressArrow("left") })
        await act(async () => { await view.waitForVisualIdle() })
        frame = view.captureCharFrame()
        expect(frame.split("\n").find(l => l.includes(" – "))).not.toBe(before)
        expect(sent).toHaveLength(0)
        await act(async () => { for (let i = 0; i < 20; i++) view.mockInput.pressKey("\u001b[6~") })
        await act(async () => { await view.waitForVisualIdle() })
        expect(view.captureCharFrame()).toContain("model-19")
        expect(view.captureCharFrame()).toContain("esc back")
      } finally { reader.dispose(); await act(async () => { await view.dispose() }) }
    })
  }
}
afterAll(async () => {
  await Bun.write(join(tmpdir(), "koma-usage-frames.txt"), frames.join("\n"))
  await Bun.write(join(tmpdir(), "koma-usage-review.html"), `<!doctype html><meta charset="utf-8"><title>Koma Usage frames</title><style>body{background:#161616;color:#eee}pre{font:14px/1.15 monospace;white-space:pre}</style>${html.join("\n")}`)
})

test("metric, refresh and resize retain the selected timestamp; header controls send daemon keys", async () => {
  let rerender = (_body: Record<string, unknown>) => {}
  const { useState } = await import("react")
  const calls: unknown[] = [], requests: unknown[] = []
  const reader = new UsageReader({ request: async r => { requests.push(r); return { ...fixture(r.scope, r.range), request_id: r.request_id } }, dispose() {} })
  function Dashboard() {
    const [body, setBody] = useState<Record<string, unknown>>({ view: "global", range: "year", metric: "cost", data: {} })
    rerender = setBody
    return <UsageContext.Provider value={{ reader, session: "fixture" }}><ModeSurface mode={{ Usage: body }} theme={themeFor("dark")} columns={100} onMove={() => {}} send={r => calls.push(r)} /></UsageContext.Provider>
  }
  const view = await testRender(<Dashboard />, { width: 100, height: 40 })
  const idle = async () => { await act(async () => { await view.waitForVisualIdle() }) }
  try {
    await idle(); await idle()
    await act(async () => { view.mockInput.pressArrow("left") }); await idle()
    const detail = () => view.captureCharFrame().split("\n").find(l => l.includes(" – "))!.trim()
    const selected = detail()
    await act(async () => { rerender({ view: "global", range: "year", metric: "tokens", data: {} }) }); await idle()
    expect(detail()).toBe(selected)
    expect(requests).toHaveLength(1)
    await act(async () => { reader.refresh() }); await idle()
    expect(detail()).toBe(selected)
    await act(async () => { view.resize(160, 45) }); await idle(); await idle()
    expect(detail()).toBe(selected)
    let frame = view.captureCharFrame(), lines = frame.split("\n"), y = lines.findIndex(l => l.includes("Back (esc)"))
    await act(async () => { await view.mockMouse.click(lines[y]!.indexOf("Back") + 1, y) }); await idle()
    expect(calls).toContainEqual({ SendKey: { code: "Esc", mods: 0 } })
    y = lines.findIndex(l => l.includes("Sun"))
    await act(async () => { await view.mockMouse.click(10, y) }); await idle()
    expect(detail()).not.toBe(selected)
    await act(async () => { view.mockInput.pressKey("HOME") }); await idle()
    expect(detail()).toContain("2023-03-02")
    await act(async () => { view.mockInput.pressKey("END") }); await idle()
    expect(detail()).toContain("2024-03-01")
  } finally { reader.dispose(); await act(async () => { await view.dispose() }) }
})

for (const palette of PALETTE_NAMES) for (const [width, height] of [[50, 24], [80, 18], [100, 40], [160, 45]] as const) {
  test(`usage calendar native colors / ${palette} / ${width}x${height}`, async () => {
    const reader = new UsageReader({ request: async r => ({ ...fixture(r.scope, r.range), request_id: r.request_id }), dispose() {} })
    const theme = themeFor(palette)
    const view = await testRender(<UsageContext.Provider value={{ reader, session: "fixture" }}><ModeSurface mode={{ Usage: { view: "global", range: "year", metric: "cost", data: {} } }} theme={theme} columns={width} onMove={() => {}} send={() => {}} /></UsageContext.Provider>, { width, height })
    try {
      await act(async () => { await view.waitForVisualIdle() })
      await act(async () => { await view.waitForVisualIdle() })
      const spans = view.captureSpans().lines.flatMap(l => l.spans)
      const backgrounds = new Set(spans.map(s => rgbToHex(s.bg)))
      for (const color of theme.heat) expect(backgrounds.has(color)).toBe(true)
      expect(spans.some(s => s.text.includes("Summary") && rgbToHex(s.fg) === theme.accent)).toBe(true)
      expect(spans.some(s => s.text.includes("Global") && rgbToHex(s.fg) === theme.accent)).toBe(true)
      if (view.captureCharFrame().includes("◆")) expect(backgrounds.has(theme.selBg)).toBe(true)
      captureColors(view, `${palette} year ${width}×${height}`)
    } finally { reader.dispose(); await act(async () => { await view.dispose() }) }
  })
}

for (const [scope, range] of [["global", "today"], ["global", "week"], ["global", "year"], ["session", "today"]]) for (const empty of [true, false]) {
  test(`${scope}/${range} renders ${empty ? "empty" : "zero-cost token"} ledgers without invalid shares`, async () => {
    const reader = new UsageReader({ request: async r => {
      const base = fixture(r.scope, r.range)
      const model = { model_id: "free-model", total_cost: 0, call_count: 1, tokens_in: 100, tokens_cached: 30, tokens_out: 20 }
      return { ...base, request_id: r.request_id, data: { totals: { cost: 0, calls: empty ? 0 : 1, tokens_in: empty ? 0 : 100, tokens_cached: empty ? 0 : 30, tokens_out: empty ? 0 : 20 }, top_models: empty ? [] : [model], session_models: empty ? [] : [model], heatmap_buckets: [], session_hourly: [], role_split: {} } }
    }, dispose() {} })
    const view = await testRender(<UsageContext.Provider value={{ reader, session: "fixture" }}><ModeSurface mode={{ Usage: { view: scope, range, metric: "tokens", data: {} } }} theme={themeFor("dark")} columns={100} onMove={() => {}} send={() => {}} /></UsageContext.Provider>, { width: 100, height: 40 })
    try {
      await act(async () => { await view.waitForVisualIdle() }); await act(async () => { await view.waitForVisualIdle() })
      const frame = view.captureCharFrame()
      expect(frame).not.toMatch(/NaN|Infinity/)
      expect(frame).toContain("$0.0000")
      expect(frame).toContain(empty ? "No model usage recorded" : "100.0%")
    } finally { reader.dispose(); await act(async () => { await view.dispose() }) }
  })
}

test("bar selection moves only the caret marker, preserving native bar shapes and colors", async () => {
  const reader = new UsageReader({ request: async r => ({ ...fixture(r.scope, r.range), request_id: r.request_id }), dispose() {} })
  const view = await testRender(<UsageContext.Provider value={{ reader, session: "fixture" }}><ModeSurface mode={{ Usage: { view: "global", range: "today", metric: "cost", data: {} } }} theme={themeFor("dark")} columns={100} onMove={() => {}} send={() => {}} /></UsageContext.Provider>, { width: 100, height: 40 })
  try {
    await act(async () => { await view.waitForVisualIdle() }); await act(async () => { await view.waitForVisualIdle() })
    const barRow = view.captureCharFrame().split("\n").findIndex(line => line.includes("Activity / today")) + 1
    const nativeBars = () => view.captureSpans().lines.slice(barRow, barRow + 5).map(line => line.spans.map(span => ({ text: span.text, fg: rgbToHex(span.fg), bg: rgbToHex(span.bg) })))
    const before = nativeBars(), marker = view.captureCharFrame().split("\n")[barRow + 5]!
    expect(marker).toContain("^^^")
    const filled = before.flat().filter(span => span.text.includes("█") && themeFor("dark").heat.includes(span.fg))
    expect(filled.length).toBeGreaterThan(0)
    for (const span of filled) expect(span.bg).toBe(span.fg)
    expect(before.flat().some(span => span.bg === themeFor("dark").selBg)).toBe(false)
    await act(async () => { view.mockInput.pressArrow("left") }); await act(async () => { await view.waitForVisualIdle() })
    expect(nativeBars()).toEqual(before)
    expect(view.captureCharFrame().split("\n")[barRow + 5]).toContain("^^^")
    expect(view.captureCharFrame().split("\n")[barRow + 5]).not.toBe(marker)
    await act(async () => { view.mockInput.pressKey("HOME") }); await act(async () => { await view.waitForVisualIdle() })
    expect(view.captureCharFrame().split("\n")[barRow + 5]).toContain("^^^")
    await act(async () => { view.mockInput.pressKey("END") }); await act(async () => { await view.waitForVisualIdle() })
    expect(view.captureCharFrame().split("\n")[barRow + 5]).toContain("^^^")
  } finally { reader.dispose(); await act(async () => { await view.dispose() }) }
})

for (const width of [50, 80, 100, 160]) {
  test(`year heat cells fill the panel at ${width} columns`, async () => {
    const theme = themeFor("dark")
    const reader = new UsageReader({ request: async r => ({ ...fixture(r.scope, r.range), request_id: r.request_id }), dispose() {} })
    const view = await testRender(<UsageContext.Provider value={{ reader, session: "fixture" }}><ModeSurface mode={{ Usage: { view: "global", range: "year", metric: "cost", data: {} } }} theme={theme} columns={width} onMove={() => {}} send={() => {}} /></UsageContext.Provider>, { width, height: 40 })
    try {
      await act(async () => { await view.waitForVisualIdle() }); await act(async () => { await view.waitForVisualIdle() })
      const lines = view.captureCharFrame().split("\n"), row = lines.findIndex(line => line.includes("│Thu"))
      expect(row).toBeGreaterThan(0)
      let column = 0, heatEnd = 0
      for (const span of view.captureSpans().lines[row]!.spans) {
        column += span.width
        if (theme.heat.includes(rgbToHex(span.bg))) heatEnd = column
      }
      expect(heatEnd).toBe(lines[row]!.lastIndexOf("│"))
    } finally { reader.dispose(); await act(async () => { await view.dispose() }) }
  })
}

for (const palette of ["dark", "light", "forest"]) {
  test(`usage choices match shared tab colors and pointer behavior / ${palette}`, async () => {
    const sent: unknown[] = [], theme = themeFor(palette)
    const view = await testRender(<ModeSurface mode={{ Usage: { view: "global", range: "year", metric: "cost", data: {} } }} theme={theme} columns={100} onMove={() => {}} send={r => sent.push(r)} />, { width: 100, height: 40 })
    try {
      await act(async () => { await view.waitForVisualIdle() }); await act(async () => { await view.waitForVisualIdle() })
      const lines = view.captureCharFrame().split("\n"), row = lines.findIndex(line => line.includes("Global") && line.includes("Tokens"))
      const spans = view.captureSpans().lines[row]!.spans
      expect(lines[row].trim()).toBe("Global · Session (tab) | Today (1) | Week (2) | Year (3) | Cost · Tokens (m) | Back (esc)")
      for (const label of ["Global", "Year", "Cost"]) {
        const span = spans.find(span => span.text.includes(label))!
        expect(rgbToHex(span.fg)).toBe(theme.accent)
        expect(rgbToHex(span.bg)).toBe(theme.bg)
      }
      for (const label of ["Session", "Today", "Week", "Tokens"]) expect(rgbToHex(spans.find(span => span.text.includes(label))!.fg)).toBe(theme.fg)
      const click = async (label: string) => { await act(async () => { await view.mockMouse.click(lines[row]!.indexOf(label) + 1, row) }); await act(async () => { await view.waitForVisualIdle() }) }
      await click("Cost"); await click("Global"); await click("Year")
      expect(sent).toHaveLength(0)
      await click("Tokens"); expect(sent.at(-1)).toEqual({ SendKey: { code: { Char: "m" }, mods: 0 } })
      await click("Session"); expect(sent.at(-1)).toEqual({ SendKey: { code: "Tab", mods: 0 } })
      await click("Today"); expect(sent.at(-1)).toEqual({ SendKey: { code: { Char: "1" }, mods: 0 } })
    } finally { await act(async () => { await view.dispose() }) }
  })
}
