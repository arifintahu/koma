import { expect, test } from "bun:test"
import { act, useEffect, useState } from "react"
import { testRender } from "@opentui/react/test-utils"
import { themeFor } from "./theme.ts"
import { Toast } from "./toast.tsx"

const theme = themeFor("dark")

test("notification countdown expires despite fresh payloads and callbacks", async () => {
  let dismissed = 0
  function Harness() {
    const [, refresh] = useState(0)
    useEffect(() => {
      const timer = setInterval(() => refresh((n) => n + 1), 50)
      return () => clearInterval(timer)
    }, [])
    const payload = ["info", "copied the transcript"]
    return <Toast id="copy-event" kind={payload[0]!} text={payload[1]!} theme={theme} onDismiss={() => { dismissed++ }} />
  }
  const view = await testRender(<Harness />, { width: 50, height: 6 })
  const advance = async (ms: number) => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)) })
    await act(async () => { await view.waitForVisualIdle() })
  }
  try {
    await act(async () => { await view.waitForVisualIdle() })
    expect(view.captureCharFrame()).toContain("3s [x]")
    await advance(1200)
    expect(view.captureCharFrame()).toContain("2s [x]")
    await advance(1000)
    expect(view.captureCharFrame()).toContain("1s [x]")
    await advance(1000)
    expect(view.captureCharFrame()).not.toContain("copied the transcript")
    expect(dismissed).toBe(1)
  } finally { await act(async () => { await view.dispose() }) }
})

test("clicking [x] dismisses immediately and an identical new event can appear", async () => {
  let dismissed = 0
  let notify = () => {}
  let refresh = () => {}
  function Harness() {
    const [id, setId] = useState(0)
    const [, setRefresh] = useState(0)
    notify = () => setId((n) => n + 1)
    refresh = () => setRefresh((n) => n + 1)
    return <Toast key={id} id={String(id)} kind="error" text="Connection interrupted" theme={theme} onDismiss={() => { dismissed++ }} />
  }
  const view = await testRender(<Harness />, { width: 50, height: 6 })
  try {
    await act(async () => { await view.waitForVisualIdle() })
    const lines = view.captureCharFrame().split("\n")
    const y = lines.findIndex((line) => line.includes("[x]"))
    await act(async () => { await view.mockMouse.click(lines[y]!.indexOf("[x]") + 1, y) })
    expect(dismissed).toBe(1)
    await act(async () => { await view.waitForVisualIdle() })
    expect(view.captureCharFrame()).not.toContain("Connection interrupted")
    await act(async () => { refresh(); await view.waitForVisualIdle() })
    expect(view.captureCharFrame()).not.toContain("Connection interrupted")
    await act(async () => { notify(); await view.waitForVisualIdle() })
    await act(async () => { await view.waitForVisualIdle() })
    expect(view.captureCharFrame()).toContain("Connection interrupted")
    expect(view.captureCharFrame()).toContain("3s [x]")
  } finally { await act(async () => { await view.dispose() }) }
})
