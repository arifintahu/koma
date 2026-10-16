import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "bun:test"
import { act, useMemo, type ReactNode } from "react"
import { useRenderer } from "@opentui/react"
import { SyntaxStyle } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { Chat } from "./chat.tsx"
import { ModeSurface } from "./modes/surface.tsx"
import { SubagentPanel } from "./modes/subagents.tsx"
import { QuitScreen } from "./quit.tsx"
import { fold } from "./protocol.ts"
import { themeFor } from "./theme.ts"
import { writeFileSync } from "node:fs"

const menuModes = [
 {Effort:{options:["default","xhigh","high","medium","low"],selected:1,note:"Reasoning stays on"}},
 {Model:{sub:"choose",options:["First model","Second model"],cursor:1}},
 {Bash:{jobs:[],selected:0}}, {Todo:{items:[],selected:0}},
 {Skill:{all:[{name:"Skill fixture"}],selected:0}},
 {Attachments:{items:[{kind:"image",marker_n:1,rel_path:"image.png"}],selected:0}},
 {Settings:{page:"menu"}}, {Extensions:{mode:"use",rows:[],list_sel:0}},
]
const cases = ["commands","files","approval","rewind","subagents","quit", ...menuModes.map(m=>Object.keys(m)[0]!)]
const frames:string[]=[]
for(const [width,height] of [[50,24],[80,18],[100,40],[160,45]])for(const name of cases)test(`shared overlay sits between metadata and composer / ${name} / ${width}×${height}`,async()=>{
 const theme=themeFor("dark")
 const snap=fold(null,{Snapshot:{foreground_id:"order",sessions:[{id:"order",name:"Draft session",messages:[],awaiting_approval:name==="approval",pending_tool_calls:[{id:"call",function:{name:"write",arguments:"{}"}}]}],global:{mode:"Chat",current_version:"0.4.5",input:"preserved draft",cursor:15,command_palette:name==="commands"?[{name:"/help",desc:"Help"}]:[],file_palette:name==="files"?["src/example.ts"]:[]}}})!
 const send=()=>{}
 function Harness(){
  const renderer=useRenderer(),style=useMemo(()=>SyntaxStyle.fromStyles({},renderer.nativeScene),[renderer])
  const mode=menuModes.find(m=>Object.keys(m)[0]===name)
  let overlay:ReactNode=mode?<ModeSurface mode={mode} theme={theme} columns={width!} onMove={()=>{}} send={send}/>:null
  if(name==="subagents")overlay=<SubagentPanel agents={[]} pending={[]} selected={0} theme={theme} wide={width!>=80} onMove={()=>{}}/>
  return <Chat snap={snap} theme={theme} syntaxStyle={style} focused={false} send={send} sendTracked={async()=>"ack"} onFlushError={()=>{}} overlay={overlay} rewind={name==="rewind"?{entries:["Earlier message"],selected:0}:null} modalOverlay={name==="quit"?<QuitScreen state={{working:0,total:1,selected:2}} theme={theme} exiting={null} onPick={()=>{}}/>:null}/>
 }
 const view=await testRender(<Harness/>,{width,height})
 try{
  for(let n=0;n<3;n++)await act(async()=>{await view.waitForVisualIdle()})
  const frame=view.captureCharFrame(),rows=frame.split("\n")
  const metadata=rows.findIndex(l=>l.includes("Koma 0.4.5")),composer=rows.findIndex(l=>l.includes("[$]"))-1
  const top=rows.findIndex((l,i)=>i>metadata&&l.includes("╭"))
  const bottom=rows.findLastIndex((l,i)=>i<composer&&l.includes("╰"))
  expect(metadata).toBeGreaterThanOrEqual(0)
  expect(top).toBe(metadata+2)
  expect(bottom).toBe(composer-1)
  expect(composer).toBeGreaterThan(top)
  expect(frame).toContain("preserved draft")
  if(name==="commands"||name==="quit")frames.push(`${name} ${width}×${height}\n${frame}`)
 }finally{await act(async()=>{await view.dispose()})}
})
test("capture overlay order renders",()=>{writeFileSync(join(tmpdir(), "koma-overlay-order-frames.txt"),frames.join("\n\n"))})
