import { expect, spyOn, test } from "bun:test"
import { act } from "react"
import { testRender } from "@opentui/react/test-utils"
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
