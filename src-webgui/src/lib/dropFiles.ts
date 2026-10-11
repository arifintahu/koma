// Composer file drops: images stay images; text files become paste chips.
// MIME is not enough — Finder often reports empty or application/octet-stream.

import { PASTE_SOFT_MAX_BYTES } from './pasteText'

export const DROP_IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] as const

export const DROP_TEXT_EXTS = [
  'txt', 'md', 'markdown', 'rst', 'csv', 'tsv', 'json', 'jsonc', 'yaml', 'yml', 'toml',
  'xml', 'html', 'htm', 'css', 'svg', 'log', 'env', 'ini', 'cfg', 'conf',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'py', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx',
  'rs', 'go', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'rb', 'php', 'swift',
] as const

const IMAGE_EXTS = new Set<string>(DROP_IMAGE_EXTS)
const TEXT_EXTS = new Set<string>(DROP_TEXT_EXTS)

export const COMPOSER_FILE_ACCEPT = ['image/*', ...DROP_TEXT_EXTS.map((ext) => `.${ext}`)].join(',')

export type DropPreview = 'image' | 'text' | 'reject'

export function dropExtension(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? name
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return ''
  return base.slice(dot + 1).toLowerCase()
}

export function dropFileLabel(name: string): string {
  const base = name.split(/[/\\]/).pop()?.trim()
  return base || 'file'
}

/** Size / extension / MIME gate. Opaque types still need a UTF-8 body check. */
export function previewDroppedFile(name: string, type: string, size: number): DropPreview {
  if (size > PASTE_SOFT_MAX_BYTES) return 'reject'
  const ext = dropExtension(name)
  const mime = type.toLowerCase()
  if (ext === 'svg' || mime === 'image/svg+xml') return 'text'
  if (IMAGE_EXTS.has(ext) || (mime.startsWith('image/') && mime !== 'image/svg+xml')) return 'image'
  if (TEXT_EXTS.has(ext) || mime.startsWith('text/')) return 'text'
  if (!mime || mime === 'application/octet-stream') return 'text'
  return 'reject'
}

export function decodeDroppedText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

export function readDroppedBytes(file: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result
      if (!(result instanceof ArrayBuffer)) {
        reject(new Error('read failed'))
        return
      }
      resolve(new Uint8Array(result))
    }
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.readAsArrayBuffer(file)
  })
}
