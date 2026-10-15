import { Action, Fullscreen, InputField, Lines, Note, Panel, nativeMenuInput, type Line } from "./modes/bits.tsx"
import { useKeyboard } from "@opentui/react"
import { basename } from "node:path"
import { useEffect, useRef, useState, type ReactNode } from "react"
import { deleteSession, killSession, listSessions, type HistorySession, type LiveSession, type SessionsFile } from "./paths.ts"
import type { Theme } from "./theme.ts"

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

type Pane = "cooking" | "history"

export function Hub({ theme, onOpen, onBack, currentId, overlay }: { overlay?: ReactNode; theme: Theme; onOpen: (id: string) => void; onBack?: () => void; currentId?: string | null }) {
  const disabled = Boolean(overlay)
  const liveIdentity = useRef<string | null>(null)
  const historyIdentity = useRef<string | null>(null)
  const queryRef = useRef("")
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
          const needle=queryRef.current.toLowerCase().trim()
          const live=next.live.filter((r)=>matches(needle,r.name,r.pwd,r.session_id))
          const history=next.history.filter((r)=>matches(needle,r.name,r.pwd,r.session_id,r.dir_label))
          if (liveIdentity.current) setCookingSel(Math.max(0,live.findIndex((r)=>r.session_id===liveIdentity.current)+1))
          if (historyIdentity.current) setHistorySel(Math.max(0,history.findIndex((r)=>r.session_id===historyIdentity.current)))
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
  liveIdentity.current = live[cookingIndex-1]?.session_id ?? null
  historyIdentity.current = history[historyIndex]?.session_id ?? null
  queryRef.current = query

  function openCooking() {
    if (disabled) return
    if (cookingIndex === 0) {
      onOpen(crypto.randomUUID())
      return
    }
    const row = live[cookingIndex - 1]
    if (row) onOpen(row.session_id)
  }

  function openHistory() {
    if (disabled) return
    const row = history[historyIndex]
    if (row) onOpen(row.session_id)
  }

  function remove() {
    if (disabled) return
    const id = pane === "cooking" ? live[cookingIndex - 1]?.session_id : history[historyIndex]?.session_id
    if (!id) return
    if (armed === id) {
      setArmed(null)
      void (pane === "cooking" ? killSession(id) : deleteSession(id)).then(() => listSessions().then(setRows)).catch((err: unknown) => setError(String(err)))
    } else setArmed(id)
  }

  useKeyboard((key) => {
    if (key.eventType === "release" || disabled) return
    if (key.name === "escape") {
      if (armed) setArmed(null)
      else if (query) {setQuery("");nativeMenuInput.current?.setText("")}
      else onBack?.()
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
      if (armed) remove()
      else if (pane === "cooking") openCooking()
      else openHistory()
      return
    }
    if (key.ctrl && key.name === "x") {
      remove()
      return
    }
    if (nativeMenuInput.current) return
    if (key.name === "backspace") {
      setQuery((value) => value.slice(0, -1))
      return
    }
    if (key.name === "c") {setPane("cooking");return}
    if (key.name === "h") {setPane("history");return}
    if (key.name === "q" || key.ctrl || key.meta) return
    if (key.name && key.name.length === 1 && key.name >= " ") {
      setQuery((value) => value + key.name)
    }
  })

  const liveRows: Line[] = [{ label: "+ New session", color: "accent" }, ...live.map((row): Line => ({ label: row.name || row.session_id.slice(0, 8), detail: `${basename(row.pwd)} · ${row.session_id.slice(0,8)}`, badge: { text: row.session_id === currentId ? "current" : row.working ? `${glyph} working` : "ready", role: row.working ? "success" : "info" } }))]
  const historyRows: Line[] = history.map((row) => ({label:row.name || row.session_id.slice(0,8), detail:`${row.dir_label || basename(row.pwd)} · ${age(row.updated_at)} · ${row.session_id.slice(0,8)}`}))
  const target = [...live,...history].find((s)=>s.session_id===armed)
  return <box flexDirection="column" flexGrow={1} minHeight={0}><Fullscreen title="Sessions" theme={theme} hint={<box flexDirection="column" flexShrink={0}>
    {armed ? <Note text={`${pane === "cooking" ? "Stop" : "Delete"} ${target?.name || armed} (${armed})?`} color={theme.warn} theme={theme} /> : null}
    <box flexDirection="row" flexWrap="wrap"><Action disabled={disabled} label={armed ? "Confirm (enter)" : "Open (enter)"} theme={theme} onPress={() => {if(armed)remove();else if(pane === "cooking")openCooking();else openHistory()}} /><Action disabled={disabled} label="New session" theme={theme} onPress={() => onOpen(crypto.randomUUID())} /><Action disabled={disabled} label={pane === "cooking" ? "Stop (ctrl+x)" : "Delete (ctrl+x)"} theme={theme} onPress={remove} />{onBack ? <Action disabled={disabled} label="Back (esc)" theme={theme} onPress={onBack} /> : null}</box>
  </box>}>
    <box flexDirection="row" flexShrink={0}><Action disabled={disabled} label="Cooking (c)" primary={pane==="cooking"} theme={theme} onPress={()=>{setPane("cooking");setArmed(null)}} /><Action disabled={disabled} label="History (h)" primary={pane==="history"} theme={theme} onPress={()=>{setPane("history");setArmed(null)}} /></box>
    {error ? <Note text={error} color={theme.error} theme={theme} /> : null}
    <box flexDirection="column" flexGrow={1} flexBasis={0} minHeight={0}>
      {pane === "cooking" ? <Panel key="cooking" title={`cooking · ${live.length}`} mark={0} hot theme={theme}><Lines rows={liveRows} selected={cookingIndex} theme={theme} onPress={(i)=>{if(!disabled){setCookingSel(i);setArmed(null)}}} /></Panel> :
      <Panel key="history" title={`history · ${history.length}`} mark={0} hot theme={theme}>
        <InputField label="Search sessions" value={query} active={!armed && !disabled} onChange={(value)=>{setQuery(value);setHistorySel(0);setCookingSel(0)}} theme={theme} />
        <Lines rows={historyRows} selected={historyIndex} theme={theme} onPress={(i)=>{if(!disabled){setHistorySel(i);setArmed(null)}}} />
      </Panel>
      }
    </box>
  </Fullscreen>{overlay}</box>
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
