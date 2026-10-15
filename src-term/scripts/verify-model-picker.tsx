/** Live OpenTUI keyboard/pointer regression against an isolated daemon.
 * Build: cargo build -p agent; run: .tools/bun scripts/verify-model-picker.tsx
 */
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { resolve } from "node:path"
import { act, useMemo } from "react"
import { useRenderer } from "@opentui/react"
import { SyntaxStyle } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { SessionScreen } from "../src/session.tsx"
import { FrameReader, fold, encodeFrame, decodeFrames, type Snapshot } from "../src/protocol.ts"
import type { DaemonTransport } from "../src/transport.ts"
import { nativeMenuInput } from "../src/modes/bits.tsx"
import { syntaxStyles } from "../src/syntax.ts"
import { themeFor } from "../src/theme.ts"

const root=resolve(import.meta.dir,"../.."), data=mkdtempSync("/private/tmp/koma-models-")
const id=crypto.randomUUID(), requests:string[]=[], frames:string[]=[]
const server=Bun.serve({port:0,fetch(req){requests.push(req.url);return Response.json({data:[{id:"offline-model",name:"Offline model"}]})}})
const providers=["first","second"].map((name)=>({uuid:name,name:name==="first"?"First provider":"Second provider with a long Unicode label 猫",endpoint:`http://127.0.0.1:${server.port}/${name}/v1`,api_key:"fixture-key"}))
writeFileSync(`${data}/config.json`,JSON.stringify({providers,models:[{uuid:"seed-model",name:"Offline model",model_id:"offline-model",provider_uuid:"first",roles:["main"]},{uuid:"beta",name:"Beta model",model_id:"beta-model",provider_uuid:"second",roles:[]}]}))
const daemon=Bun.spawn([`${root}/target/debug/koma`,"--daemon","--session",id],{cwd:root,env:{...process.env,KOMA_TEST_DATA_DIR:data},stdout:"ignore",stderr:"pipe"})
class Transport implements DaemonTransport {
  readonly remote=true
  socket:Awaited<ReturnType<typeof Bun.connect>>|null=null
  snap:Snapshot|null=null
  reader=new FrameReader()
  snapshots=0
  pending=new Set<string>()
  outgoing:any[]=[]
  errors:string[]=[]
  async open(_id:string,receive:(bytes:Uint8Array)=>void,close:()=>void,error:(error:unknown)=>void) {
    const deadline=Date.now()+15000
    while(true) {
      try {
        this.socket=await Bun.connect({unix:`${data}/run/${id}.sock`,socket:{data:(_s,bytes)=>{
          for(const envelope of this.reader.push(bytes) as {event:any}[]) { this.snap=fold(this.snap,envelope.event); if(envelope.event?.MenuResult) {this.pending.delete(envelope.event.MenuResult.request_id);if(envelope.event.MenuResult.error)this.errors.push(envelope.event.MenuResult.error)} if(envelope.event?.Snapshot) this.snapshots++ }
          receive(bytes)
        },close,error:(_s,e)=>error(e)}})
        return
      } catch(e) {if(Date.now()>deadline) throw e;await Bun.sleep(25)}
    }
  }
  write(bytes:Uint8Array){for(const r of decodeFrames(bytes) as any[]) {this.outgoing.push(r);if(r.Menu)this.pending.add(r.Menu.request_id)} return this.socket?.write(bytes)??0}
  send(request:unknown){this.write(encodeFrame(request))}
  end(){this.socket?.end()}
}
const transport=new Transport()
function Screen(){
  const renderer=useRenderer(), style=useMemo(()=>SyntaxStyle.fromStyles(syntaxStyles(themeFor("dark")),renderer.nativeScene),[renderer])
  return <SessionScreen id={id} transport={transport} syntaxStyle={style} onHome={()=>{}} onOpen={()=>{}} onExit={()=>{}} onRemote={()=>{}} onPalette={()=>{}}/>
}
const view=await testRender(<Screen/>,{width:80,height:24})
const model=()=> (transport.snap?.global.mode as any)?.Model
async function settle(predicate:()=>unknown=()=>true){
  const deadline=Date.now()+10000
  do {await act(async()=>{await Bun.sleep(20);await view.waitForVisualIdle()});if(predicate())return}while(Date.now()<deadline)
  throw Error(`Timed out\n${view.captureCharFrame()}`)
}
async function sync(){await settle(()=>transport.pending.size===0);const before=transport.snapshots;transport.send("Resync");await settle(()=>transport.snapshots>before)}
async function key(name:"enter"|"escape"|"down"|"up"|"tab"){
  await act(async()=>{if(name==="enter")view.mockInput.pressEnter();else if(name==="escape")view.mockInput.pressEscape();else if(name==="tab")view.mockInput.pressTab();else view.mockInput.pressArrow(name); await Bun.sleep(80)})
  await sync()
}
async function click(label:string){
  const lines=view.captureCharFrame().split("\n"),y=lines.findIndex(l=>l.includes(label))
  assert(y>=0,`${label} missing\n${lines.join("\n")}`)
  await act(async()=>{await view.mockMouse.click(lines[y]!.indexOf(label)+1,y)})
  await sync()
}
async function open(command="/model"){
 transport.send({ReplaceInput:{text:command,cursor:command.length}});transport.send({SendKey:{code:"Enter",mods:0}});await settle(()=>model())
}
async function query(value:string){await act(async()=>{view.mockInput.pressKey("a",{ctrl:true});await view.mockInput.pasteBracketedText(value)});await sync();assert.equal(model().query,value)}
try {
 await settle(()=>transport.snap?.global.mode==="Chat")
 // Offline fixtures can produce an awareness notice during warmup; dismiss it
 // before measuring the picker plus composer in an 18-row viewport.
 if(view.captureCharFrame().includes("[x]"))await click("[x]")
 await open();assert.equal(model().sub,"roles");assert.equal(model().options.length,5);assert(!nativeMenuInput.current)
 await key("down");await key("enter");assert.equal(model().role,"awareness");assert(model().from_roles);assert(nativeMenuInput.current)
 await key("escape");assert.equal(model().sub,"roles")
 await click("planner");assert.equal(model().role,"planner");assert(nativeMenuInput.current)
 await query("Beta");assert.deepEqual(model().filtered_indices,[2]);assert.equal(nativeMenuInput.current?.plainText,"Beta")
 assert.equal(transport.outgoing.filter(r=>r.Menu?.action?.Replace?.value==="Beta").length,1)
 for(const [width,height] of [[50,24],[80,18],[100,40],[160,45]]){
  await act(async()=>{view.resize(width!,height!);await view.waitForVisualIdle()});await settle()
  if(view.captureCharFrame().includes("[x]"))await click("[x]")
  const frame=view.captureCharFrame();assert(frame.includes("Search models"),frame);assert(frame.includes("Beta model"),frame);assert(!frame.includes("Offline model"),frame);assert(frame.includes("[$]"),frame);frames.push(`${width}×${height}\n${frame}`)
 }
 await click("Beta model");assert.equal(transport.snap?.global.mode,"Chat")
 assert(transport.snap?.global.toast?.[1]?.includes("planner: beta-model"))
 await open("/model main");assert.equal(model().role,"main");assert(!model().from_roles)
 await query("nothing matches this");assert.deepEqual(model().filtered_indices,[])
 await key("enter");assert.equal(model().sub,"role_pick");assert.equal(model().query,"nothing matches this")
 await query("second Beta");assert.equal(model().options[model().filtered_indices[0]][0],"beta")
 await key("escape");assert.equal(transport.snap?.global.mode,"Chat")
 await open("/model safeguard");assert.equal(model().role,"safeguard");await key("escape")
 await open("/model help");assert.equal(model().sub,"help");assert(!nativeMenuInput.current);await key("escape")
 assert.deepEqual(transport.errors,[])
 writeFileSync("/tmp/koma-model-picker-frames.txt",frames.join("\n\n"))
 console.log("PASS: live five-role picker, direct shortcuts, searchable native input, exactly-once paste, stable filtered selection, saved role swap, empty results, Esc/back/help, and all four sizes")
} finally {
 await act(async()=>{await view.dispose()});transport.end();daemon.kill();await daemon.exited;server.stop(true);rmSync(data,{recursive:true,force:true})
}
