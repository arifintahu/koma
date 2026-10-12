import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api'
import { BookOpen, Braces, ChevronDown, ChevronUp, Code2, Play, Plus, Square, Trash2, RotateCcw } from 'lucide-react'
import { Streamdown } from 'streamdown'
import { initMonaco, applyKomaTheme, readMonoFont } from '../lib/monaco-setup'
import { stampModelPath } from '../lib/monaco-lsp'
import { useCodingAutosave } from '../lib/coding-autosave'
import {
  disposeNotebookController,
  obtainNotebookController,
  type NotebookController,
} from '../lib/notebook-controller'
import { isNotebookPath } from '../lib/notebook-workspace'
import { NOTEBOOK_EDITABLE_MAX_CHARS, type NotebookCellType } from '../lib/notebook-document'
import { notebookAnalysisLabel } from '../lib/notebook-analysis'
import {
  consentKernel,
  executeCell,
  interruptKernel,
  iopubToNbformatOutput,
  kernelIsRunnable,
  probeIpykernel,
  restartKernel,
  startKernel,
  stopKernel,
  subscribeNotebookEvents,
  type KernelStatus,
  type NotebookKernelInfo,
  type NotebookNativeEvent,
} from '../lib/notebook-runtime'
import {
  listPythonEnvironments,
  readRememberedInterpreter,
  rememberInterpreter,
  shortInterpreterLabel,
  type PythonEnvironment,
} from '../lib/notebook-kernel-picker'
import { showCodingPacks } from './CodingPacks'
import { NotebookOutputs, NotebookHtmlFrame, sanitizeMarkdownCellHtml } from './NotebookOutputs'
import { showCodingHistory } from './CodingHistory'
import { showToast, showToastConfirm } from '../lib/toast'
import { markdownLooksLikeHtml } from '../lib/notebook-html'
import { useKoma, type Tab } from '../store/koma'
import { fileKey } from '../store/coding'
import { BrailleSpinner } from './BrailleSpinner'
import { EditorChrome } from './EditorChrome'
import { komaCode } from './komaShiki'
import { komaLinkSafety } from './LinkSafetyModal'
import { luminance } from '../lib/luminance'

type CodingTab = Extract<Tab, { kind: 'codingFile' }>

function useControllerState(controller: NotebookController | null) {
  return useSyncExternalStore(
    (cb) => (controller ? controller.subscribe(cb) : () => {}),
    () => controller?.getState() ?? null,
    () => controller?.getState() ?? null,
  )
}

function cellLanguage(cellType: NotebookCellType): string {
  if (cellType === 'markdown') return 'markdown'
  if (cellType === 'raw') return 'plaintext'
  return 'python'
}

function CellEditor({
  runtimeId,
  language,
  value,
  readOnly,
  onChange,
  active,
}: {
  runtimeId: string
  language: string
  value: string
  readOnly: boolean
  onChange: (text: string) => void
  active: boolean
}) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const modelRef = useRef<monaco.editor.ITextModel | null>(null)
  const applyingRef = useRef(false)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    initMonaco()
    const theme = applyKomaTheme()
    const uri = monaco.Uri.parse(`koma-notebook-cell://cell/${encodeURIComponent(runtimeId)}`)
    let model = monaco.editor.getModel(uri)
    if (!model) model = monaco.editor.createModel(value, language, uri)
    else {
      if (model.getValue() !== value) {
        applyingRef.current = true
        model.setValue(value)
        applyingRef.current = false
      }
      monaco.editor.setModelLanguage(model, language)
    }
    // Mark so ordinary LSP providers refuse this model (monaco-lsp modelToRootPath).
    stampModelPath(model, '', '')
    ;(model as unknown as { __komaNotebook?: boolean }).__komaNotebook = true
    modelRef.current = model
    const editor = monaco.editor.create(host, {
      model,
      readOnly,
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontFamily: readMonoFont(),
      fontSize: 12,
      lineNumbers: 'on',
      lineNumbersMinChars: 2,
      glyphMargin: false,
      folding: false,
      lineDecorationsWidth: 8,
      theme,
      wordWrap: 'on',
      // Content drives host height — vertical bar only after the soft-cap.
      scrollbar: {
        vertical: 'auto',
        horizontal: 'hidden',
        verticalScrollbarSize: 8,
        horizontalScrollbarSize: 8,
        handleMouseWheel: true,
        alwaysConsumeMouseWheel: false,
      },
      padding: { top: 8, bottom: 8 },
      // No ordinary file LSP — cell analysis is M2 and stays unavailable.
      quickSuggestions: false,
      parameterHints: { enabled: false },
      hover: { enabled: false },
      links: false,
    })
    editorRef.current = editor

    const fitHeight = () => {
      const lh = editor.getOption(monaco.editor.EditorOption.lineHeight) || 18
      // getContentHeight includes word-wrap view lines + padding — preferred over model lineCount.
      const contentHeight = editor.getContentHeight()
      const height = Math.min(480, Math.max(lh * 2 + 16, contentHeight + 4))
      if (host.style.height !== `${height}px`) {
        host.style.height = `${height}px`
        editor.layout()
      }
    }

    const sub = model.onDidChangeContent(() => {
      fitHeight()
      if (applyingRef.current) return
      onChangeRef.current(model!.getValue())
    })
    // Wrap / font metrics also change content height without a model edit.
    const subLayout = editor.onDidContentSizeChange(() => fitHeight())
    const ro = new ResizeObserver(() => {
      editor.layout()
      fitHeight()
    })
    fitHeight()
    ro.observe(host)
    return () => {
      sub.dispose()
      subLayout.dispose()
      ro.disconnect()
      editor.dispose()
      // Keep model only while tab lives — dispose with cell unmount to avoid leaks on delete.
      model.dispose()
      editorRef.current = null
      modelRef.current = null
    }
    // runtimeId identity is stable per cell for the controller lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtimeId])

  useEffect(() => {
    const model = modelRef.current
    const editor = editorRef.current
    const host = hostRef.current
    if (!model || !editor || !host) return
    if (model.getValue() !== value) {
      applyingRef.current = true
      const pos = editor.getPosition()
      model.setValue(value)
      if (pos) editor.setPosition(pos)
      applyingRef.current = false
    }
    monaco.editor.setModelLanguage(model, language)
    editor.updateOptions({ readOnly })
    // External value sync (undo, run-clear, peer) must re-grow after setValue.
    const lh = editor.getOption(monaco.editor.EditorOption.lineHeight) || 18
    const height = Math.min(480, Math.max(lh * 2 + 16, editor.getContentHeight() + 4))
    host.style.height = `${height}px`
    editor.layout()
  }, [value, language, readOnly])

  useEffect(() => {
    if (active) editorRef.current?.focus()
  }, [active])

  return <div ref={hostRef} className="w-full overflow-hidden bg-transparent" />
}

