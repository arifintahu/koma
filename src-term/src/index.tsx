import { createCliRenderer, SyntaxStyle, type SyntaxStyle as SyntaxStyleHandle } from "@opentui/core"
import { createRoot, useKeyboard, useRenderer, useSelectionHandler } from "@opentui/react"
import { useCallback, useState } from "react"
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

function App({ syntaxStyle }: { syntaxStyle: SyntaxStyleHandle }) {
  const renderer = useRenderer()
  const [route, setRoute] = useState<Route>(initialRoute)
  const [hubQuit, setHubQuit] = useState<QuitState | null>(null)
  const theme = themeFor("dark")
  const onHome = useCallback(() => setRoute({ kind: "hub" }), [])
  const onOpen = useCallback((id: string) => setRoute({ kind: "session", id }), [])

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
    if (route.kind !== "hub") return
    if (key.eventType === "release") return
    if (key.ctrl && key.name === "c") {
      setHubQuit({ working: 0, total: 0, selected: 2 })
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

  if (route.kind === "hub" && hubQuit) {
    return (
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
  }
  if (route.kind === "session") {
    return (
      <SessionScreen
        key={route.id}
        id={route.id}
        syntaxStyle={syntaxStyle}
        onHome={onHome}
        onOpen={onOpen}
      />
    )
  }
  return <Hub theme={theme} onOpen={onOpen} />
}

const renderer = await createCliRenderer({ exitOnCtrlC: false })
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
