/**
 * M2 notebook analysis capability gate.
 *
 * LSP 3.17 defines notebookDocument/didOpen|didChange|didClose. Koma will only
 * enable cell-aware analysis when a real server advertises notebookDocumentSync
 * and a live probe succeeds. Concatenating cells into a temp .py is forbidden.
 */

export type NotebookAnalysisStatus =
  | { state: 'unavailable'; reason: string }
  | { state: 'probe-pending'; reason: string }
  | { state: 'available'; server: string }

/**
 * Until a pinned BasedPyright/Pyright build is probed in-process against a
 * fixture notebook, analysis stays honestly unavailable.
 *
 * Evidence so far (plan): languageServerBase registers text-document handlers
 * only; type-server notebook chaining is not a drop-in completion LSP.
 */
export function notebookAnalysisStatus(): NotebookAnalysisStatus {
  return {
    state: 'unavailable',
    reason:
      'Cell-aware analysis requires notebookDocumentSync on the language server. '
      + 'No successful probe against the pinned BasedPyright/Pyright build yet — '
      + 'Koma will not fake analysis by concatenating cells into a temporary .py file.',
  }
}

export function notebookAnalysisLabel(status = notebookAnalysisStatus()): string {
  if (status.state === 'available') return `Analysis · ${status.server}`
  if (status.state === 'probe-pending') return 'Analysis · probing'
  return 'Analysis · Unavailable'
}
