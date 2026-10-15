import { select, replaceField } from "./actions.ts"
import type { MenuData } from "./data.ts"
import type { Theme } from "../theme.ts"
import { Action, Document, InputField, Lines, Note, OVERLAY_BODY, Panel, Paragraphs, type Line } from "./bits.tsx"
import { editorFrom, TextEditor } from "./editor.tsx"
import { clip, flag, num, rec, rows, str, strings, type Rec } from "./read.ts"
import { UsageBoard } from "./usage.tsx"

export function helpView(body: MenuData["Help"] & Rec, theme: Theme, onMove: (index: number) => void) {
  const all = rows(body.all)
  const filtered = Array.isArray(body.filtered_idx) ? body.filtered_idx.map(num) : all.map((_, index) => index)
  const lines: Line[] = filtered.map((index) => {
    const row = all[index] ?? {}
    return { label: str(row.key), detail: str(row.desc), dim: str(row.kind) === "keybinding" }
  })
  const update = Array.isArray(body.update) ? body.update : null
  return {
    title: "help",
    hint: "type to search · enter runs a command · esc back",
    children: (
      <box flexDirection="column" flexGrow={1} flexBasis={0} minHeight={0}>
        <InputField field="query" label="Search commands and shortcuts" value={str(body.query)} placeholder="Search help" active theme={theme} />
        {update ? <Note text={`update ${str(update[0])}`} theme={theme} color={theme.success} /> : null}
        <Panel title={`Help · ${lines.length}`} hot={false} theme={theme}><Lines rows={lines} selected={num(body.selected)} theme={theme} onPress={onMove} /></Panel>
      </box>
    ),
  }
}

export function effortView(body: MenuData["Effort"] & Rec, theme: Theme, onMove: (index: number) => void) {
  const lines: Line[] = strings(body.options).map((label) => ({ label }))
  const note = str(body.note)
  return {
    title: "effort",
    hint: "↑↓ · enter set · esc cancel",
    children: (
      <box flexDirection="column" flexGrow={1} flexBasis={0} minHeight={0}>
        <Lines rows={lines} selected={num(body.selected)} visible={OVERLAY_BODY - (note ? 1 : 0)} theme={theme} onPress={onMove} />
        {note ? <Note text={note} theme={theme} /> : null}
      </box>
    ),
  }
}

export function modelView(body: Rec, theme: Theme, onMove: (index: number) => void, send: (request: unknown) => void) {
  const sub = str(body.sub) || "model"
  if (sub === "help") {
    return {
      title: "model",
      hint: "esc back",
      children: <Paragraphs lines={strings(body.lines).slice(0, 16)} theme={theme} />,
    }
  }
  const options = Array.isArray(body.options) ? body.options : []
  const indices = Array.isArray(body.filtered_indices) ? body.filtered_indices.map(num) : options.map((_, index) => index)
  const searchable = sub === "role_pick" || sub === "agent_pick"
  const lines: Line[] = indices.map(index => options[index]).map((row) => {
    if (Array.isArray(row)) return { label: str(row[1] ?? row[0]) }
    return { label: str(row) }
  })
  return {
    title: sub === "roles" ? "model · roles" : sub === "role_pick" ? `model · ${str(body.role)}` : sub === "agent_pick" ? `model · ${str(body.agent_name)}` : sub.replaceAll("_", " "),
    hint: sub === "roles" ? "↑↓ choose role · enter open · esc close" : searchable ? "type search · ↑↓ · enter set · esc back" : `${str(body.note)} · enter set · esc back`.replace(/^ · /, ""),
    children: <box flexGrow={1} flexBasis={0} minHeight={0} flexDirection="column">
      {searchable ? <InputField key={`${sub}:${str(body.role) || str(body.agent_name)}`} field="query" label="Search models" value={str(body.query)} placeholder="Name, model ID, or provider" active theme={theme} onChange={value => replaceField(send, "query", value)} /> : null}
      <Lines rows={lines} selected={num(body.cursor)} theme={theme} visible={OVERLAY_BODY - (searchable ? 3 : 0)} onPress={visibleIndex => {
        const index=indices[visibleIndex]
        if(index == null) return
        const row=options[index]
        const id=Array.isArray(row) ? row[0] == null ? "__inherit__" : str(row[0]) : undefined
        select(send, index, "models", id)
        send({SendKey:{code:"Enter",mods:0}})
      }} />
    </box>,
  }
}

