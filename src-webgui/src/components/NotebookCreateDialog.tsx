import { useEffect, useRef, useState } from 'react'
import { useKoma } from '../store/koma'
import { codingRequest, type WorkspaceRef } from '../lib/coding-service'

type Context = { workspace: WorkspaceRef; directory: string }
export function showNewNotebook(root?: string, directory = '') {
  const state = useKoma.getState()
  root ??= state.coding.activeRoot ?? state.settingsValues?.workdir?.[0]
  if (root) window.dispatchEvent(new CustomEvent<Context>('koma-new-notebook', {
    detail: { workspace: { hostId: state.remoteState.hostId ?? 'local', root }, directory },
  }))
}

export function NotebookCreateDialog() {
  const [context, setContext] = useState<Context | null>(null)
  const [name, setName] = useState('Untitled.ipynb')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const restoreFocus = useRef<HTMLElement | null>(null)
  const sequence = useRef(0)
  const hostId = useKoma(state => state.remoteState.hostId ?? 'local')
  const close = () => { ++sequence.current; setContext(null); requestAnimationFrame(() => restoreFocus.current?.focus()) }
  useEffect(() => {
    const open = (event: Event) => {
      ++sequence.current
      restoreFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      setContext((event as CustomEvent<Context>).detail); setName('Untitled.ipynb'); setError(null); setBusy(false)
    }
    window.addEventListener('koma-new-notebook', open)
    return () => window.removeEventListener('koma-new-notebook', open)
  }, [])
  useEffect(() => { ++sequence.current; setContext(null) }, [hostId])
  useEffect(() => { if (context) { input.current?.focus(); input.current?.select() } }, [context])
  if (!context) return null
  const create = async () => {
    const filename = name.trim()
    if (!filename || filename.includes('..') || /[/\\\0]/.test(filename)) { setError('Choose a filename without path separators or ..'); return }
    const path = `${context.directory ? context.directory.replace(/\/$/, '') + '/' : ''}${/\.ipynb$/i.test(filename) ? filename : filename + '.ipynb'}`
    const request = ++sequence.current
    setBusy(true); setError(null)
    try {
      const result = await codingRequest<{ error?: string | null }>(context.workspace, { op: 'file', body: { r: 'FileCreate', path, kind: 'file' } })
      if (result.error) throw new Error(result.error)
      if (request !== sequence.current) return
      const store = useKoma.getState()
      if ((store.remoteState.hostId ?? 'local') !== context.workspace.hostId) return
      store.refreshCodingDir(context.workspace.root, context.directory)
      store.openCodingFile(context.workspace.root, path)
      close()
    } catch (error) {
      if (request === sequence.current) setError(error instanceof Error ? error.message : String(error))
    } finally { if (request === sequence.current) setBusy(false) }
  }
  return <div className="absolute inset-0 z-50 flex items-start justify-center bg-black/20 pt-16" onMouseDown={() => { if (!busy) close() }}>
    <form role="dialog" aria-modal="true" aria-label="New Notebook" className="w-[min(440px,90vw)] rounded border border-koma-border bg-koma-panel p-4 text-[12px] text-koma-fg shadow-xl" onMouseDown={event => event.stopPropagation()} onSubmit={event => { event.preventDefault(); if (!busy) void create() }} onKeyDown={event => {
      if (event.key === 'Escape' && !busy) { event.preventDefault(); close() }
      if (event.key === 'Tab') {
        const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('input:not([disabled]),button:not([disabled])'))
        const current = items.indexOf(document.activeElement as HTMLElement)
        event.preventDefault(); items[(current + (event.shiftKey ? -1 : 1) + items.length) % items.length]?.focus()
      }
    }}>
      <h2 className="mb-3 font-semibold">New Notebook</h2>
      <p className="mb-2 break-all text-koma-dim">{context.workspace.root}{context.directory ? '/' + context.directory : ''}</p>
      <label className="block">Filename<input ref={input} value={name} disabled={busy} onChange={event => setName(event.target.value)} className="mt-1 w-full rounded border border-koma-border bg-koma-bg px-2 py-1.5 outline-none focus:border-koma-accent" /></label>
      <p className="mt-2 text-koma-dim">Creates a Python notebook. Opening it does not run code or install packages.</p>
      {error && <p role="alert" className="mt-2 text-koma-error">{error}</p>}
      <div className="mt-4 flex justify-end gap-2"><button type="button" disabled={busy} onClick={close} className="rounded px-3 py-1 hover:bg-koma-hover">Cancel</button><button type="submit" disabled={busy} className="rounded bg-koma-hover px-3 py-1 disabled:opacity-40">{busy ? 'Creating…' : 'Create'}</button></div>
    </form>
  </div>
}
