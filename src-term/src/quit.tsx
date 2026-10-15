import { useEffect, useState } from "react"
import type { Theme } from "./theme.ts"
import { Action, Overlay } from "./modes/bits.tsx"

const LABELS = ["Quit (k)", "Detach (d)", "Cancel (esc)"] as const
const DESCS = [
  "Quit session and stop current progress",
  "Detach and keep the session running",
  "Back to chat",
]
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

export type QuitState = {
  working: number
  total: number
  selected: number
}

/** `ModeSnapshot::QuitConfirm` from the daemon. Null for every other mode. */
export function quitState(mode: unknown): QuitState | null {
  if (!mode || typeof mode !== "object" || !("QuitConfirm" in mode)) return null
  const body = (mode as { QuitConfirm?: { working?: number; total?: number; selected?: number } }).QuitConfirm
  return {
    working: body?.working ?? 0,
    total: body?.total ?? 0,
    selected: Math.min(2, Math.max(0, body?.selected ?? 2)),
  }
}

export function QuitScreen({
  state,
  theme,
  exiting,
  onPick,
  scope = "session",
}: {
  state: QuitState
  theme: Theme
  exiting: number | null
  onPick: (index: number) => void
  scope?: "session" | "hub"
}) {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (exiting == null) return
    const timer = setInterval(() => setTick((value) => value + 1), 80)
    return () => clearInterval(timer)
  }, [exiting])
  const glyph = SPINNER[tick % SPINNER.length] ?? "⠋"
  const selected = exiting ?? state.selected
  const plural = state.working === 1 ? "session" : "sessions"
  return (
    <Overlay title="Confirm exit" theme={theme} hint={exiting != null ? exiting === 0 ? "Quitting…" : "Detaching…" : "←/→ move · Tab switch · Enter select"}>
      <box
        width="100%"
        flexGrow={1}
        minHeight={0}
        flexDirection="column"
        paddingLeft={1}
        paddingRight={1}
      >
        <text fg={theme.fg}>Do you want to quit?</text>
        {state.working > 0 ? (
          <text fg={scope === "session" ? theme.warn : theme.dim}>{scope === "hub" ? `${state.working} ${plural} still working. They will keep running.` : `${state.working} ${plural} still working — in-flight work will be lost.`}</text>
        ) : null}
        <box flexDirection="row" flexWrap="wrap" columnGap={1} flexShrink={0}>
          {LABELS.map((label, index) => {
            const spinning = exiting === index
            return <Action plain key={label} label={spinning ? `${glyph} ${label}` : label} primary={index === selected} disabled={exiting != null} theme={theme} onPress={() => onPick(index)} />
          })}
        </box>
        <text fg={theme.dim}>{scope === "hub" ? selected === 2 ? "Back to sessions" : "Close this terminal. Sessions keep running." : DESCS[selected] ?? DESCS[2]}</text>
      </box>
    </Overlay>
  )
}
