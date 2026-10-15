import { expect, test } from "bun:test"
import { act, useMemo } from "react"
import { SyntaxStyle, rgbToHex } from "@opentui/core"
import { useRenderer } from "@opentui/react"
import { testRender } from "@opentui/react/test-utils"
import { OpeningSplash, WarmingSplash, type WarmSplash } from "./loading.tsx"
import { encodeFrame } from "./protocol.ts"
import { SessionScreen } from "./session.tsx"
import { themeFor } from "./theme.ts"
import type { DaemonTransport } from "./transport.ts"

function paint(view: Awaited<ReturnType<typeof testRender>>, needle: string) {
  const span = view.captureSpans().lines.flatMap((line) => line.spans).find((item) => item.text.includes(needle))
  expect(span, needle).toBeDefined()
  return { fg: rgbToHex(span!.fg), bg: rgbToHex(span!.bg) }
}

function stalled() {
  let receive: (bytes: Uint8Array) => void = () => {}
  const transport: DaemonTransport = {
    remote: true,
    async open(_id, onData) { receive = onData },
    write: () => 0,
    end() {},
  }
  return {
    transport,
    push(event: unknown) { receive(encodeFrame({ event })) },
  }
}

function Screen({ palette, transport }: { palette: string; transport: DaemonTransport }) {
  const renderer = useRenderer()
  const syntaxStyle = useMemo(() => SyntaxStyle.fromStyles({}, renderer.nativeScene), [renderer])
  const theme = themeFor(palette)
  return (
    <box flexGrow={1} flexDirection="column" backgroundColor={theme.bg} paddingLeft={2} paddingRight={2}>
      <SessionScreen
        id="splash-test"
        initialPalette={palette}
        transport={transport}
        syntaxStyle={syntaxStyle}
        onHome={() => {}}
        onOpen={() => {}}
        onExit={() => {}}
        onRemote={() => {}}
        onPalette={() => {}}
      />
    </box>
  )
}

const warm: WarmSplash = {
  elapsedMs: 1400,
  workspace: { phase: "running", detail: "" },
  awareness: { phase: "pending", detail: "" },
}

for (const name of ["light", "dark", "forest"] as const) {
  test(`opening and warming splashes use the ${name} palette`, async () => {
    const theme = themeFor(name)
    const view = await testRender(
      <box flexGrow={1} flexDirection="column" backgroundColor={theme.bg} paddingLeft={2} paddingRight={2}>
        <OpeningSplash theme={theme} />
      </box>,
      { width: 80, height: 24 },
    )
    try {
      await act(async () => { await view.waitForVisualIdle() })
      expect(view.captureCharFrame()).toContain("opening session")
      const title = paint(view, "koma")
      expect(title.fg).toBe(theme.accent)
      expect(title.bg).toBe(theme.bg)
      expect(paint(view, "opening session").fg).toBe(theme.fg)
      expect(paint(view, "opening").bg).toBe(theme.bg)
    } finally {
      await act(async () => { await view.dispose() })
    }

    const warming = await testRender(
      <box flexGrow={1} flexDirection="column" backgroundColor={theme.bg} paddingLeft={2} paddingRight={2}>
        <WarmingSplash theme={theme} warm={warm} />
      </box>,
      { width: 80, height: 24 },
    )
    try {
      await act(async () => { await warming.waitForVisualIdle() })
      expect(warming.captureCharFrame()).toContain("indexing workspace")
      expect(paint(warming, "koma").fg).toBe(theme.accent)
      expect(paint(warming, "koma").bg).toBe(theme.bg)
      expect(paint(warming, "indexing workspace").fg).toBe(theme.fg)
    } finally {
      await act(async () => { await warming.dispose() })
    }
  })
}

test("a session still opening uses the saved palette before the snapshot arrives", async () => {
  const link = stalled()
  const light = themeFor("light")
  const view = await testRender(<Screen palette="light" transport={link.transport} />, { width: 80, height: 24 })
  try {
    await act(async () => { await view.waitForVisualIdle() })
    expect(view.captureCharFrame()).toContain("opening session")
    expect(paint(view, "koma")).toEqual({ fg: light.accent, bg: light.bg })
    expect(paint(view, "opening session").fg).toBe(light.fg)
    expect(paint(view, "opening session").fg).not.toBe(themeFor("dark").fg)
    const backgrounds = view.captureSpans().lines.flatMap((line) => line.spans).map((span) => rgbToHex(span.bg))
    expect(backgrounds.every((bg) => bg === light.bg)).toBe(true)

    await act(async () => {
      link.push({
        Snapshot: {
          foreground_id: "splash-test",
          sessions: [{ id: "splash-test", name: "Splash", cwd: "/tmp", messages: [] }],
          global: { palette: "light", mode: { Loading: { elapsed_ms: 1400, workspace: "Running", awareness: "Pending" } } },
        },
      })
      await Bun.sleep(40)
    })
    for (let n = 0; n < 4; n++) await act(async () => { await view.waitForVisualIdle() })
    expect(view.captureCharFrame()).toContain("indexing workspace")
    expect(view.captureCharFrame()).toContain("reading project docs")
    expect(paint(view, "indexing workspace")).toEqual({ fg: light.fg, bg: light.bg })
    expect(paint(view, "koma").fg).toBe(light.accent)
  } finally {
    await act(async () => { await view.dispose() })
  }
})
