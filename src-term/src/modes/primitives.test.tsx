import { expect, test } from "bun:test"
import { act } from "react"
import { testRender } from "@opentui/react/test-utils"
import { rgbToHex } from "@opentui/core"
import { writeFileSync } from "node:fs"
import { ModeSurface } from "./surface.tsx"
import { PALETTE_NAMES, themeFor } from "../theme.ts"
import { FormGuard } from "./drafts.ts"
import { EventDispatcher, PendingOperations } from "../events.ts"

const escape = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;")
const previews: string[] = []
const frames: unknown[] = []
for (const [width, height] of [[50, 24], [80, 18], [100, 40], [160, 45]]) {
  for (const name of PALETTE_NAMES) test(`semantic settings colors / ${name} / ${width}×${height}`, async () => {
    const theme = themeFor(name)
    const view = await testRender(<box flexGrow={1} paddingLeft={2} paddingRight={2}><ModeSurface mode={{ Settings: { page: "quick", quick_focus: "general", palette: name, palette_sel: PALETTE_NAMES.indexOf(name), field: 2, awareness_enabled: true, classifier_enabled: false } }} theme={theme} columns={width!} onMove={() => {}} send={() => {}} /></box>, { width, height })
    try {
      await act(async () => { await view.waitForVisualIdle() })
      await act(async () => { await view.waitForVisualIdle() })
      await act(async () => { await view.waitForVisualIdle() })
      const text = view.captureCharFrame()
      expect(text).toContain("Appearance")
      expect(text).toContain("General")
      expect(text).toContain("[━●] on")
      expect(text).toContain("[●─] off")
      expect(text).not.toContain("Save")
      expect(text).not.toContain("Unsaved")
      expect(text).not.toContain("preview")
      expect(text).not.toContain("■")
      expect(text).not.toContain("Edit / toggle\n")
      expect(text.match(/Edit \/ toggle/g)?.length).toBe(1)
      expect(text).toContain("Back (esc)")
      if (width! < 100) expect(text).toContain("/ 13")
      if (width === 50) expect(text).toContain("/ 10")
      const frame = view.captureSpans()
      const spans = frame.lines.flatMap((line) => line.spans)
      for (const label of ["General"]) {
        const line = frame.lines.find((line) => line.spans.map((s) => s.text).join("").includes(label))!
        const at = line.spans.map((s) => s.text).join("").indexOf(label)
        let offset = 0
        const hit = line.spans.find((span) => { const end=offset+span.text.length; const found=offset<=at && end>at;offset=end;return found })!
        expect(rgbToHex(hit.fg).toLowerCase()).toBe(theme.accent)
      }
      expect(spans.some((span) => span.text.includes("[━●] on") && rgbToHex(span.fg).toLowerCase() === theme.success)).toBe(true)
      const html = frame.lines.map((line) => line.spans.map((span) => `<span style="color:${rgbToHex(span.fg)};background:${rgbToHex(span.bg)}">${escape(span.text)}</span>`).join("")).join("\n")
      frames.push({name,width,height,lines:frame.lines.map((line)=>line.spans.map((span)=>({text:span.text,fg:rgbToHex(span.fg),bg:rgbToHex(span.bg),width:span.width})))})
      previews.push(`<article><h2>${escape(name)} · ${width}×${height}</h2><pre style="background:${theme.bg}">${html}</pre></article>`)
    } finally { await act(async () => { await view.dispose() }) }
  })
}

test("write actual rendered theme previews", () => {
  if (process.env.KOMA_PREVIEW_PATH) writeFileSync(process.env.KOMA_PREVIEW_PATH+".json",JSON.stringify(frames))
  if (process.env.KOMA_PREVIEW_PATH) writeFileSync(process.env.KOMA_PREVIEW_PATH, `<!doctype html><meta charset="utf-8"><title>Terminal color previews</title><style>body{background:#202124;color:white;font-family:system-ui}pre{font-family:monospace;font-size:13px;line-height:1.2;display:inline-block;padding:12px}article{overflow:auto}</style>${previews.join("\n")}`)
})