function RawJsonEditor({
  value,
  readOnly,
  onChange,
}: {
  value: string
  readOnly: boolean
  onChange: (text: string) => void
}) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const modelRef = useRef<monaco.editor.ITextModel | null>(null)
  const applyingRef = useRef(false)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    initMonaco()
    const theme = applyKomaTheme()
    const uri = monaco.Uri.parse(`koma-notebook-raw://document/raw`)
    let model = monaco.editor.getModel(uri)
    if (!model) model = monaco.editor.createModel(value, 'javascript', uri)
    ;(model as unknown as { __komaNotebook?: boolean }).__komaNotebook = true
    stampModelPath(model, '', '')
    modelRef.current = model
    const editor = monaco.editor.create(host, {
      model,
      readOnly,
      automaticLayout: true,
      minimap: { enabled: false },
      fontFamily: readMonoFont(),
      fontSize: 12,
      theme,
      wordWrap: 'on',
      scrollBeyondLastLine: false,
      quickSuggestions: false,
      hover: { enabled: false },
    })
    editorRef.current = editor
    if (model.getValue() !== value) {
      applyingRef.current = true
      model.setValue(value)
      applyingRef.current = false
    }
    const sub = model.onDidChangeContent(() => {
      if (applyingRef.current) return
      onChangeRef.current(model!.getValue())
    })
    return () => {
      sub.dispose()
      editor.dispose()
      model.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const model = modelRef.current
    const editor = editorRef.current
    if (!model || !editor) return
    if (model.getValue() !== value) {
      applyingRef.current = true
      model.setValue(value)
      applyingRef.current = false
    }
    editor.updateOptions({ readOnly })
  }, [value, readOnly])

  return <div ref={hostRef} className="absolute inset-0" />
}

function MarkdownPreview({ source }: { source: string }) {
  const bg = useKoma((s) => s.palette.bg)
  const theme = luminance(bg) >= 0.5 ? 'github-light' : 'github-dark'
  const trimmed = source.trim()
  // Jupyter renders raw HTML in markdown cells (Colab badges, tables). Prefer
  // the sandboxed HTML path when the cell is HTML-dominant; otherwise Streamdown.
  if (markdownLooksLikeHtml(trimmed)) {
    const html = sanitizeMarkdownCellHtml(trimmed)
    return (
      <div className="min-w-0 px-1 py-1">
        {html ? (
          <NotebookHtmlFrame html={html} allowRemoteImages borderless />
        ) : (
          <span className="text-[12px] text-koma-dim">Empty after HTML sanitization</span>
        )}
      </div>
    )
  }
  return (
    <div className="min-w-0 px-1 py-0.5">
      {trimmed ? (
        <Streamdown
          className="koma-md text-[13px]"
          mode="static"
          parseIncompleteMarkdown={false}
          normalizeHtmlIndentation
          plugins={{ code: komaCode }}
          shikiTheme={[theme, theme]}
          lineNumbers={false}
          controls={{ code: { copy: false, download: false }, table: false, mermaid: false }}
          linkSafety={komaLinkSafety}
        >
          {source}
        </Streamdown>
      ) : (
        <span className="text-[12px] text-koma-dim">Empty markdown cell</span>
      )}
    </div>
  )
}

function UnavailablePill({ label, detail }: { label: string; detail: string }) {
  return (
    <span
      title={detail}
      className="inline-flex items-center gap-1 rounded border border-koma-border px-1.5 py-0.5 text-[10px] text-koma-dim"
    >
      {label}
      <span className="opacity-70">Unavailable</span>
    </span>
  )
}

