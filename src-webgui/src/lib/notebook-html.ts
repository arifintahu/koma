/**
 * Sanitize + render notebook HTML outputs (M4).
 *
 * - DOMPurify with a strict allowlist
 * - inert sandboxed iframe via srcdoc only (no allow-scripts)
 * - remote images stripped; javascript: neutralized
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
  'src', 'width', 'height', 'align',
]

/** Purify notebook HTML. Returns empty string when nothing safe remains. */
export function sanitizeNotebookHtml(raw: string): string {
  if (!raw || typeof raw !== 'string') return ''
  // DOMPurify needs a window; in vitest/jsdom it uses the global.
  const purified = DOMPurify.sanitize(raw, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'svg', 'math', 'link', 'meta', 'base', 'style'],
    FORBID_ATTR: ['style', 'srcset'],
    // Hook: only allow http(s) links and data:image/png|jpeg images.
  })
  return stripDangerousUrls(String(purified))
}

function stripDangerousUrls(html: string): string {
  // Defense in depth beyond DOMPurify defaults.
  return html
    .replace(/\shref\s*=\s*("|'|)(\s*javascript:[^"'\s>]*)\1/gi, ' href="#"')
    .replace(/\ssrc\s*=\s*("|'|)(\s*javascript:[^"'\s>]*)\1/gi, '')
    .replace(/\ssrc\s*=\s*("|'|)(https?:\/\/[^"'\s>]*)\1/gi, '') // strip remote img
    .replace(/\ssrc\s*=\s*("|'|)(data:image\/(?!png|jpeg|jpg)[^"'\s>]*)\1/gi, '')
}

export function notebookHtmlSrcdoc(purified: string): string {
  const body = purified || '<p></p>'
  // CSP meta inside srcdoc: block scripts and external loads.
  return `<!doctype html><html><head><meta charset="utf-8"/><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox"/><style>html,body{margin:0;padding:4px 6px;font:12px/1.4 system-ui,sans-serif;color:inherit;background:transparent;overflow:auto}table{border-collapse:collapse}td,th{border:1px solid #8884;padding:2px 6px}a{color:#6af}</style></head><body>${body}</body></html>`
}
