import { expect, test } from "bun:test"
import { act, useMemo, type ReactNode } from "react"
import { writeFileSync } from "node:fs"
import { SyntaxStyle, rgbToHex } from "@opentui/core"
import { useRenderer } from "@opentui/react"
import { testRender } from "@opentui/react/test-utils"
import { Chat, collapsePastedText } from "./chat.tsx"
import { SessionScreen } from "./session.tsx"
import { decodeFrames, encodeFrame, fold, type Snapshot } from "./protocol.ts"
import { themeFor } from "./theme.ts"
import type { DaemonTransport } from "./transport.ts"

const previews: string[] = []
const renderedFrames: string[] = []
const escapeHtml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
function Styled({ children }: { children: (style: SyntaxStyle) => ReactNode }) {
  const renderer = useRenderer()
  const style = useMemo(() => SyntaxStyle.fromStyles({}, renderer.nativeScene), [renderer])
  return children(style)
}
function snapshot(name = "write", id = "call-1"): Snapshot {
  return fold(null, { Snapshot: {
    foreground_id: "test", sessions: [{ id: "test", name: "Test", messages: [], awaiting_approval: true,
      approval_reason: "Human decision required", tool_idx: 0,
      pending_tool_calls: [{ id, function: { name, arguments: JSON.stringify({ highlights: "Readable decision digest\n" + "long details\n".repeat(40), command: "rm example" }) } }],
    }],
    global: { mode: "Chat", input: "draft 🐈", cursor: 7, current_version: "0.4.5", command_palette: [{ name: "/help", desc: "help" }] },
  } })!
}
class Transport implements DaemonTransport {
  readonly remote = true
  requests: any[] = []
  receive: (bytes: Uint8Array) => void = () => {}
  constructor(public snap = snapshot()) {}
  async open(_id: string, receive: (bytes: Uint8Array) => void) {
    this.receive = receive
    this.emit({ Hello: { version: "test" } })
  }
  emit(event: unknown) { this.receive(encodeFrame({ event })) }
  write(bytes: Uint8Array) {
    for (const request of decodeFrames(bytes) as any[]) {
      this.requests.push(request)
      if (request.Attach) queueMicrotask(() => this.emit({ Snapshot: this.snap }))
      if (request === "GetMenuCapabilities") queueMicrotask(() => this.emit({ MenuCapabilities: { version: 1 } }))
      if (request.ReplaceInputTracked) {
        const r = request.ReplaceInputTracked
        this.snap = { ...this.snap, global: { ...this.snap.global, input: r.text, cursor: r.cursor } }
        queueMicrotask(() => { this.emit({ Snapshot: this.snap }); this.emit({ MenuResult: { request_id: r.request_id, error: null } }) })
      }
    }
    return bytes.length
  }
  end() {}
}
function screen(transport: Transport) {
  return <Styled>{(syntaxStyle) => <SessionScreen id="test" transport={transport} syntaxStyle={syntaxStyle} onHome={() => {}} onOpen={() => {}} onExit={() => {}} onRemote={() => {}} onPalette={() => {}} />}</Styled>
}

for (const [width, height] of [[50, 24], [80, 18], [100, 40], [160, 45]]) {
  for (const name of ["write", "plan_ready", "mission_ready"]) test(`approval controls stay above draft / ${name} / ${width}×${height}`, async () => {
    const requests: unknown[] = []
    const view = await testRender(<Styled>{(syntaxStyle) => <Chat snap={snapshot(name)} theme={themeFor("dark")} syntaxStyle={syntaxStyle} focused={false} send={(r) => requests.push(r)} sendTracked={async () => "ack"} onFlushError={() => {}} />}</Styled>, { width, height })
    try {
      await act(async () => { await view.waitForVisualIdle() })
      const frame = view.captureCharFrame()
      renderedFrames.push(`${name} · ${width}×${height}\n${frame}`)
      const spans = view.captureSpans()
      previews.push(`<h2>${name} · ${width}×${height}</h2><pre>${spans.lines.map((line) => line.spans.map((span) => `<span style="color:${rgbToHex(span.fg)};background:${rgbToHex(span.bg)}">${escapeHtml(span.text)}</span>`).join("")).join("\n")}</pre>`)
      expect(frame).toContain("Approve (y)")
      expect(frame).toContain("draft 🐈")
      expect(frame).not.toContain("/help")
      if (name === "write") expect(frame).toContain("Deny (n/esc)")
      else { expect(frame).toContain("Readable decision digest"); expect(frame).toContain("Approve & compact (a)"); expect(frame).toContain("Chat more (n/esc)") }
      const lines = frame.split("\n")
      const y = lines.findIndex((line) => line.includes("Approve (y)"))
      expect(y).toBeLessThan(lines.findIndex((line) => line.includes("draft 🐈")))
      await act(async () => { await view.mockMouse.click(lines[y]!.indexOf("Approve") + 2, y) })
      expect(requests).toHaveLength(1)
      await act(async () => { view.resize(50, 24); await view.waitForVisualIdle() })
      await act(async () => { await view.waitForVisualIdle() })
      await act(async () => { await view.waitForVisualIdle() })
      expect(view.captureCharFrame()).toContain("Approve (y)")
    } finally { await act(async () => { await view.dispose() }) }
  })
}

