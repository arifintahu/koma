import { describe, expect, it } from 'vitest'
import {
  fallbackSignature,
  formatToolPayload,
  isPathToolPreview,
  toolPreviewValue,
  truncateChars,
} from './toolSignature'

describe('isPathToolPreview', () => {
  it('treats file tools as path-like (CSS left-ellipsis)', () => {
    expect(isPathToolPreview('read')).toBe(true)
    expect(isPathToolPreview('edit')).toBe(true)
    expect(isPathToolPreview('delete')).toBe(true)
    expect(isPathToolPreview('write')).toBe(true)
    expect(isPathToolPreview('cd')).toBe(true)
    expect(isPathToolPreview('bash')).toBe(false)
    expect(isPathToolPreview('grep')).toBe(false)
  })
})

describe('toolPreviewValue', () => {
  it('returns the full path / command — no char cap (CSS clips the row)', () => {
    const path = JSON.stringify({ path: 'src-webgui/src/components/ChatView.tsx' })
    expect(toolPreviewValue('edit', path)).toBe('src-webgui/src/components/ChatView.tsx')
    expect(toolPreviewValue('read', path)).toBe('src-webgui/src/components/ChatView.tsx')
    const cmd = JSON.stringify({ command: 'npm run test:logic -- src/lib/toolSignature.vitest.test.ts' })
    expect(toolPreviewValue('bash', cmd)).toBe(
      'npm run test:logic -- src/lib/toolSignature.vitest.test.ts',
    )
  })

  it('leaves short values intact', () => {
    expect(toolPreviewValue('bash', JSON.stringify({ command: 'ls -la' }))).toBe('ls -la')
    expect(toolPreviewValue('edit', JSON.stringify({ path: 'main.rs' }))).toBe('main.rs')
  })
})

describe('payload stays intact', () => {
  it('formatToolPayload pretty-prints the full JSON', () => {
    const args = JSON.stringify({ path: 'path/path/path.php', old: 'a'.repeat(80), new: 'b' })
    const pretty = formatToolPayload(args)
    expect(pretty).toContain('path/path/path.php')
    expect(pretty).toContain('a'.repeat(80))
    expect(fallbackSignature('edit', args)).toContain('path/path/path.php')
  })
})

describe('truncateChars', () => {
  it('caps at max including ellipsis (approval overlay only)', () => {
    expect(truncateChars('abcdefghijklmnop', 15)).toBe('abcdefghijklmn…')
  })
})
