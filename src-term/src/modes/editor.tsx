import { useContext, useEffect, useRef, useState } from "react"
import type { TextareaRenderable } from "@opentui/core"
import { DraftContext, InputSuspendedContext, nativeMenuInput } from "./bits.tsx"
import type { Theme } from "../theme.ts"
import { Note, useBodyHeight } from "./bits.tsx"
import { paletteWindow } from "../palette.ts"
import { num, rec, str, strings, type Rec } from "./read.ts"

/** The daemon owns the buffer. This only shows the lines and the caret. */
export function TextEditor({ body, theme }: { body: Rec; theme: Theme }) {
  const update = useContext(DraftContext)
  if (update) return <NativeEditor body={body} theme={theme} update={update} />
  return <ReadEditor body={body} theme={theme} />
}

function ReadEditor({ body, theme }: { body: Rec; theme: Theme }) {
  const lines = strings(body.lines)
  const row = num(body.row)
  const col = num(body.col)
  const scroll = num(body.scroll)
  const { ref, height } = useBodyHeight(24)
  const start = paletteWindow(scroll, row, lines.length, Math.max(1, height - 1))
  const shown = lines.slice(start, start + Math.max(1, height - 1))
  return (
    <box ref={ref} flexDirection="column" flexGrow={1} flexBasis={0} minHeight={0} overflow="hidden">
      {shown.map((line, index) => {
        const absolute = start + index
        const here = absolute === row
        const text = here ? paintCaret(line, col) : line || " "
        return (
          <text key={absolute} wrapMode="none" fg={theme.fg}>
            <span fg={here ? theme.accent : theme.dim}>{`${String(absolute + 1).padStart(4)}  `}</span>{text}
          </text>
        )
      })}
      {shown.length === 0 ? <text fg={theme.fg}>▮</text> : null}
      <box flexGrow={1} />
      <text fg={theme.dim}>{` Line ${row + 1} / ${Math.max(1, lines.length)} · Column ${col + 1}`}</text>
    </box>
  )
}

export function editorFrom(value: unknown): Rec | null {
  if (!value) return null
  if (Array.isArray(value)) return rec(value[1])
  return rec(value)
}

function paintCaret(line: string, col: number): string {
  const chars = [...line]
  const at = Math.max(0, Math.min(col, chars.length))
  if (at >= chars.length) return `${line}▮`
  chars[at] = "▮"
  return chars.join("")
}

export function editorHint(): string {
  return "arrows move · enter newline · esc close"
}

export function EditorNote({ text, theme }: { text: string; theme: Theme }) {
  return <Note text={text} theme={theme} />
}

function NativeEditor({ body, theme, update }: { body: Rec; theme: Theme; update: (field: string, value: string) => void }) {
  const suspended = useContext(InputSuspendedContext)
  const ref = useRef<TextareaRenderable | null>(null)
  const live = useRef(true)
  const initial = useRef(strings(body.lines).join("\n"))
  const [position, setPosition] = useState({ row: num(body.row), col: num(body.col), lines: strings(body.lines).length })
  useEffect(() => {
    const node = ref.current
    live.current = true
    nativeMenuInput.current = node
    nativeMenuInput.multiline = true
    nativeMenuInput.listNavigation = false
    if (ref.current) ref.current.cursorOffset = strings(body.lines).slice(0, num(body.row)).reduce((n, line) => n + [...line].length + 1, 0) + num(body.col)
    return () => {
      live.current = false
      if (nativeMenuInput.current === node) { nativeMenuInput.current = null; nativeMenuInput.multiline = false }
    }
  }, [])
  const read = () => {
    const area = ref.current
    if (!area) return
    const cursor = area.logicalCursor
    setPosition({ row: cursor.row, col: cursor.col, lines: area.plainText.split("\n").length })
  }
  return <box flexDirection="column" flexGrow={1} flexBasis={0} minHeight={0}>
    <textarea ref={ref} flexGrow={1} flexBasis={0} minHeight={0} focused={!suspended} keyBindings={[{name:"a",ctrl:true,action:"select-all"}]} initialValue={initial.current} textColor={theme.fg} focusedTextColor={theme.fg} backgroundColor={theme.bg} focusedBackgroundColor={theme.bg} cursorColor={theme.accent} onContentChange={() => { if (!live.current || !ref.current) return; update("editor", ref.current.plainText); read() }} onCursorChange={read} />
    <text flexShrink={0} fg={theme.dim}>{`Line ${position.row + 1} / ${position.lines} · Column ${position.col + 1}`}</text>
  </box>
}
