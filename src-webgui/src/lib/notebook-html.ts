/**
 * Sanitize + render notebook HTML (M4 outputs + markdown cell HTML).
 *
 * - DOMPurify with a strict allowlist
 * - inert sandboxed iframe via srcdoc only (no allow-scripts)
 * - output mode: remote images stripped (existing policy)
 * - markdown mode: https/http images allowed (badges, etc.); still no scripts
 * - metadata.trusted grants nothing (enforced by policy, not here)
 */

import DOMPurify from 'dompurify'

const ALLOWED_TAGS = [
  'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'code', 'col', 'colgroup',
  'div', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'li',
  'ol', 'p', 'pre', 'span', 'strong', 'sub', 'sup', 'table', 'tbody', 'td',
  'tfoot', 'th', 'thead', 'tr', 'ul',
]

const ALLOWED_ATTR = [
  'href', 'title', 'alt', 'colspan', 'rowspan', 'scope', 'class', 'id',
  'src', 'width', 'height', 'align', 'target', 'rel',
]

export type SanitizeNotebookHtmlOptions = {
  /** Markdown cells may show remote badge images; cell *outputs* stay locked down. */
  allowRemoteImages?: boolean
}

/** Purify notebook HTML. Returns empty string when nothing safe remains. */
export function sanitizeNotebookHtml(
  raw: string,
  opts?: SanitizeNotebookHtmlOptions,
): string {
  if (!raw || typeof raw !== 'string') return ''
  const purified = DOMPurify.sanitize(raw, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
    FORBID_TAGS: [
      'script', 'iframe', 'object', 'embed', 'form', 'input', 'button',
      'textarea', 'select', 'svg', 'math', 'link', 'meta', 'base', 'style',
    ],
    FORBID_ATTR: ['style', 'srcset', 'onerror', 'onload', 'onclick'],
  })
  return stripDangerousUrls(String(purified), !!opts?.allowRemoteImages)
}

function stripDangerousUrls(html: string, allowRemoteImages: boolean): string {
  let out = html
    .replace(/\shref\s*=\s*("|'|)(\s*javascript:[^"'\s>]*)\1/gi, ' href="#"')
    .replace(/\ssrc\s*=\s*("|'|)(\s*javascript:[^"'\s>]*)\1/gi, '')
    .replace(/\ssrc\s*=\s*("|'|)(data:image\/(?!png|jpeg|jpg|gif|webp)[^"'\s>]*)\1/gi, '')
  if (!allowRemoteImages) {
    // Cell outputs: no remote network fetches from the sandboxed frame.
    out = out.replace(/\ssrc\s*=\s*("|'|)(https?:\/\/[^"'\s>]*)\1/gi, '')
  }
  // Force safe link targets (noopener) when target is present.
  out = out.replace(
    /\starget\s*=\s*("|'|)([^"'\s>]*)\1/gi,
    ' target="_blank" rel="noopener noreferrer"',
  )
  return out
}

export function notebookHtmlSrcdoc(
  purified: string,
  opts?: { allowRemoteImages?: boolean; themeFg?: string; themeBg?: string },
): string {
  const body = purified || '<p></p>'
  const imgSrc = opts?.allowRemoteImages ? 'img-src https: http: data:;' : 'img-src data:;'
  const fg = opts?.themeFg || 'inherit'
  const bg = opts?.themeBg || 'transparent'
  // CSP meta inside srcdoc: block scripts; images per mode.
  return `<!doctype html><html><head><meta charset="utf-8"/><meta http-equiv="Content-Security-Policy" content="default-src 'none'; ${imgSrc} style-src 'unsafe-inline'; sandbox"/><style>html,body{margin:0;padding:2px 0;font:13px/1.5 system-ui,-apple-system,sans-serif;color:${fg};background:${bg};overflow:auto}table{border-collapse:collapse}td,th{border:1px solid color-mix(in srgb, ${fg} 25%, transparent);padding:2px 6px}a{color:#3b82f6}img{max-width:100%;height:auto;vertical-align:middle}</style></head><body>${body}</body></html>`
}

/** True when a markdown cell is mostly/raw HTML (Colab badges, tables, etc.). */
export function markdownLooksLikeHtml(source: string): boolean {
  const t = source.trim()
  if (!t) return false
  // Leading tag, or a substantial share of angle-bracket markup.
  if (/^<[a-zA-Z!/?]/.test(t)) return true
  const tags = t.match(/<\/?[a-zA-Z][^>]*>/g)
  if (!tags || tags.length < 2) return false
  const tagChars = tags.join('').length
  return tagChars / t.length > 0.25
}
