import { expect, spyOn, test } from "bun:test"
import { act, useState } from "react"
import { testRender } from "@opentui/react/test-utils"
import { QuitScreen } from "./quit.tsx"
import { Hub } from "./hub.tsx"
import { nativeMenuInput } from "./modes/bits.tsx"
import * as paths from "./paths.ts"
import { themeFor } from "./theme.ts"

test("Sessions tabs show one pane and retain selection and History search", async () => {
  const list = spyOn(paths, "listSessions").mockResolvedValue({
    live: [{ session_id: "live-fixture", name: "Active fixture", pwd: "/tmp", working: false }],
    history: [{ session_id: "history-fixture", name: "Saved fixture", pwd: "/tmp", dir_label: "tmp", updated_at: 1 }],
  })
  try {
    for (const [width, height] of [[50, 24], [160, 45]]) {
      const view = await testRender(<Hub theme={themeFor("dark")} onOpen={() => {}} />, { width, height })
      const settle = async () => {
        for (let pass = 0; pass < 4; pass++) await act(async () => { await view.waitForVisualIdle() })
      }
      try {
        await settle()
        expect(view.captureCharFrame()).toContain("Active fixture")
        expect(view.captureCharFrame()).not.toContain("Saved fixture")
        expect(view.captureCharFrame()).not.toContain("Search sessions")
        await act(async () => { view.mockInput.pressArrow("down"); view.mockInput.pressTab() })
        await settle()
        expect(view.captureCharFrame()).toContain("Saved fixture")
        expect(view.captureCharFrame()).toContain("Search sessions")
        expect(view.captureCharFrame()).not.toContain("Active fixture")
        const lines = view.captureCharFrame().split("\n")
        const y = lines.findIndex((line) => line.includes("Cooking (c)"))
        await act(async () => { await view.mockMouse.click(lines[y]!.indexOf("Cooking (c)") + 2, y) })
        await settle()
        expect(view.captureCharFrame()).toContain("› Active fixture")
        expect(view.captureCharFrame()).not.toContain("Saved fixture")
        await act(async () => { view.mockInput.pressTab() })
        await settle()
        await act(async () => { await view.mockInput.typeText("Saved") })
        await settle()
        await act(async () => { view.mockInput.pressTab() })
        await settle()
        await act(async () => { view.mockInput.pressTab() })
        await settle()
        expect(view.captureCharFrame()).toContain("Saved fixture")
        expect(view.captureCharFrame()).toContain("Saved")
        expect(nativeMenuInput.current?.plainText).toBe("Saved")
      } finally { await act(async () => { await view.dispose() }) }
    }
  } finally { list.mockRestore() }
})

for(const [width,height] of [[50,24],[80,18]])test(`hub exit overlay suspends underlying controls and preserves selection / ${width}×${height}`,async()=>{
 const list=spyOn(paths,"listSessions").mockResolvedValue({live:[{session_id:"live-fixture",name:"Active fixture",pwd:"/tmp",working:false}],history:[]})
 const opened:string[]=[];let show=()=>{}
 function Harness(){const [confirm,setConfirm]=useState(false);show=()=>setConfirm(true);return <Hub theme={themeFor("dark")} onOpen={id=>opened.push(id)} overlay={confirm?<QuitScreen scope="hub" state={{working:1,total:1,selected:2}} theme={themeFor("dark")} exiting={null} onPick={i=>{if(i===2)setConfirm(false)}}/>:null}/>}
 const view=await testRender(<Harness/>,{width,height})
 const settle=async()=>{for(let n=0;n<3;n++)await act(async()=>{await view.waitForVisualIdle()})}
 try{
  await settle();await act(async()=>{view.mockInput.pressArrow("down")});await settle()
  await act(async()=>{show()});await settle()
  expect(view.captureCharFrame()).toContain("Confirm exit");expect(view.captureCharFrame()).toContain("Koma / Sessions")
  await act(async()=>{view.mockInput.pressEnter();view.mockInput.pressTab()});await settle();expect(opened).toEqual([])
  const lines=view.captureCharFrame().split("\n"),y=lines.findIndex(l=>l.includes("Cancel (esc)"))
  await act(async()=>{await view.mockMouse.click(lines[y]!.indexOf("Cancel (esc)")+1,y)});await settle()
  expect(view.captureCharFrame()).toContain("› Active fixture")
  await act(async()=>{view.mockInput.pressEnter()});await settle();expect(opened).toEqual(["live-fixture"])
 }finally{await act(async()=>{await view.dispose()});list.mockRestore()}
})
