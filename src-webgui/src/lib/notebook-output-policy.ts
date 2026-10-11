/**
 * Notebook output security policy (M4).
 *
 * Do not reuse MarkdownPreviewTab for cell outputs — that path opens workspace
 * files and allows remote images. Notebook outputs must stay inert.
 *
 * `metadata.trusted` in the ipynb grants nothing.
 */

export const NOTEBOOK_OUTPUT_MAX_TEXT_CHARS = 256 * 1024
export const NOTEBOOK_OUTPUT_MAX_IMAGE_BYTES = 2 * 1024 * 1024

export type NotebookOutputKind =
  | 'stream'
  | 'error'
  | 'text'
  | 'markdown'
  | 'image-png'
  | 'image-jpeg'
  | 'html-blocked'
  | 'unsupported'

export type NotebookSafeOutput =
  | { kind: 'stream' | 'text' | 'markdown' | 'error'; text: string; truncated: boolean }
  | { kind: 'image-png' | 'image-jpeg'; bytes: Uint8Array; mime: string }
  | { kind: 'html-blocked' | 'unsupported'; reason: string }

function truncate(text: string, max = NOTEBOOK_OUTPUT_MAX_TEXT_CHARS): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  return { text: text.slice(0, max) + '\n… [truncated]', truncated: true }
}

/** PNG magic 89 50 4E 47 0D 0A 1A 0A */
function isPng(bytes: Uint8Array): boolean {
  return bytes.length >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a
}

/** JPEG magic FF D8 FF */
function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
}

function decodeBase64(data: string): Uint8Array | null {
  try {
    const bin = atob(data.replace(/\s/g, ''))
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

/**
 * Classify a single Jupyter output payload into a safe render plan.
 * HTML is never executed; callers may show a placeholder only.
 */
export function classifyNotebookOutput(output: {
  output_type?: string
  name?: string
  text?: string | string[]
  data?: Record<string, unknown>
  ename?: string
  evalue?: string
  traceback?: string[]
}): NotebookSafeOutput {
  const join = (v: string | string[] | undefined) =>
    v == null ? '' : Array.isArray(v) ? v.join('') : String(v)

  if (output.output_type === 'stream') {
    const { text, truncated } = truncate(join(output.text))
    return { kind: 'stream', text, truncated }
  }
  if (output.output_type === 'error') {
    const parts = [
      output.ename ?? 'Error',
      output.evalue ?? '',
      ...(output.traceback ?? []),
    ].filter(Boolean)
    const { text, truncated } = truncate(parts.join('\n'))
    return { kind: 'error', text, truncated }
  }

  const data = output.data ?? {}
  // Prefer plain text / markdown over HTML. Never trust metadata.trusted.
  if (typeof data['text/plain'] === 'string' || Array.isArray(data['text/plain'])) {
    const { text, truncated } = truncate(join(data['text/plain'] as string | string[]))
    return { kind: 'text', text, truncated }
  }
  if (typeof data['text/markdown'] === 'string' || Array.isArray(data['text/markdown'])) {
    const { text, truncated } = truncate(join(data['text/markdown'] as string | string[]))
    return { kind: 'markdown', text, truncated }
  }
  if (typeof data['image/png'] === 'string') {
    const bytes = decodeBase64(data['image/png'] as string)
    if (!bytes || bytes.length > NOTEBOOK_OUTPUT_MAX_IMAGE_BYTES) {
      return { kind: 'unsupported', reason: 'PNG output missing or exceeds size bound' }
    }
    if (!isPng(bytes)) return { kind: 'unsupported', reason: 'PNG magic mismatch' }
    return { kind: 'image-png', bytes, mime: 'image/png' }
  }
  if (typeof data['image/jpeg'] === 'string' || typeof data['image/jpg'] === 'string') {
    const raw = (data['image/jpeg'] ?? data['image/jpg']) as string
    const bytes = decodeBase64(raw)
    if (!bytes || bytes.length > NOTEBOOK_OUTPUT_MAX_IMAGE_BYTES) {
      return { kind: 'unsupported', reason: 'JPEG output missing or exceeds size bound' }
    }
    if (!isJpeg(bytes)) return { kind: 'unsupported', reason: 'JPEG magic mismatch' }
    return { kind: 'image-jpeg', bytes, mime: 'image/jpeg' }
  }
  if (data['text/html'] != null) {
    // M4: HTML requires inert sandboxed iframe + DOMPurify before enablement.
    // Until that path is wired and advisory-checked, block rather than render.
    return {
      kind: 'html-blocked',
      reason: 'HTML outputs are blocked until the sandboxed renderer ships',
    }
  }
  return { kind: 'unsupported', reason: 'No safe MIME type in output' }
}

/** Markdown cell / output rendering must not resolve workspace files or remote images by default. */
export const notebookMarkdownComponents = {
  // Strip images entirely in notebook markdown (no workspace File RPC, no remote).
  img: () => null,
  // Only allow http(s) links through the existing confirm + OpenExternal path at click time.
  // The component that consumes this should still intercept clicks.
} as const

/** metadata.trusted must never widen privileges. */
export function notebookTrustGrantsNothing(_metadata: unknown): false {
  return false
}

/**
 * Owned blob URLs for raster outputs — caller must revoke on clear/close.
 * Never point at koma://localhost/image/ or File RPC.
 */
export function notebookImageObjectUrl(bytes: Uint8Array, mime: 'image/png' | 'image/jpeg'): string {
  const copy = new Uint8Array(bytes)
  const blob = new Blob([copy], { type: mime })
  return URL.createObjectURL(blob)
}
