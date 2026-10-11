import { useKoma } from '../store/koma'
import { fileKey, type CodingFileState } from '../store/coding'
import { codingHostViews } from '../store/runtime'
import { backupCodingDocument, forgetCodingDraft } from './coding-recovery'
import type { WorkspaceRef } from './coding-service'

/** Kernel callbacks keep their originating host, even while another host is active. */
export function readNotebookFile(workspace: WorkspaceRef, path: string): CodingFileState | undefined {
  const state = useKoma.getState()
  const coding = (state.remoteState.hostId ?? 'local') === workspace.hostId
    ? state.coding : codingHostViews.get(workspace.hostId)?.coding
  return coding?.files[fileKey(workspace.root, path)]
}

/** The existing Coding file buffer is the only saved/draft notebook authority. */
export function updateNotebookText(workspace: WorkspaceRef, path: string, text: string): boolean {
  const state = useKoma.getState()
  const key = fileKey(workspace.root, path)
  if ((state.remoteState.hostId ?? 'local') === workspace.hostId) {
    if (!state.coding.files[key]) return false
    state.updateCodingContent(workspace.root, path, text)
    return true
  }
  const view = codingHostViews.get(workspace.hostId)
  const before = view?.coding.files[key]
  if (!view || !before) return false
  const content = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const dirty = content !== (before.savedContent ?? '')
  if (before.content === content && before.dirty === dirty) return true
  const file = { ...before, content, dirty }
  view.coding = { ...view.coding, files: { ...view.coding.files, [key]: file } }
  if (dirty) backupCodingDocument(workspace, path, {
    content, savedContent: file.savedContent, fingerprint: file.fingerprint,
  })
  else if (!file.saving) forgetCodingDraft(workspace, path)
  return true
}

export function isNotebookPath(path: string): boolean {
  return /\.ipynb$/i.test(path)
}
