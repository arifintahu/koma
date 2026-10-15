import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react"
import type { BoxRenderable, ScrollBoxRenderable, InputRenderable, TextareaRenderable } from "@opentui/core"
import { useKeyboard, useRenderer } from "@opentui/react"
import { paletteWindow } from "../palette.ts"
import type { Theme } from "../theme.ts"

import { select, type ActionDescriptor } from "./actions.ts"

export const DraftContext = createContext<((field: string, value: string) => void) | null>(null)
export const nativeMenuInput: { current: TextareaRenderable | null; multiline: boolean; listNavigation: boolean } = { current: null, multiline: false, listNavigation: false }

const FullscreenContext = createContext(false)

export function Fullscreen({
  title,
  hint,
  theme,
  children,
}: {
  title: ReactNode
  hint: ReactNode
  theme: Theme
  children: ReactNode
}) {
  return (
    <FullscreenContext.Provider value={true}>
    <box flexGrow={1} minHeight={0} flexDirection="column" backgroundColor={theme.bg} paddingTop={1} paddingBottom={1} gap={1}>
      <box flexShrink={0} minHeight={1}>
        {typeof title === "string" ? <text fg={theme.accent}>{` Koma / ${title}`}</text> : title}
      </box>
      <box flexGrow={1} flexBasis={0} minHeight={0} flexDirection="column">
        {children}
      </box>
      <box flexShrink={0} flexDirection="column">
        {typeof hint === "string" ? <text fg={theme.dim}>{` ${hint}`}</text> : hint}
      </box>
    </box>
    </FullscreenContext.Provider>
  )
}

/** Overlay rows, border included. Same budget as the slash palette. */
export const OVERLAY_HEIGHT = 10
/** List rows under the hint, inside that budget. */
export const OVERLAY_BODY = 7

export function Overlay({
  title,
  hint,
  theme,
  children,
}: {
  title: ReactNode
  hint: ReactNode
  theme: Theme
  children: ReactNode
}) {
  return (
    <box
      border
      borderStyle="rounded"
      borderColor={theme.dim}
      flexDirection="column"
      height={OVERLAY_HEIGHT}
      flexShrink={0}
      title={typeof title === "string" ? ` ${title} ` : undefined}
      titleColor={theme.dim}
    >
      <box flexGrow={1} flexDirection="column">
        {typeof title !== "string" ? title : null}
        {children}
      </box>
      {typeof hint === "string" ? <text fg={theme.dim}>{` ${hint}`}</text> : hint}
    </box>
  )
}

export type Line = { label: string; detail?: string; dim?: boolean; color?: keyof Theme; badge?: { text: string; role: "success" | "warn" | "error" | "info" | "dim" }; toggle?: boolean; toggleLayout?: "before" | "right" }

/** Shared on/off glyph for both toggle layouts; focus never changes its state color. */
export function Toggle({ checked, theme }: { checked: boolean; theme: Theme }) {
  return <text width={4} height={1} flexShrink={0} fg={checked ? theme.success : theme.dim} wrapMode="none">{checked ? "[━●]" : "[●─]"}</text>
}

/** Read the actual layout, including subsequent terminal and sibling resizes. */
export function useBodyHeight(fallback = 1) {
  const renderer = useRenderer()
  const ref = useRef<BoxRenderable | null>(null)
  const [size, setSize] = useState({ height: fallback, width: 80 })
  useEffect(() => {
    const node = ref.current
    if (!node) return
    let previous = ""
    const read = () => {
      const height = Math.max(1, Math.floor(node.height))
      const width = Math.max(1, Math.floor(node.width))
      const signature = `${width}:${height}`
      if (signature !== previous) { previous = signature; setSize({ height, width }) }
    }
    // Native-scene boxes reject per-node resize hooks. Frame events run after
    // native layout, and also cover changes to sibling and parent allocations.
    renderer.on("frame", read)
    return () => { renderer.off("frame", read) }
  }, [renderer])
  return { ref, ...size }
}

