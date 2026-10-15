import type { MenuData } from "./data.ts"
import type { Theme } from "../theme.ts"
import { Action, Document, InputField, Lines, Note, OVERLAY_BODY, Panel, Paragraphs, type Line } from "./bits.tsx"
import { editorFrom, TextEditor } from "./editor.tsx"
import { clip, flag, num, rec, rows, str, strings, type Rec } from "./read.ts"

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
  return {
    title: "effort",
    hint: "↑↓ · enter set · esc cancel",
    children: (
      <box flexDirection="column" flexGrow={1} flexBasis={0} minHeight={0}>
        <Panel title="Reasoning effort" maxLines={lines.length} hot theme={theme}><Lines rows={lines} selected={num(body.selected)} theme={theme} onPress={onMove} /></Panel>
        <Note text={str(body.note)} theme={theme} />
      </box>
    ),
  }
}

export function modelView(body: Rec, theme: Theme, onMove: (index: number) => void) {
  const sub = str(body.sub) || "model"
  if (sub === "help") {
    return {
      title: "model",
      hint: "esc back",
      children: <Paragraphs lines={strings(body.lines).slice(0, 16)} theme={theme} />,
    }
  }
  const options = Array.isArray(body.options) ? body.options : []
  const lines: Line[] = options.map((row) => {
    if (Array.isArray(row)) return { label: str(row[1] ?? row[0]) }
    return { label: str(row) }
  })
  return {
    title: sub.replaceAll("_", " "),
    hint: `${str(body.note)} · enter set · esc back`.replace(/^ · /, ""),
    children: <Lines rows={lines} selected={num(body.cursor)} theme={theme} visible={OVERLAY_BODY} onPress={onMove} />,
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
    return { label: str(row.name), detail: flag(row.is_active) ? "active" : clip(str(row.description), 40) }
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

export function notificationsView(body: MenuData["Notifications"] & Rec, theme: Theme, onMove: (index: number) => void, send: (request: unknown) => void) {
  const query = str(body.query).toLowerCase()
  const all = rows(body.entries)
  const filtered = all.filter((row) => {
    if (!query) return true
    return `${str(row.message)} ${str(row.source)} ${str(row.severity)}`.toLowerCase().includes(query)
  })
  const lines: Line[] = filtered.map((row) => ({
    label: clip(str(row.message), 64),
    detail: str(row.source),
    badge: { text: `${flag(row.read) ? "read" : "unread"} · ${str(row.severity)}`, role: str(row.severity) === "error" ? "error" : str(row.severity) === "warn" ? "warn" : "info" },
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
        <Action label={body.app ? "App scope (tab)" : "Session scope (tab)"} theme={theme} onPress={()=>send({SendKey:{code:"Tab",mods:0}})} />
        {body.loading ? <Note text="Refreshing notifications…" color={theme.info} theme={theme} /> : null}
        <Panel title={`Notifications · ${lines.length}`} hot={false} theme={theme}><Lines rows={lines} selected={selected} theme={theme} onPress={onMove} /></Panel>
        {current && str(body.expanded) === str(current.id) ? <Panel title={str(current.source) || "Details"} hot={false} theme={theme}><Paragraphs lines={[str(current.timestamp), ...str(current.message).split("\n")]} theme={theme} /></Panel> : null}
      </box>
    ),
  }
}

export function usageView(body: MenuData["Usage"] & Rec, theme: Theme, wide: boolean) {
  const data = rec(body.data)
  const session = body.view === "session"
  const models = rows(session ? data.session_models : data.top_models)
  const totals = session ? body.session_totals ? rec(body.session_totals) : { cost: models.reduce((sum, row) => sum + num(row.total_cost), 0), calls: num(data.session_calls), tokens_in: models.reduce((sum, row) => sum + num(row.tokens_in), 0), tokens_out: models.reduce((sum, row) => sum + num(row.tokens_out), 0), tokens_cached: models.reduce((sum, row) => sum + num(row.tokens_cached), 0) } : rec(data.totals)
  const metric = body.metric === "tokens" ? "tokens" : "cost"
  const heat = rows(session ? data.session_hourly : data.heatmap_buckets)
  const max = heat.reduce((best, row) => Math.max(best, num(row[metric])), 0)
  const role = rec(data.role_split)
  const tokenMax = Math.max(1, ...models.map((row) => num(row.tokens_in) + num(row.tokens_out)))
  return {
    title: `Usage / ${session ? "Session" : "Global"} / ${str(body.range) || "today"}`,
    hint: "tab switch view · 1 today · 2 week · 3 year · m change metric · esc back",
    children: <Document>
      <text fg={theme.accent}>{`${money(totals.cost)}    ${num(totals.calls)} calls    ${money(num(totals.cost) / Math.max(1, num(totals.calls)))} / call`}</text>
      <text><span fg={theme.info}>{`${num(totals.tokens_in)} in`}</span><span fg={theme.dim}> · </span><span fg={theme.success}>{`${num(totals.tokens_cached)} cached`}</span><span fg={theme.dim}> · </span><span fg={theme.accent}>{`${num(totals.tokens_out)} out`}</span></text>
      <text fg={theme.accent}>{`Activity · ${metric}`}</text>
      <box flexDirection="row" flexWrap="wrap" flexShrink={0}>
        {heat.map((bucket, i) => <text key={i} fg={theme.heat[max ? Math.min(4, Math.ceil(num(bucket[metric]) / max * 4)) : 0]}>{"██"}</text>)}
      </box>
      <text><span fg={theme.dim}>less </span>{theme.heat.map((color, i) => <span key={i} fg={color}>██</span>)}<span fg={theme.dim}> more</span></text>
      {heat.length ? <text fg={theme.dim}>{`${new Date(num(heat[0]!.bucket_epoch) * 1000).toISOString().slice(0, 10)} – ${new Date(num(heat[heat.length - 1]!.bucket_epoch) * 1000).toISOString().slice(0, 10)} · ${metric === "tokens" ? `${heat.reduce((n, b) => n + num(b.tokens), 0)} tokens` : money(heat.reduce((n, b) => n + num(b.cost), 0))}`}</text> : <text fg={theme.dim}>No activity recorded in this range.</text>}
      <text fg={theme.accent}>Model breakdown</text>
      {models.length ? models.map((row, index) => <box key={index} flexDirection="column" flexShrink={0}>
        <text><span fg={theme.fg}>{str(row.model_id)}</span><span fg={theme.info}>{`  ${money(row.total_cost)} · ${num(row.call_count)} calls`}</span></text>
        <text><span fg={theme.accent}>{bar(num(row.tokens_out), tokenMax)}</span><span fg={theme.info}>{bar(num(row.tokens_in), tokenMax)}</span><span fg={theme.dim}>{` ${num(row.tokens_in)} in · ${num(row.tokens_out)} out`}</span></text>
        <text fg={theme.success}>{`Cached ${num(row.tokens_cached)} · ${num(row.tokens_in) + num(row.tokens_out)} total tokens`}</text>
      </box>) : <text fg={theme.dim}>No model usage recorded in this range.</text>}
      {!session ? <><text fg={theme.accent}>Role split</text><text><span fg={theme.info}>{`Main  ${money(role.main_cost)} · ${num(role.main_calls)} calls`}</span><span fg={theme.success}>{`    Subagents  ${money(role.sub_cost)} · ${num(role.sub_calls)} calls`}</span></text></> : null}
    </Document>,
  }
}

function money(value: unknown): string {
  const amount = typeof value === "number" ? value : 0
  return `$${amount.toFixed(4)}`
}

function bar(value: number, max: number): string {
  const width = max <= 0 ? 0 : Math.round((value / max) * 10)
  return "█".repeat(width).padEnd(10, "·")
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
