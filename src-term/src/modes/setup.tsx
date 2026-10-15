import type { MenuData } from "./data.ts"
import { select as selectControl } from "./actions.ts"
import type { Theme } from "../theme.ts"
import { Action, InputField, Lines, Note, Panel, nudge, sendKey, type Line } from "./bits.tsx"
import { flag, num, rec, rows, str, strings, type Rec } from "./read.ts"
import { oauthFlow, oauthHint } from "./settings.tsx"

export function onboardView(body: MenuData["Onboard"] & Rec, theme: Theme, onMove: (index: number) => void) {
  return {
    title: "Welcome to Koma",
    hint: "↑↓ select · enter continue · q quit",
    children: <box flexDirection="column" flexGrow={1} flexBasis={0} minHeight={0} gap={1}>
      <Note text="Choose how you want to connect." theme={theme} />
      <Panel title="Get started" hot theme={theme}><Lines rows={[
        { label: "koma free", detail: "Start with the free connection" },
        { label: "Connect a provider", detail: "Sign in with your account" },
        { label: "Use an API key", detail: "Connect your own endpoint" },
      ]} selected={num(body.cursor)} theme={theme} onPress={onMove} /></Panel>
    </box>,
  }
}

export function onboardProviderView(body: MenuData["OnboardProvider"] & Rec, theme: Theme, onMove: (index: number) => void, send: (request: unknown) => void) {
  if (str(body.step) !== "model_select") {
    const flow = rec(body.oauth_flow)
    return { title: "Connect a provider", hint: oauthHint(flow), children: oauthFlow(flow, theme, (index) => nudge(send, num(flow.cursor), index), send) }
  }
  const results = strings(body.results)
  return {
    title: `Choose a model · ${str(body.provider)}`,
    hint: "↑↓ select · enter use model · esc back",
    children: <box flexDirection="column" flexGrow={1} flexBasis={0} minHeight={0} gap={1}>
      <InputField field="query" label="Model" value={str(body.query)} placeholder="Search models or paste a model ID" active theme={theme} />
      <Panel title={`Models · ${results.length}`} hot={false} theme={theme}><Lines rows={results.map((label) => ({ label }))} selected={num(body.result_sel)} theme={theme} onPress={onMove} /></Panel>
      {results.length === 0 ? <Note text="Enter a model ID to continue." theme={theme} /> : null}
    </box>,
  }
}

export function keyInputView(body: MenuData["KeyInput"] & Rec, theme: Theme, onMove: (index: number) => void, send: (request: unknown) => void) {
  const modelStep = num(body.step) === 1
  const results = strings(body.results)
  return {
    title: `${body.first_run ? "Setup" : "Connection"} · ${modelStep ? "2 / 2 · Model" : "1 / 2 · Credentials"}`,
    hint: modelStep ? "↑↓ select · enter finish · esc back" : "tab next field · enter continue · esc cancel",
    children: <box flexDirection="column" flexGrow={1} flexBasis={0} minHeight={0} gap={1}>
      {modelStep ? <>
        <InputField field="query" label="Model" value={str(body.query) || str(body.model)} placeholder="Search or paste a model ID" active theme={theme} />
        <Panel title={`Models · ${results.length}`} hot={false} theme={theme}><Lines rows={results.map((label) => ({ label }))} selected={num(body.result_sel)} theme={theme} onPress={(index) => nudge(send, num(body.result_sel), index)} /></Panel>
      </> : <scrollbox flexGrow={1} flexBasis={0} minHeight={0} scrollY focusable={false}>
        <InputField field="endpoint" label="API endpoint" value={str(body.endpoint)} placeholder="https://…/v1" active={num(body.field) === 0} editing={num(body.field) === 0 && flag(body.editing)} theme={theme} onPress={() => onMove(0)} />
        <InputField field="api_key" secret label="API key" value={"•".repeat(Math.min(24, str(body.api_key).length))} placeholder="Paste your API key" active={num(body.field) === 1} editing={num(body.field) === 1 && flag(body.editing)} theme={theme} onPress={() => onMove(1)} />
      </scrollbox>}
    </box>,
  }
}

export function sessionPickerView(body: MenuData["Picker"] & Rec, theme: Theme, onMove: (index: number) => void) {
  const all = rows(body.all)
  const filtered = Array.isArray(body.filtered_idx) ? body.filtered_idx.map(num) : all.map((_, index) => index)
  const lines: Line[] = filtered.map((index) => {
    const row = all[index] ?? {}
    return { label: str(row.name) || str(row.id).slice(0, 8), detail: row.locked ? "locked" : `${str(row.message_count)} messages` }
  })
  return {
    title: "Sessions",
    hint: "↑↓ select · enter open · esc back",
    children: <box flexDirection="column" flexGrow={1} flexBasis={0} minHeight={0} gap={1}>
      <InputField field="query" label="Search sessions" value={str(body.query)} placeholder="Search by name" active theme={theme} />
      <Panel title={`Sessions · ${lines.length}`} hot={false} theme={theme}><Lines rows={lines} selected={num(body.selected)} theme={theme} onPress={onMove} /></Panel>
    </box>,
  }
}

export function sessionHubView(body: MenuData["SessionHub"] & Rec, theme: Theme, _wide: boolean, send: (request: unknown) => void) {
  const cooking = rows(body.cooking)
  const history = rows(body.history)
  const focusCooking = flag(body.focus_cooking)
  const armed = body.pending_kill || body.pending_delete
  const select = (cookingPane: boolean, index: number) => {
    if (armed) return
    selectControl(send, index, cookingPane ? "cooking" : "history")
  }
  return {
    title: "Sessions",
    hint: armed ? "enter confirm · esc cancel" : "tab switch pane · ↑↓ select · enter open · ctrl+x remove · esc back",
    children: <box flexDirection="column" flexGrow={1} flexBasis={0} minHeight={0} gap={1}>
      <box flexDirection="row" flexShrink={0}>
        <Action label="Cooking" primary={focusCooking} disabled={!!armed} theme={theme} onPress={() => { if (!focusCooking) sendKey(send, "Tab") }} />
        <Action label="History" primary={!focusCooking} disabled={!!armed} theme={theme} onPress={() => { if (focusCooking) sendKey(send, "Tab") }} />
      </box>
      {armed ? <Note text={body.pending_kill ? "Stop this session and its work?" : "Delete this saved session?"} color={theme.warn} theme={theme} /> : null}
      {focusCooking ? <Panel key="cooking" title={`Cooking · ${cooking.filter((row) => row.kind !== "new_session").length}`} hot theme={theme}>
        <Lines rows={cooking.map((row) => ({ label: row.kind === "new_session" ? "+ New session" : str(row.name), detail: row.kind === "new_session" ? "" : row.working ? "working" : "ready" }))} selected={num(body.cooking_selected)} theme={theme} onPress={(index) => select(true, index)} />
      </Panel> : <Panel key="history" title={`History · ${history.length}`} hot theme={theme}>
        <InputField field="history_query" label="Search history" value={str(body.history_query)} placeholder="Search saved sessions" active={!armed} theme={theme} />
        <Lines rows={history.map((row) => ({ label: str(row.name) }))} selected={num(body.history_selected)} theme={theme} onPress={(index) => select(false, index)} />
      </Panel>}
    </box>,
  }
}
