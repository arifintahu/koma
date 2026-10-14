import { useState } from "react"
import type { Theme } from "./theme.ts"

export type ScreenRow = { label: string; detail: string }

export type ModeScreen = {
  title: string
  hint: string
  rows: ScreenRow[]
  selected: number
}

type Rec = Record<string, unknown>

/** A rounded list for any daemon mode that is not chat or quit. */
export function modeScreen(mode: unknown): ModeScreen | null {
  if (!mode || typeof mode !== "object") return null
  const record = mode as Rec
  const name = Object.keys(record)[0]
  if (!name || name === "Chat" || name === "QuitConfirm" || name === "MessageRewind" || name === "Loading") return null
  const body = (record[name] ?? {}) as Rec
  const built = build(name, body)
  if (built) return built
  return {
    title: name,
    hint: "esc back",
    rows: Object.entries(body)
      .filter(([, value]) => typeof value === "string" || typeof value === "number")
      .slice(0, 12)
      .map(([key, value]) => ({ label: key, detail: String(value) })),
    selected: 0,
  }
}

export function rewindOf(mode: unknown): { entries: string[]; selected: number } | null {
  if (!mode || typeof mode !== "object" || !("MessageRewind" in mode)) return null
  const body = (mode as { MessageRewind?: { entries?: { content?: string }[]; selected?: number } }).MessageRewind
  const entries = Array.isArray(body?.entries) ? body.entries.map((row) => String(row?.content ?? "")) : []
  const selected = typeof body?.selected === "number" ? body.selected : Math.max(0, entries.length - 1)
  return { entries, selected }
}

export function ModeView({
  screen,
  theme,
  onMove,
}: {
  screen: ModeScreen
  theme: Theme
  onMove: (index: number) => void
}) {
  const selected = Math.min(screen.selected, Math.max(0, screen.rows.length - 1))
  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={theme.bg} padding={1} gap={1}>
      <text fg={theme.accent}>{screen.title}</text>
      <box border borderStyle="rounded" borderColor={theme.dim} flexDirection="column" flexGrow={1}>
        {screen.rows.length === 0 ? <text fg={theme.dim}> nothing here</text> : null}
        {screen.rows.map((row, index) => (
          <Row
            key={`${row.label}-${index}`}
            row={row}
            on={index === selected}
            theme={theme}
            onPress={() => onMove(index)}
          />
        ))}
      </box>
      <text fg={theme.dim}>{screen.hint}</text>
    </box>
  )
}

function Row({
  row,
  on,
  theme,
  onPress,
}: {
  row: ScreenRow
  on: boolean
  theme: Theme
  onPress: () => void
}) {
  const [hot, setHot] = useState(false)
  const lit = on || hot
  return (
    <box
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={lit ? theme.selBg : theme.bg}
      onMouseOver={() => setHot(true)}
      onMouseOut={() => setHot(false)}
      onMouseDown={onPress}
    >
      <text>
        <span fg={lit ? theme.selFg : theme.fg}>{row.label}</span>
        {row.detail ? <span fg={lit ? theme.selFg : theme.dim}>{`  ${row.detail}`}</span> : null}
      </text>
    </box>
  )
}

