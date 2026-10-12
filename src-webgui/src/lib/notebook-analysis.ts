/**
 * M2 notebook analysis capability gate.
 *
 * LSP 3.17 defines notebookDocument/didOpen|didChange|didClose. Koma will only
 * enable cell-aware analysis when a real server advertises notebookDocumentSync
 * and the client wires notebook document sync end-to-end. Concatenating cells
 * into a temp .py is forbidden.
 */

export type NotebookAnalysisStatus =
  | { state: 'unavailable'; reason: string }
  | { state: 'probe-pending'; reason: string }
  | { state: 'available'; server: string }

/**
 * Probe evidence (C1, KOMA_LSP_NOTEBOOK_PROBE=1 against pinned basedpyright):
 * the server **does** advertise `notebookDocumentSync`. Client C3 wiring
 * (didOpen/didChange/didClose + Monaco cell providers) is not shipped yet, so
 * the UI stays Unavailable rather than half-enabling analysis.
 */
export function notebookAnalysisStatus(): NotebookAnalysisStatus {
  return {
    state: 'unavailable',
    reason:
      'BasedPyright advertises notebookDocumentSync (probe green), but Koma has not '
      + 'wired notebookDocument/didOpen|didChange|didClose or cell-model LSP providers yet. '
      + 'Analysis stays Unavailable until that client path ships — Koma will not fake '
      + 'analysis by concatenating cells into a temporary .py file.',
  }
}

export function notebookAnalysisLabel(status = notebookAnalysisStatus()): string {
  if (status.state === 'available') return `Analysis · ${status.server}`
  if (status.state === 'probe-pending') return 'Analysis · probing'
  return 'Analysis · Unavailable'
}
