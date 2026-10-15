import { expect, test } from "bun:test"
import { act } from "react"
import { testRender } from "@opentui/react/test-utils"
import { ModeSurface } from "./surface.tsx"
import { SubagentPanel } from "./subagents.tsx"
import { themeFor } from "../theme.ts"

const jobs = Array.from({ length: 20 }, (_, index) => ({ command: `echo job-${index}`, status: "running", running: true, elapsed_secs: index }))
const agents = Array.from({ length: 20 }, (_, index) => ({ label: `agent-${index}`, status: "running", live_text: "" }))

test("bash and task lists show a scrollbar when they overflow", async () => {
  const theme = themeFor("dark")
  const view = await testRender(
    <box flexDirection="column" height={28}>
      <ModeSurface mode={{ Bash: { jobs, selected: 0 } }} theme={theme} columns={80} onMove={() => {}} send={() => {}} />
      <SubagentPanel agents={agents} pending={[]} selected={0} theme={theme} wide onMove={() => {}} />
    </box>,
    { width: 80, height: 28 },
  )
  try {
    await act(async () => { await view.waitForVisualIdle() })
    const frame = view.captureCharFrame()
    expect(frame).toContain("echo job-0")
    expect(frame).toContain("agent-0")
    expect(frame.split("█").length - 1).toBeGreaterThan(1)
    const short = await testRender(<ModeSurface mode={{ Bash: { jobs: jobs.slice(0, 2), selected: 0 } }} theme={theme} columns={80} onMove={() => {}} send={() => {}} />, { width: 80, height: 16 })
    try {
      await act(async () => { await short.waitForVisualIdle() })
      expect(short.captureCharFrame()).not.toContain("█")
    } finally {
      await act(async () => { await short.dispose() })
    }
  } finally {
    await act(async () => { await view.dispose() })
  }
})
