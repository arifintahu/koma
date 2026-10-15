/**
 * The daemon echoed a snapshot the user has already typed past.
 * An empty remote is a real clear, not a prefix, so it does not count.
 */
export function composerIsAhead(local: string, remote: string): boolean {
  return remote.length > 0 && local.length > remote.length && local.startsWith(remote)
}

/** Daemon cursors are Unicode scalar indexes. The textarea offset is a UTF-16 index. */

export function utf16Offset(text: string, charIndex: number): number {
  if (charIndex <= 0) return 0
  let chars = 0
  let index = 0
  while (index < text.length) {
    if (chars >= charIndex) return index
    const code = text.charCodeAt(index)
    index += code >= 0xd800 && code <= 0xdbff ? 2 : 1
    chars += 1
  }
  return text.length
}

/** Code points strictly before `utf16`. An offset at or past the end is the end. */
export function charIndexAt(text: string, utf16: number): number {
  if (utf16 >= text.length) {
    let chars = 0
    for (let index = 0; index < text.length; ) {
      const code = text.charCodeAt(index)
      index += code >= 0xd800 && code <= 0xdbff ? 2 : 1
      chars += 1
    }
    return chars
  }
  let chars = 0
  let index = 0
  const end = Math.max(0, utf16)
  while (index < end) {
    const code = text.charCodeAt(index)
    const width = code >= 0xd800 && code <= 0xdbff ? 2 : 1
    if (index + width > end) break
    index += width
    chars += 1
  }
  return chars
}
