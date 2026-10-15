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

/** Rebase newer native typing onto a daemon paste/marker insertion. */
export function mergeComposerChange(base: string, local: string, remote: string): string {
  if (local === base) return remote
  let prefix = 0
  while (prefix < base.length && prefix < local.length && base[prefix] === local[prefix]) prefix++
  let suffix = 0
  while (suffix < base.length - prefix && suffix < local.length - prefix && base[base.length - 1 - suffix] === local[local.length - 1 - suffix]) suffix++
  let remotePrefix = 0
  while (remotePrefix < base.length && remotePrefix < remote.length && base[remotePrefix] === remote[remotePrefix]) remotePrefix++
  const delta = remote.length - base.length
  const start = prefix >= remotePrefix ? prefix + delta : prefix
  const end = base.length - suffix >= remotePrefix ? base.length - suffix + delta : base.length - suffix
  return remote.slice(0, Math.max(0, start)) + local.slice(prefix, local.length - suffix) + remote.slice(Math.max(0, end))
}