for (const [name, key, expected] of [["write", "Y", "ApproveTool"], ["write", "n", "ApproveTool"], ["write", "escape", "ApproveTool"], ["plan_ready", "y", "PlanDecision"], ["plan_ready", "A", "PlanDecision"], ["plan_ready", "N", "PlanDecision"], ["mission_ready", "y", "PlanDecision"], ["mission_ready", "a", "PlanDecision"], ["mission_ready", "N", "PlanDecision"]]) {
  test(`real approval input consumes ${key} once for ${name} and restores focus`, async () => {
    const transport = new Transport(snapshot(name))
    const view = await testRender(screen(transport), { width: 80, height: 24, kittyKeyboard: true })
    try {
      await act(async () => { await view.waitForVisualIdle() })
      await act(async () => { view.mockInput.pressKey(key === "escape" ? "ESCAPE" : key!); view.mockInput.pressKey(key === "escape" ? "ESCAPE" : key!); await view.mockInput.pasteBracketedText("blocked"); view.mockInput.pressArrow("down"); view.mockInput.pressKey("RETURN") })
      expect(transport.requests.filter((r) => r && r[expected!])).toHaveLength(1)
      const response = transport.requests.find((r) => r && r[expected!])[expected!]
      if (expected === "ApproveTool") expect(response.approve).toBe(key!.toLowerCase() === "y")
      else expect(response.decision).toBe(key!.toLowerCase() === "y" ? "approve" : key!.toLowerCase() === "a" ? "compact" : "deny")
      expect(transport.requests.some((r) => r.Paste || r.ReplaceInputTracked || r.SendKey)).toBe(false)
      transport.snap = { ...transport.snap, sessions: transport.snap.sessions.map((s) => ({ ...s, awaiting_approval: false })), global: { ...transport.snap.global, command_palette: [] } }
      await act(async () => { transport.emit({ Snapshot: transport.snap }); await view.waitForVisualIdle() })
      await act(async () => { await view.mockInput.typeText("!"); await new Promise((r) => setTimeout(r, 50)) })
      expect(transport.requests.some((r) => r.ReplaceInputTracked?.text === "draft 🐈!")).toBe(true)
      transport.snap = snapshot(name, "call-2")
      await act(async () => { transport.emit({ Snapshot: transport.snap }); await view.waitForVisualIdle() })
      await act(async () => { view.mockInput.pressKey(key === "escape" ? "ESCAPE" : key!); await new Promise((resolve) => setTimeout(resolve, key === "escape" ? 150 : 30)) })
      expect(transport.requests.filter((r) => r && r[expected!])).toHaveLength(2)
    } finally { await act(async () => { await view.dispose() }) }
  })
}

test("composer paste flushes selection once and retains newer typing around returned markers", async () => {
  const transport = new Transport(snapshot())
  transport.snap.sessions[0]!.awaiting_approval = false
  transport.snap.global.command_palette = []
  const view = await testRender(screen(transport), { width: 50, height: 24 })
  try {
    await act(async () => { await view.waitForVisualIdle() })
    await act(async () => { await view.mockInput.pasteBracketedText("large\npaste"); await new Promise((r) => setTimeout(r, 10)) })
    expect(transport.requests.filter((r) => r.Paste)).toEqual([{ Paste: { text: "large\npaste" } }])
    await act(async () => { await view.mockInput.typeText(" newer") })
    await act(async () => { transport.emit({ Delta: { InputChanged: { text: "draft 🐈[Pasted Text #1]", cursor: 23 } } }); await view.waitForVisualIdle() })
    await act(async () => { await view.waitForVisualIdle() })
    expect(view.captureCharFrame()).toContain("[Pasted Text #1] newer")
  } finally { await act(async () => { await view.dispose() }) }
})

