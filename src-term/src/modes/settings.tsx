import type { MenuData } from "./data.ts"
import { button, select } from "./actions.ts"
import type { ReactNode } from "react"
import { PALETTE_NAMES, type Theme } from "../theme.ts"
import { Action, Controls, FieldList, InputField, Lines, Note, Panel, Paragraphs, nudge, sendKey, useBodyHeight, type Line } from "./bits.tsx"
import { flag, join, num, onOff, rec, rows, str, strings, type Rec } from "./read.ts"

const GENERAL: { label: string; kind: "edit" | "paths" | "toggle" | "cycle" | "search"; value: (body: Rec) => string }[] = [
  { label: "Session name", kind: "edit", value: (body) => str(body.name) || "—" },
  { label: "Workdir", kind: "paths", value: (body) => join(body.workdir) },
  { label: "Awareness", kind: "toggle", value: (body) => onOff(body.awareness_enabled) },
  { label: "Harness", kind: "toggle", value: (body) => onOff(body.classifier_enabled) },
  { label: "Allowed dirs", kind: "paths", value: (body) => join(body.allowed_folders) },
  { label: "Short-send", kind: "toggle", value: (body) => onOff(body.short_send_enabled) },
  { label: "Bash shorts", kind: "toggle", value: (body) => onOff(body.bash_saving) },
  { label: "Coding autosave", kind: "toggle", value: (body) => onOff(body.coding_autosave) },
  { label: "Internet mode", kind: "cycle", value: (body) => str(body.internet_mode) || "—" },
  { label: "Web search", kind: "search", value: (body) => searchName(body.web_search) },
  { label: "Mouse capture", kind: "cycle", value: (body) => str(body.mouse_capture) || "auto" },
  { label: "Max turns", kind: "edit", value: (body) => str(body.subagent_max_turns) },
  { label: "Max out tokens", kind: "edit", value: (body) => str(body.max_output_tokens) },
]

const ROLES = ["main", "awareness", "safeguard", "compactor", "planner"]

const TABS = ["1 quick", "2 providers", "3 oauth", "4 models"]

export function settingsView(
  body: MenuData["Settings"] & Rec,
  theme: Theme,
  wide: boolean,
  _onMove: (index: number) => void,
  send: (request: unknown) => void,
) {
  const page = str(body.page) || "quick"
  if (body.search_editor) return pageOf(tabs(0, theme), "↑↓ browse · Enter choose / save · Esc back", searchEditor(body, theme, send))
  if (body.picker) return pageOf(tabs(tabIndex(page), theme), "tab enter dir · ./ ~/ /abs · enter pick · esc cancel", pathPicker(rec(body.picker), theme, _onMove, send))
  if (page === "provider_form") return pageOf(tabs(1, theme), providerFormHint(theme, send), providerForm(body, theme, _onMove))
  if (page === "model_form") return pageOf(tabs(3, theme), modelFormHint(body, theme, send), modelForm(body, theme, send))
  if (page === "oauth" && str(rec(body.oauth_flow).kind) && str(rec(body.oauth_flow).kind) !== "idle") {
    const flow = rec(body.oauth_flow)
    return pageOf(tabs(2, theme), oauthFormHint(flow, theme, send), oauthFlow(flow, theme, (index) => nudge(send, num(flow.cursor), index), send))
  }
  if (page === "appearance") return pageOf("Appearance", "↑↓ select · enter apply · esc back", <Panel title="Theme" hot theme={theme}><Lines rows={PALETTE_NAMES.map((label) => ({ label, toggle: label === body.palette }))} selected={num(body.palette_sel)} theme={theme} onPress={_onMove} /></Panel>)
  if (page === "general") return pageOf("General", quickFooter(body, theme, send), <Panel title="General" hot theme={theme}><GeneralFields body={body} theme={theme} focused send={send} /></Panel>)
  if (page === "menu") return pageOf("Settings", "↑↓ select · enter open · esc back", <Lines rows={["Appearance", "General", "Providers", "OAuth", "Models"].map((label) => ({ label }))} selected={num(body.menu_sel)} theme={theme} onPress={_onMove} />)
  if (page === "providers" || page === "oauth" || page === "models") {
    return pageOf(tabs(tabIndex(page), theme, send), keyBar(theme, send, [
      { key: "enter", action: page === "oauth" ? "connect" : "edit" },
      { key: "ctrl+x", action: "delete" },
      { key: "esc", action: "back" },
    ]), page === "providers" ? providerDash(body, theme, wide, send) : page === "oauth" ? oauthDash(body, theme, wide, send) : modelDash(body, theme, wide, send))
  }
  return pageOf(tabs(0, theme, body.editing || body.list_editing ? undefined : send), quickFooter(body, theme, send), <QuickDash body={body} theme={theme} wide={wide} send={send} />)
}

