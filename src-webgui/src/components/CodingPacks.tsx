import { KomaSelect } from './KomaSelect'
import { useEffect, useRef, useState } from 'react'
import { FileCog, Package, RefreshCw } from 'lucide-react'
import { useKoma, fileKey } from '../store/koma'
import { codingRequest, workspaceKey, type WorkspaceRef, type CodingTaskRun } from '../lib/coding-service'
import { invalidateCodingConfig } from '../lib/coding-config'
import { showCodingTasks } from './CodingTasks'
import { BrailleSpinner } from './BrailleSpinner'

type Pack = {
  id: string
  label: string
  runtime: string | null
  runtimeName: string
  selected: string
  candidates: string[]
  lsp: string | null
  server: string
  serverOptions: string[]
  adapter: string | null
  adapterName: string
  test: string
}
type Status = { packs: Pack[]; fingerprint: string; platform: string }
type Plan = { id: string; label: string; commands: { command: string; args: string[] }[]; notes: string }

/** Match CodingTasks tool chrome (BottomPanel design signature). */
const button =
  'flex h-6 items-center justify-center gap-1 rounded px-1.5 text-koma-dim hover:bg-koma-hover hover:text-koma-fg disabled:opacity-40 disabled:pointer-events-none'
const selectClass = 'h-6 w-full min-w-0 bg-koma-panel2 pl-2 text-[11px]'
const message = (e: unknown) => String(e instanceof Error ? e.message : e)

/** Open Language Packs as a BottomPanel tab (not a floating dialog). */
export function showCodingPacks(workspace?: WorkspaceRef, opts?: { notebook?: boolean }) {
  window.dispatchEvent(new CustomEvent('koma-coding-packs', { detail: { workspace, notebook: opts?.notebook } }))
}

/**
 * Language packs dock — same shell as Tasks / Problems / LSP:
 * fill BottomPanel, tool rows, no absolute card / shadow / own close chrome.
 * Native owns installs; this view may close while a pack task keeps running.
 */
