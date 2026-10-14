import type { ScrollBoxRenderable, SyntaxStyle, TextareaRenderable } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/react"
import { existsSync } from "node:fs"
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import {
  CHAT_TURNS_DEFAULT,
  historyRows,
  nextRenderFrom,
  pageFromTurn,
  visibleFromTurn,
} from "./history.ts"
import { PALETTE_VISIBLE, paletteWindow } from "./palette.ts"
import { attachmentFile } from "./paths.ts"
import {
  showImagePath,
  type Attachment,
  type ChatMessage,
  type ContextUsage,
  type SessionSnap,
  type Snapshot,
  type ToolCall,
} from "./protocol.ts"
import type { Theme } from "./theme.ts"

const COMPOSER_KEYS = [
  { name: "return", action: "submit" as const },
  { name: "enter", action: "submit" as const },
  { name: "kpenter", action: "submit" as const },
  { name: "return", shift: true, action: "newline" as const },
  { name: "enter", shift: true, action: "newline" as const },
  { name: "kpenter", shift: true, action: "newline" as const },
  { name: "j", ctrl: true, action: "newline" as const },
]
const PALETTE_KEYS = [
  { name: "up", action: "palette-nav" as const },
  { name: "down", action: "palette-nav" as const },
  { name: "tab", action: "palette-nav" as const },
]

export function Chat({
  snap,
  theme,
  syntaxStyle,
  focused,
  send,
  sendTracked,
  onFlushError,
}: {
  snap: Snapshot
  theme: Theme
  syntaxStyle: SyntaxStyle
  focused: boolean
  send: (request: unknown) => void
  sendTracked: (request: unknown) => Promise<string>
  onFlushError: (text: string) => void
}) {
  const flushRef = useRef<() => Promise<boolean>>(async () => true)
  const session = snap.sessions.find((row) => row.id === snap.foreground_id) ?? snap.sessions[0]
  if (!session) {
    return (
      <box flexGrow={1}>
        <text fg={theme.dim}>This daemon has no session yet.</text>
      </box>
    )
  }
  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={theme.bg} paddingTop={1} paddingBottom={1}>
      <Header snap={snap} session={session} theme={theme} />
      <HistoryPane session={session} theme={theme} syntaxStyle={syntaxStyle} />
      <Steers session={session} theme={theme} selected={snap.global.pending_steer_sel} />
      <ModelRow model={session.resolved_model_id} theme={theme} />
      {session.awaiting_approval ? <Approval session={session} theme={theme} send={send} /> : null}
      <Palette snap={snap} theme={theme} flushRef={flushRef} send={send} />
      <Composer
        snap={snap}
        session={session}
        theme={theme}
        focused={focused}
        send={send}
        sendTracked={sendTracked}
        flushRef={flushRef}
        onFlushError={onFlushError}
      />
      <Status snap={snap} session={session} theme={theme} />
    </box>
  )
}

