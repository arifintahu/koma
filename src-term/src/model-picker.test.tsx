import { expect, test } from "bun:test"
import { act, useState } from "react"
import { testRender } from "@opentui/react/test-utils"
import { ModeSurface } from "./modes/surface.tsx"
import { nativeMenuInput } from "./modes/bits.tsx"
import { themeFor } from "./theme.ts"

for(const [width,height] of [[50,24],[80,18],[100,40],[160,45]])test(`role picker and searchable models retain overlay controls / ${width}×${height}`,async()=>{
 const requests:any[]=[];let search=()=>{}
 function Harness(){
  const [model,setModel]=useState(false);search=()=>setModel(true)
  const body=model?{sub:"role_pick",role:"planner",query:"",options:[[null,"(inherit global)"],["a","Alpha — a @ local"],["b","Beta — b @ remote"]],filtered_indices:[2],cursor:0}:{sub:"roles",options:["main","awareness","planner","compactor","safeguard"].map(r=>[r,r]),cursor:2}
  return <ModeSurface mode={{Model:body}} theme={themeFor("dark")} columns={width!} onMove={()=>{}} send={r=>requests.push(r)}/>
 }
 const view=await testRender(<Harness/>,{width,height})
 try{
  await act(async()=>{await view.waitForVisualIdle()})
  const frame=view.captureCharFrame();for(const role of ["main","awareness","planner","compactor","safeguard"])expect(frame).toContain(role)
  expect(nativeMenuInput.current).toBeNull()
  const rows=frame.split("\n"),y=rows.findIndex(l=>l.includes("planner"))
  await act(async()=>{await view.mockMouse.click(rows[y]!.indexOf("planner")+1,y)})
  expect(requests).toContainEqual({MenuSelect:{group:"models",index:2,id:"planner"}})
  expect(requests).toContainEqual({SendKey:{code:"Enter",mods:0}})
  await act(async()=>{search()});await act(async()=>{await view.waitForVisualIdle()})
  expect(view.captureCharFrame()).toContain("Search models");expect(view.captureCharFrame()).toContain("Beta")
  expect(view.captureCharFrame()).not.toContain("Alpha")
  await act(async()=>{await view.mockInput.pasteBracketedText("猫😀")})
  expect(requests.filter(r=>r.MenuReplace?.value==="猫😀")).toHaveLength(1)
  const resultRows=view.captureCharFrame().split("\n"),resultY=resultRows.findIndex(l=>l.includes("Beta"))
  await act(async()=>{await view.mockMouse.click(resultRows[resultY]!.indexOf("Beta")+1,resultY)})
  expect(requests).toContainEqual({MenuSelect:{group:"models",index:2,id:"b"}})
 }finally{await act(async()=>{await view.dispose()})}
 expect(nativeMenuInput.current).toBeNull()
})
