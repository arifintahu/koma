import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import { basename } from "node:path"
import { useEffect, useState } from "react"
import { deleteSession, killSession, listSessions, type HistorySession, type LiveSession, type SessionsFile } from "./paths.ts"
import type { Theme } from "./theme.ts"

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

type Pane = "cooking" | "history"

export function Hub({ theme, onOpen }: { theme: Theme; onOpen: (id: string) => void }) {
  const { height } = useTerminalDimensions()
  const [rows, setRows] = useState<SessionsFile>({ live: [], history: [] })
  const [error, setError] = useState("")
  const [query, setQuery] = useState("")
  const [pane, setPane] = useState<Pane>("cooking")
  const [cookingSel, setCookingSel] = useState(0)
  const [historySel, setHistorySel] = useState(0)
  const [armed, setArmed] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let dead = false
    const load = () => {
      listSessions()
        .then((next) => {
          if (dead) return
          setRows(next)
          setError("")
        })
        .catch((err: unknown) => {
          if (dead) return
          setError(err instanceof Error ? err.message : String(err))
        })
    }
    load()
    const timer = setInterval(load, 2000)
    const spin = setInterval(() => setTick((value) => value + 1), 80)
    return () => {
      dead = true
      clearInterval(timer)
      clearInterval(spin)
    }
  }, [])

  const needle = query.trim().toLowerCase()
  const live = rows.live.filter((row) => matches(needle, row.name, row.pwd, row.session_id))
  const history = rows.history.filter((row) => matches(needle, row.name, row.pwd, row.session_id, row.dir_label))
  const cookingCount = live.length + 1
  const cookingIndex = Math.min(cookingSel, cookingCount - 1)
  const historyIndex = history.length === 0 ? 0 : Math.min(historySel, history.length - 1)
  const glyph = SPINNER[tick % SPINNER.length] ?? "⠋"
  const cookingHeight = Math.max(3, Math.floor(height / 2))

  function openCooking() {
    if (cookingIndex === 0) {
      onOpen(crypto.randomUUID())
      return
    }
    const row = live[cookingIndex - 1]
    if (row) onOpen(row.session_id)
  }

  function openHistory() {
    const row = history[historyIndex]
    if (row) onOpen(row.session_id)
  }

  useKeyboard((key) => {
    if (key.eventType === "release") return
    if (key.name === "escape") {
      setQuery("")
      setArmed(null)
      return
    }
    if (key.name === "tab") {
      setPane((current) => (current === "cooking" ? "history" : "cooking"))
      setArmed(null)
      return
    }
    if (key.name === "up") {
      if (pane === "cooking") setCookingSel((value) => Math.max(0, value - 1))
      else setHistorySel((value) => Math.max(0, value - 1))
      return
    }
    if (key.name === "down") {
      if (pane === "cooking") setCookingSel((value) => Math.min(cookingCount - 1, value + 1))
      else setHistorySel((value) => Math.min(Math.max(history.length - 1, 0), value + 1))
      return
    }
    if (key.name === "return" || key.name === "enter") {
      if (pane === "cooking") openCooking()
      else openHistory()
      return
    }
    if (key.ctrl && key.name === "x") {
      const id = pane === "cooking" ? live[cookingIndex - 1]?.session_id : history[historyIndex]?.session_id
      if (!id) return
      if (armed === id) {
        setArmed(null)
        const run = pane === "cooking" ? killSession(id) : deleteSession(id)
        void run.then(() => listSessions().then(setRows)).catch((err: unknown) => {
          setError(err instanceof Error ? err.message : String(err))
        })
      } else {
        setArmed(id)
      }
      return
    }
    if (key.name === "backspace") {
      setQuery((value) => value.slice(0, -1))
      return
    }
    if (key.name === "q" || key.ctrl || key.meta) return
    if (key.name && key.name.length === 1 && key.name >= " ") {
      setQuery((value) => value + key.name)
    }
  })

  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={theme.bg}>
      <box height={cookingHeight} flexDirection="column">
        <Rule title={`cooking (${live.length})`} focused={pane === "cooking"} theme={theme} />
        <scrollbox flexGrow={1} scrollY focusable={false}>
          <Row
            label="+ new session"
            right=""
            selected={pane === "cooking" && cookingIndex === 0}
            focused={pane === "cooking"}
            accent
            theme={theme}
            onPress={() => onOpen(crypto.randomUUID())}
          />
          {live.map((row, index) => (
            <Row
              key={row.session_id}
              label={row.name || row.session_id.slice(0, 8)}
              right={`${basename(row.pwd)}  ${row.working ? `${glyph} working` : "○ ready"}`}
              selected={pane === "cooking" && cookingIndex === index + 1}
              focused={pane === "cooking"}
              theme={theme}
              onPress={() => onOpen(row.session_id)}
            />
          ))}
        </scrollbox>
      </box>
      <box flexGrow={1} flexDirection="column">
        <Rule title={`history (${history.length})`} focused={pane === "history"} theme={theme} />
        <text fg={theme.dim}>{` › ${query}`}</text>
        <scrollbox flexGrow={1} scrollY focusable={false}>
          {history.length === 0 ? (
            <text fg={theme.dim}>{needle ? " no matches" : " no past sessions"}</text>
          ) : (
            history.map((row, index) => (
              <Row
                key={row.session_id}
                label={row.name || row.session_id.slice(0, 8)}
                right={`${(row.dir_label || basename(row.pwd)).slice(0, 14)}  ${age(row.updated_at)}`}
                selected={pane === "history" && historyIndex === index}
                focused={pane === "history"}
                theme={theme}
                onPress={() => onOpen(row.session_id)}
              />
            ))
          )}
        </scrollbox>
      </box>
      <text fg={theme.dim}>
        {armed
          ? " Ctrl+X again to confirm"
          : " Tab switch · ↑/↓ select · Enter open · Ctrl+X kill (cooking) / delete (history) · type to search"}
      </text>
      {error ? <text fg={theme.error}>{error}</text> : null}
    </box>
  )
}

function Rule({ title, focused, theme }: { title: string; focused: boolean; theme: Theme }) {
  return (
    <box height={1} border={["top"]} borderColor={focused ? theme.accent : theme.dim} title={` ${title} `} titleColor={focused ? theme.accent : theme.dim} />
  )
}

function Row({
  label,
  right,
  selected,
  focused,
  accent,
  theme,
  onPress,
}: {
  label: string
  right: string
  selected: boolean
  focused: boolean
  accent?: boolean
  theme: Theme
  onPress: () => void
}) {
  const [hot, setHot] = useState(false)
  const on = selected || hot
  const fg = on ? theme.selFg : accent ? theme.accent : focused ? theme.fg : theme.dim
  return (
    <box
      flexDirection="row"
      justifyContent="space-between"
      backgroundColor={on ? theme.selBg : theme.bg}
      paddingLeft={1}
      paddingRight={1}
      onMouseOver={() => setHot(true)}
      onMouseOut={() => setHot(false)}
      onMouseDown={onPress}
    >
      <text fg={fg} selectable>
        {label}
      </text>
      {right ? (
        <text fg={fg} selectable>
          {right}
        </text>
      ) : null}
    </box>
  )
}

function matches(needle: string, ...parts: string[]): boolean {
  if (!needle) return true
  return parts.some((part) => part.toLowerCase().includes(needle))
}

function age(seconds: number): string {
  if (!seconds) return ""
  const delta = Math.max(0, Math.floor(Date.now() / 1000) - seconds)
  if (delta < 60) return `${delta}s ago`
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`
  return `${Math.floor(delta / 86400)}d ago`
}