function Header({ snap, session, theme }: { snap: Snapshot; session: SessionSnap; theme: Theme }) {
  const version = process.env.KOMA_VERSION ?? ""
  const latest = snap.global.latest_version
  const update = latest && latest !== version ? latest : null
  const mode = modeMark(snap.global.agent_mode, session)
  const toast = snap.global.toast
  const toastId = snap.global.toast_event_id ?? (toast ? `${toast[0]}:${toast[1]}` : "")
  const [dismissedId, setDismissedId] = useState<string | null>(null)
  // A cleared toast has no wire event. The daemon drops it on its own clock
  // (error 6s, info 8s) and the legacy client does the same locally.
  useEffect(() => {
    if (!toast || dismissedId === toastId) return
    const ms = toast[0] === "error" ? 6000 : 8000
    const timer = setTimeout(() => setDismissedId(toastId), ms)
    return () => clearTimeout(timer)
  }, [toast, toastId, dismissedId])
  const shown = toast && dismissedId !== toastId ? toast : null
  const toastLines = shown ? shown[1].replace(/^\n+/, "").split("\n").filter((line) => line.length > 0).slice(0, 4) : []
  const toastColor = shown?.[0] === "error" ? theme.error : theme.accent
  return (
    <box
      height={toastLines.length === 0 ? 2 : undefined}
      border={["bottom"]}
      borderColor={toastLines.length > 0 ? toastColor : theme.dim}
      flexDirection="column"
      paddingLeft={2}
      paddingRight={2}
    >
      <box flexDirection="row" justifyContent="space-between">
        <text>
          <span fg={theme.dim}>koma </span>
          <span fg={update ? theme.error : theme.success}>{version}</span>
          {update ? <span fg={theme.success}>{` [${update}]`}</span> : null}
        </text>
        <text fg={mode.color === "success" ? theme.success : mode.color === "warn" ? theme.warn : mode.color === "error" ? theme.error : theme.info}>
          {`${mode.icon} ${mode.label}`}
        </text>
      </box>
      {toastLines.map((line, index) => (
        <text key={index} fg={toastColor} selectable>
          {line}
        </text>
      ))}
    </box>
  )
}

function modeMark(agentMode: string, session: SessionSnap | undefined): { icon: string; label: string; color: string } {
  switch (agentMode) {
    case "auto":
      return { icon: "»", label: "auto", color: "warn" }
    case "plan":
      return { icon: "●", label: "planning", color: "info" }
    case "yolo":
      return { icon: "!", label: "yooloo", color: "error" }
    case "sdlc": {
      const phase = session?.sdlc_phase
      const branch = session?.sdlc_branch
      const label = phase ? (branch ? `sdlc:${phase} · ${branch}` : `sdlc:${phase}`) : "sdlc"
      return { icon: "◆", label, color: "info" }
    }
    default:
      return { icon: "●", label: "normal", color: "success" }
  }
}