for (const initialMode of ["Chat", { Notifications: { entries: [], query: "search draft", cursor: 0, app: true } }]) {
  test(`approval arriving during ${typeof initialMode === "string" ? "palette" : "menu"} keeps exclusive keys and focus`, async () => {
    const transport = new Transport(snapshot("write"))
    transport.snap.sessions[0]!.awaiting_approval = false
    transport.snap.global.mode = initialMode
    const view = await testRender(screen(transport), { width: 80, height: 24, kittyKeyboard: true })
    try {
      await act(async () => { await view.waitForVisualIdle() })
      transport.snap.sessions[0]!.awaiting_approval = true
      await act(async () => { transport.emit({ Snapshot: transport.snap }); await view.waitForVisualIdle() })
      await act(async () => { view.mockInput.pressKey("N"); await view.mockInput.pasteBracketedText("swallowed") })
      expect(transport.requests.filter((r) => r.ApproveTool)).toEqual([{ ApproveTool: { approve: false, call_id: "call-1" } }])
      expect(transport.requests.some((r) => r.Paste || r.Menu)).toBe(false)
      await act(async () => { await view.waitForVisualIdle() })
      expect(view.captureCharFrame()).toContain("Approve (y)")
    } finally { await act(async () => { await view.dispose() }) }
  })
}

test("long Unicode and unbroken composer lines wrap and resize within the height cap", async () => {
  const transport = new Transport(snapshot())
  transport.snap.sessions[0]!.awaiting_approval = false
  transport.snap.global.command_palette = []
  transport.snap.global.input = "🐈 " + "unbroken".repeat(100)
  transport.snap.global.cursor = [...transport.snap.global.input].length
  const view = await testRender(screen(transport), { width: 50, height: 24 })
  try {
    for (let n = 0; n < 3; n++) await act(async () => { await view.waitForVisualIdle() })
    const area = view.renderer.currentFocusedRenderable as import("@opentui/core").TextareaRenderable
    expect(area.wrapMode).toBe("word")
    expect(area.editorView.getTotalVirtualLineCount()).toBeGreaterThan(10)
    expect(area.height).toBeLessThanOrEqual(10)
    const narrow = area.editorView.getTotalVirtualLineCount()
    await act(async () => { view.resize(160, 45); await view.waitForVisualIdle() })
    for (let n = 0; n < 3; n++) await act(async () => { await view.waitForVisualIdle() })
    expect(area.editorView.getTotalVirtualLineCount()).toBeLessThan(narrow)
    expect(area.plainText).toBe(transport.snap.global.input)
  } finally { await act(async () => { await view.dispose() }) }
})

test("transcript collapses expanded pastes without changing marker references", () => {
  expect(collapsePastedText('before <<<pasted_text n=4 path="pastes/4.txt">>>\nfull 🐈 body\n<<<end_pasted_text n=4>>> after [Image #4]')).toBe('before [Pasted Text #4] after [Image #4]')
})

test("export actual approval renders for review", () => {
  const path = process.env.KOMA_PREVIEW_PATH
  if (!path) return
  writeFileSync(path + ".approvals.html", `<!doctype html><meta charset="utf-8"><title>Approval renders</title><style>body{background:#222;color:white}pre{font-family:monospace;line-height:1.2;display:inline-block}</style>${previews.join("\n")}`)
  writeFileSync(path + ".approvals.txt", renderedFrames.join("\n\n"))
})

for (const action of ["open", "remove"]) test(`staged attachment ${action} controls stay clickable with long Unicode labels`, async () => {
  const transport = new Transport(snapshot())
  transport.snap.sessions[0]!.awaiting_approval = false
  transport.snap.global.command_palette = []
  transport.snap.global.input = "🐈 [Pasted Text #1]"
  transport.snap.global.cursor = [...transport.snap.global.input].length
  transport.snap.global.pending_attachments = [{kind:"pasted_text", marker_n:1, rel_path:"pastes/1.txt", label:"🐈 pasted content with a very long label".repeat(4)}]
  const view = await testRender(screen(transport), {width:50,height:24})
  try {
    for (let n=0;n<2;n++) await act(async()=>{await view.waitForVisualIdle()})
    const lines=view.captureCharFrame().split("\n")
    const y=lines.findIndex((line)=>line.includes("×"))
    expect(y).toBeGreaterThan(0)
    await act(async()=>{await view.mockMouse.click(action==="remove"?lines[y]!.indexOf("×"):lines[y]!.indexOf("pasted")+2,y);await new Promise((r)=>setTimeout(r,40))})
    if(action==="remove") expect(transport.requests).toContainEqual({RemoveAttachment:{marker_n:1,kind:"pasted_text"}})
    else {
      expect(transport.requests).toContainEqual({SendKey:{code:{Char:"e"},mods:4}})
      expect(transport.requests.some((r)=>r.ReplaceInputTracked?.cursor===2)).toBe(true)
    }
  } finally {await act(async()=>{await view.dispose()})}
})

