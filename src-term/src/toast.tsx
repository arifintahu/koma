import { useEffect, useRef, useState } from "react"
import type { Theme } from "./theme.ts"

export type LocalNotice = { id: string; text: string }

const TOAST_MS = 3000

/** Key by notification ID so new events get their own countdown and dismissal. */
export function Toast({ id, kind, text, theme, hidden = false, onDismiss }: {
  id: string
  kind: string
  text: string
  theme: Theme
  hidden?: boolean
  onDismiss?: () => void
}) {
  const [dismissed, setDismissed] = useState(false)
  const [leftMs, setLeftMs] = useState(TOAST_MS)
  const [hovered, setHovered] = useState(false)
  const dismissRef = useRef(onDismiss)
  dismissRef.current = onDismiss

  function dismiss() {
    setDismissed(true)
    dismissRef.current?.()
  }

  useEffect(() => {
    if (dismissed) return
    const started = Date.now()
    const timer = setInterval(() => {
      const remain = TOAST_MS - (Date.now() - started)
      if (remain <= 0) {
        clearInterval(timer)
        setDismissed(true)
        dismissRef.current?.()
      } else setLeftMs(remain)
    }, 100)
    return () => clearInterval(timer)
  }, [id, dismissed])

  if (hidden || dismissed) return null
  const message = text.replace(/^\n+/, "").split("\n").filter((line) => line.length > 0).slice(0, 3).join(" ")
  const seconds = Math.max(1, Math.ceil(leftMs / 1000))
  return <box border borderStyle="rounded" borderColor={theme.dim} flexShrink={0} flexDirection="row" paddingLeft={1} paddingRight={1} marginBottom={1} gap={1}>
    <text fg={kind === "error" ? theme.error : theme.fg} flexGrow={1} flexBasis={0} minWidth={0} selectable>{message}</text>
    <box flexDirection="row" flexShrink={0} height={1} gap={1}>
      <text fg={theme.dim}>{`${seconds}s`}</text>
      <box width={3} height={1} onMouseOver={() => setHovered(true)} onMouseOut={() => setHovered(false)} onMouseDown={dismiss}>
        <text fg={hovered ? theme.accent : theme.dim}>[x]</text>
      </box>
    </box>
  </box>
}
