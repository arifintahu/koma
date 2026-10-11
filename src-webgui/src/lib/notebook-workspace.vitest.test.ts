import { beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyFileState, fileKey, initialCoding } from '../store/coding'
import { codingHostViews } from '../store/runtime'

const mock = vi.hoisted(() => ({ state: null as unknown as {
  remoteState: { hostId: string | null }
  coding: { files: Record<string, ReturnType<typeof emptyFileState>> }
  updateCodingContent: ReturnType<typeof vi.fn>
} }))
vi.mock('../store/koma', () => ({ useKoma: { getState: () => mock.state } }))
vi.mock('./coding-recovery', () => ({ backupCodingDocument: vi.fn(), forgetCodingDraft: vi.fn() }))
import { backupCodingDocument } from './coding-recovery'
import {
  clearNotebookEpoch,
  isNotebookPath,
  readNotebookFile,
  setNotebookEpoch,
  updateNotebookText,
} from './notebook-workspace'
import { NotebookController, disposeNotebookController } from './notebook-controller'
import { bindCellIdentities } from './notebook-identity'

const local = { hostId: 'local', root: '/project' }
const key = fileKey(local.root, 'same.ipynb')
const TEMPLATE = `{
  "cells": [
    {
      "cell_type": "code",
      "execution_count": null,
      "id": "cell-0",
      "metadata": {},
      "outputs": [],
      "source": []
    }
  ],
  "metadata": { "language_info": { "name": "python" } },
  "nbformat": 4,
  "nbformat_minor": 5
}`

describe('notebook host-bound document authority', () => {
  beforeEach(() => {
    codingHostViews.clear(); vi.clearAllMocks()
    clearNotebookEpoch(local, 'same.ipynb')
    mock.state = {
      remoteState: { hostId: null },
      coding: { files: { [key]: emptyFileState({ content: 'local', savedContent: 'local' }) } },
      updateCodingContent: vi.fn(),
    }
  })
  it('uses the existing active Coding writer', () => {
    expect(readNotebookFile(local, 'same.ipynb')?.content).toBe('local')
    expect(updateNotebookText(local, 'same.ipynb', 'new')).toBe(true)
    expect(mock.state.updateCodingContent).toHaveBeenCalledWith('/project', 'same.ipynb', 'new')
  })
  it('banks output in the original host without changing the active remote file', () => {
    const bank = { coding: { ...initialCoding, files: { ...mock.state.coding.files } } }
    codingHostViews.set('local', bank as Parameters<typeof codingHostViews.set>[1])
    mock.state.remoteState.hostId = 'remote'
    mock.state.coding.files[key] = emptyFileState({ content: 'remote', savedContent: 'remote' })
    expect(updateNotebookText(local, 'same.ipynb', 'local output')).toBe(true)
    expect(readNotebookFile(local, 'same.ipynb')?.content).toBe('local output')
    expect(mock.state.coding.files[key].content).toBe('remote')
    expect(mock.state.updateCodingContent).not.toHaveBeenCalled()
    expect(backupCodingDocument).toHaveBeenCalledWith(local, 'same.ipynb', expect.objectContaining({ content: 'local output', savedContent: 'local' }))
  })
  it('does not recreate a closed or unavailable document', () => {
    delete mock.state.coding.files[key]
    expect(updateNotebookText(local, 'same.ipynb', 'late output')).toBe(false)
    expect(mock.state.updateCodingContent).not.toHaveBeenCalled()
    mock.state.remoteState.hostId = 'remote'
    expect(updateNotebookText(local, 'same.ipynb', 'late output')).toBe(false)
  })
  it('recognizes only notebook extensions', () => {
    expect(isNotebookPath('NOTEBOOK.IPYNB')).toBe(true)
    expect(isNotebookPath('notebook.ipynb.py')).toBe(false)
  })
  it('rejects stale content and epoch CAS', () => {
    setNotebookEpoch(local, 'same.ipynb', 2)
    expect(updateNotebookText(local, 'same.ipynb', 'x', { expectedEpoch: 1 })).toBe(false)
    expect(mock.state.updateCodingContent).not.toHaveBeenCalled()
    setNotebookEpoch(local, 'same.ipynb', 0)
    expect(updateNotebookText(local, 'same.ipynb', 'x', { expectedContent: 'other', expectedEpoch: 0 })).toBe(false)
    expect(updateNotebookText(local, 'same.ipynb', 'x', { expectedContent: 'local', expectedEpoch: 0 })).toBe(true)
  })
})