function build(name: string, body: Rec): ModeScreen | null {
  switch (name) {
    case "Help": {
      const all = asRows(body.all)
      const filtered = Array.isArray(body.filtered_idx) ? body.filtered_idx.map(num) : all.map((_, i) => i)
      return list("help", "type to search · esc back", filtered.map((index) => {
        const row = all[index] ?? {}
        return { label: str(row.key), detail: str(row.desc) }
      }), num(body.selected))
    }
    case "Effort":
      return list("effort", `${str(body.note)} · enter set · esc back`, strings(body.options).map((label) => ({ label, detail: "" })), num(body.selected))
    case "Model":
      return list(
        str(body.sub) || "model",
        `${str(body.note)} · enter set · esc back`,
        asPairs(body.options).map((row) => ({ label: row[1], detail: row[0] })),
        num(body.cursor),
      )
    case "Todo":
      return list("todo", "enter toggle · esc back", asRows(body.items).map((row) => ({
        label: str(row.content),
        detail: `${str(row.status)}  ${str(row.priority)}`,
      })), num(body.selected))
    case "Bash":
      return list("bash", "enter open · esc back", asRows(body.jobs).map((row) => ({
        label: str(row.command),
        detail: str(row.status),
      })), num(body.selected))
    case "Attachments":
      return list("attachments", "enter open · esc back", asRows(body.items).map((row) => ({
        label: str(row.kind),
        detail: str(row.rel_path),
      })), num(body.selected))
    case "Settings":
      return list("settings", `${str(body.page)} · esc back`, [
        { label: "model", detail: str(body.model) },
        { label: "provider", detail: str(body.provider) },
        { label: "theme", detail: str(body.theme) },
        { label: "accent", detail: str(body.accent) },
        { label: "palette", detail: str(body.palette) },
        { label: "name", detail: str(body.name) },
        { label: "internet", detail: str(body.internet_mode) },
      ], num(body.field))
    case "Agents":
      return list("agents", `${str(body.mode)} · esc back`, asRows(body.agents).map((row) => ({
        label: str(row.name),
        detail: str(row.description),
      })), num(body.list_sel))
    case "Mcp":
      return list("mcp", `${str(body.mode)} · esc back`, asRows(body.servers).map((row) => ({
        label: str(row.name),
        detail: str(row.transport ?? row.url ?? ""),
      })), num(body.list_sel))
    case "Extensions":
      return list("extensions", `${str(body.mode)} · esc back`, asRows(body.rows).map((row) => ({
        label: str(row.name),
        detail: row.running ? "running" : str(row.version),
      })), num(body.list_sel))
    case "ExtStore":
      return list("store", "esc back", asRows(body.rows ?? body.items).map((row) => ({
        label: str(row.name ?? row.title),
        detail: str(row.description ?? ""),
      })), num(body.selected ?? body.list_sel))
    case "ExtScreen":
      return list(str(body.title) || "extension", "esc back", asRows(body.rows ?? body.items).map((row) => ({
        label: str(row.label ?? row.title ?? row.name),
        detail: str(row.detail ?? row.value ?? ""),
      })), num(body.selected ?? body.cursor))
    case "Security":
      return list("security", "esc back", asRows(body.tools ?? (body.status as Rec | undefined)?.tools).map((row) => ({
        label: str(row.name ?? row),
        detail: "",
      })), num(body.selected))
    case "Skill": {
      const all = asRows(body.all)
      const filtered = Array.isArray(body.filtered_idx) ? body.filtered_idx.map(num) : all.map((_, i) => i)
      return list("skills", "type to search · esc back", filtered.map((index) => {
        const row = all[index] ?? {}
        return { label: str(row.name), detail: row.is_active ? "active" : str(row.description) }
      }), num(body.selected))
    }
    case "Usage":
      return list("usage", "esc back", [
        { label: "view", detail: str(body.view) },
        { label: "range", detail: str(body.range) },
        { label: "metric", detail: str(body.metric) },
      ], 0)
    case "Notifications":
      return list("notifications", "esc back", asRows(body.items ?? body.entries).map((row) => ({
        label: str(row.text ?? row.title ?? row.msg),
        detail: str(row.kind ?? ""),
      })), num(body.selected))
    case "Remote":
      return list("remote", "esc back", asRows(body.hosts ?? body.rows).map((row) => ({
        label: str(row.name ?? row.host),
        detail: str(row.user ?? ""),
      })), num(body.selected))
    case "KeyInput":
      return list("setup", "enter next · esc back", [
        { label: "endpoint", detail: str(body.endpoint) },
        { label: "model", detail: str(body.model) },
        { label: "query", detail: str(body.query) },
      ], num(body.field))
    case "Onboard":
      return list("welcome", "enter choose", [
        { label: "connect a provider", detail: "" },
        { label: "use an api key", detail: "" },
      ], num(body.cursor))
    case "OnboardProvider":
      return list(str(body.step) || "provider", "esc back", [
        { label: "provider", detail: str(body.provider) },
        { label: "query", detail: str(body.query) },
      ], num(body.result_sel))
    case "SessionPicker": {
      const all = asRows(body.all)
      const filtered = Array.isArray(body.filtered_idx) ? body.filtered_idx.map(num) : all.map((_, i) => i)
      return list("sessions", "type to search · enter open · esc back", filtered.map((index) => {
        const row = all[index] ?? {}
        return { label: str(row.name), detail: str(row.id).slice(0, 8) }
      }), num(body.selected))
    }
    default:
      return null
  }
}

function list(title: string, hint: string, rows: ScreenRow[], selected: number): ModeScreen {
  return { title, hint, rows, selected }
}

function asRows(value: unknown): Rec[] {
  if (!Array.isArray(value)) return []
  return value.filter((row) => row && typeof row === "object") as Rec[]
}

function asPairs(value: unknown): [string, string][] {
  if (!Array.isArray(value)) return []
  return value.map((row) => {
    if (Array.isArray(row)) return [str(row[0]), str(row[1])]
    return ["", str(row)]
  })
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map((row) => str(row)) : []
}

function str(value: unknown): string {
  if (value == null) return ""
  return String(value)
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