export function Lines({
  rows,
  selected,
  theme,
  visible,
  onPress,
}: {
  rows: Line[]
  selected: number
  theme: Theme
  /** Used only until the box reports its real height. */
  visible?: number
  onPress: (index: number) => void
}) {
  const full = useContext(FullscreenContext)
  const { ref: boxRef, height: fitted } = useBodyHeight(visible ?? Math.max(1, rows.length))
  const indicator = full && rows.length > fitted && fitted > 2
  const slots = Math.max(1, fitted - (indicator ? 1 : 0))
  const startRef = useRef(0)
  const start = selected < 0 ? 0 : paletteWindow(startRef.current, selected, rows.length, slots)
  startRef.current = start
  const window = rows.slice(start, start + slots)
  return (
    <box ref={boxRef} flexDirection="column" flexGrow={1} flexBasis={0} flexShrink={1} minHeight={0} overflow="hidden">
      {rows.length === 0 ? <text fg={theme.dim}> Nothing here yet</text> : null}
      {window.map((row, index) => {
        const absolute = start + index
        return (
          <LineRow
            key={index}
            row={row}
            on={selected >= 0 && absolute === selected}
            theme={theme}
            full={full}
            onPress={() => onPress(absolute)}
          />
        )
      })}
      <box position="absolute" left={0} bottom={0} width="100%" height={1} visible={indicator} backgroundColor={theme.bg} zIndex={1}>
        <text fg={theme.dim} wrapMode="none">{` ${start > 0 ? "↑ " : ""}${start + 1}–${Math.min(rows.length, start + slots)} / ${rows.length}${start + slots < rows.length ? " ↓" : ""}`}</text>
      </box>
    </box>
  )
}

function LineRow({
  row,
  on,
  theme,
  onPress,
  full,
}: {
  row: Line
  on: boolean
  theme: Theme
  onPress: () => void
  full: boolean
}) {
  const [hot, setHot] = useState(false)
  const labelColor = on || hot ? theme.accent : row.dim ? theme.dim : theme.fg
  const detailColor = row.color ? theme[row.color] as string : !full && on ? theme.success : theme.dim
  const marker = on ? full ? "› " : "● " : "  "
  const content = <><span fg={labelColor}>{row.label}</span>
    {row.badge ? <span fg={theme[row.badge.role]}>{`  ${row.badge.text}`}</span> : null}
    {row.detail ? <span fg={detailColor}>{`  ${row.detail}`}</span> : null}
  </>
  return (
    <box width="100%" height={1} flexShrink={0} flexDirection={row.toggle != null ? "row" : "column"} backgroundColor={full ? on || hot ? theme.panel : theme.bg : undefined} paddingLeft={1} paddingRight={1} onMouseOver={() => setHot(true)} onMouseOut={() => setHot(false)} onMouseDown={onPress}>
      {row.toggle != null ? <>
        <text width={2} height={1} flexShrink={0} fg={on ? theme.accent : theme.dim}>{marker}</text>
        {row.toggleLayout === "before" ? <box width={5} height={1} flexShrink={0}><Toggle checked={row.toggle} theme={theme} /></box> : null}
        <box flexGrow={1} flexBasis={0} minWidth={0} overflow="hidden"><text wrapMode="none">{content}</text></box>
        {row.toggleLayout !== "before" ? <box width={5} height={1} flexShrink={0} paddingLeft={1}><Toggle checked={row.toggle} theme={theme} /></box> : null}
      </> : <text wrapMode="none"><span fg={on ? theme.accent : theme.dim}>{marker}</span>{content}</text>}
    </box>
  )
}

export function Note({ text, theme, color }: { text: string; theme: Theme; color?: string }) {
  if (!text) return null
  return <text fg={color ?? theme.dim}>{text}</text>
}

export function FieldList({
  rows,
  selected,
  theme,
  editing,
  onPress,
}: {
  rows: Line[]
  selected: number
  theme: Theme
  editing?: boolean
  onPress: (index: number) => void
}) {
  const full = useContext(FullscreenContext)
  const { ref, height } = useBodyHeight(12)
  const start = paletteWindow(0, selected, rows.length, Math.max(1, Math.floor(height / 3)))
  return (
    <box ref={ref} flexDirection="column" flexGrow={1} flexBasis={0} minHeight={0} overflow="hidden">
      {rows.slice(start, start + Math.max(1, Math.floor(height / 3))).map((row, offset) => row.toggle != null
        ? <box key={start + offset} height={3} flexShrink={0} paddingTop={1} paddingBottom={1}><LineRow row={row} on={start + offset === selected} theme={theme} full={full} onPress={() => onPress(start + offset)} /></box>
        : <InputField key={start + offset} field={row.label} label={row.label} value={row.detail ?? ""} active={start + offset === selected} editing={editing && start + offset === selected} theme={theme} onPress={() => onPress(start + offset)} />)}
    </box>
  )
}

