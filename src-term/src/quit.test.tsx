import { expect, test } from "bun:test"
import { act } from "react"
import { rgbToHex } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { QuitScreen } from "./quit.tsx"
import { themeFor } from "./theme.ts"

for (const [width, height] of [[50, 24], [80, 18], [100, 40], [160, 45]]) {
  test(`quit confirmation uses compact shared styling and preserves actions at ${width}×${height}`, async () => {
    for (const scope of ["session", "hub"] as const) {
      const picked: number[] = []
      const theme = themeFor("dark")
      const view = await testRender(<box flexGrow={1} paddingLeft={2} paddingRight={2}><QuitScreen state={{ working: 2, total: 3, selected: 2 }} theme={theme} exiting={null} scope={scope} onPick={(index) => picked.push(index)} /></box>, { width, height })
      try {
        await act(async () => { await view.waitForVisualIdle() })
        const frame = view.captureCharFrame()
        expect(frame).toContain("Koma / Quit")
        expect(frame).toContain("╭─ Confirm exit")
        expect(frame).toContain("Do you want to quit?")
        expect(frame).not.toContain("[ quit ]")
        expect(frame).not.toContain("a quit was requested")
        expect(frame).toContain("Tab switch")
        const readable = frame.replace(/[│\s]+/g, " ")
        expect(readable).toContain(scope === "hub" ? "They will keep running." : "in-flight work will be lost.")
        expect(frame).toContain(scope === "hub" ? "Back to sessions" : "Back to chat")
        const lines = frame.split("\n")
        const bottom = lines.findIndex((line) => line.includes("╰"))
        expect(bottom).toBeLessThan(15)
        const spans = view.captureSpans().lines.flatMap((line) => line.spans)
        expect(spans.some((s) => s.text.includes("Cancel") && rgbToHex(s.fg).toLowerCase() === theme.accent)).toBe(true)
        expect(spans.some((s) => s.text.includes("(esc)") && rgbToHex(s.fg).toLowerCase() === theme.dim)).toBe(true)
        for (const label of ["Quit (k)", "Detach (d)", "Cancel (esc)"]) {
          const y = lines.findIndex((line) => line.includes(label))
          await act(async () => { await view.mockMouse.click(lines[y]!.indexOf(label) + 1, y) })
        }
        expect(picked).toEqual([0, 1, 2])
      } finally { await act(async () => { await view.dispose() }) }
    }
  })
}

test("exiting keeps the progress indicator and blocks additional quit actions", async () => {
  const picked: number[] = []
  const view = await testRender(<QuitScreen state={{ working: 0, total: 1, selected: 2 }} theme={themeFor("github dark")} exiting={0} onPick={(index) => picked.push(index)} />, { width: 80, height: 18 })
  try {
    await act(async () => { await view.waitForVisualIdle() })
    const frame = view.captureCharFrame()
    expect(frame).toContain("Quitting…")
    expect(frame).toContain("Quit session and stop current progress")
    expect(frame).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Quit/)
    const lines = frame.split("\n")
    const y = lines.findIndex((line) => line.includes("Cancel (esc)"))
    await act(async () => { await view.mockMouse.click(lines[y]!.indexOf("Cancel (esc)") + 1, y) })
    expect(picked).toEqual([])
  } finally { await act(async () => { await view.dispose() }) }
})
