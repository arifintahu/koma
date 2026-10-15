/** Message rewind stays a chat overlay. The other modes live in `modes/`. */
export function rewindOf(mode: unknown): { entries: string[]; selected: number } | null {
  if (!mode || typeof mode !== "object" || !("MessageRewind" in mode)) return null
  const body = (mode as { MessageRewind?: { entries?: { content?: string }[]; selected?: number } }).MessageRewind
  const entries = Array.isArray(body?.entries) ? body.entries.map((row) => String(row?.content ?? "")) : []
  const selected = typeof body?.selected === "number" ? body.selected : Math.max(0, entries.length - 1)
  return { entries, selected }
}
