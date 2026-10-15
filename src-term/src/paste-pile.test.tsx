import { expect, test } from "bun:test"
import { act, useMemo } from "react"
import { CodeRenderable, SyntaxStyle, rgbToHex, type Renderable } from "@opentui/core"
import { useRenderer } from "@opentui/react"
import { testRender } from "@opentui/react/test-utils"
import { Chat } from "./chat.tsx"
import { fold } from "./protocol.ts"
import { syntaxStyles } from "./syntax.ts"
import { themeFor } from "./theme.ts"

const fence = 'can you see the text?\n\n<<<pasted_text n=2 path="pastes/02-paste.txt">>>\nThe paragraph about println.\nSecond line of the paste.\nThird line that should stay folded.\n<<<end_pasted_text n=2>>>'

test("a pasted message keeps the reference and a wrapping chip, not the body", async () => {
  const theme = themeFor("dark")
  const snapshot = fold(null, { Snapshot: {
    foreground_id: "s",
    sessions: [{ id: "s", name: "Cyber-Tiel", messages: [{ role: "user", content: fence, attachments: [{ kind: "pasted_text", marker_n: 2, rel_path: "pastes/02-paste.txt", mime: "text/plain" }, { kind: "image", marker_n: 1, rel_path: "images/01.png", label: "Image #1" }] }] }],
    global: { mode: "Chat", palette: "dark", input: "" },
  } })!
  function Harness() {
    const renderer = useRenderer()
    const style = useMemo(() => SyntaxStyle.fromStyles(syntaxStyles(theme), renderer.nativeScene), [renderer])
    return <Chat snap={snapshot} theme={theme} syntaxStyle={style} focused send={() => {}} sendTracked={async () => "ack"} onFlushError={() => {}} />
  }
  const view = await testRender(<Harness />, { width: 72, height: 40 })
  try {
    await act(async () => { await view.waitForVisualIdle() })
    await act(async () => {
      const wait = async (node: Renderable): Promise<void> => {
        if (node instanceof CodeRenderable) await node.highlightingDone
        await Promise.all(node.getChildren().map(wait))
      }
      await wait(view.renderer.root)
      await view.waitForVisualIdle()
    })
    const frame = view.captureCharFrame()
    expect(frame).toContain("can you see the text?")
    expect(frame).toContain("[Pasted Text #2]")
    expect(frame).not.toContain("The paragraph about println.")
    expect(frame).not.toContain("Second line of the paste.")
    expect(frame).not.toContain("Third line")
    expect(frame).toContain("Pasted Text #2")
    expect(frame).toContain("Image #1")
    const marker = view.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.includes("[Pasted Text #2]"))
    expect(rgbToHex(marker!.fg)).toBe(theme.accent)
    const chips = view.captureCharFrame().split("\n").filter((line) => line.includes("Pasted Text #2") && line.includes("Image #1"))
    expect(chips.length).toBeGreaterThan(0)
  } finally {
    await act(async () => { await view.dispose() })
  }
})
