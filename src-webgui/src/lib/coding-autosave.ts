import { useEffect, useRef } from 'react'
import { useKoma } from '../store/koma'
import { fileKey, type CodingFileState } from '../store/coding'

/** Matches CodeEditorTab / NotebookTab debounce before document save. */
export const CODING_AUTOSAVE_MS = 750

/** Shared dirty-document autosave guards (document authority, not per-cell). */
export function canAutosaveCodingFile(file: CodingFileState | null | undefined, enabled: boolean): boolean {
  if (!enabled || !file) return false
  if (file.manualSaveRequired) return false
  if (!file.dirty || file.content == null) return false
  if (file.saving || file.conflict || file.binary || file.tooLarge || file.error) return false
  if (file.content === (file.savedContent ?? '')) return false
  return true
}

/**
 * Debounced autosave for a codingFile buffer. Notebook and ordinary editors share
 * this so cell edits still save the full document authority once.
 */
export function useCodingAutosave(root: string, path: string, fileState: CodingFileState | null | undefined, enabled: boolean) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    if (!canAutosaveCodingFile(fileState, enabled)) return
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      const cur = useKoma.getState().coding.files[fileKey(root, path)]
      if (!canAutosaveCodingFile(cur, !!useKoma.getState().settingsValues?.codingAutosave)) return
      useKoma.getState().saveCodingFile(root, path)
    }, CODING_AUTOSAVE_MS)
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [
    enabled,
    fileState?.manualSaveRequired,
    fileState?.dirty,
    fileState?.content,
    fileState?.savedContent,
    fileState?.saving,
    fileState?.conflict,
    fileState?.binary,
    fileState?.tooLarge,
    fileState?.error,
    root,
    path,
  ])
}
