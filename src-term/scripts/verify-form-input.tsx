/** Live OpenTUI keyboard/pointer regression against an isolated daemon.
 * Build: cargo build -p agent; run: .tools/bun scripts/verify-form-input.tsx
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

const root=resolve(import.meta.dir,"../.."), data=mkdtempSync("/private/tmp/koma-forms-")
const id=crypto.randomUUID(), requests:string[]=[], frames:string[]=[]
const server=Bun.serve({port:0,fetch(req){requests.push(req.url);return Response.json({data:[{id:"offline-model",name:"Offline model"}]})}})
const providers=["first","second"].map((name)=>({uuid:name,name:name==="first"?"First provider":"Second provider with a long Unicode label 猫",endpoint:`http://127.0.0.1:${server.port}/${name}/v1`,api_key:"fixture-key"}))
writeFileSync(`${data}/config.json`,JSON.stringify({providers,models:[{uuid:"seed-model",name:"Offline model",model_id:"offline-model",provider_uuid:"first",roles:["main"]}]}))
const daemon=Bun.spawn([`${root}/target/debug/koma`,"--daemon","--session",id],{cwd:root,env:{...process.env,KOMA_TEST_DATA_DIR:data},stdout:"ignore",stderr:"pipe"})
class Transport implements DaemonTransport {
  readonly remote=true
  socket:Awaited<ReturnType<typeof Bun.connect>>|null=null
  snap:Snapshot|null=null
  reader=new FrameReader()
  snapshots=0
  pending=new Set<string>()
  async open(_id:string,receive:(bytes:Uint8Array)=>void,close:()=>void,error:(error:unknown)=>void) {
    const deadline=Date.now()+15000
    while(true) {
      try {
        this.socket=await Bun.connect({unix:`${data}/run/${id}.sock`,socket:{data:(_s,bytes)=>{
          for(const envelope of this.reader.push(bytes) as {event:any}[]) { this.snap=fold(this.snap,envelope.event); if(envelope.event?.MenuResult) this.pending.delete(envelope.event.MenuResult.request_id); if(envelope.event?.Snapshot) this.snapshots++ }
          receive(bytes)
        },close,error:(_s,e)=>error(e)}})
        return
      } catch(e) {if(Date.now()>deadline) throw e;await Bun.sleep(25)}
    }
  }
  write(bytes:Uint8Array){for(const r of decodeFrames(bytes) as any[]) if(r.Menu) this.pending.add(r.Menu.request_id); return this.socket?.write(bytes)??0}
  send(request:unknown){this.write(encodeFrame(request))}
  end(){this.socket?.end()}
}
const transport=new Transport()
function Screen(){
  const renderer=useRenderer(), style=useMemo(()=>SyntaxStyle.fromStyles(syntaxStyles(themeFor("dark")),renderer.nativeScene),[renderer])
  return <SessionScreen id={id} transport={transport} syntaxStyle={style} onHome={()=>{}} onOpen={()=>{}} onExit={()=>{}} onRemote={()=>{}} onPalette={()=>{}}/>
}
const view=await testRender(<Screen/>,{width:80,height:24})
const settings=()=> (transport.snap?.global.mode as any)?.Settings
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
async function select(group:string,index:number){transport.send({Menu:{request_id:crypto.randomUUID(),mode:"Settings",action:{Select:{group,index}}}});await sync()}
async function open(){transport.send({ReplaceInput:{text:"/settings",cursor:9}});transport.send({SendKey:{code:"Enter",mods:0}});await settle(()=>settings())}
try {
  await settle(()=>transport.snap?.global.mode==="Chat")
  await open();await select("general",9);await settle(()=>settings()?.field===9);await key("enter");await settle(()=>settings()?.search_editor)
  assert(settings().search_editor && !nativeMenuInput.current, JSON.stringify({page:settings().page,field:settings().field,focus:settings().quick_focus,editing:settings().editing,frame:view.captureCharFrame()}))
  await key("down");assert.equal(settings().search_editor.provider,"firecrawl");assert(!nativeMenuInput.current)
  await key("down");assert.equal(settings().search_editor.provider,"tavily");assert(!nativeMenuInput.current)
  await key("enter");await settle(()=>nativeMenuInput.current)
  await act(async()=>{await view.mockInput.pasteBracketedText("draft 猫😀")});await settle()
  assert.equal(nativeMenuInput.current?.plainText,"draft 猫😀")
  nativeMenuInput.current!.cursorOffset=3;nativeMenuInput.current!.setSelection(0,3)
  await key("escape");assert(!nativeMenuInput.current)
  await key("enter");assert.equal(nativeMenuInput.current?.plainText,"draft 猫😀")
  assert.deepEqual(nativeMenuInput.current?.getSelection(),{start:0,end:3})
  await act(async()=>{await view.mockInput.pasteBracketedText("key")});await settle()
  assert.equal(nativeMenuInput.current?.plainText,"keyft 猫😀")
  assert(!view.captureCharFrame().includes("keyft"))
  await click("Save search provider");await settle(()=>!settings().search_editor)
  assert.equal(JSON.parse(readFileSync(`${data}/config.json`,"utf8")).web_search.tavily_key,"keyft 猫😀")
  await key("enter");await key("enter");await settle(()=>nativeMenuInput.current)
  assert.equal(nativeMenuInput.current?.plainText,"")
  for(const [width,height] of [[50,24],[80,18],[100,40],[160,45]]){
    await act(async()=>{view.resize(width!,height!);await view.waitForVisualIdle()});await settle()
    const frame=view.captureCharFrame();assert(frame.includes("Save search provider"),frame);assert(frame.includes("Cancel"),frame);assert(frame.includes("Saved API key"),frame);frames.push(`saved key ${width}×${height}\n${frame}`)
  }
  await click("Save search provider");assert.equal(JSON.parse(readFileSync(`${data}/config.json`,"utf8")).web_search.tavily_key,"keyft 猫😀")
  await key("enter");await key("enter");await settle(()=>nativeMenuInput.current)
  await act(async()=>{await view.mockInput.typeText("discard me")});await settle()
  await click("Return to providers");await click("Firecrawl");assert.equal(nativeMenuInput.current?.plainText,"")
  await click("Cancel");assert(!settings().search_editor)
  await key("enter");await click("DuckDuckGo");assert(!nativeMenuInput.current)
  for(const [width,height] of [[50,24],[80,18],[100,40],[160,45]]){
    await act(async()=>{view.resize(width!,height!);await view.waitForVisualIdle()});await settle()
    const frame=view.captureCharFrame();assert(frame.includes("Save search provider"));assert(frame.includes("Cancel"));frames.push(`search ${width}×${height}\n${frame}`)
  }
  await click("Save search provider");assert.equal(settings().web_search.provider,"built_in")
  await select("page",3);await select("active",5);await key("enter");assert.equal(settings().page,"model_form");assert(!nativeMenuInput.current)
  await key("down");await key("enter");assert(settings().model_provider_cursor != null)
  const original=settings().model_modal.provider_idx
  await key("down");await key("escape");assert.equal(settings().model_modal.provider_idx,original)
  await key("enter");await click("Second provider");assert.equal(settings().model_provider_cursor,null)
  assert.equal(settings().model_provider_choices.find((p:any)=>p.index===settings().model_modal.provider_idx).id,"second")
  await settle(()=>requests.some(url=>url.includes("/second/v1/models")))
  for(const [width,height] of [[50,24],[80,18],[100,40],[160,45]]){
    await key("enter");await act(async()=>{view.resize(width!,height!);await view.waitForVisualIdle()});await settle()
    const frame=view.captureCharFrame();assert(frame.includes("Providers"));assert(frame.includes("Second provider"));assert(frame.includes("Name"));frames.push(`chooser ${width}×${height}\n${frame}`);await key("escape")
  }
  await key("up");await key("enter");assert(nativeMenuInput.current)
  nativeMenuInput.current!.setSelection(0,nativeMenuInput.current!.plainText.length)
  await act(async()=>{await view.mockInput.pasteBracketedText("Renamed 猫")});await settle()
  await key("escape");await key("enter");assert.equal(nativeMenuInput.current?.plainText,"Renamed 猫")
  await click("Save (enter)");await settle(()=>settings().page==="models")
  writeFileSync("/tmp/koma-form-frames.txt",frames.join("\n\n"))
  console.log("Live keyboard/pointer, masked drafts, selection paste, saved keys, provider cancellation/confirmation, catalogue refresh and four-size renders passed.")
} finally {
  await act(async()=>{await view.dispose()});transport.end();daemon.kill();await daemon.exited;server.stop(true);rmSync(data,{recursive:true,force:true})
}
