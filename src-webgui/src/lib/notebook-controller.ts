import {
  type NotebookCellType,
  type NotebookDocument,
  type NotebookParseResult,
  NOTEBOOK_EDITABLE_MAX_CHARS,
  deleteCell,
  insertCell,
  moveCell,
  parseNotebook,
  setCellOutputs,
  setCellSource,
  setCellType,
  sliceCellOutputsJson,
} from './notebook-document'
import { bindCellIdentities, mintPersistedCellId, type CellIdentity } from './notebook-identity'
import { NotebookHistory } from './notebook-history'
import {
  clearNotebookEpoch,
  setNotebookEpoch,
  updateNotebookText,
  type NotebookCommitOptions,
} from './notebook-workspace'
import type { WorkspaceRef } from './coding-service'

export type NotebookControllerListener = () => void

export type NotebookControllerState = {
  mode: 'cells' | 'raw'
  parse: NotebookParseResult
  identities: CellIdentity[]
  selectedRuntimeId: string | null
  /** True when serialized text exceeds the editable cell-UI budget. */
  oversize: boolean
  canUndo: boolean
  canRedo: boolean
  lastError: string | null
}

/**
 * Owns parse + history for one open notebook tab. Commits go through
 * `updateNotebookText` (Coding buffer authority) with content/epoch CAS.
 */
export class NotebookController {
  private text: string
  private parse: NotebookParseResult
  private identities: CellIdentity[] = []
  private mode: 'cells' | 'raw' = 'cells'
  private selectedRuntimeId: string | null = null
  private lastError: string | null = null
  private history = new NotebookHistory()
  private listeners = new Set<NotebookControllerListener>()
  private disposed = false
  private epoch = 0
  /** Source revision bumped on every successful commit. */
  private revision = 0
  /**
   * Cached snapshot for useSyncExternalStore. Must be referentially stable
   * between emits — a fresh object every getState() call causes React #185
   * (maximum update depth exceeded).
   */
  private snapshot: NotebookControllerState

  constructor(
    private readonly workspace: WorkspaceRef,
    private readonly path: string,
    initialText: string,
  ) {
    this.text = initialText.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    this.parse = parseNotebook(this.text)
    this.syncIdentities()
    this.epoch = 0
    setNotebookEpoch(this.workspace, this.path, this.epoch)
    if (this.parse.ok && this.parse.doc.cells[0]) {
      this.selectedRuntimeId = this.identities[0]?.runtimeId ?? null
    }
    if (!this.parse.ok || this.text.length > NOTEBOOK_EDITABLE_MAX_CHARS) {
      this.mode = 'raw'
    }
    this.snapshot = this.buildSnapshot()
  }

  get documentEpoch() { return this.epoch }
  get documentRevision() { return this.revision }
  get workspaceRef() { return this.workspace }
  get filePath() { return this.path }