function HistoryPane({
  session,
  theme,
  syntaxStyle,
}: {
  session: SessionSnap
  theme: Theme
  syntaxStyle: SyntaxStyle
}) {
  const scrollRef = useRef<ScrollBoxRenderable | null>(null)
  const stickRef = useRef(true)
  const expandingRef = useRef(false)
  const restoreRef = useRef<number | null>(null)
  const rows = useMemo(() => historyRows(session.messages), [session.messages])
  const prevRows = useRef(rows)
  const prevSession = useRef(session.id)
  const [from, setFrom] = useState(() => visibleFromTurn(historyRows(session.messages), CHAT_TURNS_DEFAULT))
  const [following, setFollowing] = useState(true)

  useEffect(() => {
    const sessionChanged = prevSession.current !== session.id
    const next = nextRenderFrom(
      prevRows.current,
      rows,
      from,
      stickRef.current,
      CHAT_TURNS_DEFAULT,
      sessionChanged,
    )
    prevRows.current = rows
    prevSession.current = session.id
    if (sessionChanged) {
      stickRef.current = true
      setFollowing(true)
    }
    if (next !== from) setFrom(next)
  }, [rows, session.id, from])

  useEffect(() => {
    const box = scrollRef.current
    const marker = restoreRef.current
    if (!box || marker == null) return
    restoreRef.current = null
    queueMicrotask(() => {
      box.scrollTop = Math.max(0, box.scrollHeight - marker)
      expandingRef.current = false
    })
  }, [from])

  function expand() {
    if (expandingRef.current || from <= 0) return
    const next = pageFromTurn(rows, from, CHAT_TURNS_DEFAULT)
    if (next >= from) return
    const box = scrollRef.current
    if (box) restoreRef.current = box.scrollHeight - box.scrollTop
    stickRef.current = false
    expandingRef.current = true
    setFollowing(false)
    setFrom(next)
  }

  function followTail() {
    const was = stickRef.current
    stickRef.current = true
    setFollowing(true)
    if (was) return
    const tail = visibleFromTurn(rows, CHAT_TURNS_DEFAULT)
    if (tail !== from) setFrom(tail)
  }

  function syncScroll() {
    const box = scrollRef.current
    if (!box || expandingRef.current) return
    const view = box.viewport?.height ?? box.height
    const distance = box.scrollHeight - box.scrollTop - view
    if (distance < 2) {
      followTail()
      return
    }
    if (stickRef.current) {
      stickRef.current = false
      setFollowing(false)
    }
    if (box.scrollTop < 2) expand()
  }

  const start = rows[from]?.sourceIndex ?? 0
  const mounted = { ...session, messages: session.messages.slice(start) }
  return (
    <scrollbox
      ref={scrollRef}
      flexGrow={1}
      stickyScroll={following}
      stickyStart="bottom"
      scrollY
      focusable={false}
      onMouseScroll={() => queueMicrotask(syncScroll)}
      onMouseUp={() => queueMicrotask(syncScroll)}
    >
      <Transcript session={mounted} theme={theme} syntaxStyle={syntaxStyle} />
    </scrollbox>
  )
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
const SHELL_MARK = "\u2064"
const BASH_NUDGE_MARK = "\u2061"
const EXT_PROMPT_MARK = "\u2060\u2060"

function Transcript({
  session,
  theme,
  syntaxStyle,
}: {
  session: SessionSnap
  theme: Theme
  syntaxStyle: SyntaxStyle
}) {
  const results = new Map<string, ChatMessage>()
  for (const message of session.messages) {
    if (message.role === "tool" && message.tool_call_id) results.set(message.tool_call_id, message)
  }
  const visible = session.messages.filter((message) => message.role !== "system" && message.role !== "tool")
  const used = new Set<string>()
  for (const message of visible) {
    for (const call of message.tool_calls ?? []) used.add(call.id)
  }
  const live = Boolean(session.streaming || session.stream_reasoning)
  const pending = session.pending_tool_calls.filter((call) => !used.has(call.id))
  return (
    <box flexDirection="column" gap={1} paddingLeft={1} paddingRight={1}>
      {visible.map((message, index) => (
        <HistoryTurn
          key={`${index}-${message.role}-${message.tool_call_id ?? ""}`}
          message={message}
          session={session}
          theme={theme}
          syntaxStyle={syntaxStyle}
          results={results}
        />
      ))}
      {live || pending.length > 0 ? (
        <AssistantCard theme={theme}>
          {session.stream_reasoning ? (
            <Reasoning text={session.stream_reasoning} theme={theme} syntaxStyle={syntaxStyle} defaultOpen streaming />
          ) : null}
          {session.streaming ? (
            <MarkdownBody content={session.streaming} syntaxStyle={syntaxStyle} fg={theme.fg} streaming />
          ) : null}
          {pending.map((call) => (
            <ToolCard key={call.id} call={call} result={results.get(call.id)} theme={theme} syntaxStyle={syntaxStyle} />
          ))}
        </AssistantCard>
      ) : null}
    </box>
  )
}

function HistoryTurn({
  message,
  session,
  theme,
  syntaxStyle,
  results,
}: {
  message: ChatMessage
  session: SessionSnap
  theme: Theme
  syntaxStyle: SyntaxStyle
  results: Map<string, ChatMessage>
}) {
  if (message.role === "user") {
    if (message.content.startsWith(BASH_NUDGE_MARK) || message.content.startsWith(EXT_PROMPT_MARK)) {
      const body = message.content.replace(BASH_NUDGE_MARK, "").replace(EXT_PROMPT_MARK, "")
      const summary = body.split("\n")[0] ?? ""
      return (
        <text fg={theme.dim} selectable>
          <span fg={theme.success}>✓ </span>
          {summary}
        </text>
      )
    }
    if (message.content.startsWith(SHELL_MARK)) {
      const body = message.content.slice(SHELL_MARK.length)
      const [head, ...rest] = body.split("\n")
      const cmd = (head ?? "").replace(/^\$\s?/, "")
      return (
        <box flexDirection="column">
          <text fg={theme.accent} selectable>
            {`$ ${cmd}`}
          </text>
          {rest.join("\n").trim() ? (
            <text fg={theme.dim} selectable>
              {clip(rest.join("\n"))}
            </text>
          ) : null}
        </box>
      )
    }
    return <UserBand message={message} session={session} theme={theme} syntaxStyle={syntaxStyle} />
  }
  return (
    <AssistantCard theme={theme}>
      {message.reasoning ? (
        <Reasoning text={message.reasoning} theme={theme} syntaxStyle={syntaxStyle} defaultOpen={false} />
      ) : null}
      {message.content ? <MarkdownBody content={message.content} syntaxStyle={syntaxStyle} fg={theme.fg} /> : null}
      {message.tool_calls?.map((call) => (
        <ToolCard
          key={call.id}
          call={call}
          result={results.get(call.id)}
          theme={theme}
          syntaxStyle={syntaxStyle}
        />
      ))}
    </AssistantCard>
  )
}

function UserBand({
  message,
  session,
  theme,
  syntaxStyle,
}: {
  message: ChatMessage
  session: SessionSnap
  theme: Theme
  syntaxStyle: SyntaxStyle
}) {
  return (
    <box flexDirection="column" gap={1}>
      <box flexDirection="row" backgroundColor={theme.panel}>
        <box width={1} backgroundColor={theme.accent} />
        <box flexGrow={1} paddingLeft={1} paddingRight={1} paddingTop={1} paddingBottom={1} backgroundColor={theme.panel}>
          {message.content ? (
            <MarkdownBody content={message.content} syntaxStyle={syntaxStyle} fg={theme.accent} />
          ) : null}
        </box>
      </box>
      {message.attachments?.map((attachment) => (
        <AttachmentCard
          key={`${attachment.kind ?? "image"}-${attachment.marker_n}`}
          attachment={attachment}
          session={session}
          theme={theme}
        />
      ))}
    </box>
  )
}

function AssistantCard({ theme, children }: { theme: Theme; children: ReactNode }) {
  return (
    <box flexDirection="row">
      <box width={1} border={["left"]} borderColor={theme.dim} />
      <box flexGrow={1} flexDirection="column" paddingLeft={1} gap={1}>
        {children}
      </box>
    </box>
  )
}

function MarkdownBody({
  content,
  syntaxStyle,
  fg,
  streaming,
}: {
  content: string
  syntaxStyle: SyntaxStyle
  fg: string
  streaming?: boolean
}) {
  return (
    <markdown
      content={content}
      syntaxStyle={syntaxStyle}
      fg={fg}
      conceal
      selectable
      streaming={streaming}
      internalBlockMode="top-level"
      renderNode={renderMarkdownNode}
    />
  )
}

type ListNode = {
  width?: number
  content?: unknown
  chunks?: Array<{ text?: string }>
  getChildren?: () => ListNode[]
}

/** Keep lists as real blocks, then give each marker a gutter so wrapped lines hang. */
function renderMarkdownNode(token: { type?: string }, context: { defaultRender: () => ListNode | null }) {
  if (token.type !== "list") return null
  const list = context.defaultRender()
  if (list) dressList(list)
  return list
}

function dressList(list: ListNode) {
  for (const row of list.getChildren?.() ?? []) {
    const cells = row.getChildren?.() ?? []
    const marker = cells[0]
    const text = marker?.chunks?.[0]?.text
    if (!marker || typeof text !== "string") continue
    const trimmed = text.trim()
    if (trimmed === "-" || /^\d+\.$/.test(trimmed)) {
      const width = typeof marker.width === "number" ? marker.width : text.length
      marker.width = width + 2
    }
    const content = cells[1]
    if (!content) continue
    for (const child of content.getChildren?.() ?? []) {
      const nested = child.getChildren?.() ?? []
      const nestedMarker = nested[0]?.getChildren?.()?.[0]?.chunks?.[0]?.text
      if (typeof nestedMarker === "string") dressList(child)
    }
  }
}

function Reasoning({
  text,
  theme,
  syntaxStyle,
  defaultOpen,
  streaming,
}: {
  text: string
  theme: Theme
  syntaxStyle: SyntaxStyle
  defaultOpen: boolean
  streaming?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  useEffect(() => {
    if (defaultOpen) setOpen(true)
  }, [defaultOpen])
  return (
    <box flexDirection="column">
      <box onMouseDown={() => setOpen((value) => !value)}>
        <text fg={theme.dim}>{`${open ? "▾" : "▸"} reasoning`}</text>
      </box>
      {open ? <MarkdownBody content={text} syntaxStyle={syntaxStyle} fg={theme.dim} streaming={streaming} /> : null}
    </box>
  )
}

function AttachmentCard({
  attachment,
  session,
  theme,
}: {
  attachment: Attachment
  session: SessionSnap
  theme: Theme
}) {
  if (attachment.kind === "pasted_text") {
    return (
      <box border borderStyle="rounded" borderColor={theme.dim} paddingLeft={1} paddingRight={1}>
        <text fg={theme.dim}>{attachment.label || `Pasted text #${attachment.marker_n}`}</text>
      </box>
    )
  }
  const path = attachmentFile(session.cwd, session.id, attachment.rel_path)
  return (
    <box border borderStyle="rounded" borderColor={theme.dim} paddingLeft={1} paddingRight={1} flexDirection="column">
      <text fg={theme.dim}>{`image #${attachment.marker_n}`}</text>
      {existsSync(path) ? <image source={path} protocol="blocks" width={48} height={12} /> : null}
    </box>
  )
}

function ToolCard({
  call,
  result,
  theme,
  syntaxStyle,
}: {
  call: ToolCall
  result?: ChatMessage
  theme: Theme
  syntaxStyle: SyntaxStyle
}) {
  const [open, setOpen] = useState(false)
  const [hot, setHot] = useState(false)
  const [tick, setTick] = useState(0)
  const done = Boolean(result)
  useEffect(() => {
    if (done) return
    const timer = setInterval(() => setTick((value) => value + 1), 80)
    return () => clearInterval(timer)
  }, [done])
  const mark = done ? "✓" : (SPINNER[tick % SPINNER.length] ?? "⠋")
  const digest = planDigest(call.function.arguments)
  const image = result ? showImagePath(result.content) : null
  return (
    <box border borderStyle="rounded" borderColor={hot ? theme.accent : theme.dim} flexDirection="column">
      <box
        flexDirection="row"
        justifyContent="space-between"
        paddingLeft={1}
        paddingRight={1}
        onMouseOver={() => setHot(true)}
        onMouseOut={() => setHot(false)}
        onMouseDown={() => setOpen((value) => !value)}
      >
        <text>
          <span fg={done ? theme.accent : theme.info}>{`${mark} `}</span>
          <span fg={theme.fg}>{call.function.name}</span>
          <span fg={theme.dim}>{`  ${toolHint(call.function.arguments)}`}</span>
        </text>
        <text fg={theme.dim}>{open ? "▾" : "▸"}</text>
      </box>
      {open ? (
        <box border={["top"]} borderColor={theme.dim} paddingLeft={1} paddingRight={1} flexDirection="column">
          {digest ? (
            <MarkdownBody content={digest} syntaxStyle={syntaxStyle} fg={theme.fg} />
          ) : (
            <>
              <text fg={theme.dim}>payload</text>
              <text fg={theme.fg} selectable>
                {clip(call.function.arguments || "{}")}
              </text>
            </>
          )}
          {image && existsSync(image) ? <image source={image} protocol="blocks" width={48} height={12} /> : null}
          {result?.content ? (
            <>
              <text fg={theme.dim}>result</text>
              <text fg={theme.fg} selectable>
                {capResult(result.content)}
              </text>
            </>
          ) : null}
        </box>
      ) : null}
    </box>
  )
}

function Steers({ session, theme, selected }: { session: SessionSnap; theme: Theme; selected: number }) {
  if (session.pending_steer.length === 0) return null
  return (
    <box border={["top"]} borderColor={theme.dim} paddingLeft={2} paddingRight={2} flexDirection="column">
      {session.pending_steer.map((text, index) => (
        <text key={`${index}-${text.slice(0, 12)}`} fg={index === selected ? theme.accent : theme.dim}>
          {`${index === selected ? "●" : "○"} ${text}`}
        </text>
      ))}
    </box>
  )
}

function ModelRow({ model, theme }: { model: string; theme: Theme }) {
  return (
    <box height={1} flexDirection="row" justifyContent="flex-end" paddingRight={2}>
      <text fg={theme.dim}>{model}</text>
    </box>
  )
}

function Approval({
  session,
  theme,
  send,
}: {
  session: SessionSnap
  theme: Theme
  send: (request: unknown) => void
}) {
  const call = session.pending_tool_calls[session.tool_idx]
  const name = call?.function.name ?? "tool"
  const plan = name === "plan_ready" || name === "mission_ready"
  return (
    <box border={["top", "bottom"]} borderColor={theme.warn} paddingLeft={2} paddingRight={2} flexDirection="column">
      <text fg={theme.warn}>{name}</text>
      {session.approval_reason ? <text fg={theme.dim}>{session.approval_reason}</text> : null}
      <box flexDirection="row" gap={2}>
        <Choice label="y approve" theme={theme} onPress={() => send(charKey("y"))} />
        {plan ? <Choice label="a compact" theme={theme} onPress={() => send(charKey("a"))} /> : null}
        <Choice label="n deny" theme={theme} onPress={() => send(charKey("n"))} />
      </box>
    </box>
  )
}

function Palette({
  snap,
  theme,
  flushRef,
  send,
}: {
  snap: Snapshot
  theme: Theme
  flushRef: { current: () => Promise<boolean> }
  send: (request: unknown) => void
}) {
  const commands = snap.global.command_palette
  const files = snap.global.file_palette ?? []
  const command = commands.length > 0
  const rows = command
    ? commands.map((row) => ({ label: row.name, detail: row.desc }))
    : files.map((row) => ({ label: row, detail: "" }))
  const selected = rows.length === 0 ? 0 : Math.min(snap.global.palette_sel, rows.length - 1)
  const [start, setStart] = useState(0)
  useEffect(() => {
    setStart((current) => paletteWindow(current, selected, rows.length))
  }, [selected, rows.length])
  if (rows.length === 0) return null
  const slots = Array.from({ length: PALETTE_VISIBLE }, (_, index) => rows[start + index] ?? null)
  return (
    <box border borderStyle="rounded" borderColor={theme.dim} flexDirection="column" title={command ? " commands " : " files "} titleColor={theme.dim}>
      {slots.map((row, index) => {
        const absolute = start + index
        if (!row) return <box key={`empty-${index}`} height={1} />
        return (
          <Choice
            key={`${row.label}-${absolute}`}
            label={row.label}
            detail={row.detail}
            theme={theme}
            selected={absolute === selected}
            onPress={() => {
              void (async () => {
                await flushRef.current()
                const steps = absolute - selected
                const code = steps > 0 ? "Down" : "Up"
                for (let i = 0; i < Math.abs(steps); i++) send({ SendKey: { code, mods: 0 } })
                send({ SendKey: { code: "Enter", mods: 0 } })
              })()
            }}
          />
        )
      })}
    </box>
  )
}

function Composer({
  snap,
  session,
  theme,
  focused,
  send,
  sendTracked,
  flushRef,
  onFlushError,
}: {
  snap: Snapshot
  session: SessionSnap
  theme: Theme
  focused: boolean
  send: (request: unknown) => void
  sendTracked: (request: unknown) => Promise<string>
  flushRef: { current: () => Promise<boolean> }
  onFlushError: (text: string) => void
}) {
  const { height } = useTerminalDimensions()
  const area = useRef<TextareaRenderable | null>(null)
  const lastSent = useRef(snap.global.input)
  const lastCursor = useRef(snap.global.cursor)
  const applying = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [lines, setLines] = useState(Math.max(1, snap.global.input.split("\n").length))
  const innerCap = Math.max(1, Math.floor(height / 2) - 2)
  const boxHeight = Math.min(innerCap, Math.max(1, lines)) + 2
  const paletteOpen = snap.global.command_palette.length > 0 || (snap.global.file_palette?.length ?? 0) > 0
  useKeyboard((key) => {
    if (!paletteOpen || key.eventType === "release") return
    if (key.name === "up") send({ SendKey: { code: "Up", mods: 0 } })
    else if (key.name === "down") send({ SendKey: { code: "Down", mods: 0 } })
    else if (key.name === "tab") send({ SendKey: { code: key.shift ? "BackTab" : "Tab", mods: 0 } })
  })

  useEffect(() => {
    const current = area.current
    if (!current) return
    if (snap.global.input === lastSent.current) return
    if (current.plainText === snap.global.input) {
      lastSent.current = snap.global.input
      lastCursor.current = snap.global.cursor
      return
    }
    applying.current = true
    current.setText(snap.global.input)
    lastSent.current = snap.global.input
    lastCursor.current = snap.global.cursor
    setLines(Math.max(1, snap.global.input.split("\n").length))
    queueMicrotask(() => {
      applying.current = false
    })
  }, [snap.global.input, snap.global.cursor])

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  async function flush(): Promise<boolean> {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
    const current = area.current
    const text = current?.plainText ?? ""
    const cursor = current?.cursorCharacterOffset ?? [...text].length
    if (text === lastSent.current && cursor === lastCursor.current) return true
    const result = await sendTracked({ ReplaceInput: { text, cursor } })
    if (result !== "ack") {
      onFlushError(result)
      return false
    }
    lastSent.current = text
    lastCursor.current = cursor
    return true
  }
  flushRef.current = flush

  function schedule() {
    if (applying.current) return
    const text = area.current?.plainText ?? ""
    setLines(Math.max(1, text.split("\n").length))
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      void flush()
    }, 30)
  }

  return (
    <box
      border
      borderStyle="rounded"
      borderColor={focused ? theme.accent : theme.dim}
      title={session.name ? ` ${session.name} ` : undefined}
      titleAlignment="right"
      titleColor={theme.accent}
      height={boxHeight}
      flexDirection="row"
      paddingLeft={2}
      paddingRight={2}
    >
      <text fg={theme.accent}>[$] </text>
      <textarea
        ref={area}
        flexGrow={1}
        focused={focused}
        focusable
        initialValue={snap.global.input}
        textColor={theme.fg}
        focusedTextColor={theme.fg}
        backgroundColor={theme.bg}
        focusedBackgroundColor={theme.bg}
        keyBindings={paletteOpen ? [...COMPOSER_KEYS, ...PALETTE_KEYS] : COMPOSER_KEYS}
        onContentChange={schedule}
        onCursorChange={schedule}
        onSubmit={() => {
          void (async () => {
            const ok = await flush()
            if (ok) send({ SendKey: { code: "Enter", mods: 0 } })
          })()
        }}
      />
    </box>
  )
}

