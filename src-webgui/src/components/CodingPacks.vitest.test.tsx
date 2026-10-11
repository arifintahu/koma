import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useKoma } from '../store/koma'

vi.mock('./CodingTasks', () => ({ showCodingTasks: vi.fn() }))
vi.mock('../lib/coding-service', async importOriginal => {
  const actual = await importOriginal<typeof import('../lib/coding-service')>()
  return { ...actual, codingRequest: vi.fn() }
})
import { codingRequest } from '../lib/coding-service'
import { CodingPacks } from './CodingPacks'

const lspPath = '/Users/test/.koma/lsp/basedpyright/venv/bin/basedpyright-langserver'
const status = {
  platform: 'macos', fingerprint: 'test', packs: [{
    id: 'python', label: 'Python', runtime: '/usr/bin/python3', runtimeName: 'python3',
    selected: '/usr/bin/python3', candidates: [], lsp: lspPath,
    server: 'basedpyright', serverOptions: ['basedpyright'],
    adapter: null, adapterName: 'debugpy', test: 'pytest',
  }],
}
afterEach(() => { cleanup(); vi.clearAllMocks() })

it('keeps descriptions and paths behind help and reviews selected tools', async () => {
  vi.mocked(codingRequest).mockImplementation(async (_workspace, op) => {
    if (op.op === 'packPlan') return { id: 'plan', label: 'Python', commands: [], notes: 'Reviewed install' } as never
    return status as never
  })
  useKoma.setState(s => ({ coding: { ...s.coding, activeRoot: '/workspace' }, remoteState: { ...s.remoteState, hostId: 'local' } }))
  render(<CodingPacks visible />)
  await screen.findByLabelText('Python interpreter')
  fireEvent.click(screen.getByRole('button', { name: 'Tools', exact: true }))
  const checkbox = screen.getByRole('checkbox', { name: 'Language server' })
  expect((checkbox as HTMLInputElement).checked).toBe(true)
  const help = screen.getByLabelText('About Language server').closest('details')!
  expect(help.open).toBe(false)
  expect(help.textContent).toContain(lspPath)
  help.open = true
  fireEvent(help, new Event('toggle'))
  expect(help.open).toBe(true)
  fireEvent.click(screen.getByRole('checkbox', { name: 'Debugger' }))
  fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
  await waitFor(() => expect(codingRequest).toHaveBeenCalledWith(
    { hostId: 'local', root: '/workspace' },
    { op: 'packPlan', packId: 'python', runtime: false, notebook: false, lsp: true, adapter: false, server: 'basedpyright' },
  ))
  await screen.findByRole('button', { name: 'Install / update', exact: true })
})
