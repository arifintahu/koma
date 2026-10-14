import type { SyntaxStyle } from "@opentui/core"
import { useKeyboard } from "@opentui/react"
import { useCallback, useEffect, useRef, useState } from "react"
import { Chat } from "./chat.tsx"
import { foregroundSession, modeName, type Snapshot } from "./protocol.ts"
import { QuitScreen, quitState } from "./quit.tsx"
import { ModeView, modeScreen } from "./screens.tsx"
import { DaemonLink } from "./socket.ts"
import { themeFor, type Theme } from "./theme.ts"

export function SessionScreen({
  id,
  syntaxStyle,
  onHome,
  onOpen,
}: {
  id: string
  syntaxStyle: SyntaxStyle
  onHome: () => void
  onOpen: (id: string) => void
}) {
  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [phase, setPhase] = useState<"connecting" | "live" | "error">("connecting")
  const [error, setError] = useState("")
  const linkRef = useRef<DaemonLink | null>(null)
  const snapRef = useRef<Snapshot | null>(null)
  const send = useCallback((request: unknown) => {
    linkRef.current?.send(request)
  }, [])
  const sendTracked = useCallback((request: unknown) => {
    return linkRef.current?.sendTracked(request) ?? Promise.resolve("not connected")
  }, [])

  useEffect(() => {
    let dead = false
    const link = new DaemonLink(
      (next) => {
        if (dead) return
        snapRef.current = next
        setSnap(next)
        setPhase(next ? "live" : "connecting")
      },
      (control) => {
        if (dead) return
        if (control.kind === "home") {
          onHome()
          return
        }
        if (control.kind === "open") {
          onOpen(control.id)
          return
        }
        if (control.kind === "new") {
          if (control.kill) link.send("QuitDaemon")
          onOpen(crypto.randomUUID())
          return
        }
        if (control.kind === "error" && control.text) {
          setError(control.text)
          if (!snapRef.current) setPhase("error")
        }
      },
    )
    linkRef.current = link
    void link.start(id).catch((err: unknown) => {
      if (dead) return
      setError(err instanceof Error ? err.message : String(err))
      setPhase("error")
    })
    return () => {
      dead = true
      link.detach()
      if (linkRef.current === link) linkRef.current = null
    }
  }, [id, onHome, onOpen])

  const theme = themeFor(snap?.global.palette)
  const session = snap ? foregroundSession(snap) : null
  const mode = snap ? modeName(snap.global.mode) : ""
  const quit = snap ? quitState(snap.global.mode) : null
  const screen = snap ? modeScreen(snap.global.mode) : null
  const chat = mode === "Chat"
  const approval = Boolean(session?.awaiting_approval)
  const busy = Boolean(session && (session.working || session.waiting || session.streaming))
  const [exiting, setExiting] = useState<number | null>(null)

  function chooseQuit(index: number) {
    if (exiting != null) return
    if (index === 2) {
      send({ SendKey: { code: "Esc", mods: 0 } })
      return
    }
    setExiting(index)
    if (index === 0) {
      send("QuitDaemon")
      send("Detach")
      onHome()
      return
    }
    send({ SendKey: { code: "Esc", mods: 0 } })
    send("Detach")
    onHome()
  }

  function nudge(from: number, delta: number, length: number) {
    if (delta === 0 || length === 0) return
    const code = delta > 0 ? "Down" : "Up"
    const steps = Math.min(Math.abs(delta), Math.max(0, length - 1))
    for (let i = 0; i < steps; i++) send({ SendKey: { code, mods: 0 } })
    void from
  }

  useKeyboard((key) => {
    if (key.eventType === "release") return
    if (key.ctrl && key.name === "c") {
      if (phase === "live" && !quit) send({ SendKey: { code: { Char: "c" }, mods: 2 } })
      return
    }
    if (screen && phase === "live" && !quit) {
      if (key.name === "up") nudge(screen.selected, -1, screen.rows.length)
      else if (key.name === "down") nudge(screen.selected, 1, screen.rows.length)
      else if (key.name === "escape") send({ SendKey: { code: "Esc", mods: 0 } })
      else if (key.name === "return" || key.name === "enter") send({ SendKey: { code: "Enter", mods: 0 } })
      else if (key.name === "left") send({ SendKey: { code: "Left", mods: 0 } })
      else if (key.name === "right") send({ SendKey: { code: "Right", mods: 0 } })
      else if (key.name === "tab") send({ SendKey: { code: key.shift ? "BackTab" : "Tab", mods: 0 } })
      else if (key.name === "backspace") send({ SendKey: { code: "Backspace", mods: 0 } })
      else if (key.name && key.name.length === 1 && !key.ctrl && !key.meta) send({ SendKey: { code: { Char: key.name }, mods: 0 } })
      return
    }
    if (quit && phase === "live") {
      if (exiting != null) return
      if (key.name === "left" || key.name === "h") send({ SendKey: { code: "Left", mods: 0 } })
      else if (key.name === "right" || key.name === "l") send({ SendKey: { code: "Right", mods: 0 } })
      else if (key.name === "tab" && key.shift) send({ SendKey: { code: "BackTab", mods: 0 } })
      else if (key.name === "tab") send({ SendKey: { code: "Tab", mods: 0 } })
      else if (key.name === "k") chooseQuit(0)
      else if (key.name === "d") chooseQuit(1)
      else if (key.name === "escape") chooseQuit(2)
      else if (key.name === "return" || key.name === "enter") chooseQuit(quit.selected)
      return
    }
    if (phase !== "live" || !chat) {
      if (key.name === "escape") onHome()
      return
    }
    if (approval) {
      const call = session?.pending_tool_calls[session.tool_idx]
      const plan = call?.function.name === "plan_ready" || call?.function.name === "mission_ready"
      if (key.name === "y") send({ SendKey: { code: { Char: "y" }, mods: 0 } })
      else if (key.name === "n" || key.name === "escape") send({ SendKey: { code: key.name === "escape" ? "Esc" : { Char: "n" }, mods: 0 } })
      else if (plan && key.name === "a") send({ SendKey: { code: { Char: "a" }, mods: 0 } })
      return
    }
    if (key.name === "escape") {
      if (busy) send({ SendKey: { code: "Esc", mods: 0 } })
      else onHome()
    }
  })

  if (phase === "connecting") {
    return <Opening theme={theme} />
  }
  if (phase === "error" && !snap) {
    return (
      <box flexDirection="column" flexGrow={1} padding={1} gap={1} backgroundColor={theme.bg}>
        <text fg={theme.error}>{error || "could not open this session"}</text>
        <text fg={theme.dim}>esc home. the current terminal for this screen is koma legacy.</text>
      </box>
    )
  }
  if (!snap) return null
  if (quit) {
    return <QuitScreen state={quit} theme={theme} exiting={exiting} onPick={chooseQuit} />
  }
  if (screen) {
    return (
      <ModeView
        screen={screen}
        theme={theme}
        onMove={(index) => nudge(screen.selected, index - screen.selected, screen.rows.length)}
      />
    )
  }
  if (!chat) {
    return <OtherMode name={mode} theme={theme} note={error} />
  }
  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={theme.bg}>
      {error ? <text fg={theme.warn}>{`  ${error}`}</text> : null}
      <Chat
        snap={snap}
        theme={theme}
        syntaxStyle={syntaxStyle}
        focused={!approval}
        send={send}
        sendTracked={sendTracked}
        onFlushError={(text) => setError(text)}
      />
    </box>
  )
}

const OPENING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

function Opening({ theme }: { theme: Theme }) {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 80)
    return () => clearInterval(timer)
  }, [])
  return (
    <box flexGrow={1} flexDirection="column" justifyContent="center" alignItems="center" backgroundColor={theme.bg} gap={1}>
      <text fg={theme.accent}>{OPENING_FRAMES[tick % OPENING_FRAMES.length]}</text>
      <text fg={theme.dim}>opening session…</text>
    </box>
  )
}

function OtherMode({ name, theme, note }: { name: string; theme: Theme; note: string }) {
  return (
    <box flexDirection="column" flexGrow={1} padding={1} gap={1} backgroundColor={theme.bg}>
      <text fg={theme.accent}>{name}</text>
      <text>This screen is still on koma legacy.</text>
      {note ? <text fg={theme.warn}>{note}</text> : null}
      <text fg={theme.dim}>esc home</text>
    </box>
  )
}
