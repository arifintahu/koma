import { createCliRenderer, SyntaxStyle, type SyntaxStyle as SyntaxStyleHandle } from "@opentui/core"
import { createRoot, useKeyboard, useRenderer, useSelectionHandler } from "@opentui/react"
import { useCallback, useEffect, useRef, useState } from "react"
import { copyText } from "./copy.ts"
import { Hub } from "./hub.tsx"
import { QuitScreen, type QuitState } from "./quit.tsx"
import { SessionScreen } from "./session.tsx"
import { themeFor } from "./theme.ts"

type Route = { kind: "hub" } | { kind: "session"; id: string }

function initialRoute(): Route {
  if (process.env.KOMA_START === "hub") return { kind: "hub" }
  return { kind: "session", id: process.env.KOMA_SESSION || crypto.randomUUID() }
}

const MIN_COLUMNS = 50

function isCtrlC(key: { name?: string; ctrl?: boolean; sequence?: string }): boolean {
  return (key.ctrl && key.name === "c") || key.sequence === "\u0003" || key.name === "ctrl+c"
}

let onInterrupt = () => {}

function App({ syntaxStyle }: { syntaxStyle: SyntaxStyleHandle }) {
  const renderer = useRenderer()
  const [route, setRoute] = useState<Route>(initialRoute)
  const [hubQuit, setHubQuit] = useState<QuitState | null>(null)
  const width = useColumns()
  const tooSmall = width < MIN_COLUMNS
  const routeRef = useRef(route)
  const hubQuitRef = useRef(hubQuit)
  const tooSmallRef = useRef(tooSmall)
  const sessionCtrlC = useRef<() => void>(() => {})
  routeRef.current = route
  hubQuitRef.current = hubQuit
  tooSmallRef.current = tooSmall
  const theme = themeFor("dark")
  const onHome = useCallback(() => setRoute({ kind: "hub" }), [])
  const onOpen = useCallback((id: string) => setRoute({ kind: "session", id }), [])

  useEffect(() => {
    onInterrupt = () => {
      if (tooSmallRef.current) {
        renderer.destroy()
        syntaxStyle.destroy()
        process.exit(0)
      }
      if (routeRef.current.kind === "hub") {
        if (!hubQuitRef.current) setHubQuit({ working: 0, total: 0, selected: 2 })
        return
      }
      sessionCtrlC.current()
    }
  }, [])

  function leave() {
    renderer.destroy()
    syntaxStyle.destroy()
    process.exit(0)
  }

  useSelectionHandler((selection) => {
    const text = selection.getSelectedText()
    if (text) copyText(text)
  })

  useKeyboard((key) => {
    if (tooSmall) {
      if (key.eventType === "release") return
      if (key.name === "q" || key.name === "escape" || key.name === "return" || key.name === "enter" || isCtrlC(key)) leave()
      return
    }
    if (route.kind !== "hub") return
    if (key.eventType === "release") return
    if (isCtrlC(key)) {
      if (!hubQuit) setHubQuit({ working: 0, total: 0, selected: 2 })
      return
    }
    if (hubQuit) {
      if (key.name === "left" || key.name === "h") {
        setHubQuit((current) => current && { ...current, selected: Math.max(0, current.selected - 1) })
      } else if (key.name === "right" || key.name === "l") {
        setHubQuit((current) => current && { ...current, selected: Math.min(2, current.selected + 1) })
      } else if (key.name === "tab") {
        setHubQuit((current) => current && { ...current, selected: (current.selected + (key.shift ? 2 : 1)) % 3 })
      } else if (key.name === "escape") setHubQuit(null)
      else if (key.name === "k" || ((key.name === "return" || key.name === "enter") && hubQuit.selected === 0)) leave()
      else if (key.name === "d" || ((key.name === "return" || key.name === "enter") && hubQuit.selected === 1)) leave()
      else if ((key.name === "return" || key.name === "enter") && hubQuit.selected === 2) setHubQuit(null)
      return
    }
    if (key.name === "q") leave()
  })

  let screen
  if (tooSmall) {
    screen = <TooNarrow theme={theme} width={width} />
  } else if (route.kind === "hub" && hubQuit) {
    screen = (
      <QuitScreen
        state={hubQuit}
        theme={theme}
        exiting={null}
        onPick={(index) => {
          if (index === 2) setHubQuit(null)
          else leave()
        }}
      />
    )
  } else if (route.kind === "session") {
    screen = (
      <SessionScreen
        key={route.id}
        id={route.id}
        syntaxStyle={syntaxStyle}
        onHome={onHome}
        onOpen={onOpen}
        onExit={leave}
        ctrlC={sessionCtrlC}
      />
    )
  } else {
    screen = <Hub theme={theme} onOpen={onOpen} />
  }
  if (tooSmall) {
    return <TooNarrow theme={theme} width={width} />
  }
  return (
    <box flexGrow={1} flexDirection="column" backgroundColor={theme.bg} paddingLeft={2} paddingRight={2}>
      {screen}
    </box>
  )
}

function useColumns(): number {
  const renderer = useRenderer()
  const [width, setWidth] = useState(() => columnsNow(renderer.width))
  useEffect(() => {
    const read = () => {
      const next = columnsNow(renderer.width)
      setWidth((current) => (current === next ? current : next))
    }
    renderer.on("resize", read)
    const timer = setInterval(read, 200)
    return () => {
      renderer.off("resize", read)
      clearInterval(timer)
    }
  }, [renderer])
  return width
}

function columnsNow(rendererWidth: number): number {
  const reported = process.stdout.columns
  const values = [rendererWidth, reported].filter((value): value is number => typeof value === "number" && value > 0)
  if (values.length === 0) return 80
  return Math.min(...values)
}

function TooNarrow({ theme, width }: { theme: ReturnType<typeof themeFor>; width: number }) {
  return (
    <box flexGrow={1} flexDirection="column" justifyContent="center" alignItems="center" backgroundColor={theme.bg} gap={1}>
      <text fg={theme.error}>Terminal too small</text>
      <text fg={theme.fg}>{`${width} columns`}</text>
      <text fg={theme.dim}>need 50</text>
      <text fg={theme.fg}>Resize if you can</text>
      <text fg={theme.dim}>q  esc  ctrl+c</text>
    </box>
  )
}

const renderer = await createCliRenderer({
  exitOnCtrlC: false,
  exitSignals: ["SIGTERM", "SIGQUIT", "SIGABRT", "SIGHUP", "SIGPIPE", "SIGBREAK", "SIGBUS"],
})
process.on("SIGINT", () => {
  onInterrupt()
})
const syntaxStyle = SyntaxStyle.fromStyles(
  {
    default: {},
    conceal: { dim: true },
    "markup.heading": { fg: "#39ff14", bold: true },
    "markup.strong": { bold: true },
    "markup.italic": { italic: true },
    "markup.strikethrough": { dim: true },
    "markup.raw": { fg: "#50c8ff" },
    "markup.link": { fg: "#50c8ff", underline: true },
    "markup.link.label": { fg: "#50c8ff", underline: true },
    "markup.link.url": { fg: "#50c8ff", dim: true },
    "markup.list": { fg: "#39ff14" },
    "markup.quote": { dim: true, italic: true },
    keyword: { fg: "#39ff14" },
    string: { fg: "#00c853" },
    comment: { fg: "#adadad", italic: true },
    number: { fg: "#ffb43c" },
  },
  renderer.nativeScene!,
)

createRoot(renderer).render(<App syntaxStyle={syntaxStyle} />)
