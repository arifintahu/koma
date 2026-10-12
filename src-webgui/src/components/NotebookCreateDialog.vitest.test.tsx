import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({
  state: { remoteState: { hostId: null as string | null }, coding: { activeRoot: '/workspace' }, settingsValues: { workdir: ['/workspace'] }, refreshCodingDir: vi.fn(), openCodingFile: vi.fn() },
  request: vi.fn(),
}))
vi.mock('../store/koma', () => ({ useKoma: Object.assign((selector: (state: typeof mock.state) => unknown) => selector(mock.state), { getState: () => mock.state }) }))
vi.mock('../lib/coding-service', () => ({ codingRequest: mock.request }))
import { NotebookCreateDialog, showNewNotebook } from './NotebookCreateDialog'

beforeEach(() => {
  vi.clearAllMocks(); mock.state.remoteState.hostId = null; mock.request.mockResolvedValue({})
})
afterEach(cleanup)
it('creates through the native exclusive-file operation using the captured workspace', async () => {
  render(<NotebookCreateDialog />)
  act(() => showNewNotebook('/workspace', 'notebooks'))
  fireEvent.change(screen.getByRole('textbox', { name: 'Filename' }), { target: { value: 'experiment' } })
  fireEvent.click(screen.getByRole('button', { name: 'Create' }))
  await waitFor(() => expect(mock.state.openCodingFile).toHaveBeenCalledWith('/workspace', 'notebooks/experiment.ipynb'))
  expect(mock.request).toHaveBeenCalledWith({ hostId: 'local', root: '/workspace' }, { op: 'file', body: { r: 'FileCreate', path: 'notebooks/experiment.ipynb', kind: 'file' } })
  expect(mock.state.refreshCodingDir).toHaveBeenCalledWith('/workspace', 'notebooks')
  expect(screen.queryByRole('dialog')).toBeNull()
})
it('refuses traversal without sending a mutation', () => {
  render(<NotebookCreateDialog />)
  act(() => showNewNotebook('/workspace'))
  fireEvent.change(screen.getByRole('textbox', { name: 'Filename' }), { target: { value: '../bad' } })
  fireEvent.click(screen.getByRole('button', { name: 'Create' }))
  expect(screen.getByRole('alert').textContent).toContain('without path separators')
  expect(mock.request).not.toHaveBeenCalled()
})
it('does not open a late creation reply in a newly selected host', async () => {
  let resolve!: (result: object) => void
  mock.request.mockImplementation(() => new Promise(result => { resolve = result }))
  const view = render(<NotebookCreateDialog />)
  act(() => showNewNotebook('/workspace'))
  fireEvent.click(screen.getByRole('button', { name: 'Create' }))
  mock.state.remoteState.hostId = 'remote'
  view.rerender(<NotebookCreateDialog />)
  await act(async () => resolve({}))
  expect(mock.state.openCodingFile).not.toHaveBeenCalled()
  expect(mock.request.mock.calls[0][0]).toEqual({ hostId: 'local', root: '/workspace' })
  expect(screen.queryByRole('dialog')).toBeNull()
})