function tabs(active: number, theme: Theme, send?: (request: unknown) => void) {
  return <box flexDirection="row" flexWrap="wrap" columnGap={1} rowGap={0}>
    {TABS.map((tab, index) => <Action key={tab} label={tab} primary={index === active} disabled={!send} theme={theme} onPress={() => { if (send) sendKey(send, { Char: String(index + 1) }) }} />)}
  </box>
}


function tabIndex(page: string): number {
  if (page === "providers" || page === "provider_form") return 1
  if (page === "oauth") return 2
  if (page === "models" || page === "model_form") return 3
  return 0
}

function QuickDash({ body, theme, wide, send }: { body: Rec; theme: Theme; wide: boolean; send: (request: unknown) => void }) {
  const { ref, height } = useBodyHeight(24)
  const editing = Boolean(body.editing)
  const appearanceHeight = wide ? 12 : height >= 28 ? 12 : Math.min(7, Math.max(4, Math.floor((height - 1) / 3)))
  const generalHeight = Math.min(15 + (editing ? 3 : 0), wide ? height : Math.max(4, height - appearanceHeight - 1))
  const mainHeight = wide ? generalHeight : appearanceHeight + generalHeight + 1
  const summaries = wide && height >= mainHeight + 7 && !editing && !body.list_editing
  const focus = str(body.quick_focus) || "appearance"
  const appearanceBox = (
    <Panel title="Appearance" mark={0} hot={focus === "appearance"} theme={theme}>
      <Lines
        rows={PALETTE_NAMES.map((name) => ({ label: name, toggle: name === (str(body.palette) || "dark") }))}
        selected={focus === "appearance" ? num(body.palette_sel) : -1}
        theme={theme}
        onPress={(index) => {
          if (body.editing || body.list_editing) return
          select(send, index, "appearance")
        }}
      />
    </Panel>
  )
  const generalBox = (
    <Panel title="General" mark={0} hot={focus === "general" || Boolean(body.list_editing)} theme={theme}>
      <GeneralFields body={body} theme={theme} focused={focus === "general"} send={send} />
    </Panel>
  )
  const roles = roleLines(body)
  const info = (
    <box height={6} flexShrink={0} flexDirection="row" gap={1}>
      <RoleBox title="Providers" jump="2" lines={roles.map((row) => `${row.role}  ${row.provider}`)} theme={theme} send={send} />
      <RoleBox title="Connections" jump="3" lines={roles.flatMap((row) => row.oauth ? [`${row.role}  ${row.oauth}`] : [])} theme={theme} send={send} />
      <RoleBox title="Models" jump="4" lines={roles.map((row) => `${row.role}  ${row.model}`)} theme={theme} send={send} />
    </box>
  )
  return (
    <box ref={ref} flexDirection="column" flexGrow={1} flexBasis={0} minHeight={0} gap={1}>
      <box flexDirection={wide ? "row" : "column"} height={mainHeight} flexShrink={0} minHeight={0} gap={1}>
        <box width={wide ? "32%" : "100%"} height={Math.min(appearanceHeight, mainHeight)} flexShrink={0} flexDirection="column">{appearanceBox}</box>
        <box height={generalHeight} flexGrow={wide ? 1 : 0} flexBasis={wide ? 0 : undefined} minWidth={0} minHeight={0} flexDirection="column">{generalBox}</box>
      </box>
      {summaries ? info : null}
    </box>
  )
}

