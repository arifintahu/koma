/** Rows shown in the `/` and `@` palettes, including empty rows. */
export const PALETTE_VISIBLE = 8

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