export function Split({
  wide,
  theme,
  listTitle,
  list,
  detail,
}: {
  wide: boolean
  theme: Theme
  listTitle?: string
  list: ReactNode
  detail: ReactNode
}) {
  return (
    <box flexDirection={wide ? "row" : "column"} flexGrow={1} flexBasis={0} minHeight={0} gap={1}>
      <box width={wide ? "42%" : "100%"} flexGrow={wide ? 0 : 2} flexBasis={wide ? undefined : 0} minWidth={0} minHeight={0} flexDirection="column">
        <Panel title={listTitle || "select"} hot theme={theme}>
        {list}
        </Panel>
      </box>
      <box flexGrow={1} flexBasis={0} minWidth={0} minHeight={0} flexDirection="column">
        <Panel title="detail" hot={false} theme={theme}>
        {detail}
        </Panel>
      </box>
    </box>
  )
}

export function Panel({
  title,
  mark,
  actions,
  maxLines,
  hot,
  theme,
  children,
}: {
  title: string
  /** Index of an existing shortcut letter in the title. */
  mark?: number
  /** Clickable actions placed in the top-right border. */
  actions?: ReactNode
  /** Content rows. When set, the box does not grow past this. */
  maxLines?: number
  hot: boolean
  theme: Theme
  children: ReactNode
}) {
  return (
    <box
      flexGrow={maxLines == null ? 1 : 0}
      flexBasis={maxLines == null ? 0 : undefined}
      flexShrink={maxLines == null ? 1 : 0}
      height={maxLines == null ? undefined : maxLines + 2}
      minHeight={0}
      minWidth={0}
      overflow="hidden"
      flexDirection="column"
    >
      <box border borderStyle="rounded" borderColor={hot ? theme.accent : theme.dim} title={` ${title} `} titleColor={mark != null ? hot ? theme.fg : theme.dim : hot ? theme.accent : theme.dim} flexGrow={1} flexBasis={0} minHeight={0} minWidth={0} overflow="hidden" flexDirection="column">
        {children}
      </box>
      {mark != null && mark >= 0 && mark < title.length ? <text position="absolute" left={3 + mark} top={0} height={1} width={1} zIndex={1} fg={theme.accent} bg={theme.bg}>{title[mark]}</text> : null}
      {actions ? <box position="absolute" right={2} top={0} height={1} flexDirection="row" backgroundColor={theme.bg} zIndex={1}>{actions}</box> : null}
    </box>
  )
}

export function sendKey(send: (request: unknown) => void, code: string | { Char: string }) {
  send({ SendKey: { code, mods: 0 } })
}

/** Compatibility for existing view callbacks; direct selection, never arrow replay. */
export function nudge(send: (request: unknown) => void, _from: number, to: number) {
  select(send, to)
}

export function Paragraphs({ lines, theme }: { lines: string[]; theme: Theme }) {
  return (
    <scrollbox flexGrow={1} flexBasis={0} minHeight={0} scrollY focusable={false} contentOptions={{ paddingLeft: 0, paddingRight: 0 }}>
      {lines.map((line, index) => (
        <text key={index} fg={theme.fg}>
          {line || " "}
        </text>
      ))}
    </scrollbox>
  )
}

/** Daemon-owned input: the outline makes the editing target visible. */
export function InputField({ label, value, placeholder = "Not set", active = false, editing = active, theme, onPress, field, secret = false, onChange }: {
  label: string; value: string; placeholder?: string; active?: boolean; editing?: boolean; theme: Theme; onPress?: () => void; field?: string; secret?: boolean; onChange?: (value: string) => void
}) {
  const update = useContext(DraftContext)
  const { ref, width } = useBodyHeight(3)
  if ((onChange || update && field) && editing) return <EditableField label={label} value={value} placeholder={placeholder} theme={theme} secret={secret} listNavigation={["query", "Model", "directory"].includes(field ?? "")} onChange={onChange ?? ((next) => update!(field!, next))} />
  const chars = [...value]
  const capacity = Math.max(1, width - 5)
  const shown = editing && chars.length > capacity ? `…${chars.slice(-(capacity - 1)).join("")}` : value
  return (
    <box ref={ref} height={3} flexShrink={0} border borderStyle="rounded" borderColor={active ? theme.accent : theme.dim} title={` ${label} `} titleColor={active ? theme.accent : theme.dim} flexDirection="column" onMouseDown={onPress}>
      <box height={1} paddingLeft={1} paddingRight={1}>
        <text wrapMode="none"><span fg={value ? theme.fg : theme.dim}>{shown || placeholder}</span>{editing ? <span fg={theme.accent}>▮</span> : null}</text>
      </box>
    </box>
  )
}

