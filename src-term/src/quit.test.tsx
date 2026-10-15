import { expect, test } from "bun:test"
import { act, useMemo, type ReactNode } from "react"
import { rgbToHex, SyntaxStyle, TextareaRenderable, type Renderable } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { useRenderer } from "@opentui/react"
import { SessionScreen } from "./session.tsx"
import { decodeFrames, encodeFrame, fold } from "./protocol.ts"
import type { DaemonTransport } from "./transport.ts"
import { QuitScreen } from "./quit.tsx"
import { themeFor } from "./theme.ts"

for (const [width, height] of [[50, 24], [80, 18], [100, 40], [160, 45]]) {
  test(`quit confirmation uses compact shared styling and preserves actions at ${width}×${height}`, async () => {
    for (const scope of ["session", "hub"] as const) {
      const picked: number[] = []
      const theme = themeFor("dark")
      const view = await testRender(<box flexGrow={1} paddingLeft={2} paddingRight={2}><QuitScreen state={{ working: 2, total: 3, selected: 2 }} theme={theme} exiting={null} scope={scope} onPick={(index) => picked.push(index)} /></box>, { width, height })
      try {
        await act(async () => { await view.waitForVisualIdle() })
        const frame = view.captureCharFrame()
        expect(frame).not.toContain("Koma / Quit")
        expect(frame).toContain("╭─ Confirm exit")
        expect(frame).toContain("Do you want to quit?")
        expect(frame).not.toContain("[ quit ]")
        expect(frame).not.toContain("a quit was requested")
        expect(frame).toContain("Tab switch")
        const readable = frame.replace(/[│\s]+/g, " ")
        expect(readable).toContain(scope === "hub" ? "They will keep running." : "in-flight work will be lost.")
        expect(frame).toContain(scope === "hub" ? "Back to sessions" : "Back to chat")
        const lines = frame.split("\n")
        const bottom = lines.findIndex((line) => line.includes("╰"))
        expect(bottom).toBe(9)
        const spans = view.captureSpans().lines.flatMap((line) => line.spans)
        expect(spans.some((s) => s.text.includes("Cancel") && rgbToHex(s.fg).toLowerCase() === theme.accent)).toBe(true)
        expect(spans.some((s) => s.text.includes("(esc)") && rgbToHex(s.fg).toLowerCase() === theme.dim)).toBe(true)
        for (const label of ["Quit (k)", "Detach (d)", "Cancel (esc)"]) {
          const y = lines.findIndex((line) => line.includes(label))
          await act(async () => { await view.mockMouse.click(lines[y]!.indexOf(label) + 1, y) })
        }
        expect(picked).toEqual([0, 1, 2])
      } finally { await act(async () => { await view.dispose() }) }
    }
  })
}

test("exiting keeps the progress indicator and blocks additional quit actions", async () => {
  const picked: number[] = []
  const view = await testRender(<QuitScreen state={{ working: 0, total: 1, selected: 2 }} theme={themeFor("github dark")} exiting={0} onPick={(index) => picked.push(index)} />, { width: 80, height: 18 })
  try {
    await act(async () => { await view.waitForVisualIdle() })
    const frame = view.captureCharFrame()
    expect(frame).toContain("Quitting…")
    expect(frame).toContain("Quit session and stop current progress")
    expect(frame).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Quit/)
    const lines = frame.split("\n")
    const y = lines.findIndex((line) => line.includes("Cancel (esc)"))
    await act(async () => { await view.mockMouse.click(lines[y]!.indexOf("Cancel (esc)") + 1, y) })
    expect(picked).toEqual([])
  } finally { await act(async () => { await view.dispose() }) }
})

