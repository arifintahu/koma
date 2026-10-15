import { useEffect, useState, type ReactNode } from "react"
import type { Theme } from "./theme.ts"

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

export type WarmPhase = {
  phase: "pending" | "running" | "done" | "skipped" | "failed"
  detail: string
}

export type WarmSplash = {
  elapsedMs: number
  workspace: WarmPhase
  awareness: WarmPhase
}

export function warmSplash(mode: unknown): WarmSplash | null {
  if (!mode || typeof mode !== "object" || !("Loading" in mode)) return null
  const body = (mode as { Loading?: { elapsed_ms?: number; workspace?: unknown; awareness?: unknown } }).Loading
  return {
    elapsedMs: typeof body?.elapsed_ms === "number" ? body.elapsed_ms : 0,
    workspace: warmPhase(body?.workspace),
    awareness: warmPhase(body?.awareness),
  }
}

function warmPhase(raw: unknown): WarmPhase {
  if (raw === "Running") return { phase: "running", detail: "" }
  if (raw === "Skipped") return { phase: "skipped", detail: "" }
  if (raw === "Failed") return { phase: "failed", detail: "" }
  if (raw && typeof raw === "object" && "Done" in raw) {
    return { phase: "done", detail: String((raw as { Done?: unknown }).Done ?? "") }
  }
  return { phase: "pending", detail: "" }
}

export function OpeningSplash({ theme }: { theme: Theme }) {
  const tick = useSpinner()
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    const started = Date.now()
    const timer = setInterval(() => setElapsed(Date.now() - started), 100)
    return () => clearInterval(timer)
  }, [])
  const stuck = elapsed >= 10_000
  return (
    <Splash theme={theme}>
      <Center>
        <text fg={theme.accent}>koma</text>
      </Center>
      <Center>
        <text>
          <span fg={theme.accent}>{FRAMES[Number(tick)]} </span>
          <span fg={theme.fg}>opening session</span>
        </text>
      </Center>
      {stuck ? (
        <Center>
          <text fg={theme.dim}>taking longer than expected…</text>
        </Center>
      ) : null}
      <Footer theme={theme} text={`opening · ${(elapsed / 1000).toFixed(1)}s`} />
    </Splash>
  )
}

export function WarmingSplash({ theme, warm }: { theme: Theme; warm: WarmSplash }) {
  const tick = useSpinner()
  return (
    <Splash theme={theme}>
      <Center>
        <text fg={theme.accent}>koma</text>
      </Center>
      <PhaseRow theme={theme} tick={tick} label="indexing workspace" phase={warm.workspace} />
      <PhaseRow theme={theme} tick={tick} label="reading project docs" phase={warm.awareness} />
      <Footer theme={theme} text={`warming up · ${(warm.elapsedMs / 1000).toFixed(1)}s   ·   esc to skip`} />
    </Splash>
  )
}

function Splash({ theme, children }: { theme: Theme; children: ReactNode }) {
  return (
    <box flexGrow={1} flexDirection="column" justifyContent="center" alignItems="center" backgroundColor={theme.bg} gap={1}>
      {children}
    </box>
  )
}

function Center({ children }: { children: ReactNode }) {
  return (
    <box flexDirection="row" justifyContent="center">
      {children}
    </box>
  )
}

function Footer({ theme, text }: { theme: Theme; text: string }) {
  return (
    <box flexDirection="row" justifyContent="center" marginTop={1}>
      <text fg={theme.dim}>{text}</text>
    </box>
  )
}

function PhaseRow({
  theme,
  tick,
  label,
  phase,
}: {
  theme: Theme
  tick: string
  label: string
  phase: WarmPhase
}) {
  const marker =
    phase.phase === "running" ? tick : phase.phase === "done" ? "●" : "·"
  const markerFg = phase.phase === "failed" ? theme.error : phase.phase === "pending" || phase.phase === "skipped" ? theme.dim : theme.accent
  const extra = phase.phase === "done" ? phase.detail : phase.phase === "skipped" ? "skipped" : phase.phase === "failed" ? "failed" : ""
  return (
    <Center>
      <text>
        <span fg={markerFg}>{`${marker}  `}</span>
        <span fg={theme.fg}>{label}</span>
        {extra ? <span fg={theme.dim}>{`  ${extra}`}</span> : null}
      </text>
    </Center>
  )
}

function useSpinner(): string {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 80)
    return () => clearInterval(timer)
  }, [])
  return FRAMES[tick % FRAMES.length] ?? "⠋"
}
