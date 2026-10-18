import { useRef, useState } from "react"
import { useKeyboard, usePaste } from "@opentui/react"
import { Action, Fullscreen, Note } from "./modes/bits.tsx"
import type { Theme } from "./theme.ts"

export function SuspendedScreen({ error, theme, onRestart, onExit }: {
  error: string
  theme: Theme
  onRestart: () => void
  onExit: () => void
}) {
  const [selected, setSelected] = useState(0)
  const chosen = useRef(false)
  const choose = (index: number) => {
    if (chosen.current) return
    chosen.current = true
    if (index === 0) onRestart()
    else onExit()
  }
  usePaste((event) => { event.preventDefault(); event.stopPropagation() })
  useKeyboard((key) => {
    if (key.eventType === "release") return
    key.preventDefault()
    key.stopPropagation()
    if (key.ctrl && key.name === "c" || key.sequence === "\u0003" || key.name === "ctrl+c" || key.name === "escape") choose(1)
    else if (key.name === "r") choose(0)
    else if (["tab", "left", "right", "up", "down"].includes(key.name)) setSelected((value) => 1 - value)
    else if (["return", "enter"].includes(key.name)) choose(selected)
  })
  return <Fullscreen title="Connection suspended" theme={theme} hint={<box flexDirection="row" columnGap={1}>
    <Action label="Restart (r)" primary={selected === 0} theme={theme} onPress={() => choose(0)} />
    <Action label="Exit (esc)" primary={selected === 1} theme={theme} onPress={() => choose(1)} />
  </box>}>
    <Note text={error || "The connection closed."} color={theme.error} theme={theme} />
  </Fullscreen>
}
