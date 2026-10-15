/** Wire modifier bits. They match `ipc/proto/key.rs`. */
const SHIFT = 1
const CONTROL = 2
const ALT = 4

export type WireKey = { code: string | { Char: string }; mods: number }

type KeyLike = {
  name?: string
  ctrl?: boolean
  shift?: boolean
  meta?: boolean
  option?: boolean
  sequence?: string
}

const NAMED: Record<string, string> = {
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  tab: "Tab",
  escape: "Esc",
  esc: "Esc",
  return: "Enter",
  enter: "Enter",
  kpenter: "Enter",
  backspace: "Backspace",
  delete: "Delete",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
}

/** Map one OpenTUI key to SendKey. Ctrl+C stays with the quit path, so it is null. */
export function forwardKey(key: KeyLike): WireKey | null {
  if ((key.ctrl && key.name === "c") || key.sequence === "\u0003" || key.name === "ctrl+c") return null
  let mods = 0
  if (key.shift) mods |= SHIFT
  if (key.ctrl) mods |= CONTROL
  if (key.meta || key.option) mods |= ALT
  const rawName = key.name ?? ""
  const name = rawName.toLowerCase()
  if (name === "tab" && key.shift) return { code: "BackTab", mods: mods & ~SHIFT }
  const named = NAMED[name]
  if (named) return { code: named, mods }
  // Text fields need the character the terminal produced, including case and
  // punctuation. Key names are normalized for navigation, not for text entry.
  const sequence = key.sequence ?? ""
  if (!key.ctrl && !key.meta && !key.option && [...sequence].length === 1 && sequence.codePointAt(0)! >= 32 && sequence !== "\u007f") {
    return { code: { Char: sequence }, mods }
  }
  if (name === "space") return { code: { Char: " " }, mods }
  if ([...rawName].length === 1) return { code: { Char: rawName }, mods }
  return null
}