export function CodingPacks({ visible: open }: { visible: boolean }) {
  const [workspaces, setWorkspaces] = useState<WorkspaceRef[]>([])
  const [workspace, setWorkspace] = useState<WorkspaceRef | null>(null)
  const [data, setData] = useState<Status | null>(null)
  const [packId, setPackId] = useState('python')
  const [executable, setExecutable] = useState('')
  const [server, setServer] = useState('')
  const [runtime, setRuntime] = useState(false)
  const [notebook, setNotebook] = useState(false)
  const [plan, setPlan] = useState<Plan | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [loadError, setLoadError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const mutation = useRef(false)
  const generation = useRef(0)
  const scope = workspace ? workspaceKey(workspace) : ''
  const currentHost = useKoma(s => s.remoteState.hostId ?? 'local')
  const currentRoots = useKoma(s => s.settingsValues?.workdir)
  const rootsKey = JSON.stringify(currentRoots ?? [])

  useEffect(() => {
    const onOpen = (event: Event) => {
      const state = useKoma.getState()
      const hostId = state.remoteState.hostId ?? 'local'
      const root = state.coding.activeRoot ?? state.settingsValues?.workdir?.[0]
      const target = (event as CustomEvent<{ workspace?: WorkspaceRef; notebook?: boolean }>).detail
      if (target?.workspace) setWorkspace(target.workspace)
      else if (root) setWorkspace({ hostId, root })
      if (target?.notebook) {
        setPackId('python')
        setNotebook(true)
      }
      state.setBottomPanelTab('packs')
      setRefresh(n => n + 1)
    }
    window.addEventListener('koma-coding-packs', onOpen)
    return () => window.removeEventListener('koma-coding-packs', onOpen)
  }, [])

  useEffect(() => {
    setWorkspaces(previous =>
      [
        ...new Map(
          [
            ...previous,
            ...JSON.parse(rootsKey).map((root: string) => ({ hostId: currentHost, root })),
            ...(workspace ? [workspace] : []),
          ].map(w => [workspaceKey(w), w]),
        ).values(),
      ],
    )
  }, [rootsKey, currentHost, scope])

  useEffect(() => {
    if (!open || workspace) return
    const state = useKoma.getState()
    const root = state.coding.activeRoot ?? state.settingsValues?.workdir?.[0]
    if (root) setWorkspace({ hostId: currentHost, root })
  }, [open, workspace, currentHost, rootsKey])

  useEffect(() => {
    generation.current++
    setPlan(null)
    setError('')
    setLoadError('')
    setData(null)
    setBusy(mutation.current)
  }, [scope])

  useEffect(() => {
    if (!open || !workspace) return
    const abort = new AbortController()
    setData(null)
    setLoadError('')
    void codingRequest<Status>(workspace, { op: 'packs' }, abort.signal)
      .then(v => {
        if (!abort.signal.aborted) setData(v)
      })
      .catch(e => {
        if (!abort.signal.aborted) setLoadError(message(e))
      })
    return () => abort.abort()
  }, [open, scope, refresh])

  const pack = data?.packs.find(p => p.id === packId)
  useEffect(() => {
    setExecutable(pack?.selected ?? '')
    setServer(pack?.server ?? '')
    setPlan(null)
  }, [packId, data])

  const act = async (action: 'plan' | 'apply' | 'select') => {
    if (!workspace || !data || mutation.current) return
    mutation.current = true
    setBusy(true)
    setError('')
    const gen = generation.current
    try {
      if (action === 'plan') {
        const result = await codingRequest<Plan>(workspace, {
          op: 'packPlan',
          packId,
          runtime,
          notebook: packId === 'python' ? notebook : false,
          server,
        })
        if (gen === generation.current) setPlan(result)
      } else if (action === 'apply' && plan) {
        const run = await codingRequest<CodingTaskRun>(workspace, { op: 'packApply', planId: plan.id })
        if (gen === generation.current) {
          setPlan(null)
          showCodingTasks(undefined, workspace, run.id)
        }
      } else if (action === 'select') {
        const s = useKoma.getState()
        const config = s.coding.files[fileKey(workspace.root, '.koma/coding.json')]
        if (
          (s.remoteState.hostId ?? 'local') === workspace.hostId &&
          config &&
          config.content !== config.savedContent
        ) {
          throw new Error('Save or discard your open coding settings before changing the environment.')
        }
        await codingRequest(workspace, {
          op: 'environmentSelect',
          language: packId,
          executable,
          fingerprint: data.fingerprint,
          server: packId === 'php' ? server : undefined,
        })
        invalidateCodingConfig(workspace)
        if (gen === generation.current) setRefresh(n => n + 1)
      }
    } catch (e) {
      if (gen === generation.current) setError(message(e))
    } finally {
      mutation.current = false
      setBusy(false)
    }
  }

  const editConfig = async () => {
    if (!workspace) return
    const target = workspace
    const gen = generation.current
    try {
      await codingRequest(target, { op: 'configEnsure' })
      const state = useKoma.getState()
      if ((state.remoteState.hostId ?? 'local') === target.hostId) {
        state.openCodingFile(target.root, '.koma/coding.json')
      } else if (gen === generation.current) {
        setError('Switch to this host to edit its coding configuration.')
      }
    } catch (e) {
      if (gen === generation.current) setError(message(e))
    }
  }

  if (!open) return null

  return (
    <section aria-label="Language packs" className="flex min-h-0 flex-1 flex-col overflow-auto text-[11px] text-koma-fg">
      {/* Row 1 — workspace scope (Tasks signature) */}
      <div className="flex h-8 flex-none items-center gap-2 border-b border-koma-border px-2">
        <KomaSelect
          className={selectClass}
          aria-label="Language pack workspace"
          value={scope}
          disabled={busy}
          onChange={e => {
            generation.current++
            setWorkspace(workspaces.find(w => workspaceKey(w) === e.target.value) ?? null)
          }}
        >
          {!workspace && <option value="">Choose a workspace</option>}
          {workspaces.map(w => (
            <option key={workspaceKey(w)} value={workspaceKey(w)}>
              {w.hostId} · {w.root}
            </option>
          ))}
        </KomaSelect>
        <button
          type="button"
          className={button}
          title="Refresh installed components"
          aria-label="Refresh language packs"
          disabled={busy}
          onClick={() => setRefresh(n => n + 1)}
        >
          <RefreshCw size={12} />
        </button>
        <button
          type="button"
          className={button}
          title="Open coding configuration"
          aria-label="Open coding configuration"
          disabled={!workspace || currentHost !== workspace.hostId}
          onClick={() => void editConfig()}
        >
          <FileCog size={12} />
        </button>
      </div>

      {/* Row 2 — pack + primary actions */}
      <div className="flex flex-none flex-wrap items-center gap-1 border-b border-koma-border px-2 py-1">
        <Package size={12} className="flex-none text-koma-dim" />
        <KomaSelect
          className={`${selectClass} max-w-48 flex-none`}
          aria-label="Language"
          value={packId}
          disabled={busy || !data}
          onChange={e => setPackId(e.target.value)}
        >
          {(data?.packs ?? [{ id: 'python', label: 'Python' }]).map(p => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </KomaSelect>
        {pack && pack.serverOptions.length > 1 && (
          <KomaSelect
            className={`${selectClass} max-w-40 flex-none`}
            aria-label="Language server"
            value={server}
            disabled={busy}
            onChange={e => {
              setServer(e.target.value)
              setPlan(null)
            }}
          >
            {pack.serverOptions.map(id => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </KomaSelect>
        )}
        <label className="flex items-center gap-1 px-1 text-koma-dim">
          <input
            type="checkbox"
            className="accent-koma-accent"
            checked={runtime}
            disabled={busy}
            onChange={e => {
              setRuntime(e.target.checked)
              setPlan(null)
            }}
          />
          Include runtime
        </label>
        {packId === 'python' && (
          <label className="flex items-center gap-1 px-1 text-koma-dim" title="Installs ipykernel into the selected workspace Python (reviewed plan, not silent)">
            <input
              type="checkbox"
              className="accent-koma-accent"
              checked={notebook}
              disabled={busy}
              onChange={e => {
                setNotebook(e.target.checked)
                setPlan(null)
              }}
            />
            Notebook kernel (ipykernel)
          </label>
        )}
        <button type="button" className={button} disabled={busy || !data} onClick={() => void act('plan')}>
          {busy ? <BrailleSpinner size={12} /> : null}
          Review install
        </button>
      </div>

      {/* Status grid — compact path rows */}
      {pack && (
        <div className="flex-none border-b border-koma-border px-3 py-1.5 font-mono text-[10px] text-koma-dim">
          <div className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-x-2 gap-y-0.5 break-all">
            <span>Runtime</span>
            <span className="text-koma-fg">
              {pack.runtime ?? (pack.runtimeName ? `${pack.runtimeName} · missing` : 'Not required')}
            </span>
            <span>Language server</span>
            <span className="text-koma-fg">{pack.lsp ?? `${pack.server} · missing`}</span>
            <span>Debugger</span>
            <span className="text-koma-fg">
              {pack.adapter ?? (pack.adapterName ? `${pack.adapterName} · missing` : 'Not applicable')}
            </span>
            <span>Tests</span>
            <span className="text-koma-fg">{pack.test || 'Not applicable'}</span>
            {data?.platform && (
              <>
                <span>Platform</span>
                <span className="text-koma-fg">{data.platform}</span>
              </>
            )}
          </div>
        </div>
      )}

      {/* Executable selection */}
      {pack?.runtimeName && !['web', 'toml'].includes(packId) && (
        <div className="flex flex-none items-center gap-1 border-b border-koma-border px-2 py-1">
          <label htmlFor="coding-executable" className="flex-none text-koma-dim">
            Executable
          </label>
          <input
            id="coding-executable"
            list="coding-environments"
            value={executable}
            onChange={e => setExecutable(e.target.value)}
            placeholder="Automatic (project environment / host PATH)"
            disabled={busy}
            className="h-6 min-w-0 flex-1 rounded border border-koma-border bg-koma-panel2 px-2 text-[11px] text-koma-fg"
          />
          <datalist id="coding-environments">
            {pack.candidates.map(v => (
              <option key={v} value={v} />
            ))}
          </datalist>
          <button type="button" className={button} disabled={busy || !data} onClick={() => void act('select')}>
            Use for workspace
          </button>
        </div>
      )}

      <div className="flex-none px-3 py-1 text-[10px] text-koma-dim">
        Environment changes apply to new tasks, debug sessions, and notebook kernel defaults. Workspace language servers
        restart automatically. Install progress opens in Tasks.
      </div>

      {(loadError || error) && (
        <div role="alert" className="max-h-16 flex-none overflow-auto border-b border-koma-border px-3 py-1 text-koma-error">
          {[loadError, error].filter(Boolean).join(' · ')}
        </div>
      )}

      {!workspace && <div className="flex-none px-3 py-2 text-koma-dim">Choose a coding workspace first.</div>}
      {workspace && !data && !loadError && (
        <div className="flex flex-none items-center gap-2 px-3 py-2 text-koma-dim">
          <BrailleSpinner size={12} /> Loading packs…
        </div>
      )}

      {/* Install plan body (scrolls like task output) */}
      <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
        {plan ? (
          <div className="space-y-2">
            <div className="text-koma-fg">
              {plan.label} · install / update on {workspace?.hostId}
            </div>
            <pre className="whitespace-pre-wrap break-all font-mono text-[11px] text-koma-dim">
              {plan.commands.map(c => [c.command, ...c.args].map(v => JSON.stringify(v)).join(' ')).join('\n')}
            </pre>
            {plan.notes && <p className="text-koma-dim">{plan.notes}</p>}
            <button type="button" className={button} disabled={busy} onClick={() => void act('apply')}>
              Install / update
            </button>
          </div>
        ) : (
          <span className="text-koma-dim">
            {data
              ? 'Review install to preview the exact command vector. No silent pip or package installs.'
              : null}
          </span>
        )}
      </div>
    </section>
  )
}
