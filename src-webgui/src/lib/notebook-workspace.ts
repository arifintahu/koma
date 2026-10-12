import { useKoma } from '../store/koma'
import { fileKey, type CodingFileState } from '../store/coding'
import { codingHostViews } from '../store/runtime'
import { backupCodingDocument, forgetCodingDraft } from './coding-recovery'
import type { WorkspaceRef } from './coding-service'

/** Kernel / UI callbacks keep their originating host, even while another host is active. */
export function readNotebookFile(workspace: WorkspaceRef, path: string): CodingFileState | undefined {
  const state = useKoma.getState()
  const coding = (state.remoteState.hostId ?? 'local') === workspace.hostId
    ? state.coding : codingHostViews.get(workspace.hostId)?.coding
  return coding?.files[fileKey(workspace.root, path)]
}

export type NotebookCommitOptions = {
  /** Reject when the live buffer text no longer matches this snapshot. */
  expectedContent?: string
  /** Reject when the controller epoch no longer matches (stale callback). */
  expectedEpoch?: number
}

/** Per open notebook document epoch — advanced by successful controller commits and external adopts. */
const epochs = new Map<string, number>()

function epochKey(workspace: WorkspaceRef, path: string) {
  return `${workspace.hostId}\0${workspace.root}\0${path}`
}

export function getNotebookEpoch(workspace: WorkspaceRef, path: string): number {
  return epochs.get(epochKey(workspace, path)) ?? 0
}

export function setNotebookEpoch(workspace: WorkspaceRef, path: string, epoch: number) {
  epochs.set(epochKey(workspace, path), epoch)
}

export function clearNotebookEpoch(workspace: WorkspaceRef, path: string) {
  epochs.delete(epochKey(workspace, path))
}

/**
 * The existing Coding file buffer is the only saved/draft notebook authority.
 * Optional CAS guards stop stale kernel/UI callbacks from clobbering newer edits.
 */
export function updateNotebookText(
  workspace: WorkspaceRef,
  path: string,
  text: string,
  opts?: NotebookCommitOptions,
): boolean {
  const state = useKoma.getState()
  const key = fileKey(workspace.root, path)
  const content = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')

  if (opts?.expectedEpoch != null) {
    const liveEpoch = epochs.get(epochKey(workspace, path))
    // First commit may not have seeded the map; treat missing as 0.
    if ((liveEpoch ?? 0) !== opts.expectedEpoch) return false
  }

  if ((state.remoteState.hostId ?? 'local') === workspace.hostId) {
    const before = state.coding.files[key]
    if (!before) return false
    if (opts?.expectedContent != null && before.content !== opts.expectedContent) return false
    state.updateCodingContent(workspace.root, path, content)
    if (opts?.expectedEpoch != null) {
      epochs.set(epochKey(workspace, path), opts.expectedEpoch + 1)
    }
    return true
  }

  const view = codingHostViews.get(workspace.hostId)
  const before = view?.coding.files[key]
  if (!view || !before) return false
  if (opts?.expectedContent != null && before.content !== opts.expectedContent) return false
  const dirty = content !== (before.savedContent ?? '')
  if (before.content === content && before.dirty === dirty) {
    if (opts?.expectedEpoch != null) epochs.set(epochKey(workspace, path), opts.expectedEpoch + 1)
    return true
  }
  const file = { ...before, content, dirty }
  view.coding = { ...view.coding, files: { ...view.coding.files, [key]: file } }
  if (dirty) backupCodingDocument(workspace, path, {
    content, savedContent: file.savedContent, fingerprint: file.fingerprint,
  })
  else if (!file.saving) forgetCodingDraft(workspace, path)
  if (opts?.expectedEpoch != null) epochs.set(epochKey(workspace, path), opts.expectedEpoch + 1)
  return true
}

export function isNotebookPath(path: string): boolean {
  return /\.ipynb$/i.test(path)
}