export function Action({ label, theme, onPress, primary = false, disabled = false }: { label: string; theme: Theme; onPress: () => void; primary?: boolean; disabled?: boolean }) {
  const [hot, setHot] = useState(false)
  const full = useContext(FullscreenContext)
  const shortcut = full ? /^(.*?)( \([^()]+\))$/.exec(label) : null
  return <box height={1} flexShrink={0} paddingLeft={1} paddingRight={1} backgroundColor={!full && primary ? theme.selBg : hot ? theme.panel : undefined} onMouseOver={() => setHot(true)} onMouseOut={() => setHot(false)} onMouseDown={() => { if (!disabled) onPress() }}><text fg={disabled ? theme.dim : !full ? primary ? theme.selFg : theme.accent : primary || hot ? theme.accent : theme.fg}>{full ? shortcut ? <><span>{shortcut[1]}</span><span fg={theme.dim}>{shortcut[2]}</span></> : label : `[ ${label} ]`}</text></box>
}

export function Controls({ actions, theme, send }: { actions: ActionDescriptor[]; theme: Theme; send: (request: unknown) => void }) {
  return <box flexDirection="row" flexWrap="wrap" columnGap={1} rowGap={0} flexShrink={0}>
    {actions.map((action, index) => <Action key={index} label={action.label} primary={action.primary} disabled={action.disabled} theme={theme} onPress={() => {
      if (action.action) send({ MenuAction: action.action })
      else if (action.key) send({ SendKey: action.key })
    }} />)}
  </box>
}

function EditableField({ label, value, placeholder, secret, theme, onChange, listNavigation }: { label: string; value: string; placeholder: string; secret: boolean; theme: Theme; onChange: (value: string) => void; listNavigation: boolean }) {
  const ref = useRef<InputRenderable | null>(null)
  const [length, setLength] = useState(0)
  const initial = useRef(secret ? "" : value)
  // Native buffer owns cursor, selection, paste and draft. Snapshot refreshes
  // cannot replace this input while the user is editing it.
  useEffect(() => {
    const node = ref.current
    nativeMenuInput.current = node
    nativeMenuInput.multiline = false
    nativeMenuInput.listNavigation = listNavigation
    return () => { if (nativeMenuInput.current === node) nativeMenuInput.current = null }
  }, [])
  return <box height={3} flexShrink={0} border borderStyle="rounded" borderColor={theme.accent} title={` ${label} `} titleColor={theme.accent} flexDirection="column">
    <box height={1} paddingLeft={1} paddingRight={1}>
      <input ref={ref} flexGrow={1} focused keyBindings={[{ name: "a", ctrl: true, action: "select-all" }]} value={initial.current} placeholder={placeholder} textColor={secret ? theme.bg : theme.fg} focusedTextColor={secret ? theme.bg : theme.fg} backgroundColor={theme.bg} focusedBackgroundColor={theme.bg} cursorColor={theme.accent} onInput={(next: string) => { setLength([...next].length); onChange(next) }} />
      {secret ? <box position="absolute" left={0} top={0}><text fg={theme.fg}>{"•".repeat(Math.min(60, length))}</text></box> : null}
    </box>
  </box>
}

export function Document({ children, target }: { children: ReactNode; target?: string }) {
  const ref = useRef<ScrollBoxRenderable | null>(null)
  useKeyboard((key) => {
    if (key.eventType === "release" || nativeMenuInput.current) return
    if (!target && key.name === "up") ref.current?.scrollBy(-1)
    if (!target && key.name === "down") ref.current?.scrollBy(1)
    if (key.name === "pageup") ref.current?.scrollBy(-1, "viewport")
    if (key.name === "pagedown") ref.current?.scrollBy(1, "viewport")
    if (!target && key.name === "home") ref.current?.scrollTo(0)
    if (!target && key.name === "end") ref.current?.scrollTo(ref.current.scrollHeight)
  })
  const renderer = useRenderer()
  useEffect(() => {
    if (!target) return
    let previous = ""
    const follow = () => {
      const box = ref.current
      if (!box) return
      const signature = `${box.width}:${box.height}:${box.scrollHeight}`
      if (signature === previous) return
      previous = signature
      box.scrollChildIntoView(target)
    }
    renderer.on("frame", follow)
    return () => { renderer.off("frame", follow) }
  }, [renderer, target])
  return <scrollbox ref={ref} flexGrow={1} flexBasis={0} minHeight={0} scrollY focusable={false} contentOptions={{ paddingLeft: 0, paddingRight: 0 }}>{children}</scrollbox>
}
