import { describe, expect, it } from 'vitest'
import {
  markdownLooksLikeHtml,
  sanitizeNotebookHtml,
} from './notebook-html'

describe('notebook-html', () => {
  it('detects HTML-dominant markdown cells', () => {
    expect(markdownLooksLikeHtml('# title')).toBe(false)
    expect(
      markdownLooksLikeHtml(
        '<table><tr><td><a href="https://x"><img src="https://x/b.svg"/></a></td></tr></table>',
      ),
    ).toBe(true)
  })

  it('allows remote images only when opted in', () => {
    const raw = '<img src="https://colab.research.google.com/assets/colab-badge.svg" alt="x"/>'
    const locked = sanitizeNotebookHtml(raw, { allowRemoteImages: false })
    expect(locked.toLowerCase()).not.toContain('https://colab')
    const open = sanitizeNotebookHtml(raw, { allowRemoteImages: true })
    expect(open).toContain('colab.research.google.com')
    expect(open.toLowerCase()).not.toContain('script')
  })

  it('strips scripts always', () => {
    const html = sanitizeNotebookHtml('<script>alert(1)</script><b>ok</b>', {
      allowRemoteImages: true,
    })
    expect(html.toLowerCase()).not.toContain('script')
    expect(html).toContain('ok')
  })
})