// Keep the real session input routing under test: the dialog must own keys and
// paste while the native composer remains mounted beneath it.
class QuitTransport implements DaemonTransport {
  readonly remote=true
  requests:any[]=[]
  receive:(bytes:Uint8Array)=>void=()=>{}
  snap=fold(null,{Snapshot:{foreground_id:"quit-test",sessions:[{id:"quit-test",name:"Keep session",messages:[]}],global:{mode:"Chat",input:"draft 🐈",cursor:7}}})!
  async open(_id:string,receive:(bytes:Uint8Array)=>void){this.receive=receive;this.emit({Hello:{version:"test"}})}
  emit(event:unknown){this.receive(encodeFrame({event}))}
  quit(approval=false){
    this.snap={...this.snap,sessions:this.snap.sessions.map(s=>({...s,awaiting_approval:approval,approval_reason:"Human decision required"})),global:{...this.snap.global,mode:{QuitConfirm:{working:0,total:1,selected:2}}}}
    this.emit({Snapshot:this.snap})
  }
  write(bytes:Uint8Array){
    for(const r of decodeFrames(bytes) as any[]){
      this.requests.push(r)
      if(r.Attach)queueMicrotask(()=>this.emit({Snapshot:this.snap}))
      if(r==="GetMenuCapabilities")queueMicrotask(()=>this.emit({MenuCapabilities:{version:1}}))
      if(r.ReplaceInputTracked){const v=r.ReplaceInputTracked;this.snap={...this.snap,global:{...this.snap.global,input:v.text,cursor:v.cursor}};queueMicrotask(()=>{this.emit({Snapshot:this.snap});this.emit({MenuResult:{request_id:v.request_id,error:null}})})}
      if(r.SendKey?.code==="Esc" && this.snap.global.mode && typeof this.snap.global.mode==="object" && "QuitConfirm" in this.snap.global.mode){this.snap={...this.snap,global:{...this.snap.global,mode:"Chat"}};queueMicrotask(()=>this.emit({Snapshot:this.snap}))}
    }
    return bytes.length
  }
  end(){}
}
function Styled({children}:{children:(style:SyntaxStyle)=>ReactNode}){
 const renderer=useRenderer(),style=useMemo(()=>SyntaxStyle.fromStyles({},renderer.nativeScene),[renderer])
 return children(style)
}
function screen(transport:QuitTransport,onExit=()=>{}){
 return <Styled>{style=><SessionScreen id="quit-test" transport={transport} syntaxStyle={style} onHome={()=>{}} onOpen={()=>{}} onExit={onExit} onRemote={()=>{}} onPalette={()=>{}}/>}</Styled>
}
function composer(node:Renderable):TextareaRenderable|undefined{
 if(node instanceof TextareaRenderable)return node
 for(const child of node.getChildren()){const result=composer(child);if(result)return result}
}
for(const [width,height] of [[50,24],[80,18],[100,40],[160,45]])test(`quit overlay keeps the native draft and selection, then Cancel restores editing / ${width}×${height}`,async()=>{
 const transport=new QuitTransport(),view=await testRender(screen(transport),{width,height})
 const settle=async()=>{for(let n=0;n<3;n++)await act(async()=>{await view.waitForVisualIdle()})}
 try{
  await settle();const area=composer(view.renderer.root)!;area.cursorOffset=5;area.setSelection(0,5)
  await act(async()=>{transport.quit()});await settle()
  const frame=view.captureCharFrame(),rows=frame.split("\n")
  expect(frame).toContain("Confirm exit");expect(frame).toContain("draft 🐈");expect(frame).toContain("[$]")
  expect(rows.findIndex(l=>l.includes("Confirm exit"))).toBeLessThan(rows.findIndex(l=>l.includes("[$]")))
  expect(composer(view.renderer.root)).toBe(area)
  await act(async()=>{await view.mockInput.pasteBracketedText("blocked paste");await view.mockInput.typeText("typing")});await settle()
  expect(area.plainText).toBe("draft 🐈")
  const lines=view.captureCharFrame().split("\n"),y=lines.findIndex(l=>l.includes("Cancel (esc)"))
  await act(async()=>{await view.mockMouse.click(lines[y]!.indexOf("Cancel (esc)")+1,y)});await settle()
  expect(view.captureCharFrame()).not.toContain("Confirm exit")
  expect(composer(view.renderer.root)).toBe(area);expect(area.getSelection()).toEqual({start:0,end:5})
  await act(async()=>{await view.mockInput.typeText("X")});await settle()
  expect(area.plainText).toBe("X 🐈")
 }finally{await act(async()=>{await view.dispose()})}
})
for(const [hotkey,quitting] of [["k",true],["d",false]] as const)test(`quit overlay preserves ${quitting?"Quit":"Detach"} commands and exiting lock`,async()=>{
 const transport=new QuitTransport();let exits=0
 const view=await testRender(screen(transport,()=>exits++),{width:80,height:24})
 const settle=async()=>{for(let n=0;n<3;n++)await act(async()=>{await view.waitForVisualIdle()})}
 try{
  await settle();await act(async()=>{transport.quit()});await settle();transport.requests=[]
  await act(async()=>{await view.mockInput.typeText(hotkey)});await settle()
  expect(exits).toBe(1);expect(transport.requests.filter(r=>r==="QuitDaemon")).toHaveLength(quitting?1:0)
  expect(transport.requests.filter(r=>r==="Detach")).toHaveLength(1)
  const count=transport.requests.length
  await act(async()=>{view.mockInput.pressEnter();await view.mockInput.typeText("k");await view.mockInput.pasteBracketedText("blocked")});await settle()
  expect(transport.requests).toHaveLength(count);expect(exits).toBe(1)
 }finally{await act(async()=>{await view.dispose()})}
})
test("quit confirmation takes precedence over approval and Cancel restores approval",async()=>{
 const transport=new QuitTransport(),view=await testRender(screen(transport),{width:80,height:24})
 const settle=async()=>{for(let n=0;n<3;n++)await act(async()=>{await view.waitForVisualIdle()})}
 try{
  await settle();await act(async()=>{transport.quit(true)});await settle()
  expect(view.captureCharFrame()).toContain("Confirm exit");expect(view.captureCharFrame()).not.toContain("Human decision required")
  await act(async()=>{await view.mockInput.typeText("y");view.mockInput.pressEscape();await Bun.sleep(80)});await settle()
  expect(transport.requests.some(r=>r.ApproveTool)).toBe(false)
  expect(view.captureCharFrame()).not.toContain("Confirm exit");expect(view.captureCharFrame()).toContain("Human decision required")
 }finally{await act(async()=>{await view.dispose()})}
})

test("a long draft leaves room for exit controls and the composer in a short terminal",async()=>{
 const transport=new QuitTransport(),draft="long draft 猫\n".repeat(20)
 transport.snap={...transport.snap,global:{...transport.snap.global,input:draft,cursor:0}}
 const view=await testRender(screen(transport),{width:80,height:18})
 const settle=async()=>{for(let n=0;n<3;n++)await act(async()=>{await view.waitForVisualIdle()})}
 try{
  await settle();const area=composer(view.renderer.root)!
  await act(async()=>{transport.quit()});await settle()
  const frame=view.captureCharFrame()
  expect(frame).toContain("Confirm exit");expect(frame).toContain("Cancel (esc)");expect(frame).toContain("[$]")
  expect(area.plainText).toBe(draft);expect(composer(view.renderer.root)).toBe(area)
 }finally{await act(async()=>{await view.dispose()})}
})
