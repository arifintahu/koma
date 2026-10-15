import { expect, test } from "bun:test"
import { act, useMemo } from "react"
import { SyntaxStyle } from "@opentui/core"
import { useRenderer } from "@opentui/react"
import { testRender } from "@opentui/react/test-utils"
import { Chat } from "./chat.tsx"
import { fold } from "./protocol.ts"
import { themeFor } from "./theme.ts"

test("the prompt mark sits against the composer border", async () => {
  const theme = themeFor("dark")
  const snapshot = fold(null, { Snapshot: {
    foreground_id: "pad",
    sessions: [{ id: "pad", name: "Pad", cwd: "/tmp", messages: [] }],
    global: { mode: "Chat", palette: "dark", input: "asd\nalk" },
  } })!
  function Harness() {
    const renderer = useRenderer()
    const style = useMemo(() => SyntaxStyle.fromStyles({}, renderer.nativeScene), [renderer])
    return <Chat snap={snapshot} theme={theme} syntaxStyle={style} focused send={() => {}} sendTracked={async () => "ack"} onFlushError={() => {}} />
  }
  const view = await testRender(<Harness />, { width: 40, height: 16 })
  try {
    await act(async () => { await view.waitForVisualIdle() })
    const frame = view.captureCharFrame()
    const line = frame.split("\n").find((row) => row.includes("[$]"))
    expect(line).toBeDefined()
    expect(line).toContain("│[$]")
  } finally {
    await act(async () => { await view.dispose() })
  }
})