function Status({ snap, session, theme }: { snap: Snapshot; session: SessionSnap; theme: Theme }) {
  const elapsed = useWorkElapsed(snap.global.work_elapsed_ms, session.working || session.waiting)
  const readout = usageReadout(session)
  return (
    <box height={1} flexDirection="row" justifyContent="space-between" paddingLeft={2} paddingRight={2}>
      <text>
        {elapsed == null ? (
          <span fg={theme.dim}>{snap.global.status}</span>
        ) : (
          [
            <span key="spin" fg={theme.accent}>{`${SPINNER[Math.floor(elapsed / 80) % SPINNER.length] ?? "⠋"} `}</span>,
            <span key="status" fg={theme.fg}>{snap.global.status}</span>,
            <span key="time" fg={theme.dim}>{`  ${(elapsed / 1000).toFixed(1)}s`}</span>,
          ]
        )}
      </text>
      {readout ? <text fg={theme.accent}>{readout}</text> : null}
    </box>
  )
}

function useWorkElapsed(anchor: number | null, running: boolean): number | null {
  const [tick, setTick] = useState(0)
  const started = useRef(Date.now())
  useEffect(() => {
    started.current = Date.now()
  }, [anchor])
  useEffect(() => {
    if (!running || anchor == null) return
    const timer = setInterval(() => setTick((value) => value + 1), 80)
    return () => clearInterval(timer)
  }, [running, anchor])
  if (anchor == null || !running) return null
  void tick
  return anchor + (Date.now() - started.current)
}

