import { expect, test } from "bun:test"
import { act } from "react"
import { testRender } from "@opentui/react/test-utils"
import { SuspendedScreen } from "./suspended.tsx"
import { themeFor } from "./theme.ts"

for (const [width, height] of [[50, 24], [80, 18], [100, 40]]) {
  for (const action of ["restart", "exit", "ctrl+c", "selected-exit"]) test(`suspended screen has two working options / ${width}×${height} / ${action}`, async () => {
    let restarts = 0, exits = 0
    const view = await testRender(<SuspendedScreen error="Original connection error" theme={themeFor("dark")} onRestart={() => { restarts++ }} onExit={() => { exits++ }} />, { width, height, exitOnCtrlC: false })
    try {
      await act(async () => { await view.waitForVisualIdle() })
      const frame = view.captureCharFrame()
      expect(frame).toContain("Connection suspended")
      expect(frame).toContain("Original connection error")
      expect(frame.match(/Restart \(r\)/g)).toHaveLength(1)
      expect(frame.match(/Exit \(esc\)/g)).toHaveLength(1)
      expect(frame).not.toContain("[$]")
      await act(async () => {
        if (action === "ctrl+c") view.mockInput.pressCtrlC()
        else if (action === "selected-exit") { view.mockInput.pressTab(); await new Promise((resolve) => setTimeout(resolve, 20)) }
        else {
          const label = action === "restart" ? "Restart" : "Exit"
          const lines = frame.split("\n"), y = lines.findIndex((line) => line.includes(`${label} (`))
          await view.mockMouse.click(lines[y]!.indexOf(label) + 1, y)
        }
        await new Promise((resolve) => setTimeout(resolve, 20))
      })
      if (action === "selected-exit") await act(async () => { view.mockInput.pressEnter(); await new Promise((resolve) => setTimeout(resolve, 20)) })
      expect(restarts).toBe(action === "restart" ? 1 : 0)
      expect(exits).toBe(action === "restart" ? 0 : 1)
    } finally { await act(async () => { await view.dispose() }) }
  })
}

test("a long connection error keeps both suspended actions visible", async () => {
  const view = await testRender(<SuspendedScreen error={"SSH failed: connection refused.\n".repeat(100)} theme={themeFor("dark")} onRestart={() => {}} onExit={() => {}} />, { width: 50, height: 18, exitOnCtrlC: false })
  try {
    await act(async () => { await view.waitForVisualIdle() })
    const frame = view.captureCharFrame()
    expect(frame).toContain("Connection suspended")
    expect(frame).toContain("Restart (r)")
    expect(frame).toContain("Exit (esc)")
  } finally { await act(async () => { await view.dispose() }) }
})
