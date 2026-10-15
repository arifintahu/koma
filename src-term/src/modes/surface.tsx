import type { MenuData } from "./data.ts"
import { identifiedSelection, menuControls, replaceField, select } from "./actions.ts"
import type { ReactNode } from "react"
import { usePaste } from "@opentui/react"
import type { Theme } from "../theme.ts"
import { Controls, DraftContext, InputSuspendedContext, Fullscreen, Overlay, nativeMenuInput } from "./bits.tsx"
import { agentsView, extScreenView, extensionsView, mcpView, remoteView, securityView, storeView } from "./manage.tsx"
import {
  attachmentsView,
  bashView,
  effortView,
  helpView,
  modelView,
  notificationsView,
  skillView,
  todoView,
  usageView,
} from "./panels.tsx"
import { placeOf, wideEnough } from "./place.ts"
import { modeParts, type Rec } from "./read.ts"
import { settingsView } from "./settings.tsx"
import { keyInputView, onboardProviderView, onboardView, sessionHubView, sessionPickerView } from "./setup.tsx"

type Built = { title: ReactNode; hint: ReactNode; children: ReactNode }

export function ModeSurface({
  mode,
  disabled = false,
  theme,
  columns,
  onMove,
  send,
}: {
  mode: unknown
  disabled?: boolean
  theme: Theme
  columns: number
  onMove: (index: number) => void
  send: (request: unknown) => void
}) {
  usePaste((event) => {
    if (event.defaultPrevented || nativeMenuInput.current) return
    event.preventDefault()
    send({ Paste: { text: new TextDecoder().decode(event.bytes) } })
  })
  const parts = modeParts(mode)
  const originalSend = send
  send = (request) => {
    if (parts && request && typeof request === "object" && "MenuSelect" in request) {
      const selection = (request as { MenuSelect: { group: string; index: number; id?: string } }).MenuSelect
      originalSend({ MenuSelect: identifiedSelection(parts.name, parts.body, selection) })
    } else originalSend(request)
  }
  const move = placeOf(mode) === "full" ? (index: number) => select(send, index) : onMove
  const built = build(mode, theme, wideEnough(columns), move, send)
  if (!built) return null
  const place = placeOf(mode)
  if (place === "overlay") {
    return (
      <Overlay title={built.title} hint={built.hint} theme={theme}>
        {built.children}
      </Overlay>
    )
  }
  return (
    <Fullscreen title={built.title} hint={typeof built.hint === "string" ? <Controls actions={menuControls(parts!.name, parts!.body)} theme={theme} send={send} /> : built.hint} theme={theme}>
      <InputSuspendedContext.Provider value={disabled}><DraftContext.Provider value={(field, value) => replaceField(send, field, value)}>{built.children}</DraftContext.Provider></InputSuspendedContext.Provider>
    </Fullscreen>
  )
}

function build(mode: unknown, theme: Theme, wide: boolean, onMove: (index: number) => void, send: (request: unknown) => void): Built | null {
  const parts = modeParts(mode)
  if (!parts || !placeOf(mode)) return null
  const { name, body } = parts
  const view = viewOf(name, body, theme, wide, onMove, send)
  if (view) return view
  return { title: name, hint: "esc back", children: <text fg={theme.dim}> nothing to show</text> }
}

function viewOf(name: string, body: Rec, theme: Theme, wide: boolean, onMove: (index: number) => void, send: (request: unknown) => void): Built | null {
  switch (name) {
    case "Settings":
      return settingsView(body as MenuData["Settings"] & Rec, theme, wide, onMove, send)
    case "Help":
      return helpView(body as MenuData["Help"] & Rec, theme, onMove)
    case "Effort":
      return effortView(body as MenuData["Effort"] & Rec, theme, onMove)
    case "Model":
      return modelView(body, theme, onMove)
    case "Todo":
      return todoView(body, theme, wide, onMove)
    case "Bash":
      return bashView(body, theme, wide, onMove)
    case "Skill":
      return skillView(body, theme, onMove)
    case "Attachments":
      return attachmentsView(body, theme, onMove)
    case "Notifications":
      return notificationsView(body as MenuData["Notifications"] & Rec, theme, onMove, send)
    case "Usage":
      return usageView(body as MenuData["Usage"] & Rec, theme, wide)
    case "Agents":
      return agentsView(body as MenuData["Agents"] & Rec, theme, wide, onMove, send)
    case "Mcp":
      return mcpView(body as MenuData["Mcp"] & Rec, theme, wide, onMove, send)
    case "Extensions":
      return extensionsView(body as MenuData["Extensions"] & Rec, theme, wide, onMove, send)
    case "ExtStore":
      return storeView(body as MenuData["ExtStore"] & Rec, theme, wide, onMove)
    case "ExtScreen":
      return extScreenView(body as MenuData["ExtScreen"] & Rec, theme, onMove)
    case "Security":
      return securityView(body as MenuData["Security"] & Rec, theme, onMove)
    case "Remote":
      return remoteView(body as MenuData["Remote"] & Rec, theme, wide, onMove, send)
    case "Onboard":
      return onboardView(body as MenuData["Onboard"] & Rec, theme, onMove)
    case "OnboardProvider":
      return onboardProviderView(body as MenuData["OnboardProvider"] & Rec, theme, onMove, send)
    case "KeyInput":
      return keyInputView(body as MenuData["KeyInput"] & Rec, theme, onMove, send)
    case "SessionHub":
      return sessionHubView(body as MenuData["SessionHub"] & Rec, theme, wide, send)
    case "SessionPicker":
      return sessionPickerView(body as MenuData["Picker"] & Rec, theme, onMove)
    default:
      return null
  }
}
