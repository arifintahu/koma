// Shared tool-signature formatting — used by ChatView's tool-call rows and
// ApprovalOverlay's risky-tool modal. Both render a `name(<short args>)`
// preview when the host hasn't projected a pre-formatted `signature`.

// Char-aware truncate with an ellipsis at the end (mirrors transcript.rs `truncate_chars`).
export function truncateChars(s: string, max: number): string {
  const chars = Array.from(s)
  return chars.length <= max ? s : `${chars.slice(0, Math.max(0, max - 1)).join('')}…`
}

// Salient-arg keys per tool (light port of transcript.rs `tool_signature_inner`)
// — used only when the host doesn't supply a pre-formatted `signature`.
const SALIENT_ARG: Record<string, string> = {
  bash: 'command',
  read: 'path',
  write: 'path',
  edit: 'path',
  delete: 'path',
  cd: 'path',
  grep: 'pattern',
  glob: 'pattern',
  dir_list: 'path',
  task: 'agent',
  recall: 'slug',
}

const PATH_TOOLS = new Set(['read', 'write', 'edit', 'delete', 'cd', 'dir_list'])

/** Path-like tools keep the filename: CSS left-ellipsis on the collapsed row. */
export function isPathToolPreview(name: string): boolean {
  return PATH_TOOLS.has(name)
}

function previewScalar(val: unknown): string {
  if (val == null) return ''
  if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
    return String(val)
  }
  return ''
}

/** Untruncated salient value for the collapsed-row hint + tooltip. Payload untouched. */
export function toolPreviewValue(name: string, args: string): string {
  // Checklist lives in Explore / /todo — never dump the todos array inline.
  if (name === 'checklist') return ''
  let inner = ''
  try {
    const parsed = JSON.parse(args)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const key = SALIENT_ARG[name]
      const val = key != null && (parsed as Record<string, unknown>)[key] != null
        ? (parsed as Record<string, unknown>)[key]
        : Object.values(parsed as Record<string, unknown>)[0]
      inner = previewScalar(val)
    }
  } catch {
    inner = args
  }
  return inner.replace(/\s+/g, ' ').trim()
}

// Fallback display signature `name(arg)` when the host hasn't projected one.
export function fallbackSignature(name: string, args: string): string {
  const inner = toolPreviewValue(name, args)
  return `${name}(${truncateChars(inner, 60)})`
}

/** Pretty-printed tool arguments for the GUI payload pane. */
export function formatToolPayload(args: string): string {
  const raw = args.trim()
  if (raw === '') return ''
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}
