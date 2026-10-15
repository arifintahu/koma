import { expect, test } from "bun:test"
import { act, useMemo } from "react"
import { SyntaxStyle } from "@opentui/core"
import { useRenderer } from "@opentui/react"
import { testRender } from "@opentui/react/test-utils"
import { Chat } from "./chat.tsx"
import { fold } from "./protocol.ts"
import { themeFor } from "./theme.ts"

test("shift+tab cycles the mode from the composer", async () => {
  const requests: unknown[] = []
  const theme = themeFor("dark")
  const snapshot = fold(null, { Snapshot: {
    foreground_id: "s",
    sessions: [{ id: "s", name: "S", messages: [] }],
    global: { mode: "Chat", palette: "dark", input: "", agent_mode: "auto" },
  } })!
  function Harness() {
    const renderer = useRenderer()
    const style = useMemo(() => SyntaxStyle.fromStyles({}, renderer.nativeScene), [renderer])
    return <Chat snap={snapshot} theme={theme} syntaxStyle={style} focused send={(request) => requests.push(request)} sendTracked={async () => "ack"} onFlushError={() => {}} />
  }
  const view = await testRender(<Harness />, { width: 80, height: 24, kittyKeyboard: true })
  try {
    await act(async () => { await view.waitForVisualIdle() })
    await act(async () => { view.mockInput.pressKey("TAB", { shift: true }); await new Promise((resolve) => setTimeout(resolve, 30)) })
    expect(requests).toContainEqual({ SendKey: { code: "BackTab", mods: 0 } })
  } finally {
    await act(async () => { await view.dispose() })
  }
})