export function todoView(body: Rec, theme: Theme, wide: boolean, onMove: (index: number) => void) {
  const items = rows(body.items)
  const selected = num(body.selected)
  const lines: Line[] = items.map((row) => ({
    label: str(row.content) || "task",
    detail: `${str(row.status)}  ${str(row.priority)}`,
    dim: str(row.status) === "completed" || str(row.status) === "cancelled",
  }))
  const current = items[selected]
  return {
    title: "todo",
    hint: "↑↓ or j k · enter toggle · esc close",
    children: side(wide, theme, lines, selected, onMove, current ? [str(current.content), str(current.status), str(current.priority)] : ["no tasks"]),
  }
}

export function bashView(body: Rec, theme: Theme, wide: boolean, onMove: (index: number) => void) {
  const jobs = rows(body.jobs)
  const selected = num(body.selected)
  const lines: Line[] = jobs.map((row) => ({
    label: clip(str(row.command), 40) || "job",
    detail: str(row.status),
    dim: !flag(row.running),
  }))
  const current = jobs[selected]
  const tail = str(current?.output_tail).split("\n").slice(-6)
  const detail = current
    ? [str(current.command), str(current.status), `${str(current.elapsed_secs)}s`, ...tail]
    : ["no jobs"]
  return {
    title: "bash",
    hint: "↑↓ · ctrl+x kill · any other key closes",
    children: side(wide, theme, lines, selected, onMove, detail),
  }
}

export function skillView(body: Rec, theme: Theme, onMove: (index: number) => void) {
  const all = rows(body.all)
  const filtered = Array.isArray(body.filtered_idx) ? body.filtered_idx.map(num) : all.map((_, index) => index)
  const lines: Line[] = filtered.map((index) => {
    const row = all[index] ?? {}
    return { label: str(row.name), toggle: flag(row.is_active), toggleLayout: "before" as const, detail: clip(str(row.description), 40) }
  })
  return {
    title: `skills · ${str(body.chip) || "all"}${str(body.query) ? ` · ${str(body.query)}` : ""}`,
    hint: "type to search · ← → filter · enter toggle · esc close",
    children: <Lines rows={lines} selected={num(body.selected)} theme={theme} visible={OVERLAY_BODY} onPress={onMove} />,
  }
}

export function attachmentsView(body: Rec, theme: Theme, onMove: (index: number) => void) {
  const editor = editorFrom(body.editor)
  if (editor && body.editor) {
    return {
      title: "paste",
      hint: "arrows · enter newline · esc back",
      children: <TextEditor body={editor} theme={theme} />,
    }
  }
  const items = rows(body.items)
  const lines: Line[] = items.map((row) => ({
    label: str(row.kind) === "pasted_text" ? `paste #${str(row.marker_n)}` : `image #${str(row.marker_n)}`,
    detail: str(row.rel_path),
  }))
  return {
    title: "attachments",
    hint: "↑↓ or j k · enter open · d remove · esc close",
    children: <Lines rows={lines} selected={num(body.selected)} theme={theme} visible={OVERLAY_BODY} onPress={onMove} />,
  }
}

function notificationTime(value: unknown): string {
  const date = new Date(typeof value === "number" ? value : str(value))
  return Number.isNaN(date.getTime()) ? str(value) : date.toLocaleString()
}