function providerDash(body: Rec, theme: Theme, wide: boolean, send: (request: unknown) => void) {
  const list = rows(body.providers)
  const selected = num(body.prov_sel)
  const lines: Line[] = list.map((row) => ({
    label: str(row.name) || "provider",
    detail: str(row.endpoint),
    dim: Boolean(row.ext_id),
  }))
  return <box flexGrow={1} flexBasis={0} minHeight={0} flexDirection="column">
    <Panel title="Providers" hot theme={theme} actions={<Action label="+ Add (a)" primary={selected === list.length} theme={theme} onPress={() => sendKey(send, { Char: "a" })} />}>
      <Lines rows={lines} selected={selected < list.length ? selected : -1} theme={theme} onPress={(index) => select(send, index)} />
    </Panel>
    {body.prov_delete_armed ? <Note text="Ctrl+X again deletes this provider" theme={theme} color={theme.warn} /> : null}
    {str(body.prov_msg) ? <Note text={str(body.prov_msg)} theme={theme} /> : null}
  </box>
}

function oauthDash(body: Rec, theme: Theme, wide: boolean, send: (request: unknown) => void) {
  const flow = rec(body.oauth_flow)
  if (str(flow.kind) && str(flow.kind) !== "idle") return oauthFlow(flow, theme, (index) => nudge(send, num(flow.cursor), index), send)
  const list = rows(body.oauth_drafts)
  const selected = num(body.oauth_sel)
  const lines: Line[] = list.map((row) => ({
    label: str(row.label) || str(row.provider) || "connection",
    detail: str(row.status) || str(row.provider),
  }))
  return <box flexGrow={1} flexBasis={0} minHeight={0} flexDirection="column">
    <Panel title="OAuth" hot theme={theme} actions={<Action label="+ Connect (a)" primary={selected === list.length} theme={theme} onPress={() => sendKey(send, { Char: "a" })} />}>
      <Lines rows={lines} selected={selected < list.length ? selected : -1} theme={theme} onPress={(index) => select(send, index)} />
    </Panel>
    {body.oauth_armed != null && body.oauth_armed !== false ? <Note text="Ctrl+X again deletes this connection" theme={theme} color={theme.warn} /> : null}
  </box>
}

function modelDash(body: Rec, theme: Theme, wide: boolean, send: (request: unknown) => void) {
  const filter = str(body.model_filter) || "all"
  const list = rows(body.models).filter((row) => filter === "all" || (filter === "local" ? flag(row.session_only) : !flag(row.session_only)))
  const selected = num(body.model_sel)
  const lines: Line[] = list.map((row) => ({ label: str(row.name) || str(row.model_id), detail: strings(row.roles).join(" ") || (flag(row.session_only) ? "session" : "global") }))
  const onFilter = selected >= 2 && selected <= 4
  const add = (index: number) => { select(send, index); sendKey(send, "Enter") }
  return <box flexGrow={1} flexBasis={0} minHeight={0} flexDirection="column" gap={1}>
    <box flexDirection="row" flexShrink={0}>
      {[["all", "All", 2], ["local", "Local", 3], ["global", "Global", 4]].map(([name, label, index]) => <Action key={name} label={String(label)} primary={onFilter ? selected === index : filter === name} theme={theme} onPress={() => { select(send, Number(index)); sendKey(send, "Enter") }} />)}
    </box>
    <Panel title={`Models · ${list.length}`} hot theme={theme} actions={<><Action label="+ Global (a)" primary={selected === 0} theme={theme} onPress={() => add(0)} /><Action label="+ Session" primary={selected === 1} theme={theme} onPress={() => add(1)} /></>}>
      <Lines rows={lines} selected={selected >= 5 ? selected - 5 : -1} theme={theme} onPress={(index) => select(send, index + 5)} />
    </Panel>
    {body.model_delete_armed ? <Note text="Ctrl+X again deletes this model" theme={theme} color={theme.warn} /> : null}
  </box>
}