function KernelStatusPill({
  status,
  busy,
  needsKernel,
}: {
  status: KernelStatus | null
  busy: boolean
  needsKernel: boolean
}) {
  if (needsKernel) {
    return (
      <span
        title="Choose a Python environment with ipykernel"
        className="inline-flex items-center gap-1 rounded border border-koma-error/40 px-1.5 py-0.5 text-[10px] text-koma-error"
      >
        Select Kernel
      </span>
    )
  }
  if (!status) {
    return (
      <span className="inline-flex items-center gap-1 rounded border border-koma-border px-1.5 py-0.5 text-[10px] text-koma-dim">
        Kernel off
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 rounded border border-koma-border px-1.5 py-0.5 text-[10px] text-koma-dim">
      {busy && <BrailleSpinner size={10} />}
      {status}
    </span>
  )
}

export default function NotebookTab({ tab }: { tab: CodingTab }) {
  const hostId = useKoma(s => s.remoteState.hostId ?? 'local')
  return <WorkspaceNotebook key={JSON.stringify([hostId, tab.id])} tab={tab} />
}

function WorkspaceNotebook({ tab }: { tab: CodingTab }) {
  const hostId = useKoma(s => s.remoteState.hostId ?? 'local')
  const fileState = useKoma(s => s.coding.files[fileKey(tab.root, tab.path)] ?? null)
  const codingAutosave = useKoma(s => !!s.settingsValues?.codingAutosave)
  const saveCodingFile = useKoma(s => s.saveCodingFile)
  const revertCodingFile = useKoma(s => s.revertCodingFile)

  const workspace = useMemo(() => ({ hostId, root: tab.root }), [hostId, tab.root])
  const [controller, setController] = useState<NotebookController | null>(null)
  const [mdPreview, setMdPreview] = useState<Record<string, boolean>>({})
  const rawDraftRef = useRef<string | null>(null)
  const [rawDraft, setRawDraft] = useState<string | null>(null)

  const [kernel, setKernel] = useState<NotebookKernelInfo | null>(null)
  const [kernelStatus, setKernelStatus] = useState<KernelStatus | null>(null)
  /** Sticky chrome action only — transient failures go through showToast. */
  const [kernelAction, setKernelAction] = useState<null | { kind: 'select-kernel'; path: string }>(null)
  const [runBusy, setRunBusy] = useState(false)
  const [startingKernel, setStartingKernel] = useState(false)
  // VS Code–style: selected Python environment (may lack ipykernel until run).
  const [selectedInterpreter, setSelectedInterpreter] = useState<string | null>(() =>
    readRememberedInterpreter(workspace, tab.path),
  )
  const [pickerOpen, setPickerOpen] = useState(false)
  const [envs, setEnvs] = useState<PythonEnvironment[]>([])
  const [envsLoading, setEnvsLoading] = useState(false)
  const [envsError, setEnvsError] = useState<string | null>(null)
  const [customPath, setCustomPath] = useState('')
  const [probingPath, setProbingPath] = useState<string | null>(null)
  const pickerRef = useRef<HTMLDivElement | null>(null)
  const liveOutputsRef = useRef<unknown[]>([])
  const liveParentRef = useRef<string | null>(null)
  const liveCellRef = useRef<string | null>(null)
  const kernelRef = useRef<NotebookKernelInfo | null>(null)
  kernelRef.current = kernel
  const selectedInterpreterRef = useRef(selectedInterpreter)
  selectedInterpreterRef.current = selectedInterpreter
  const sessionId = useKoma(s => s.session.id)

  /** Actionable kernel recovery → sticky vertical banner only. Transient → toast. */
  function reportKernel(message: string, opts?: { selectKernel?: string }) {
    const text = message.trim() || 'Notebook kernel error'
    if (opts?.selectKernel) {
      setKernelAction({ kind: 'select-kernel', path: opts.selectKernel })
      return
    }
    // Native strings that mean "pick another env" → banner only (no toast pile-on).
    if (/ipykernel/i.test(text) && /not available|missing|did not become ready/i.test(text)) {
      setKernelAction({
        kind: 'select-kernel',
        path: selectedInterpreterRef.current || 'python',
      })
      return
    }
    setKernelAction(null)
    showToast(text, 'error', { session: sessionId, source: 'coding' })
  }

  // Obtain / dispose controller with the tab mount. Coding may retain the buffer.
  useEffect(() => {
    if (fileState?.content == null) return
    if (!isNotebookPath(tab.path)) return
    const c = obtainNotebookController(workspace, tab.path, fileState.content)
    setController(c)
    return () => {
      disposeNotebookController(workspace.hostId, tab.root, tab.path)
      setController(null)
    }
    // Remount when host/path identity changes or content first becomes available.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.hostId, workspace.root, tab.path, fileState?.content != null])

  // External buffer changes (disk, revert, history restore) while mounted.
  // Local controller commits already match fileState.content — adopt no-ops then.
  // A real external replace advances epoch; drop the kernel bind so the next run
  // re-consents against the new document identity.
  useEffect(() => {
    if (!controller || fileState?.content == null) return
    const before = controller.documentEpoch
    controller.adoptExternalText(fileState.content)
    if (controller.documentEpoch !== before) {
      const k = kernelRef.current
      if (k?.kernelId) {
        void stopKernel(workspace, k.kernelId).catch(() => {})
      }
      setKernel(null)
      setKernelStatus(null)
    }
  }, [controller, fileState?.content, workspace])

  // Release kernel when the tab unmounts.
  useEffect(() => {
    return () => {
      const k = kernelRef.current
      if (k?.kernelId) {
        void stopKernel(workspace, k.kernelId).catch(() => {})
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.hostId, workspace.root, tab.path])

  // Subscribe to native notebook events for this document.
  useEffect(() => {
    return subscribeNotebookEvents(workspace, tab.path, (event: NotebookNativeEvent) => {
      if (event.k === 'NotebookKernelState') {
        const st = event as { status?: KernelStatus; error?: string; generation?: number }
        if (st.status) setKernelStatus(st.status)
        if (st.error) reportKernel(String(st.error))
        if (st.generation != null && kernelRef.current) {
          setKernel(k => (k ? { ...k, generation: st.generation!, status: st.status ?? k.status } : k))
        }
        return
      }
      if (event.k === 'NotebookIo') {
        const io = event as { parentMsgId?: string; msgType: string; payload: Record<string, unknown> }
        if (liveParentRef.current && io.parentMsgId && io.parentMsgId !== liveParentRef.current) return
        if (io.msgType === 'clear_output') {
          liveOutputsRef.current = []
        } else {
          const mapped = iopubToNbformatOutput(io.msgType, io.payload ?? {})
          if (mapped) liveOutputsRef.current = [...liveOutputsRef.current, mapped]
        }
        const cellId = liveCellRef.current
        if (cellId && controller) {
          controller.setCellOutputs(cellId, liveOutputsRef.current, null, false)
        }
        return
      }
      if (event.k === 'NotebookExecuteReply') {
        const reply = event as { executionCount?: number | null; cellId?: string; status?: string }
        const cellId = reply.cellId ?? liveCellRef.current
        if (cellId && controller) {
          controller.setCellOutputs(cellId, liveOutputsRef.current, reply.executionCount ?? null, false)
        }
        setRunBusy(false)
      }
    })
    // reportKernel closes over sessionId; events only need workspace/path/controller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace, tab.path, controller, sessionId])

  useCodingAutosave(tab.root, tab.path, fileState, codingAutosave)

  const state = useControllerState(controller)

  const canEdit = !!(
    fileState &&
    fileState.content != null &&
    !fileState.binary &&
    !fileState.tooLarge &&
    !fileState.loading
  )
  const canSave = !!(canEdit && fileState?.dirty && !fileState.saving && !fileState.conflict)
  const canRevert = !!(fileState && (fileState.dirty || fileState.conflict) && !fileState.saving)
  const runnable = kernelIsRunnable(kernelStatus) && !!kernel && !startingKernel
  const needsKernelPick = kernelAction?.kind === 'select-kernel'

  // Close kernel picker on outside click / Escape.
  useEffect(() => {
    if (!pickerOpen) return
    const onDoc = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPickerOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [pickerOpen])

  // Load Python environments when the picker opens (VS Code "Python Environments").
  useEffect(() => {
    if (!pickerOpen) return
    const abort = new AbortController()
    setEnvsLoading(true)
    setEnvsError(null)
    void listPythonEnvironments(workspace, abort.signal)
      .then((list) => {
        if (!abort.signal.aborted) setEnvs(list)
      })
      .catch((e) => {
        if (!abort.signal.aborted) {
          const msg = e instanceof Error ? e.message : String(e)
          setEnvsError(msg)
          showToast(msg, 'error', { session: sessionId, source: 'coding' })
        }
      })
      .finally(() => {
        if (!abort.signal.aborted) setEnvsLoading(false)
      })
    return () => abort.abort()
  }, [pickerOpen, workspace, sessionId])

  async function openKernelPicker() {
    setPickerOpen(true)
  }

  async function chooseInterpreter(path: string) {
    const trimmed = path.trim()
    if (!trimmed) return
    setProbingPath(trimmed)
    try {
      // Selecting an env is allowed even without ipykernel (VS Code lists them).
      const probe = await probeIpykernel(workspace, trimmed)
      const resolved = probe.interpreter || trimmed
      setSelectedInterpreter(resolved)
      rememberInterpreter(workspace, tab.path, resolved)
      setCustomPath('')
      if (kernelRef.current) {
        void stopKernel(workspace, kernelRef.current.kernelId).catch(() => {})
        setKernel(null)
        setKernelStatus(null)
      }
      if (!probe.ipykernel) {
        reportKernel(`ipykernel missing in ${resolved}`, { selectKernel: resolved })
        return
      }
      setKernelAction(null)
      setPickerOpen(false)
      showToast(`Kernel environment · ${shortInterpreterLabel(resolved)}`, 'info', {
        session: sessionId,
        source: 'coding',
      })
    } catch (e) {
      reportKernel(e instanceof Error ? e.message : String(e))
    } finally {
      setProbingPath(null)
    }
  }

  async function ensureKernel(): Promise<NotebookKernelInfo | null> {
    if (!controller) return null
    if (kernel && kernelIsRunnable(kernelStatus)) return kernel
    setStartingKernel(true)
    try {
      const preferred = selectedInterpreterRef.current ?? undefined
      const probe = await probeIpykernel(workspace, preferred)
      const interpreter = probe.interpreter || preferred || 'python3'
      setSelectedInterpreter(interpreter)
      rememberInterpreter(workspace, tab.path, interpreter)
      if (!probe.ipykernel) {
        reportKernel(`ipykernel missing in ${interpreter}`, { selectKernel: interpreter })
        return null
      }
      // Snapshot epoch at consent/start — later cell edits / output commits must not
      // invalidate the bind (execute uses this bound epoch, not the live controller epoch).
      const bindEpoch = controller.documentEpoch
      // First start: toast-confirm (never window.confirm — silent no-op inside wry).
      const ok = await showToastConfirm({
        text: `Start Python kernel?\n${shortInterpreterLabel(interpreter)} · ${tab.path}`,
        confirmLabel: 'Start kernel',
        kind: 'warn',
        session: sessionId,
        source: 'coding',
      })
      if (!ok) return null
      await consentKernel(workspace, tab.path, interpreter, bindEpoch)
      const info = await startKernel(workspace, tab.path, bindEpoch, interpreter)
      const bound: NotebookKernelInfo = {
        ...info,
        documentEpoch: info.documentEpoch ?? bindEpoch,
      }
      setKernel(bound)
      setKernelStatus(bound.status)
      setKernelAction(null)
      if (bound.interpreter) {
        setSelectedInterpreter(bound.interpreter)
        rememberInterpreter(workspace, tab.path, bound.interpreter)
      }
      return bound
    } catch (e) {
      reportKernel(e instanceof Error ? e.message : String(e))
      return null
    } finally {
      setStartingKernel(false)
    }
  }

  async function runCell(runtimeId: string) {
    if (!controller || !state?.parse.ok) return
    const index = state.identities.findIndex(i => i.runtimeId === runtimeId)
    if (index < 0) return
    const cell = state.parse.doc.cells[index]
    if (!cell || cell.cellType !== 'code') return
    const info = await ensureKernel()
    if (!info) return
    // Kernel is bound to documentEpoch from start/reuse — not the live controller
    // epoch. clearCellOutputs / streaming commits advance the controller epoch and
    // must not be sent as the execute CAS token (that produced "Document epoch mismatch").
    const boundEpoch = info.documentEpoch
    if (boundEpoch == null) {
      reportKernel('Kernel is missing a document epoch binding — restart the kernel')
      return
    }
    setRunBusy(true)
    liveOutputsRef.current = []
    liveCellRef.current = runtimeId
    liveParentRef.current = null
    controller.clearCellOutputs(runtimeId)
    try {
      const reply = await executeCell({
        workspace,
        kernelId: info.kernelId,
        path: tab.path,
        cellId: runtimeId,
        code: cell.source,
        generation: info.generation,
        documentEpoch: boundEpoch,
      })
      if (reply.parentMsgId) liveParentRef.current = reply.parentMsgId
      controller.setCellOutputs(
        runtimeId,
        liveOutputsRef.current,
        reply.executionCount ?? null,
        false,
      )
      setKernelStatus('idle')
    } catch (e) {
      reportKernel(e instanceof Error ? e.message : String(e))
    } finally {
      setRunBusy(false)
      liveCellRef.current = null
    }
  }

  async function runAll() {
    if (!controller || !state?.parse.ok) return
    for (const id of state.identities) {
      const index = state.identities.findIndex(i => i.runtimeId === id.runtimeId)
      const cell = state.parse.doc.cells[index!]
      if (cell?.cellType === 'code') {
        await runCell(id.runtimeId)
        if (kernelAction) break
      }
    }
  }

  async function onInterrupt() {
    if (!kernel) return
    try {
      await interruptKernel(workspace, kernel.kernelId)
    } catch (e) {
      reportKernel(e instanceof Error ? e.message : String(e))
    }
  }

  async function onRestart() {
    if (!kernel) return
    setStartingKernel(true)
    try {
      const prevEpoch = kernel.documentEpoch
      const info = await restartKernel(workspace, kernel.kernelId)
      const bound: NotebookKernelInfo = {
        ...info,
        documentEpoch: info.documentEpoch ?? prevEpoch,
      }
      setKernel(bound)
      setKernelStatus(bound.status)
      setKernelAction(null)
    } catch (e) {
      reportKernel(e instanceof Error ? e.message : String(e))
    } finally {
      setStartingKernel(false)
    }
  }

  const status = useMemo(() => {
    if (!fileState) return 'Loading…'
    if (fileState.loading && fileState.content == null) return 'Loading…'
    if (fileState.saving) return 'Saving…'
    if (fileState.conflict) return 'Conflict — reload required'
    if (fileState.error) return fileState.error
    if (fileState.binary) return 'Binary'
    if (fileState.tooLarge) return 'Too large'
    if (state?.oversize) return 'Too large for cell UI · raw only'
    if (state?.mode === 'raw') return fileState.dirty ? 'Raw JSON · modified' : 'Raw JSON'
    if (fileState.dirty) return fileState.manualSaveRequired ? 'Modified · save to apply' : codingAutosave ? 'Modified · autosave on' : 'Modified'
    return 'Saved'
  }, [fileState, codingAutosave, state?.mode, state?.oversize])

  if (!isNotebookPath(tab.path)) {
    return <div className="flex h-full items-center justify-center text-[12px] text-koma-dim">Not a notebook path</div>
  }

  if (fileState?.binary) {
    return (
      <div className="flex h-full w-full flex-col">
        <EditorChrome path={tab.path} status={status} canSave={false} canRevert={false} saving={false} />
        <div className="flex flex-1 items-center justify-center text-[12px] text-koma-dim">Binary notebook</div>
      </div>
    )
  }
  if (fileState?.tooLarge) {
    return (
      <div className="flex h-full w-full flex-col">
        <EditorChrome path={tab.path} status={status} canSave={false} canRevert={false} saving={false} />
        <div className="flex flex-1 items-center justify-center text-[12px] text-koma-dim">File too large to edit</div>
      </div>
    )
  }
  if (fileState?.error && fileState.content === null) {
    return (
      <div className="flex h-full w-full flex-col">
        <EditorChrome path={tab.path} status={status} canSave={false} canRevert={false} saving={false} />
        <div className="flex flex-1 items-center justify-center px-6 text-center text-[12px] text-koma-dim">{fileState.error}</div>
      </div>
    )
  }
  if (!fileState || fileState.content == null || !controller || !state) {
    return (
      <div className="flex h-full w-full flex-col">
        <EditorChrome path={tab.path} status="Loading…" canSave={false} canRevert={false} saving={false} />
        <div className="flex flex-1 items-center justify-center text-koma-dim"><BrailleSpinner size={14} /></div>
      </div>
    )
  }

  // Keyboard undo/redo for structural history when focus is not inside Monaco's own stack exclusively —
  // cell Monaco handles text undo locally; chrome buttons drive controller history.

  const readOnly = !!fileState.conflict || !!fileState.saving
  const notebookDoc = state.parse.ok ? state.parse.doc : null
  const showCells = state.mode === 'cells' && notebookDoc != null && !state.oversize

  return (
    <div data-tour="notebook-editor" className="flex h-full w-full flex-col">
      <EditorChrome
        path={tab.path}
        status={status}
        canSave={canSave}
        canRevert={canRevert}
        saving={!!fileState.saving}
        onSave={() => saveCodingFile(tab.root, tab.path)}
        onRevert={() => revertCodingFile(tab.root, tab.path)}
        onHistory={() => showCodingHistory(tab.root, tab.path)}
        canUndo={state.canUndo}
        canRedo={state.canRedo}
        onUndo={() => controller.undo()}
        onRedo={() => controller.redo()}
        icon={<BookOpen size={13} className="flex-none text-koma-dim" />}
        trailing={
          <div className="relative flex flex-none items-center gap-1" ref={pickerRef}>
            {/* VS Code: Select Kernel (top-right). Opens Python Environments list. */}
            <button
              type="button"
              title={selectedInterpreter ? selectedInterpreter : 'Select Kernel — choose a Python environment'}
              aria-haspopup="listbox"
              aria-expanded={pickerOpen}
              disabled={readOnly || startingKernel}
              onClick={() => (pickerOpen ? setPickerOpen(false) : void openKernelPicker())}
              className={`flex h-6 max-w-[12rem] items-center gap-1 rounded border px-1.5 text-[11px] hover:bg-koma-hover disabled:opacity-30 ${
                needsKernelPick
                  ? 'border-koma-error/50 text-koma-error'
                  : 'border-koma-border text-koma-dim hover:text-koma-fg'
              }`}
            >
              <span className="min-w-0 truncate">
                {selectedInterpreter || kernel?.interpreter
                  ? shortInterpreterLabel(selectedInterpreter ?? kernel?.interpreter)
                  : 'Select Kernel'}
              </span>
              <ChevronDown size={12} className="flex-none opacity-70" />
            </button>
            {pickerOpen && (
              <div
                role="listbox"
                aria-label="Python environments"
                className="absolute right-0 top-full z-50 mt-1 w-[min(22rem,calc(100vw-2rem))] rounded-md border border-koma-border bg-koma-panel p-1.5 text-[11px] text-koma-fg shadow-xl"
              >
                <div className="px-1.5 pb-1 text-[10px] uppercase tracking-wide text-koma-dim">
                  Python Environments
                </div>
                {envsLoading && (
                  <div className="flex items-center gap-1.5 px-1.5 py-2 text-koma-dim">
                    <BrailleSpinner size={10} /> Discovering…
                  </div>
                )}
                {envsError && <div className="px-1.5 py-1 text-koma-error">{envsError}</div>}
                {!envsLoading && envs.length === 0 && !envsError && (
                  <div className="px-1.5 py-2 text-koma-dim">
                    No environments found. Enter a path below, or open Language Packs.
                  </div>
                )}
                <ul className="max-h-56 overflow-auto">
                  {envs.map((env) => {
                    const active = selectedInterpreter === env.path
                    return (
                      <li key={env.path}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={active}
                          disabled={!!probingPath}
                          title={env.path}
                          onClick={() => void chooseInterpreter(env.path)}
                          className={`flex w-full flex-col items-start gap-0.5 rounded px-1.5 py-1.5 text-left hover:bg-koma-hover disabled:opacity-50 ${
                            active ? 'bg-koma-hover/80' : ''
                          }`}
                        >
                          <span className="flex w-full items-center gap-1">
                            <span className="min-w-0 flex-1 truncate font-medium">{env.label}</span>
                            {probingPath === env.path && <BrailleSpinner size={10} />}
                            {env.projectVenv && (
                              <span className="flex-none text-[9px] text-koma-dim">venv</span>
                            )}
                            {env.workspaceDefault && (
                              <span className="flex-none text-[9px] text-koma-dim">workspace</span>
                            )}
                          </span>
                          <span className="w-full truncate text-[10px] text-koma-dim">{env.path}</span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
                <div className="mt-1 border-t border-koma-border pt-1.5">
                  <label className="flex flex-col gap-1 px-1">
                    <span className="text-[10px] text-koma-dim">Enter interpreter path</span>
                    <div className="flex gap-1">
                      <input
                        value={customPath}
                        onChange={(e) => setCustomPath(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            void chooseInterpreter(customPath)
                          }
                        }}
                        placeholder="/path/to/python"
                        className="min-w-0 flex-1 rounded border border-koma-border bg-koma-bg px-1.5 py-1 text-[11px] text-koma-fg"
                      />
                      <button
                        type="button"
                        disabled={!customPath.trim() || !!probingPath}
                        onClick={() => void chooseInterpreter(customPath)}
                        className="rounded border border-koma-border px-1.5 py-1 text-koma-dim hover:bg-koma-hover hover:text-koma-fg disabled:opacity-30"
                      >
                        Use
                      </button>
                    </div>
                  </label>
                  <button
                    type="button"
                    className="mt-1 w-full rounded px-1.5 py-1 text-left text-[10px] text-koma-dim hover:bg-koma-hover hover:text-koma-fg"
                    onClick={() => {
                      setPickerOpen(false)
                      showCodingPacks(workspace, { notebook: true })
                    }}
                  >
                    Language Packs… (install LSP / ipykernel)
                  </button>
                </div>
              </div>
            )}
            <KernelStatusPill
              status={kernelStatus}
              busy={runBusy || startingKernel}
              needsKernel={needsKernelPick}
            />
            <button
              type="button"
              title={runnable ? 'Run all code cells' : 'Start kernel and run all'}
              disabled={readOnly || startingKernel}
              onClick={() => void runAll()}
              className="flex h-6 items-center gap-1 rounded px-1.5 text-[11px] text-koma-dim hover:bg-koma-hover hover:text-koma-fg disabled:opacity-30"
            >
              <Play size={13} />
              Run all
            </button>
            <button
              type="button"
              title="Interrupt kernel"
              disabled={!kernel || readOnly}
              onClick={() => void onInterrupt()}
              className="flex h-6 items-center gap-1 rounded px-1.5 text-[11px] text-koma-dim hover:bg-koma-hover hover:text-koma-fg disabled:opacity-30"
            >
              <Square size={12} />
            </button>
            <button
              type="button"
              title="Restart kernel"
              disabled={!kernel || readOnly || startingKernel}
              onClick={() => void onRestart()}
              className="flex h-6 items-center gap-1 rounded px-1.5 text-[11px] text-koma-dim hover:bg-koma-hover hover:text-koma-fg disabled:opacity-30"
            >
              <RotateCcw size={12} />
            </button>
            <UnavailablePill label="Analysis" detail={notebookAnalysisLabel()} />
            <button
              type="button"
              title={showCells ? 'Edit raw notebook JSON' : 'Return to cells'}
              aria-label={showCells ? 'Raw JSON' : 'Cells'}
              disabled={readOnly && !showCells}
              onClick={() => {
                if (showCells) {
                  rawDraftRef.current = fileState.content
                  setRawDraft(fileState.content)
                  controller.enterRawMode()
                } else {
                  const draft = rawDraftRef.current ?? fileState.content ?? ''
                  if (controller.exitRawMode(draft, fileState.content)) {
                    setRawDraft(null)
                    rawDraftRef.current = null
                  }
                }
              }}
              className="flex h-6 items-center gap-1 rounded px-1.5 text-[11px] text-koma-dim hover:bg-koma-hover hover:text-koma-fg disabled:opacity-30"
            >
              {showCells ? <Braces size={13} /> : <Code2 size={13} />}
              {showCells ? 'Raw' : 'Cells'}
            </button>
          </div>
        }
      />
      {fileState.conflict && (
        <div className="flex flex-none items-center gap-2 border-b border-koma-border bg-koma-accent/10 px-3 py-1.5 text-[12px] text-koma-fg">
          <span className="min-w-0 flex-1">File changed on disk. Your edits are kept.</span>
          <button onClick={() => showCodingHistory(tab.root, tab.path, true)} className="flex-none rounded border border-koma-border px-2 py-0.5 text-[11px] hover:bg-koma-hover">Compare and resolve</button>
        </div>
      )}
      {state.lastError && (
        <div className="flex flex-none items-center gap-2 border-b border-koma-border bg-koma-error/10 px-3 py-1.5 text-[12px] text-koma-error">
          <span className="min-w-0 flex-1">{state.lastError}</span>
        </div>
      )}
      {kernelAction?.kind === 'select-kernel' && (
        <div className="flex flex-none flex-col gap-2 border-b border-koma-border bg-koma-warn/10 px-3 py-2 text-[12px] text-koma-fg">
          <div className="min-w-0 break-all">
            ipykernel missing in <span className="font-mono text-[11px]">{kernelAction.path}</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="rounded border border-koma-border px-2 py-0.5 text-[11px] hover:bg-koma-hover"
              onClick={() => void openKernelPicker()}
            >
              Select Kernel
            </button>
            <button
              type="button"
              className="rounded border border-koma-border px-2 py-0.5 text-[11px] hover:bg-koma-hover"
              title="Open Language Packs — install ipykernel into the workspace Python"
              onClick={() => showCodingPacks(workspace, { notebook: true })}
            >
              Install ipykernel…
            </button>
            <button
              type="button"
              className="text-[11px] text-koma-dim underline"
              onClick={() => setKernelAction(null)}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
      {!state.parse.ok && state.mode === 'raw' && (
        <div className="flex flex-none flex-col gap-1 border-b border-koma-border bg-koma-warn/10 px-3 py-2 text-[12px] text-koma-warn">
          <span className="min-w-0">
            Invalid notebook JSON — edit as raw text. Returning to cells requires a successful reparse.
            Original bytes are not rewritten on open.
          </span>
        </div>
      )}
      {state.oversize && (
        <div className="flex flex-none flex-col gap-1 border-b border-koma-border bg-koma-warn/10 px-3 py-2 text-[12px] text-koma-warn">
          <span className="min-w-0">
            Notebook exceeds the {Math.round(NOTEBOOK_EDITABLE_MAX_CHARS / (1024 * 1024))} MiB cell-editor
            budget. Raw JSON only — outputs are not stripped.
          </span>
        </div>
      )}

      {showCells && notebookDoc ? (
        <div className="min-h-0 flex-1 overflow-auto px-2 py-2 sm:px-4">
          <div className="mx-auto flex max-w-4xl flex-col">
            {notebookDoc.cells.map((cell, index) => {
              const identity = state.identities[index]
              if (!identity) return null
              const selected = state.selectedRuntimeId === identity.runtimeId
              // Jupyter default: markdown shows rendered; code shows editor.
              // mdPreview[id] === false means explicitly editing; undefined/true = preview.
              const mdEditing = cell.cellType === 'markdown' && mdPreview[identity.runtimeId] === false
              const showMdPreview = cell.cellType === 'markdown' && !mdEditing
              const execLabel =
                cell.cellType === 'code'
                  ? cell.executionCount != null
                    ? `In [${cell.executionCount}]:`
                    : 'In [ ]:'
                  : ''
              return (
                <div
                  key={identity.runtimeId}
                  className={`group relative flex gap-2 border-l-2 py-1 pl-1 pr-1 transition-colors ${
                    selected
                      ? 'border-koma-accent bg-koma-accent/[0.04]'
                      : 'border-transparent hover:bg-koma-hover/30'
                  }`}
                  onMouseDown={() => controller.selectCell(identity.runtimeId)}
                  onDoubleClick={() => {
                    if (cell.cellType === 'markdown' && showMdPreview) {
                      setMdPreview((m) => ({ ...m, [identity.runtimeId]: false }))
                    }
                  }}
                >
                  {/* Gutter — Jupyter-style prompt */}
                  <div className="flex w-14 flex-none flex-col items-end pt-1.5 font-mono text-[11px] leading-none text-koma-dim select-none">
                    {cell.cellType === 'code' ? (
                      <span title={`Cell ${index + 1}`}>{execLabel}</span>
                    ) : (
                      <span className="opacity-0 group-hover:opacity-50">[{index + 1}]</span>
                    )}
                  </div>

                  <div className="min-w-0 flex-1">
                    {/* Toolbar — hover / selected only (borderless chrome) */}
                    <div
                      className={`mb-0.5 flex flex-wrap items-center gap-0.5 text-[11px] transition-opacity ${
                        selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100'
                      }`}
                    >
                      <select
                        disabled={readOnly}
                        value={cell.cellType}
                        onChange={(e) =>
                          controller.setCellType(identity.runtimeId, e.target.value as NotebookCellType)
                        }
                        className="rounded border-0 bg-transparent px-0.5 py-0.5 text-koma-dim hover:bg-koma-hover hover:text-koma-fg"
                        aria-label="Cell type"
                      >
                        <option value="code">Code</option>
                        <option value="markdown">Markdown</option>
                        <option value="raw">Raw</option>
                      </select>
                      {cell.cellType === 'markdown' && (
                        <button
                          type="button"
                          className="rounded px-1 text-koma-dim hover:bg-koma-hover hover:text-koma-fg"
                          onClick={() =>
                            setMdPreview((m) => ({
                              ...m,
                              [identity.runtimeId]: mdEditing ? true : false,
                            }))
                          }
                        >
                          {mdEditing ? 'Preview' : 'Edit'}
                        </button>
                      )}
                      <span className="ml-auto flex items-center gap-0.5">
                        <button
                          type="button"
                          disabled={readOnly || index === 0}
                          title="Move up"
                          className="rounded p-0.5 text-koma-dim hover:bg-koma-hover disabled:opacity-30"
                          onClick={() => controller.moveCell(identity.runtimeId, index - 1)}
                        >
                          <ChevronUp size={13} />
                        </button>
                        <button
                          type="button"
                          disabled={readOnly || index >= notebookDoc.cells.length - 1}
                          title="Move down"
                          className="rounded p-0.5 text-koma-dim hover:bg-koma-hover disabled:opacity-30"
                          onClick={() => controller.moveCell(identity.runtimeId, index + 1)}
                        >
                          <ChevronDown size={13} />
                        </button>
                        <button
                          type="button"
                          disabled={readOnly}
                          title="Add cell below"
                          className="rounded p-0.5 text-koma-dim hover:bg-koma-hover disabled:opacity-30"
                          onClick={() => controller.addCell(identity.runtimeId, 'code')}
                        >
                          <Plus size={13} />
                        </button>
                        <button
                          type="button"
                          disabled={readOnly || notebookDoc.cells.length <= 1}
                          title="Delete cell"
                          className="rounded p-0.5 text-koma-dim hover:bg-koma-hover disabled:opacity-30"
                          onClick={() => controller.deleteCell(identity.runtimeId)}
                        >
                          <Trash2 size={13} />
                        </button>
                        <button
                          type="button"
                          disabled={readOnly || cell.cellType !== 'code' || startingKernel || runBusy}
                          title={
                            cell.cellType === 'code'
                              ? runnable
                                ? 'Run cell'
                                : 'Start kernel and run cell'
                              : 'Only code cells run'
                          }
                          className="rounded p-0.5 text-koma-dim hover:bg-koma-hover hover:text-koma-fg disabled:opacity-30"
                          onClick={() => void runCell(identity.runtimeId)}
                        >
                          <Play size={13} />
                        </button>
                      </span>
                    </div>

                    {/* Body */}
                    <div
                      className={
                        cell.cellType === 'code'
                          ? 'rounded-sm bg-koma-bg/60 ring-1 ring-koma-border/30'
                          : showMdPreview
                            ? ''
                            : 'rounded-sm ring-1 ring-koma-border/25'
                      }
                    >
                      {showMdPreview ? (
                        <MarkdownPreview source={cell.source} />
                      ) : (
                        <CellEditor
                          runtimeId={identity.runtimeId}
                          language={cellLanguage(cell.cellType)}
                          value={cell.source}
                          readOnly={readOnly}
                          active={selected}
                          onChange={(text) => controller.setCellSource(identity.runtimeId, text)}
                        />
                      )}
                    </div>
                    {cell.cellType === 'code' && (
                      <div className="flex gap-2 pt-0.5">
                        <div className="w-0 flex-none" />
                        <div className="min-w-0 flex-1">
                          <NotebookOutputs outputs={controller.getCellOutputs(identity.runtimeId)} />
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
            <button
              type="button"
              disabled={readOnly}
              onClick={() => controller.addCell(state.selectedRuntimeId, 'code')}
              className="mt-2 flex items-center justify-center gap-1 rounded border border-dashed border-koma-border/50 py-1.5 text-[12px] text-koma-dim hover:border-koma-border hover:bg-koma-hover/40 hover:text-koma-fg disabled:opacity-40"
            >
              <Plus size={14} /> Add cell
            </button>
          </div>
        </div>
      ) : (
        <div className="relative min-h-0 flex-1">
          <RawJsonEditor
            value={rawDraft ?? fileState.content}
            readOnly={readOnly}
            onChange={(text) => {
              rawDraftRef.current = text
              setRawDraft(text)
              controller.applyRawText(text)
            }}
          />
        </div>
      )}
      {fileState.loading && (
        <div className="pointer-events-none absolute right-2 top-10 text-koma-dim">
          <BrailleSpinner size={14} className="opacity-70" />
        </div>
      )}
    </div>
  )
}
