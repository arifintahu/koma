import { expect, test } from "bun:test"
import { act } from "react"
import { testRender } from "@opentui/react/test-utils"
import { ModeSurface } from "./surface.tsx"
import { themeFor } from "../theme.ts"

for (const [width, height] of [[50,24],[80,18],[100,40],[160,45]]) {
  test(`notification severity, full details and controls are bounded at ${width}×${height}`, async () => {
    const entries = Array.from({length: 30}, (_, n) => ({id: String(n), timestamp: 1720000000000, severity: n % 2 ? "error" : "info", source: "fixture", read: n !== 29, message: `Notice ${n}\n` + "Full detail text\n".repeat(80)}))
    const requests: any[] = []
    const view = await testRender(<ModeSurface mode={{Notifications:{app:false, query:"Notice", severity:"error", cursor:14, expanded:"29", entries}}} theme={themeFor("dark")} columns={width!} onMove={() => {}} send={(r) => requests.push(r)} />, {width,height})
    try {
      for (let n=0;n<3;n++) await act(async () => { await view.waitForVisualIdle() })
      const frame = view.captureCharFrame()
      expect(frame).toContain("Severity: error")
      expect(frame).toContain("1 unread")
      expect(frame).not.toContain("Notice 28")
      expect(frame).toContain("Details / read")
      expect(frame).toContain("Back (esc)")
      expect(frame.split("\n").length).toBeLessThanOrEqual(height!+1)
      const lines=frame.split("\n")
      const y=lines.findIndex((line)=>line.includes("Severity: error"))
      await act(async()=>{await view.mockMouse.click(lines[y]!.indexOf("Severity:")+2,y)})
      expect(requests).toContainEqual({SendKey:{code:{Char:"f"},mods:2}})
    } finally {await act(async()=>{await view.dispose()})}
  })
}