function quickFooter(body: Rec, theme: Theme, send: (request: unknown) => void) {
  if (body.list_editing) return keyBar(theme, send, [
    { key: "a", action: "add" },
    { key: "enter", action: "edit" },
    { key: "d", action: "remove" },
    { key: "esc", action: "back" },
  ])
  const focus = str(body.quick_focus) || "appearance"
  if (!body.editing) return <Controls actions={[button(focus === "appearance" ? "Apply (enter)" : "Edit / toggle (enter)", "Enter"), button("Group (tab)", "Tab"), button("Back (esc)", "Esc")]} theme={theme} send={send} />
  return keyBar(theme, send, [
    { key: "enter", action: "done" },
    { key: "esc", action: "cancel" },
  ])
}

function keyBar(theme: Theme, send: (request: unknown) => void, parts: { key: string; action: string }[]) {
  const codes: Record<string, string | { Char: string }> = { enter: "Enter", esc: "Esc", tab: "Tab", space: { Char: " " } }
  return <Controls actions={[
    ...parts.filter((p) => p.key !== "type").map((p) => button(`${p.action} (${p.key})`, codes[p.key] ?? { Char: p.key.startsWith("ctrl+") ? p.key.slice(-1) : p.key }, p.key.startsWith("ctrl+") ? 2 : 0)),
  ]} theme={theme} send={send} />
}

function RoleBox({ title, jump, lines, theme, send }: { title: string; jump: string; lines: string[]; theme: Theme; send: (request: unknown) => void }) {
  const shown = lines.length > 0 ? lines : ["none"]
  return (
    <Panel title={title} hot={false} theme={theme}>
      <box flexGrow={1} flexBasis={0} minHeight={0} flexDirection="column" onMouseDown={() => sendKey(send, { Char: jump })}>
        <Paragraphs lines={shown} theme={theme} />
      </box>
    </Panel>
  )
}

function roleLines(body: Rec): { role: string; model: string; provider: string; oauth: string }[] {
  const models = rows(body.models)
  const providers = rows(body.providers)
  const oauth = rows(body.oauth_drafts)
  const out: { role: string; model: string; provider: string; oauth: string }[] = []
  for (const role of ROLES) {
    const model = models.find((row) => strings(row.roles).includes(role))
    if (!model) continue
    const index = num(model.provider_idx)
    const provider = providers[index]
    const connection = index >= providers.length ? oauth[index - providers.length] : undefined
    const oauthName = connection ? str(connection.label) || str(connection.provider) : ""
    out.push({
      role,
      model: str(model.name) || str(model.model_id),
      provider: provider ? str(provider.name) : oauthName || "—",
      oauth: oauthName,
    })
  }
  return out
}

function GeneralFields({ body, theme, focused, send }: { body: Rec; theme: Theme; focused: boolean; send: (request: unknown) => void }) {
  if (body.list_editing) {
    const items = strings(num(body.field) === 4 ? body.allowed_folders : body.workdir)
    return <Lines rows={items.map((item) => ({ label: item || "—" }))} selected={num(body.list_sel)} theme={theme} onPress={(index) => nudge(send, num(body.list_sel), index)} />
  }
  const selected = focused ? num(body.field) : -1
  const editing = focused && flag(body.editing)
  const fields: Line[] = GENERAL.map((field) => ({ label: field.label, toggle: field.kind === "toggle" ? field.value(body) === "on" : undefined, detail: field.kind === "toggle" ? undefined : field.kind === "paths" ? "Edit directories ›" : field.value(body), color: field.kind === "cycle" ? "info" : undefined }))
  return <box flexGrow={1} flexBasis={0} minHeight={0} flexDirection="column">
    <Lines rows={fields} selected={selected} theme={theme} onPress={(index) => { if (!editing) focusGeneral(send, num(body.field), index) }} />
    {editing ? <InputField field={GENERAL[selected]?.label} label={GENERAL[selected]?.label || "Value"} value={GENERAL[selected]?.value(body) || ""} active theme={theme} /> : null}
  </box>
}

function focusGeneral(send: (request: unknown) => void, from: number, index: number) {
  select(send, index, "general")
}