test("correlation ignores unrelated acknowledgements, failures and stale results", async () => {
  const ops = new PendingOperations()
  const dispatch = new EventDispatcher()
  dispatch.on("MenuResult", (reply) => ops.complete(reply))
  let done = false
  const pending = ops.wait("save").then((error) => { done = true; return error })
  dispatch.dispatch("Ack")
  dispatch.dispatch({ Error: "another request failed" })
  dispatch.dispatch({ MenuResult: { request_id: "old-save", error: null } })
  await Promise.resolve()
  expect(done).toBe(false)
  dispatch.dispatch({ MenuResult: { request_id: "save", error: "Validation failed" } })
  expect(await pending).toBe("Validation failed")
  expect(ops.size).toBe(0)
  const disconnected = ops.wait("draft")
  ops.close()
  expect(await disconnected).toContain("draft is retained")
})

test("live snapshots preserve form drafts and detect only content changes", () => {
  const guard = new FormGuard()
  const state = { mode: "edit", list_sel: 1, field: "name", draft_name: "Example", draft_body: "full prompt", editing: false }
  guard.observe({ Agents: state })
  expect(guard.dirty({ Agents: { ...state, field: "description" } })).toBe(false)
  expect(guard.dirty({ Agents: { ...state, draft_body: "changed prompt" } })).toBe(true)
  expect(guard.canLeave({ Agents: { ...state, editor: ["prompt", {}] } })).toBe(false)
  guard.observe({ Agents: { ...state, draft_body: "changed prompt" } })
  expect(guard.dirty({ Agents: { ...state, draft_body: "changed prompt" } })).toBe(true)
})

test("native secret input edits in the middle, selects, pastes, and remains masked", async () => {
  const requests: unknown[] = []
  const view = await testRender(<ModeSurface mode={{ Settings: { page: "provider_form", prov_modal: { name: "Example", endpoint: "example", api_key: "existing-secret", field: 2 } } }} theme={themeFor("dark")} columns={80} onMove={() => {}} send={(r) => requests.push(r)} />, { width: 80, height: 24 })
  try {
    await act(async () => { await view.waitForVisualIdle() })
    await act(async () => { await view.mockInput.typeText("abc"); view.mockInput.pressArrow("left"); await view.mockInput.typeText("X") })
    expect(requests).toContainEqual({ MenuReplace: { field: "API key", value: "abXc" } })
    await act(async () => { view.mockInput.pressKey("a", { ctrl: true }); await view.mockInput.pasteBracketedText("replacement") })
    expect(requests).toContainEqual({ MenuReplace: { field: "API key", value: "replacement" } })
    expect(view.captureCharFrame()).not.toContain("replacement")
    expect(view.captureCharFrame()).not.toContain("existing-secret")
  } finally { await act(async () => { await view.dispose() }) }
})

test("a click directly selects the intended model without arrow replay", async () => {
  const requests: unknown[] = []
  const view = await testRender(<ModeSurface mode={{ Settings: { page: "models", model_sel: 0, models: [{ uuid: "model-id", name: "Example model", model_id: "example", roles: [] }] } }} theme={themeFor("dark")} columns={80} onMove={() => {}} send={(r) => requests.push(r)} />, { width: 80, height: 24 })
  try {
    await act(async () => { await view.waitForVisualIdle() })
    await act(async () => { await view.waitForVisualIdle() })
    const lines = view.captureCharFrame().split("\n")
    const y = lines.findIndex((line) => line.includes("Example model"))
    await act(async () => { await view.mockMouse.click(8, y) })
    expect(requests).toContainEqual({ MenuSelect: { group: "active", index: 5, id: "model-id" } })
    expect(requests.some((r) => JSON.stringify(r).includes('"Up"') || JSON.stringify(r).includes('"Down"'))).toBe(false)
  } finally { await act(async () => { await view.dispose() }) }
})