test("clipboard image shortcut flushes once and rebases its marker onto newer text", async () => {
  const transport = new Transport(snapshot())
  transport.snap.sessions[0]!.awaiting_approval = false
  transport.snap.global.command_palette = []
  const view=await testRender(screen(transport),{width:80,height:24,kittyKeyboard:true})
  try {
    await act(async()=>{await view.waitForVisualIdle()})
    await act(async()=>{view.mockInput.pressKey("v",{ctrl:true});await new Promise((r)=>setTimeout(r,10))})
    expect(transport.requests.filter((r)=>r.SendKey)).toEqual([{SendKey:{code:{Char:"v"},mods:2}}])
    await act(async()=>{await view.mockInput.typeText(" newer")})
    await act(async()=>{transport.emit({Delta:{InputChanged:{text:"draft 🐈[Image #1]",cursor:17}}})})
    await act(async()=>{await view.waitForVisualIdle()})
    expect(view.captureCharFrame()).toContain("draft 🐈[Image #1] newer")
  }finally{await act(async()=>{await view.dispose()})}
})

test("composer paste replaces native selection and submission waits for the daemon insertion", async () => {
  const transport=new Transport(snapshot())
  transport.snap.sessions[0]!.awaiting_approval=false
  transport.snap.global.command_palette=[]
  const view=await testRender(screen(transport),{width:80,height:24,kittyKeyboard:true})
  try {
    await act(async()=>{await view.waitForVisualIdle()})
    await act(async()=>{const area=view.renderer.currentFocusedRenderable as import("@opentui/core").TextareaRenderable;area.setSelection(0,area.plainText.length);await view.mockInput.pasteBracketedText("replacement 🐈");view.mockInput.pressKey("RETURN");await new Promise((r)=>setTimeout(r,20))})
    expect(transport.requests.some((r)=>r.ReplaceInputTracked?.text==="")).toBe(true)
    expect(transport.requests.filter((r)=>r.Paste)).toEqual([{Paste:{text:"replacement 🐈"}}])
    expect(transport.requests.some((r)=>r.SendKey?.code==="Enter")).toBe(false)
    await act(async()=>{transport.emit({Delta:{InputChanged:{text:"replacement 🐈",cursor:13}}})})
    await act(async()=>{await new Promise((r)=>setTimeout(r,20));await view.waitForVisualIdle()})
    expect(transport.requests.filter((r)=>r.SendKey?.code==="Enter")).toHaveLength(1)
    expect(view.captureCharFrame()).toContain("replacement 🐈")
  }finally{await act(async()=>{await view.dispose()})}
})

for (const focused of [false, true]) test(`follow-up accent follows actual navigation focus / ${focused}`, async () => {
  const { Steers } = await import("./chat.tsx")
  const theme=themeFor("monokai")
  const session={...snapshot().sessions[0]!,pending_steer:["Queued follow-up"],pending_steer_attachments:[[{kind:"image",marker_n:2,rel_path:"not-rendered.png"}]]}
  const view=await testRender(<Steers session={session} theme={theme} selected={0} focused={focused}/>,{width:50,height:24})
  try {
    await act(async()=>{await view.waitForVisualIdle()})
    const span=view.captureSpans().lines.flatMap(l=>l.spans).find(s=>s.text.includes("Queued follow-up"))!
    expect(rgbToHex(span.fg)).toBe(focused ? theme.accent : theme.dim)
    expect(view.captureCharFrame()).toContain(focused ? "●" : "○")
  } finally {await act(async()=>{await view.dispose()})}
})
test("transcript attachments form a neutral wrapping pile with no image renderers",async()=>{
  const {AttachmentPile}=await import("./chat.tsx")
  const theme=themeFor("monokai")
  const attachments=Array.from({length:6},(_,i)=>({kind:"image",marker_n:i+1,rel_path:"/tmp/existing-or-missing.png",label:`Image #${i+1}`}))
  const view=await testRender(<AttachmentPile attachments={attachments} theme={theme}/>,{width:50,height:24})
  try {
    await act(async()=>{await view.waitForVisualIdle()})
    const frame=view.captureCharFrame(), rows=frame.split("\n")
    for(let i=1;i<=6;i++) expect(frame).toContain(`Image #${i}`)
    expect(rows.findIndex(l=>l.includes("Image #6"))).toBeGreaterThan(rows.findIndex(l=>l.includes("Image #1")))
    const visit=(node:any):boolean=>node.constructor.name.toLowerCase().includes("imagerenderable") || node.getChildren().some(visit)
    expect(visit(view.renderer.root)).toBe(false)
    for(const span of view.captureSpans().lines.flatMap(l=>l.spans).filter(s=>s.text.includes("Image #"))) expect(rgbToHex(span.fg)).toBe(theme.dim)
  } finally {await act(async()=>{await view.dispose()})}
})