function pageOf(title: ReactNode, hint: ReactNode, children: ReactNode) {
  return { title, hint, children }
}

function providerFormHint(theme: Theme, send: (request: unknown) => void) {
  return <box flexDirection="row" flexWrap="wrap" columnGap={1} flexShrink={0}>
    <Action label="Save (enter)" primary theme={theme} onPress={() => { select(send, 3); sendKey(send, "Enter") }} />
    <Action label="Field (tab)" theme={theme} onPress={() => sendKey(send, "Tab")} />
    <Action label="Back (esc)" theme={theme} onPress={() => sendKey(send, "Esc")} />
  </box>
}

function providerForm(body: Rec, theme: Theme, onMove: (index: number) => void) {
  const modal = rec(body.prov_modal)
  if (!modal.name && !modal.endpoint && Object.keys(modal).length === 0) {
    return <text fg={theme.dim}> opening the form…</text>
  }
  const field = num(modal.field)
  const inputs = [
    { label: "Name", value: str(modal.name), empty: "type a name" },
    { label: "Endpoint", value: str(modal.endpoint), empty: "https://…" },
    { label: "API key", value: "", empty: modal.api_key ? "Saved credential · leave blank to retain" : "not set" },
  ]
  return (
    <box flexDirection="column" flexGrow={1} flexBasis={0} minHeight={0} gap={1}>
      <text fg={theme.fg}>{body.prov_replace != null ? "Edit this provider" : "Add a provider"}</text>
      {str(modal.api_type) ? <text fg={theme.dim}>{`Kind  ${str(modal.api_type)}`}</text> : null}
      {inputs.map((row, index) => <InputField key={row.label} field={row.label} secret={row.label === "API key"} label={row.label} value={row.value === "—" ? "" : row.value} placeholder={row.empty} active={field === index} editing={field === index && flag(body.provider_editing)} theme={theme} onPress={() => onMove(index)} />)}
    </box>
  )
}

function oauthFormHint(flow: Rec, theme: Theme, send: (request: unknown) => void) {
  const kind = str(flow.kind)
  const actions = kind === "codex_wait" || kind === "kilo_wait"
    ? [button("Open browser (o)", { Char: "o" }), button("Copy URL (c)", { Char: "c" }), button("Back (esc)", "Esc")]
    : kind === "failed"
      ? [button("Try again (enter)", "Enter"), button("Back (esc)", "Esc")]
      : kind === "starting"
        ? [button("Back (esc)", "Esc")]
        : [button("Connect (enter)", "Enter"), button("Back (esc)", "Esc")]
  return <Controls actions={actions} theme={theme} send={send} />
}

export function oauthHint(flow: Rec): string {
  switch (str(flow.kind)) {
    case "codex_wait": case "kilo_wait": return "o open browser · c copy URL · esc cancel"
    case "codex_paste": return "enter connect · esc cancel"
    case "failed": return "enter try again · esc back"
    case "starting": return "esc cancel"
    default: return "↑↓ select · enter connect · esc back"
  }
}

export function oauthFlow(flow: Rec, theme: Theme, onMove: (index: number) => void, send: (request: unknown) => void) {
  const kind = str(flow.kind) || "pick"
  if (kind === "pick" || kind === "idle") {
    const options = strings(flow.options)
    const lines = options.map((label) => ({ label }))
    if (!options.length) return <Note text="This daemon does not expose OAuth choices. Restart it with the current Koma build." color={theme.warn} theme={theme} />
    return <Panel title="Sign in to a provider" hot theme={theme}><Lines rows={lines} selected={num(flow.cursor)} theme={theme} onPress={onMove} /></Panel>
  }
  if (kind === "codex_paste") return <box flexDirection="column" flexGrow={1} flexBasis={0} minHeight={0} gap={1}>
    <Note text={`Connect ${str(flow.provider) || "your account"} with an existing token.`} theme={theme} />
    <InputField field="oauth_token" secret label="Access token" value={mask(str(flow.input)) === "—" ? "" : mask(str(flow.input))} placeholder="Paste your access token" active theme={theme} />
  </box>
  const lines = [
    kind === "starting" ? "Starting sign-in…" : kind === "failed" ? "Could not connect" : "Finish signing in through your browser.",
    str(flow.provider), str(flow.url), str(flow.user_code) ? `Verification code  ${str(flow.user_code)}` : "",
    flow.copied ? "URL copied to clipboard" : "", str(flow.error),
  ].filter(Boolean)
  return <Panel title={kind === "failed" ? "Connection failed" : "Sign in"} hot theme={theme}><Paragraphs lines={lines} theme={theme} /></Panel>
}

