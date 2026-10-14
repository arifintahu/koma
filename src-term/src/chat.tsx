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
  rewind = null,
  send,
  sendTracked,
  onFlushError,
}: {
  snap: Snapshot
  theme: Theme
  syntaxStyle: SyntaxStyle
  focused: boolean
  rewind?: { entries: string[]; selected: number } | null
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
      <Toast snap={snap} theme={theme} />
      <HistoryPane session={session} theme={theme} syntaxStyle={syntaxStyle} />
      <Steers session={session} theme={theme} selected={snap.global.pending_steer_sel} />
      {session.awaiting_approval ? <Approval session={session} theme={theme} send={send} /> : null}
      {rewind ? (
        <RewindOverlay rewind={rewind} theme={theme} send={send} />
      ) : (
        <Palette snap={snap} theme={theme} flushRef={flushRef} send={send} />
      )}
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

const TOAST_MS = 3000

function Toast({ snap, theme }: { snap: Snapshot; theme: Theme }) {
  const toast = snap.global.toast
  const toastId = snap.global.toast_event_id ?? (toast ? `${toast[0]}:${toast[1]}` : "")
  const [dismissedId, setDismissedId] = useState<string | null>(null)
  const [leftMs, setLeftMs] = useState(TOAST_MS)
  useEffect(() => {
    if (!toast || dismissedId === toastId) return
    const started = Date.now()
    setLeftMs(TOAST_MS)
    const timer = setInterval(() => {
      const remain = TOAST_MS - (Date.now() - started)
      if (remain <= 0) {
        setDismissedId(toastId)
        return
      }
      setLeftMs(remain)
    }, 100)
    return () => clearInterval(timer)
  }, [toast, toastId, dismissedId])
  if (!toast || dismissedId === toastId) return null
  const error = toast[0] === "error"
  const color = error ? theme.error : theme.fg
  const text = toast[1].replace(/^\n+/, "").split("\n").filter((line) => line.length > 0).slice(0, 3).join(" ")
  const seconds = Math.max(1, Math.ceil(leftMs / 1000))
  return (
    <box
      border
      borderStyle="rounded"
      borderColor={theme.dim}
      flexShrink={0}
      flexDirection="row"
      justifyContent="space-between"
      paddingLeft={1}
      paddingRight={1}
      marginBottom={1}
    >
      <text fg={color} selectable>
        {text}
      </text>
      <text fg={theme.dim}>{`${seconds}s`}</text>
    </box>
  )
}

function modeMark(agentMode: string, session: SessionSnap | undefined): { icon: string; label: string; color: string } {
  switch (agentMode) {
    case "auto":
      return { icon: "»", label: "Auto", color: "warn" }
    case "plan":
      return { icon: "●", label: "Planning", color: "info" }
    case "yolo":
      return { icon: "!", label: "Yooloo", color: "error" }
    case "sdlc": {
      const phase = session?.sdlc_phase
      const branch = session?.sdlc_branch
      const label = phase ? (branch ? `sdlc:${phase} · ${branch}` : `sdlc:${phase}`) : "sdlc"
      return { icon: "◆", label, color: "info" }
    }
    default:
      return { icon: "●", label: "Normal", color: "success" }
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
  const stickyMessages = useRef<Array<ChatMessage | null>>([])
  const rows = useMemo(() => historyRows(session.messages), [session.messages])
  const prevRows = useRef(rows)
  const prevSession = useRef(session.id)
  const [from, setFrom] = useState(() => visibleFromTurn(historyRows(session.messages), CHAT_TURNS_DEFAULT))
  const [following, setFollowing] = useState(true)
  const [sticky, setSticky] = useState<ChatMessage | null>(null)

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

  function updateSticky() {
    const box = scrollRef.current
    const root = box?.content.getChildren()[0]
    if (!box || !root) return
    const top = box.scrollTop
    let next: ChatMessage | null = null
    for (const turn of root.getChildren()) {
      const id = String(turn.id ?? "")
      if (!id.startsWith("turn-")) continue
      const user = turn.getChildren().find((child) => String(child.id ?? "").startsWith("user-"))
      if (!user) continue
      const y = turn.y - root.y
      const pos = y >= 0 && y < box.scrollHeight ? y : turn.y
      if (pos + user.height <= top) {
        const index = Number(id.slice("turn-".length))
        next = stickyMessages.current[index] ?? null
      } else {
        break
      }
    }
    setSticky((current) => (current?.content === next?.content && current?.role === next?.role ? current : next))
  }

  function syncScroll() {
    const box = scrollRef.current
    if (!box || expandingRef.current) return
    updateSticky()
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
  useEffect(() => {
    const timer = setInterval(() => updateSticky(), 150)
    return () => clearInterval(timer)
  }, [])

  return (
    <box flexGrow={1} flexDirection="column">
      {sticky ? (
        <box flexShrink={0} backgroundColor={theme.bg}>
          <UserBand message={sticky} session={session} theme={theme} syntaxStyle={syntaxStyle} muted />
        </box>
      ) : null}
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
        <Transcript
          session={mounted}
          theme={theme}
          syntaxStyle={syntaxStyle}
          onTurns={(messages) => {
            stickyMessages.current = messages
          }}
        />
      </scrollbox>
    </box>
  )
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
const SHELL_MARK = "\u2064"
const BASH_NUDGE_MARK = "\u2061"
const EXT_PROMPT_MARK = "\u2060\u2060"

function groupTurns(messages: ChatMessage[]): { user: ChatMessage | null; rest: ChatMessage[] }[] {
  const turns: { user: ChatMessage | null; rest: ChatMessage[] }[] = []
  for (const message of messages) {
    if (message.role === "user") {
      turns.push({ user: message, rest: [] })
      continue
    }
    if (turns.length === 0) turns.push({ user: null, rest: [] })
    turns[turns.length - 1].rest.push(message)
  }
  return turns
}

function Transcript({
  session,
  theme,
  syntaxStyle,
  onTurns,
}: {
  session: SessionSnap
  theme: Theme
  syntaxStyle: SyntaxStyle
  onTurns: (users: Array<ChatMessage | null>) => void
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
  const turns = groupTurns(visible)
  onTurns(turns.map((turn) => turn.user))
  return (
    <box flexDirection="column" gap={1} paddingLeft={1} paddingRight={1}>
      {turns.map((turn, index) => (
        <box key={`turn-${index}`} id={`turn-${index}`} flexDirection="column" gap={1}>
          {turn.user ? (
            <box id={`user-${index}`}>
              <HistoryTurn
                message={turn.user}
                session={session}
                theme={theme}
                syntaxStyle={syntaxStyle}
                results={results}
              />
            </box>
          ) : null}
          {turn.rest.map((message, restIndex) => (
            <HistoryTurn
              key={`${index}-${restIndex}-${message.role}`}
              message={message}
              session={session}
              theme={theme}
              syntaxStyle={syntaxStyle}
              results={results}
            />
          ))}
        </box>
      ))}
      {live || pending.length > 0 ? (
        <AssistantCard theme={theme}>
          {session.stream_reasoning ? (
            <Reasoning text={session.stream_reasoning} theme={theme} syntaxStyle={syntaxStyle} defaultOpen streaming />
          ) : null}
          {session.streaming ? (
            <MarkdownBody content={session.streaming} syntaxStyle={syntaxStyle} fg={theme.fg} streaming />
          ) : null}
          {pending.length > 0 ? (
            <box flexDirection="column" gap={0}>
              {pending.map((call) => (
                <ToolCard key={call.id} call={call} result={results.get(call.id)} theme={theme} syntaxStyle={syntaxStyle} />
              ))}
            </box>
          ) : null}
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
      {message.tool_calls && message.tool_calls.length > 0 ? (
        <box flexDirection="column" gap={0}>
          {message.tool_calls.map((call) => (
            <ToolCard
              key={call.id}
              call={call}
              result={results.get(call.id)}
              theme={theme}
              syntaxStyle={syntaxStyle}
            />
          ))}
        </box>
      ) : null}
    </AssistantCard>
  )
}

function UserBand({
  message,
  session,
  theme,
  syntaxStyle,
  muted = false,
}: {
  message: ChatMessage
  session: SessionSnap
  theme: Theme
  syntaxStyle: SyntaxStyle
  muted?: boolean
}) {
  const ink = muted ? theme.dim : theme.accent
  return (
    <box flexDirection="column" gap={1}>
      <box flexDirection="row" backgroundColor={theme.panel}>
        <box width={1} backgroundColor={ink} />
        <box flexGrow={1} paddingLeft={1} paddingRight={1} paddingTop={1} paddingBottom={1} backgroundColor={theme.panel}>
          {message.content ? (
            <MarkdownBody content={message.content} syntaxStyle={syntaxStyle} fg={ink} />
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

const DOTTED_RAIL = {
  topLeft: " ",
  topRight: " ",
  bottomLeft: " ",
  bottomRight: " ",
  horizontal: " ",
  vertical: "┊",
  topT: " ",
  bottomT: " ",
  leftT: " ",
  rightT: " ",
  cross: " ",
}

function AssistantCard({ theme, children }: { theme: Theme; children: ReactNode }) {
  return (
    <box flexDirection="row">
      <box width={1} border={["left"]} borderColor={theme.fg} customBorderChars={DOTTED_RAIL} />
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
      {open ? (
        <box border={["left"]} borderColor={theme.dim} paddingLeft={1}>
          <MarkdownBody content={text} syntaxStyle={syntaxStyle} fg={theme.dim} streaming={streaming} />
        </box>
      ) : null}
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

function RewindOverlay({
  rewind,
  theme,
  send,
}: {
  rewind: { entries: string[]; selected: number }
  theme: Theme
  send: (request: unknown) => void
}) {
  const { width } = useTerminalDimensions()
  const selected = rewind.entries.length === 0 ? 0 : Math.min(rewind.selected, rewind.entries.length - 1)
  const visible = 10
  const [start, setStart] = useState(0)
  useEffect(() => {
    setStart((current) => paletteWindow(current, selected, rewind.entries.length, visible))
  }, [selected, rewind.entries.length])
  const slots = Array.from({ length: visible }, (_, index) => {
    const absolute = start + index
    return absolute < rewind.entries.length ? rewind.entries[absolute] : null
  })
  return (
    <box
      height={12}
      flexShrink={0}
      border
      borderColor={theme.dim}
      title=" edit a previous message "
      titleColor={theme.dim}
      flexDirection="column"
      paddingLeft={1}
      paddingRight={1}
    >
      <box flexGrow={1} flexDirection="column">
        {slots.map((entry, index) => {
          if (entry == null) return <box key={`empty-${index}`} height={1} />
          const absolute = start + index
          const on = absolute === selected
          return (
            <box
              key={`${absolute}-${entry.slice(0, 12)}`}
              height={1}
              backgroundColor={on ? theme.selBg : theme.bg}
              onMouseDown={() => {
                const steps = absolute - selected
                if (steps === 0) return
                const code = steps > 0 ? "Down" : "Up"
                for (let i = 0; i < Math.abs(steps); i++) send({ SendKey: { code, mods: 0 } })
              }}
            >
              <text fg={on ? theme.selFg : theme.fg}>{previewLine(entry, Math.max(8, width - 6))}</text>
            </box>
          )
        })}
      </box>
      <text fg={theme.dim}>↑↓ select · Enter rewind · Esc cancel</text>
    </box>
  )
}

function previewLine(text: string, max: number): string {
  const flat = text.replace(/[\n\t\r]/g, " ")
  const chars = [...flat]
  if (chars.length <= max) return flat
  return `${chars.slice(0, Math.max(0, max - 1)).join("")}…`
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
  const signature = rows.map((row) => row.label).join("\n")
  const signatureRef = useRef(signature)
  const [start, setStart] = useState(0)
  useEffect(() => {
    const listChanged = signatureRef.current !== signature
    signatureRef.current = signature
    setStart((current) => paletteWindow(listChanged ? 0 : current, selected, rows.length))
  }, [selected, rows.length, signature])
  if (rows.length === 0) return null
  const slots = Array.from({ length: PALETTE_VISIBLE }, (_, index) => rows[start + index] ?? null)
  return (
    <box
      height={PALETTE_VISIBLE + 2}
      flexShrink={0}
      border
      borderStyle="rounded"
      borderColor={theme.dim}
      flexDirection="column"
      title={command ? " commands " : " files "}
      titleColor={theme.dim}
    >
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
              const steps = absolute - selected
              if (steps === 0) return
              const code = steps > 0 ? "Down" : "Up"
              for (let i = 0; i < Math.abs(steps); i++) send({ SendKey: { code, mods: 0 } })
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
  const keyQueue = useRef(Promise.resolve())
  const lastPaletteKey = useRef({ code: "", at: 0 })
  useKeyboard((key) => {
    if (key.eventType === "release") return
    if (key.name === "escape" && focused) {
      if (typeof key.preventDefault === "function") key.preventDefault()
      keyQueue.current = keyQueue.current.then(async () => {
        const ok = await flush()
        if (!ok) return
        send({ SendKey: { code: "Esc", mods: 0 } })
      })
      return
    }
    if (!paletteOpen) return
    const name = key.name
    if (name !== "up" && name !== "down" && name !== "tab") return
    if (typeof key.preventDefault === "function") key.preventDefault()
    const code = name === "up" ? "Up" : name === "down" ? "Down" : key.shift ? "BackTab" : "Tab"
    // One physical key can arrive twice. Drop the duplicate so the highlight
    // moves a single row. Flush first so the daemon already has the / or @ draft.
    const now = Date.now()
    if (code === lastPaletteKey.current.code && now - lastPaletteKey.current.at < 40) return
    lastPaletteKey.current = { code, at: now }
    keyQueue.current = keyQueue.current.then(async () => {
      const ok = await flush()
      if (!ok) return
      send({ SendKey: { code, mods: 0 } })
    })
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

  const version = process.env.KOMA_VERSION ?? ""
  const mode = modeMark(snap.global.agent_mode, session)
  const modeColor = mode.color === "success" ? theme.success : mode.color === "warn" ? theme.warn : mode.color === "error" ? theme.error : theme.info
  return (
    <box flexDirection="column" flexShrink={0}>
      <box height={1} />
      <box flexDirection="row" justifyContent="space-between" paddingLeft={1} paddingRight={1}>
        <text>
          <span fg={theme.fg}>Koma </span>
          <span fg={theme.dim}>{version}</span>
          <span fg={theme.dim}> | </span>
          <span fg={modeColor}>{mode.label}</span>
        </text>
        <text fg={theme.dim}>{session.resolved_model_id}</text>
      </box>
      <box height={1} />
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
      <box height={1} />
    </box>
  )
}

function Status({ snap, session, theme }: { snap: Snapshot; session: SessionSnap; theme: Theme }) {
  const live = isThinking(snap.global.status, session)
  const elapsed = useWorkElapsed(snap.global.work_elapsed_ms, live)
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

function isThinking(status: string, session: SessionSnap): boolean {
  if (session.awaiting_approval) return false
  if (session.working || session.waiting || session.streaming || session.stream_reasoning) return true
  const word = status.trim().toLowerCase()
  if (!word || word === "ready" || word.includes("approve")) return false
  // A live phase is one word, like "thinking". Slash usage and other notices
  // are sentences, and they stay a still gray line.
  if (/[\s:<]/.test(word)) return false
  return true
}

function useWorkElapsed(anchor: number | null, running: boolean): number | null {
  const [tick, setTick] = useState(0)
  const started = useRef(Date.now())
  const base = useRef(0)
  useEffect(() => {
    if (!running) return
    started.current = Date.now()
    base.current = anchor ?? 0
  }, [running, anchor])
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setTick((value) => value + 1), 80)
    return () => clearInterval(timer)
  }, [running])
  if (!running) return null
  void tick
  return base.current + (Date.now() - started.current)
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
  const bg = selected ? theme.selBg : hot ? theme.panel : theme.bg
  const labelFg = selected ? theme.selFg : theme.accent
  const detailFg = selected ? theme.selFg : theme.dim
  return (
    <box
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={bg}
      onMouseOver={() => setHot(true)}
      onMouseOut={() => setHot(false)}
      onMouseDown={onPress}
    >
      <text>
        <span fg={labelFg}>{label}</span>
        {detail ? <span fg={detailFg}>{`  ${detail}`}</span> : null}
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
