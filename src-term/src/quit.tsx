import { useEffect, useState } from "react"
import type { Theme } from "./theme.ts"

const LABELS = ["quit", "detach", "cancel"] as const
const DESCS = [
  "Quit session and stop current progress",
  "Minimize — as usual agent keep cooking",
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
  const selected = state.selected
  const plural = state.working === 1 ? "session" : "sessions"
  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={theme.bg}>
      <box
        height={3}
        border={["top", "bottom"]}
        borderColor={theme.dim}
        title=" quit "
        titleColor={theme.dim}
        paddingLeft={1}
        paddingRight={1}
      >
        <text fg={theme.dim}>
          {state.working > 0
            ? "a quit was requested while work is still in flight"
            : "a quit was requested"}
        </text>
      </box>
      <box height={8} flexShrink={0} flexDirection="column" gap={1}>
        <text fg={theme.fg}>Do you want to quit?</text>
        {state.working > 0 ? (
          <text fg={theme.dim}>{scope === "hub" ? `${state.working} ${plural} still working. They will keep running.` : `${state.working} ${plural} still working — in-flight work will be lost.`}</text>
        ) : null}
        <box flexDirection="row" gap={3}>
          {LABELS.map((label, index) => {
            const on = index === selected
            const spinning = exiting === index
            return (
              <box
                key={label}
                backgroundColor={on ? theme.selBg : theme.bg}
                paddingLeft={1}
                paddingRight={1}
                onMouseDown={() => {
                  if (exiting == null) onPick(index)
                }}
              >
                <text fg={on ? theme.selFg : theme.accent}>{spinning ? `[ ${glyph}${label} ]` : `[ ${label} ]`}</text>
              </box>
            )
          })}
        </box>
        <text fg={theme.dim}>{scope === "hub" && selected !== 2 ? "Close this terminal. Sessions keep running." : DESCS[selected] ?? DESCS[2]}</text>
      </box>
      <text fg={theme.dim}>←/→ move · Enter select · k/d/Esc shortcut · click</text>
    </box>
  )
}