function modelFields(body: Rec): string[] {
  const modal = rec(body.model_modal)
  return strings(body.model_fields).length ? strings(body.model_fields) : ["name", "provider", "model", ...(modal.route != null ? ["route"] : []), "role", "save", "cancel"]
}

function modelFormHint(body: Rec, theme: Theme, send: (request: unknown) => void) {
  const modal = rec(body.model_modal)
  if (modal.role_picker) return <Controls actions={[button("Toggle (space)", { Char: " " }), button("Done (enter)", "Enter"), button("Back (esc)", "Esc")]} theme={theme} send={send} />
  if (body.model_provider_cursor != null) return <Controls actions={[button("Choose (enter)", "Enter"), button("Back (esc)", "Esc")]} theme={theme} send={send} />
  const saveAt = modelFields(body).indexOf("save")
  return <box flexDirection="row" flexWrap="wrap" columnGap={1} flexShrink={0}>
    <Action label="Save (enter)" primary theme={theme} onPress={() => { if (saveAt >= 0) select(send, saveAt); sendKey(send, "Enter") }} />
    <Action label="Field (tab)" theme={theme} onPress={() => sendKey(send, "Tab")} />
    <Action label="Back (esc)" theme={theme} onPress={() => sendKey(send, "Esc")} />
  </box>
}

function modelForm(body: Rec, theme: Theme, send: (request: unknown) => void) {
  const modal = rec(body.model_modal)
  const picker = modal.role_picker ? rec(modal.role_picker) : null
  const fields = modelFields(body)
  const visible = fields.filter((field) => field !== "save" && field !== "cancel")
  const selected = num(modal.field)
  const active = fields[selected]
  const values: Record<string, string> = { name: str(modal.name), provider: str(body.model_provider_label) || str(modal.provider_idx), model: str(modal.query) || str(modal.model_id), route: str(modal.route) || "Auto", role: strings(modal.roles).join(", ") || "Choose roles" }
  const move = (index: number) => select(send, index)
  const results = strings(body.model_results)
  const providers = rows(body.model_provider_choices)
  const providerOpen = active === "provider" && body.model_provider_cursor != null
  const routes = [{ label: "Auto" }, ...rows(modal.endpoints).map((row) => ({ label: str(row.provider_name) || str(row.name) }))]
  return <box flexDirection="column" flexGrow={1} flexBasis={0} minHeight={0} gap={1}>
    {body.model_error ? <Note text={str(body.model_error)} color={theme.error} theme={theme} /> : null}
    <Note text={flag(modal.session_only) ? "Available in this session" : "Available in all sessions"} theme={theme} />
    <FieldList rows={visible.map((field) => ({ label: field === "role" ? "Roles" : field[0]!.toUpperCase() + field.slice(1), detail: values[field] }))} selected={visible.indexOf(active ?? "")} theme={theme} editing={Boolean(body.model_editing) && (active === "name" || active === "model")} onPress={move} />
    {providerOpen ? <Panel title={`Providers · ${providers.length}`} hot theme={theme}><Lines rows={providers.map((p) => ({ label: str(p.label) }))} selected={num(body.model_provider_cursor)} theme={theme} onPress={(i) => { const p = providers[i]; if (p) select(send, num(p.index), "model_providers", str(p.id)) }} /></Panel> : null}
    {picker ? <Panel title="Roles" hot theme={theme}><Lines rows={ROLES.map((role, index) => ({ label: role, toggle: flag((Array.isArray(picker.checked) ? picker.checked : [])[index]), toggleLayout: "before" as const }))} selected={num(picker.cursor)} theme={theme} onPress={(index) => nudge(send, num(picker.cursor), index)} /></Panel> : null}
    {!picker && active === "model" && str(modal.query) ? <Panel title={`Models · ${results.length}`} hot theme={theme}><Lines rows={results.map((label) => ({ label }))} selected={num(modal.result_sel)} theme={theme} onPress={(index) => { select(send, index, "model_results"); sendKey(send, "Enter") }} /></Panel> : null}
    {!picker && !providerOpen && active === "route" ? <Panel title={`Routes · ${routes.length}`} hot theme={theme}><Lines rows={routes} selected={num(modal.route_sel)} theme={theme} onPress={(index) => { select(send, index, "routes"); sendKey(send, "Enter") }} /></Panel> : null}
  </box>
}