function usageReadout(session: SessionSnap): string | null {
  const usage: ContextUsage | null = session.context_usage
  const input = usage ? usage.prompt_tokens : session.tokens_in
  if (!usage && input === 0 && session.tokens_out === 0 && session.cost === 0) return null
  const context =
    usage && usage.effective_window > 0
      ? `${usage.estimated ? "~" : ""}${Math.round((usage.prompt_tokens / usage.effective_window) * 100)}%`
      : "—%"
  const cached = usage?.cached_tokens ?? session.tokens_cached
  const cache = cached > 0 || usage?.cached_tokens != null ? `[${fmtCount(cached)}]` : ""
  return `${context} ↑${fmtCount(input)}${cache} ↓${fmtCount(session.tokens_out)} $${session.cost.toFixed(4)}`
}

function Choice({
  label,
  detail,
  theme,
  selected,
  onPress,
}: {
  label: string
  detail?: string
  theme: Theme
  selected?: boolean
  onPress: () => void
}) {
  const [hot, setHot] = useState(false)
  const on = hot || selected
  return (
    <box
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={on ? theme.selBg : theme.bg}
      onMouseOver={() => setHot(true)}
      onMouseOut={() => setHot(false)}
      onMouseDown={onPress}
    >
      <text>
        <span fg={on ? theme.selFg : theme.accent}>{label}</span>
        {detail ? <span fg={on ? theme.selFg : theme.dim}>{`  ${detail}`}</span> : null}
      </text>
    </box>
  )
}