  subscribe(listener: NotebookControllerListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private buildSnapshot(): NotebookControllerState {
    return {
      mode: this.mode,
      parse: this.parse,
      identities: this.identities,
      selectedRuntimeId: this.selectedRuntimeId,
      oversize: this.text.length > NOTEBOOK_EDITABLE_MAX_CHARS,
      canUndo: this.history.canUndo,
      canRedo: this.history.canRedo,
      lastError: this.lastError,
    }
  }

  private emit() {
    this.snapshot = this.buildSnapshot()
    for (const listener of this.listeners) listener()
  }

  /** Stable between emits — required by useSyncExternalStore. */
  getState(): NotebookControllerState {
    return this.snapshot
  }

  private syncIdentities() {
    if (!this.parse.ok) {
      this.identities = []
      return
    }
    this.identities = bindCellIdentities(
      this.parse.doc.cells.map(c => ({ persistedId: c.persistedId })),
      this.identities,
    )
  }

  /** Rebind when Coding buffer content changes externally (disk/history/revert). */
  adoptExternalText(text: string) {
    if (this.disposed) return
    const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    if (normalized === this.text) return
    this.text = normalized
    this.parse = parseNotebook(this.text)
    this.history.clear()
    this.syncIdentities()
    this.epoch += 1
    setNotebookEpoch(this.workspace, this.path, this.epoch)
    this.revision += 1
    this.lastError = null
    if (!this.parse.ok || this.text.length > NOTEBOOK_EDITABLE_MAX_CHARS) this.mode = 'raw'
    if (this.parse.ok) {
      const still = this.identities.find(i => i.runtimeId === this.selectedRuntimeId)
      if (!still) this.selectedRuntimeId = this.identities[0]?.runtimeId ?? null
    } else {
      this.selectedRuntimeId = null
    }
    this.emit()
  }

  selectCell(runtimeId: string | null) {
    this.selectedRuntimeId = runtimeId
    this.emit()
  }

  private commit(nextText: string, label: string, recordHistory: boolean): boolean {
    if (this.disposed) return false
    const normalized = nextText.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    if (normalized === this.text) return true
    const opts: NotebookCommitOptions = {
      expectedContent: this.text,
      expectedEpoch: this.epoch,
    }
    if (recordHistory) this.history.pushBefore(this.text, label)
    const ok = updateNotebookText(this.workspace, this.path, normalized, opts)
    if (!ok) {
      this.lastError = 'Document changed; edit was not applied'
      if (recordHistory) this.history.dropLast()
      this.emit()
      return false
    }
    this.text = normalized
    this.parse = parseNotebook(this.text)
    this.syncIdentities()
    this.epoch += 1
    setNotebookEpoch(this.workspace, this.path, this.epoch)
    this.revision += 1
    this.lastError = null
    if (this.parse.ok) {
      const still = this.identities.find(i => i.runtimeId === this.selectedRuntimeId)
      if (!still) this.selectedRuntimeId = this.identities[0]?.runtimeId ?? null
    }
    this.emit()
    return true
  }

  private withDoc(label: string, fn: (doc: NotebookDocument) => NotebookDocument): boolean {
    if (!this.parse.ok) {
      this.lastError = this.parse.error
      this.emit()
      return false
    }
    if (this.text.length > NOTEBOOK_EDITABLE_MAX_CHARS) {
      this.lastError = 'Notebook is too large for the cell editor; use Raw JSON'
      this.mode = 'raw'
      this.emit()
      return false
    }
    try {
      const next = fn(this.parse.doc)
      return this.commit(next.text, label, true)
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e)
      this.emit()
      return false
    }
  }

  setCellSource(runtimeId: string, source: string): boolean {
    const index = this.identities.findIndex(i => i.runtimeId === runtimeId)
    if (index < 0) return false
    return this.withDoc('Edit cell source', doc => setCellSource(doc, index, source))
  }

  setCellType(runtimeId: string, cellType: NotebookCellType): boolean {
    const index = this.identities.findIndex(i => i.runtimeId === runtimeId)
    if (index < 0) return false
    return this.withDoc(`Change cell type to ${cellType}`, doc => setCellType(doc, index, cellType))
  }

  addCell(afterRuntimeId: string | null, cellType: NotebookCellType = 'code'): boolean {
    let index = this.identities.length
    if (afterRuntimeId) {
      const at = this.identities.findIndex(i => i.runtimeId === afterRuntimeId)
      if (at >= 0) index = at + 1
    }
    const id = mintPersistedCellId(index)
    const ok = this.withDoc('Add cell', doc => insertCell(doc, index, cellType, '', id))
    if (ok && this.parse.ok) {
      // Select the newly inserted cell (same index after insert).
      this.selectedRuntimeId = this.identities[index]?.runtimeId ?? this.selectedRuntimeId
      this.emit()
    }
    return ok
  }

  deleteCell(runtimeId: string): boolean {
    const index = this.identities.findIndex(i => i.runtimeId === runtimeId)
    if (index < 0) return false
    return this.withDoc('Delete cell', doc => deleteCell(doc, index))
  }

  moveCell(runtimeId: string, toIndex: number): boolean {
    const from = this.identities.findIndex(i => i.runtimeId === runtimeId)
    if (from < 0) return false
    return this.withDoc('Move cell', doc => moveCell(doc, from, toIndex))
  }