describe('notebook controller history and identity', () => {
  beforeEach(() => {
    codingHostViews.clear(); vi.clearAllMocks()
    clearNotebookEpoch(local, 'nb.ipynb')
    disposeNotebookController(local.hostId, local.root, 'nb.ipynb')
    const k = fileKey(local.root, 'nb.ipynb')
    mock.state = {
      remoteState: { hostId: null },
      coding: { files: { [k]: emptyFileState({ content: TEMPLATE, savedContent: TEMPLATE }) } },
      updateCodingContent: vi.fn((root: string, path: string, content: string) => {
        const fk = fileKey(root, path)
        const prev = mock.state.coding.files[fk]
        if (!prev) return
        mock.state.coding.files[fk] = { ...prev, content, dirty: content !== (prev.savedContent ?? '') }
      }),
    }
  })

  it('does not invent persisted ids on open and keeps runtime ids stable across source edits', () => {
    const c = new NotebookController(local, 'nb.ipynb', TEMPLATE)
    const first = c.getState().identities[0]!
    expect(first.persistedId).toBe('cell-0')
    c.setCellSource(first.runtimeId, 'a = 1')
    expect(c.getState().identities[0]!.runtimeId).toBe(first.runtimeId)
    expect(mock.state.coding.files[fileKey(local.root, 'nb.ipynb')].dirty).toBe(true)
    c.dispose()
  })

  it('undoes structural edits and rejects late CAS after external adopt', () => {
    const c = new NotebookController(local, 'nb.ipynb', TEMPLATE)
    const id = c.getState().identities[0]!.runtimeId
    expect(c.setCellSource(id, 'one')).toBe(true)
    expect(c.setCellSource(id, 'two')).toBe(true)
    expect(c.getState().canUndo).toBe(true)
    expect(c.undo()).toBe(true)
    const afterUndo = mock.state.coding.files[fileKey(local.root, 'nb.ipynb')].content
    expect(afterUndo).toContain('one')
    expect(afterUndo).not.toContain('two')
    // External buffer change advances epoch; a stale expected epoch cannot commit.
    c.adoptExternalText(TEMPLATE)
    const stale = updateNotebookText(local, 'nb.ipynb', 'nope', {
      expectedContent: afterUndo!,
      expectedEpoch: 0,
    })
    expect(stale).toBe(false)
    c.dispose()
  })

  it('forces raw mode for invalid JSON without rewriting the buffer on construct', () => {
    const bad = '{broken'
    const k = fileKey(local.root, 'bad.ipynb')
    mock.state.coding.files[k] = emptyFileState({ content: bad, savedContent: bad })
    const c = new NotebookController(local, 'bad.ipynb', bad)
    expect(c.getState().mode).toBe('raw')
    expect(c.getState().parse.ok).toBe(false)
    expect(mock.state.coding.files[k].content).toBe(bad)
    c.dispose()
  })
})

describe('notebook identity binding', () => {
  it('reuses runtime ids by persisted id without minting disk ids', () => {
    const a = bindCellIdentities([{ persistedId: 'cell-0' }, { persistedId: null }])
    const b = bindCellIdentities([{ persistedId: 'cell-0' }, { persistedId: null }], a)
    expect(b[0]!.runtimeId).toBe(a[0]!.runtimeId)
    expect(b[0]!.persistedId).toBe('cell-0')
    expect(b[1]!.persistedId).toBe(null)
  })
})