function charKey(char: string): unknown {
  return { SendKey: { code: { Char: char }, mods: 0 } }
}

function planDigest(args: string): string | null {
  try {
    const parsed = JSON.parse(args) as { highlights?: unknown }
    return typeof parsed.highlights === "string" && parsed.highlights.trim() !== "" ? parsed.highlights : null
  } catch {
    return null
  }
}

function toolHint(args: string): string {
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>
    for (const key of ["path", "file", "command", "cmd", "query", "pattern"]) {
      const value = parsed[key]
      if (typeof value === "string" && value.trim()) return oneLine(value)
    }
    const first = Object.values(parsed).find((value) => typeof value === "string" && value.trim())
    if (typeof first === "string") return oneLine(first)
  } catch {
    // Arguments are not JSON yet; show the raw tail.
  }
  return oneLine(args)
}

function oneLine(text: string): string {
  const line = text.replace(/\s+/g, " ").trim()
  return line.length > 48 ? `${line.slice(0, 48)}…` : line
}

function capResult(text: string): string {
  const lines = text.split("\n")
  if (lines.length <= 15) return text
  return [...lines.slice(0, 14), "...."].join("\n")
}

function clip(text: string): string {
  const lines = text.split("\n")
  if (lines.length <= 8) return text
  return `${lines.slice(0, 8).join("\n")}\n…`
}

function fmtCount(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`
  return `${(n / 1_000_000).toFixed(1)}M`
}
