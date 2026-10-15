import { expect, test } from "bun:test"
import { act, useState } from "react"
import { testRender } from "@opentui/react/test-utils"
import { ModeSurface } from "./surface.tsx"
import { nativeMenuInput } from "./bits.tsx"
import { themeFor } from "../theme.ts"

const theme=themeFor("monokai")
const browsing = [
 {Settings:{page:"quick",search_editor:{provider:"tavily",key:"",editing:false}}},
 {Settings:{page:"provider_form",prov_modal:{name:"Provider",field:0}}},
 {Settings:{page:"model_form",model_modal:{name:"Model",field:0}}},
 {Agents:{mode:"create",field:"name"}},
 {Mcp:{mode:"create",field:"name",draft_transport:"stdio"}},
 {Remote:{sub:"manage:edit",editor:{focused:"name"}}},
 {KeyInput:{step:0,field:0,endpoint:"http://example.invalid"}},
]
for(const mode of browsing) test(`highlighted field does not claim native focus / ${JSON.stringify(mode)}`,async()=>{
 const view=await testRender(<ModeSurface mode={mode} theme={theme} columns={80} onMove={()=>{}} send={()=>{}}/>,{width:80,height:24})
 try {await act(async()=>{await view.waitForVisualIdle()});expect(nativeMenuInput.current).toBeNull()}
 finally {await act(async()=>{await view.dispose()})}
})
const cases:[string,(loading:boolean)=>unknown,string,string][]=[
 ["notifications",loading=>({Notifications:{loading,cursor:0,entries:[{id:"one",message:"Stable notification",severity:"info",timestamp:1}]}}),"Stable notification","Refreshing…"],
 ["models",loading=>({Settings:{page:"model_form",model_loading:loading,model_fields:["name","provider","model","role","save","cancel"],model_modal:{name:"Stable model",field:0}}}),"Stable model","Loading models…"],
 ["store",loading=>({ExtStore:{mode:"browse",loading,rows:[{id:"one",name:"Stable catalogue entry"}]}}),"Stable catalogue entry","Loading catalogue…"],
 ["extension",loading=>({ExtScreen:{waiting:loading,screen:{title:"Stable extension",body:[{t:"menu",items:[{id:"one",label:"Stable menu entry"}]}]}}}),"Stable menu entry","Loading…"],
]
for(const [width,height] of [[50,24],[80,18],[100,40],[160,45]]) for(const [name,mode,label,status] of cases) test(`transient ${name} status does not move content / ${width}×${height}`,async()=>{
 let toggle=()=>{}
 function Harness(){const [loading,setLoading]=useState(false);toggle=()=>setLoading(true);return <ModeSurface mode={mode(loading)} theme={theme} columns={width!} onMove={()=>{}} send={()=>{}}/>}
 const view=await testRender(<Harness/>,{width,height})
 try {
  await act(async()=>{await view.waitForVisualIdle()});const before=view.captureCharFrame().split("\n")
  await act(async()=>{toggle()});await act(async()=>{await view.waitForVisualIdle()});const after=view.captureCharFrame().split("\n")
  expect(before.findIndex(l=>l.includes(label))).toBeGreaterThanOrEqual(0)
  expect(after.findIndex(l=>l.includes(label))).toBe(before.findIndex(l=>l.includes(label)))
  expect(after.join("\n")).toContain(status)
 } finally {await act(async()=>{await view.dispose()})}
})

const editors = [
 {Settings:{page:"quick",search_editor:{provider:"tavily",key:"",editing:true}}},
 {Settings:{page:"provider_form",provider_editing:true,prov_modal:{name:"Provider",field:0}}},
 {Settings:{page:"model_form",model_editing:true,model_modal:{name:"Model",field:0}}},
 {Agents:{mode:"create",field:"name",editing:true}},
 {Mcp:{mode:"create",field:"name",draft_transport:"stdio",editing:true}},
 {Remote:{sub:"manage:edit",editing_field:true,editor:{focused:"name"}}},
 {KeyInput:{step:0,field:0,editing:true,endpoint:"http://example.invalid"}},
 {Help:{query:"",all:[]}},
 {SessionPicker:{query:"",all:[]}},
 {SessionHub:{focus_cooking:false,history_query:"",history:[]}},
]
for(const mode of editors) test(`native selection replacement and exactly-once paste / ${JSON.stringify(mode)}`,async()=>{
 const requests:any[]=[]
 const view=await testRender(<ModeSurface mode={mode} theme={theme} columns={80} onMove={()=>{}} send={r=>requests.push(r)}/>,{width:80,height:24})
 try {
  await act(async()=>{await view.waitForVisualIdle()});expect(nativeMenuInput.current).not.toBeNull()
  await act(async()=>{await view.mockInput.pasteBracketedText("first 😀")})
  await act(async()=>{view.mockInput.pressKey("a",{ctrl:true});await view.mockInput.pasteBracketedText("replacement 猫")})
  expect(nativeMenuInput.current?.plainText).toBe("replacement 猫")
  expect(requests.filter(r=>r.MenuReplace?.value==="replacement 猫")).toHaveLength(1)
  expect(requests.filter(r=>r.Paste)).toHaveLength(0)
 } finally {await act(async()=>{await view.dispose()})}
 expect(nativeMenuInput.current).toBeNull()
})

test("a new model provider invalidates the previous provider's native query draft",async()=>{
 let change=(phase:number)=>{}
 function Harness(){
  const [phase,setPhase]=useState(0);change=setPhase
  const editing=phase!==1
  return <ModeSurface mode={{Settings:{page:"model_form",model_editing:editing,model_fields:["name","provider","model","role","save","cancel"],model_modal:{field:editing?2:1,provider_idx:phase===2?1:0,query:"",model_id:""}}}} theme={theme} columns={80} onMove={()=>{}} send={()=>{}}/>
 }
 const view=await testRender(<Harness/>,{width:80,height:24})
 try {
  await act(async()=>{await view.waitForVisualIdle()})
  await act(async()=>{await view.mockInput.pasteBracketedText("old provider query")})
  expect(nativeMenuInput.current?.plainText).toBe("old provider query")
  await act(async()=>{change(1)});await act(async()=>{await view.waitForVisualIdle()})
  await act(async()=>{change(2)});await act(async()=>{await view.waitForVisualIdle()})
  expect(nativeMenuInput.current?.plainText).toBe("")
 } finally {await act(async()=>{await view.dispose()})}
})
