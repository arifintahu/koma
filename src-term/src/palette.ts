/** Rows shown in the `/` and `@` palettes, including empty rows. */
export const PALETTE_VISIBLE = 8

type Command = { name: string; desc: string }

/** Suggest commands in src-term without changing their daemon indices. */
export function commandSuggestions(commands: Command[], selected: number) {
  const rows = commands.map((command, sourceIndex) => ({ ...command, sourceIndex })).filter((command) => command.name !== "/select")
  const at = rows.findIndex((row) => row.sourceIndex >= selected)
  return { rows, selected: at < 0 ? Math.max(0, rows.length - 1) : at }
}

/** Skip hidden suggestions while retaining the daemon's navigation/activation. */
export function commandSuggestionOffset(commands: Command[], selected: number, direction: -1 | 0 | 1) {
  const suggestions = commandSuggestions(commands, selected)
  if (!suggestions.rows.length) return 0
  const candidates = suggestions.rows.filter((row) => direction < 0 ? row.sourceIndex < selected : row.sourceIndex > selected)
  const target = direction === 0 ? suggestions.rows[suggestions.selected] : direction < 0 ? candidates.at(-1) : candidates[0]
  return target ? target.sourceIndex - selected : 0
}

/**
 * Keep `selected` inside the visible window.
 * The window stays put while the highlight moves inside it, and shifts by one
 * row only when the highlight would leave the top or bottom edge.
 */
export function paletteWindow(start: number, selected: number, length: number, visible = PALETTE_VISIBLE): number {
  if (length <= 0) return 0
  const sel = Math.max(0, Math.min(selected, length - 1))
  const maxStart = Math.max(0, length - visible)
  let next = Math.max(0, Math.min(start, maxStart))
  if (sel < next) next = sel
  else if (sel >= next + visible) next = sel - visible + 1
  return Math.max(0, Math.min(next, maxStart))
}
