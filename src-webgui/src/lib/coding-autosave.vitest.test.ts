import { describe, expect, it } from 'vitest'
import { canAutosaveCodingFile, CODING_AUTOSAVE_MS } from './coding-autosave'
import { emptyFileState } from '../store/coding'

describe('coding autosave shared guards', () => {
  it('matches the previous CodeEditorTab preconditions', () => {
    expect(CODING_AUTOSAVE_MS).toBe(750)
    const base = emptyFileState({ content: 'edited', savedContent: 'old', dirty: true })
    expect(canAutosaveCodingFile(base, true)).toBe(true)
    expect(canAutosaveCodingFile(base, false)).toBe(false)
    expect(canAutosaveCodingFile({ ...base, saving: true }, true)).toBe(false)
    expect(canAutosaveCodingFile({ ...base, conflict: true }, true)).toBe(false)
    expect(canAutosaveCodingFile({ ...base, manualSaveRequired: true }, true)).toBe(false)
    expect(canAutosaveCodingFile({ ...base, content: 'old', dirty: false }, true)).toBe(false)
    expect(canAutosaveCodingFile({ ...base, binary: true }, true)).toBe(false)
    expect(canAutosaveCodingFile({ ...base, error: 'nope' }, true)).toBe(false)
    expect(canAutosaveCodingFile(null, true)).toBe(false)
  })
})
