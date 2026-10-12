import { describe, expect, it } from 'vitest'
import {
  classifyNotebookOutput,
  notebookTrustGrantsNothing,
} from './notebook-output-policy'

const PNG_B64 = btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3))

describe('notebook-output-policy', () => {
  it('classifies streams and errors as text', () => {
    expect(classifyNotebookOutput({ output_type: 'stream', text: ['hello\n', 'world'] })).toEqual({
      kind: 'stream', text: 'hello\nworld', truncated: false,
    })
    const err = classifyNotebookOutput({
      output_type: 'error', ename: 'ValueError', evalue: 'x', traceback: ['line'],
    })
    expect(err.kind).toBe('error')
    if (err.kind === 'error') expect(err.text).toContain('ValueError')
  })

  it('accepts PNG with valid magic and sanitizes HTML', () => {
    const png = classifyNotebookOutput({
      output_type: 'display_data',
      data: { 'image/png': PNG_B64 },
    })
    expect(png.kind).toBe('image-png')
    const html = classifyNotebookOutput({
      output_type: 'display_data',
      data: { 'text/html': '<script>alert(1)</script><b onclick="x">ok</b>' },
    })
    // Script + handlers stripped; remaining safe markup may render as html.
    if (html.kind === 'html') {
      expect(html.html.toLowerCase()).not.toContain('script')
      expect(html.html.toLowerCase()).not.toContain('onclick')
    } else {
      expect(html.kind).toBe('html-blocked')
    }
  })

  it('neutralizes javascript urls and remote images in HTML', () => {
    const html = classifyNotebookOutput({
      output_type: 'display_data',
      data: {
        'text/html':
          '<a href="javascript:alert(1)">x</a><img src="https://evil.example/x.png"><p>hi</p>',
      },
    })
    if (html.kind === 'html') {
      expect(html.html.toLowerCase()).not.toContain('javascript:')
      expect(html.html.toLowerCase()).not.toContain('https://evil')
      expect(html.html).toContain('hi')
    } else {
      expect(html.kind).toBe('html-blocked')
    }
  })

  it('rejects forged PNG bytes', () => {
    const bad = classifyNotebookOutput({
      output_type: 'display_data',
      data: { 'image/png': btoa('not-a-png') },
    })
    expect(bad.kind).toBe('unsupported')
  })

  it('never treats metadata.trusted as authority', () => {
    expect(notebookTrustGrantsNothing({ trusted: true })).toBe(false)
  })
})
