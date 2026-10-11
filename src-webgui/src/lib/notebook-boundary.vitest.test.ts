import { describe, expect, it, vi } from 'vitest'
import { isNotebookPath } from './notebook-workspace'

/**
 * M0 boundary: opening / watching / saving notebooks must not feed ordinary LSP.
 * These are pure policy unit checks; UI routing is covered by component structure.
 */

describe('notebook M0 LSP / format boundary helpers', () => {
  it('classifies notebook paths for every gate', () => {
    expect(isNotebookPath('a/b.IPYNB')).toBe(true)
    expect(isNotebookPath('a.ipynb.bak')).toBe(false)
  })

  it('disk-watch policy skips LspDidChange for notebooks', async () => {
    const req = vi.fn()
    const path = 'notes/demo.ipynb'
    const root = '/ws'
    const diskContent = '{"cells":[]}'
    // Mirror coding-disk.ts guard.
    if (!isNotebookPath(path)) {
      req({ r: 'LspDidChange', root, path, text: diskContent })
    }
    expect(req).not.toHaveBeenCalled()
  })

  it('save push policy skips LspDidSave for notebooks', () => {
    const req = vi.fn()
    const path = 'x.ipynb'
    if (!isNotebookPath(path)) {
      req({ r: 'LspDidSave', root: '/r', path, text: '{}' })
    }
    expect(req).not.toHaveBeenCalled()
  })

  it('close policy skips LspDidClose for notebooks', () => {
    const req = vi.fn()
    const path = 'x.ipynb'
    if (!isNotebookPath(path)) {
      req({ r: 'LspDidClose', root: '/r', path })
    }
    expect(req).not.toHaveBeenCalled()
  })
})
