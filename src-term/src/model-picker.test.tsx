import { expect, test } from "bun:test"
import { act, useState } from "react"
import { rgbToHex, type RGBA } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { ModeSurface } from "./modes/surface.tsx"
import { nativeMenuInput } from "./modes/bits.tsx"
import { themeFor } from "./theme.ts"

function spanAt(spans: { text: string; fg: RGBA }[], index: number) {
  let offset = 0
  for (const span of spans) {
    const end = offset + span.text.length
    if (offset <= index && end > index) return span
    offset = end
  }
  throw new Error(`no span at ${index}`)
}

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

for (const width of [50, 80]) test(`model role list shows provider, oauth, and model in the top right / ${width}`, async () => {
  const theme = themeFor("dark")
  const requests: unknown[] = []
  const roles = { Model: { sub: "roles", options: ["main", "awareness", "planner", "compactor", "safeguard"].map((role) => [role, role]), cursor: 0 } }
  const view = await testRender(<ModeSurface mode={roles} theme={theme} columns={width} onMove={() => {}} send={(request) => requests.push(request)} />, { width, height: 18 })
  try {
    await act(async () => { await view.waitForVisualIdle() })
    const lines = view.captureCharFrame().split("\n")
    const y = lines.findIndex((line) => line.includes("╭") && line.includes("provider"))
    const line = lines[y]!
    expect(line).toContain("model · roles")
    expect(line).toContain("provider · oauth · model")
    expect(line.indexOf("provider")).toBeGreaterThan(line.indexOf("roles"))
    expect(lines[y + 9]).toContain("╰")
    const spans = view.captureSpans().lines.find((row) => row.spans.map((span) => span.text).join("").includes("provider · oauth"))!.spans
    const text = spans.map((span) => span.text).join("")
    for (const word of ["provider", "oauth", "model"]) {
      const at = text.lastIndexOf(word)
      expect(rgbToHex(spanAt(spans, at).fg).toLowerCase()).toBe(theme.accent)
      expect(rgbToHex(spanAt(spans, at + 1).fg).toLowerCase()).toBe(theme.dim)
    }
    const dot = text.indexOf("·", text.indexOf("provider"))
    expect(rgbToHex(spanAt(spans, dot).fg).toLowerCase()).toBe(theme.dim)
    await act(async () => { await view.mockMouse.click(line.indexOf("oauth"), y) })
    expect(requests).toContainEqual({ SendKey: { code: { Char: "o" }, mods: 0 } })
  } finally { await act(async () => { await view.dispose() }) }
})

test("model search hides the settings shortcuts", async () => {
  const view = await testRender(<ModeSurface mode={{ Model: { sub: "role_pick", role: "planner", query: "", options: [[null, "(inherit global)"]], cursor: 0 } }} theme={themeFor("dark")} columns={80} onMove={() => {}} send={() => {}} />, { width: 80, height: 18 })
  try {
    await act(async () => { await view.waitForVisualIdle() })
    const frame = view.captureCharFrame()
    expect(frame).toContain("Search models")
    expect(frame).not.toContain("provider · oauth · model")
  } finally { await act(async () => { await view.dispose() }) }
})