export function notificationsView(body: MenuData["Notifications"] & Rec, theme: Theme, onMove: (index: number) => void, send: (request: unknown) => void) {
  const query = str(body.query).toLowerCase()
  const all = rows(body.entries)
  const filtered = all.filter((row) => {
    if (body.severity && row.severity !== body.severity) return false
    if (!query) return true
    return `${str(row.message)} ${str(row.source)} ${str(row.severity)}`.toLowerCase().includes(query)
  })
  const lines: Line[] = filtered.map((row) => ({
    label: clip(str(row.message), 64),
    detail: `${notificationTime(row.timestamp)} · ${str(row.source)}`,
    badge: { text: `${flag(row.read) ? "read" : "unread"} · ${str(row.severity)}`, role: str(row.severity) === "error" ? "error" : str(row.severity) === "warn" ? "warn" : str(row.severity) === "success" ? "success" : "info" },
    dim: flag(row.read),
  }))
  const selected = num(body.cursor)
  const current = filtered[selected]
  return {
    title: body.app ? "notifications · app" : "notifications",
    hint: body.confirm_clear ? "y clear permanently · esc cancel" : "tab scope · enter details · ctrl+r mark all read · ctrl+x clear · esc back",
    children: (
      <box flexDirection="column" flexGrow={1} flexBasis={0} minHeight={0}>
        {body.confirm_clear ? <Note text="Clear notifications in this scope permanently?" theme={theme} color={theme.warn} /> : <InputField field="query" label="Search notifications" value={str(body.query)} placeholder="Search messages, sources, or severity" active theme={theme} />}
        {str(body.error) ? <Note text={str(body.error)} theme={theme} color={theme.error} /> : null}
        <box flexDirection="row" flexShrink={0} flexWrap="wrap">
          <Action label={body.app ? "App (tab)" : "Session (tab)"} theme={theme} onPress={()=>send({SendKey:{code:"Tab",mods:0}})} />
          <Action label={`Severity: ${str(body.severity) || "all"} (ctrl+f)`} theme={theme} onPress={()=>send({SendKey:{code:{Char:"f"},mods:2}})} />
        </box>
        <Panel title={`Notifications · ${lines.length} · ${all.filter((row) => !flag(row.read)).length} unread`} hot={false} status={body.loading ? "Refreshing…" : undefined} theme={theme}>{!lines.length ? <Note text={body.loading ? "" : "No notifications match."} theme={theme} /> : <Lines rows={lines} selected={selected} theme={theme} onPress={onMove} />}</Panel>
        {current && str(body.expanded) === str(current.id) ? <Panel title={str(current.source) || "Details"} hot={false} theme={theme}><Document theme={theme}><text fg={theme.dim}>{notificationTime(current.timestamp)}</text><text fg={theme.fg} selectable>{str(current.message)}</text></Document></Panel> : null}
      </box>
    ),
  }
}

export function usageView(body: MenuData["Usage"] & Rec, theme: Theme, _wide: boolean) {
  const session = body.view === "session"
  return {
    title: `Usage / ${session ? "Session" : "Global"} / ${str(body.range) || "today"}`,
    hint: "tab switch view · 1 today · 2 week · 3 year · m change metric · esc back",
    children: <UsageBoard body={body} theme={theme} />,
  }
}

function side(wide: boolean, theme: Theme, lines: Line[], selected: number, onMove: (index: number) => void, detail: string[]) {
  const list = <Lines rows={lines} selected={selected} theme={theme} visible={OVERLAY_BODY} onPress={onMove} />
  const text = <Paragraphs lines={detail.slice(0, OVERLAY_BODY).map((line) => clip(line, 80))} theme={theme} />
  return (
    <box flexDirection="row" flexGrow={1}>
      <box width={wide ? 28 : 18} flexDirection="column">
        {list}
      </box>
      <box flexGrow={1} paddingLeft={1}>
        {text}
      </box>
    </box>
  )
}