function pathPicker(picker: Rec, theme: Theme, onMove: (index: number) => void, send: (request: unknown) => void) {
  const matches = strings(picker.matches)
  const lines: Line[] = matches.map((item) => ({ label: item }))
  return (
    <box flexDirection="column" flexGrow={1} flexBasis={0} minHeight={0}>
      <InputField field="directory" label="Directory" value={str(picker.query)} placeholder="Search, paste, ./ or ~/" active theme={theme} />
      <Panel title={`Directories · ${matches.length}`} hot={false} theme={theme}><Lines rows={lines} selected={num(picker.sel)} theme={theme} onPress={onMove} /></Panel>
      <box flexDirection="row" flexShrink={0} gap={1}><Action label="Use directory" primary theme={theme} onPress={() => sendKey(send, "Enter")} /><Action label="Cancel" theme={theme} onPress={() => sendKey(send, "Esc")} /></box>
    </box>
  )
}

function searchEditor(body: Rec, theme: Theme, send: (request: unknown) => void) {
  const editor = rec(body.search_editor)
  const current = searchName(editor.provider)
  const providers = ["built_in", "firecrawl", "tavily", "exa"]
  const selected = Math.max(0, providers.indexOf(current))
  const saved = strings(rec(body.web_search).saved_keys).includes(current)
  return <box flexDirection="column" minHeight={0} gap={1}>
    <Panel title="Web search provider" maxLines={4} status={str(editor.error) || (saved && current !== "built_in" ? "Saved API key" : undefined)} hot theme={theme}>
      <Lines rows={providers.map((name) => ({ label: labelProvider(name), detail: name === searchName(body.web_search) ? "current" : "" }))} selected={selected} theme={theme} onPress={(index) => select(send, index)} />
    </Panel>
    <box flexDirection="column" flexShrink={0}>
      {current === "built_in" ? <Note text="DuckDuckGo is ready to use. No API key needed." theme={theme} /> : <InputField field="search_key" secret label={`${labelProvider(current)} API key`} value={str(editor.key)} placeholder={saved ? "Paste a replacement, or leave blank to keep saved key" : "Paste your API key"} active={Boolean(editor.editing)} editing={Boolean(editor.editing)} theme={theme} onPress={() => select(send, selected)} />}
    </box>
    <box flexDirection="row" flexWrap="wrap" flexShrink={0} gap={1}><Action label="Save search provider" primary theme={theme} onPress={() => send({MenuAction: "Save"})} /><Action label="Return to providers" theme={theme} onPress={() => select(send, 0, "search_back")} /><Action label="Cancel" theme={theme} onPress={() => select(send, 0, "search_cancel")} /></box>
  </box>
}

function searchName(value: unknown): string {
  if (typeof value === "string") return value
  const body = rec(value)
  return str(body.provider) || "built_in"
}

function labelProvider(name: string): string {
  if (name === "built_in") return "Built-in DuckDuckGo"
  if (name === "firecrawl") return "Firecrawl"
  if (name === "tavily") return "Tavily"
  if (name === "exa") return "Exa"
  return name
}

function mask(value: string): string {
  if (!value) return "—"
  if (value.includes("•")) return value
  if (value.length <= 4) return "••••"
  return `${"•".repeat(Math.min(8, value.length - 2))}${value.slice(-2)}`
}
