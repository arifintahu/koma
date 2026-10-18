import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { act, useEffect, useMemo } from "react"
import { SyntaxStyle } from "@opentui/core"
import { useRenderer } from "@opentui/react"
import { testRender } from "@opentui/react/test-utils"
import { RemoteScreen } from "./remote-screen.tsx"
import { themeFor } from "./theme.ts"

// An invalid executable fails before SSH can run on either Unix or Windows.
test("remote bootstrap suspends with Restart and Exit and restarts its helper", async () => {
  const directory = mkdtempSync(join(tmpdir(), "koma-remote-suspend-"))
  const first = join(directory, "first.exe"), second = join(directory, "second.exe")
  writeFileSync(first, "invalid executable"); writeFileSync(second, "invalid executable")
  const previous = process.env.KOMA_BIN
  process.env.KOMA_BIN = first
  const ctrlC = { current: () => {} }
  const remote = { target: "fixture@example.invalid", key: null, newSession: false, sessionId: "same-remote-session", hostId: null }
  let exits = 0, homes = 0
  function Harness() {
    const renderer = useRenderer()
    const style = useMemo(() => SyntaxStyle.fromStyles({}, renderer.nativeScene), [renderer])
    useEffect(() => () => style.destroy(), [style])
    return <RemoteScreen remote={remote} theme={themeFor("dark")} syntaxStyle={style} ctrlC={ctrlC} onExit={() => { exits++ }} onHome={() => { homes++ }} onRemote={() => {}} onPalette={() => {}} />
  }
  let view!: Awaited<ReturnType<typeof testRender>>
  try {
    await act(async () => { view = await testRender(<Harness />, { width: 80, height: 24, exitOnCtrlC: false }) })
    async function suspended() {
      for (let pass = 0; pass < 10; pass++) {
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); await view.waitForVisualIdle() })
        if (view.captureCharFrame().includes("Connection suspended")) return
      }
      throw new Error(view.captureCharFrame())
    }
    await suspended()
    expect(view.captureCharFrame()).toContain("Restart (r)")
    expect(view.captureCharFrame()).toContain("Exit (esc)")
    expect(view.captureCharFrame()).not.toContain("Back (esc)")
    process.env.KOMA_BIN = second
    await act(async () => { view.mockInput.pressEnter() })
    await suspended()
    expect(view.captureCharFrame().replace(/\s/g, "")).toContain("second.exe")
    const lines = view.captureCharFrame().split("\n"), y = lines.findIndex((line) => line.includes("Exit (esc)"))
    await act(async () => { await view.mockMouse.click(lines[y]!.indexOf("Exit") + 1, y) })
    expect(exits).toBe(1)
    expect(homes).toBe(0)
  } finally {
    if (view) await act(async () => { await view.dispose() })
    if (previous === undefined) delete process.env.KOMA_BIN
    else process.env.KOMA_BIN = previous
    rmSync(directory, { recursive: true, force: true })
  }
})
