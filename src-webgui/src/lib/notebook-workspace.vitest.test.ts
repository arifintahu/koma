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
import { isNotebookPath, readNotebookFile, updateNotebookText } from './notebook-workspace'

const local = { hostId: 'local', root: '/project' }
const key = fileKey(local.root, 'same.ipynb')
describe('notebook host-bound document authority', () => {
  beforeEach(() => {
    codingHostViews.clear(); vi.clearAllMocks()
    mock.state = { remoteState: { hostId: null }, coding: { files: { [key]: emptyFileState({ content: 'local', savedContent: 'local' }) } }, updateCodingContent: vi.fn() }
  })
  it('uses the existing active Coding writer', () => {
    expect(readNotebookFile(local, 'same.ipynb')?.content).toBe('local')
    expect(updateNotebookText(local, 'same.ipynb', 'new')).toBe(true)
    expect(mock.state.updateCodingContent).toHaveBeenCalledWith('/project', 'same.ipynb', 'new')
  })
  it('banks output in the original host without changing the active remote file', () => {
    const bank = { coding: { ...initialCoding, files: { ...mock.state.coding.files } } }
    // Only the coding member is used by this document adapter.
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
})
