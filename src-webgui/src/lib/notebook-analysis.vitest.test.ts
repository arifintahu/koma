import { describe, expect, it } from 'vitest'
import { notebookAnalysisLabel, notebookAnalysisStatus } from './notebook-analysis'

describe('notebook analysis gate (M2)', () => {
  it('stays honestly unavailable until a real probe passes', () => {
    const status = notebookAnalysisStatus()
    expect(status.state).toBe('unavailable')
    if (status.state === 'unavailable') {
      expect(status.reason).toMatch(/notebookDocumentSync/)
      expect(status.reason.toLowerCase()).toContain('not fake')
      expect(status.reason).toMatch(/temporary \.py/)
    }
    expect(notebookAnalysisLabel(status)).toBe('Analysis · Unavailable')
  })
})