  /**
   * Rewrite outputs + execution_count for a code cell. Uses history when
   * `recordHistory` is true; live streaming typically passes false and commits
   * a single history entry at run start via clearCellOutputs.
   */
  setCellOutputs(
    runtimeId: string,
    outputs: unknown[],
    executionCount: number | null,
    recordHistory = false,
  ): boolean {
    const index = this.identities.findIndex(i => i.runtimeId === runtimeId)
    if (index < 0) return false
    if (!this.parse.ok) return false
    try {
      const outputsJson = JSON.stringify(outputs)
      const apply = (doc: NotebookDocument) => setCellOutputs(doc, index, outputsJson, executionCount)
      if (recordHistory) return this.withDoc('Update cell outputs', apply)
      // Direct commit without history noise for streaming updates.
      if (this.disposed) return false
      const next = apply(this.parse.doc)
      return this.commit(next.text, 'Update cell outputs', false)
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e)
      this.emit()
      return false
    }
  }

  clearCellOutputs(runtimeId: string): boolean {
    return this.setCellOutputs(runtimeId, [], null, true)
  }

  /** Raw outputs array for rendering (parsed). */
  getCellOutputs(runtimeId: string): unknown[] {
    const index = this.identities.findIndex(i => i.runtimeId === runtimeId)
    if (index < 0 || !this.parse.ok) return []
    try {
      const raw = sliceCellOutputsJson(this.parse.doc, index)
      const v = JSON.parse(raw) as unknown
      return Array.isArray(v) ? v : []
    } catch {
      return []
    }
  }

  undo(): boolean {
    const entry = this.history.undo(this.text)
    if (!entry) return false
    return this.commit(entry.text, entry.label, false)
  }

  redo(): boolean {
    const entry = this.history.redo(this.text)
    if (!entry) return false
    return this.commit(entry.text, entry.label, false)
  }

  /** Switch to raw JSON editor (always allowed). */
  enterRawMode() {
    this.mode = 'raw'
    this.emit()
  }

  /**
   * Leave raw mode only after successful reparse + optional conflict check against
   * the current Coding buffer snapshot the caller supplies.
   */
  exitRawMode(rawText: string, codingContent: string | null | undefined): boolean {
    const normalized = rawText.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    const parsed = parseNotebook(normalized)
    if (!parsed.ok) {
      this.lastError = parsed.error
      this.emit()
      return false
    }
    if (normalized.length > NOTEBOOK_EDITABLE_MAX_CHARS) {
      this.lastError = 'Notebook exceeds the editable size limit'
      this.emit()
      return false
    }
    if (codingContent != null && codingContent !== this.text) {
      this.lastError = 'Document changed while editing raw JSON; resolve conflict first'
      this.emit()
      return false
    }
    if (normalized !== this.text) {
      if (!this.commit(normalized, 'Raw JSON edit', true)) return false
    }
    this.mode = 'cells'
    this.lastError = null
    this.emit()
    return true
  }

  /** Apply raw text without leaving raw mode (live draft into authority). */
  applyRawText(rawText: string): boolean {
    const normalized = rawText.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    if (normalized === this.text) return true
    return this.commit(normalized, 'Raw JSON edit', true)
  }

  dispose() {
    this.disposed = true
    this.listeners.clear()
    this.history.clear()
    clearNotebookEpoch(this.workspace, this.path)
  }
}

/** One controller per host+root+path while a NotebookTab is mounted. */
const controllers = new Map<string, NotebookController>()

export function controllerKey(hostId: string, root: string, path: string) {
  return `${hostId}\0${root}\0${path}`
}

export function getNotebookController(hostId: string, root: string, path: string): NotebookController | undefined {
  return controllers.get(controllerKey(hostId, root, path))
}

export function obtainNotebookController(
  workspace: WorkspaceRef,
  path: string,
  initialText: string,
): NotebookController {
  const key = controllerKey(workspace.hostId, workspace.root, path)
  const existing = controllers.get(key)
  if (existing) {
    existing.adoptExternalText(initialText)
    return existing
  }
  const created = new NotebookController(workspace, path, initialText)
  controllers.set(key, created)
  return created
}

export function disposeNotebookController(hostId: string, root: string, path: string) {
  const key = controllerKey(hostId, root, path)
  const c = controllers.get(key)
  if (!c) return
  c.dispose()
  controllers.delete(key)
}

export function disposeAllNotebookControllersForHost(hostId: string) {
  for (const [key, c] of [...controllers]) {
    if (key.startsWith(hostId + '\0')) {
      c.dispose()
      controllers.delete(key)
    }
  }
}
