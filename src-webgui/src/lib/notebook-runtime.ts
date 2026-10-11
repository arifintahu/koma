/**
 * Notebook kernel runtime client (M3).
 *
 * Consent → start → execute / interrupt / restart / release.
 * Never auto-starts on open. Connection secrets stay native-side.
 */

import { codingRequest, type WorkspaceRef } from './coding-service'

export type KernelStatus = 'starting' | 'idle' | 'busy' | 'dead' | 'stopping' | 'running' | 'exited' | string

export type NotebookKernelInfo = {
  kernelId: string
  generation: number
  documentPath: string
  documentEpoch?: number
  interpreter?: string
  status: KernelStatus
  reused?: boolean
}

export type NotebookIoEvent = {
  k: 'NotebookIo'
  parentMsgId?: string
  msgType: string
  payload: Record<string, unknown>
  generation?: number
  documentPath?: string
}

export type NotebookExecuteReplyEvent = {
  k: 'NotebookExecuteReply'
  status: string
  executionCount?: number | null
  parentMsgId?: string
  generation?: number
  documentPath?: string
  documentEpoch?: number
  cellId?: string
}

export type NotebookKernelStateEvent = {
  k: 'NotebookKernelState'
  status: KernelStatus
  generation?: number
  documentPath?: string
  error?: string
}

export type NotebookNativeEvent =
  | NotebookIoEvent
  | NotebookExecuteReplyEvent
  | NotebookKernelStateEvent
  | { k: string; [key: string]: unknown }

export type NotebookEventDetail = {
  workspace: WorkspaceRef
  event: NotebookNativeEvent
}

function sameWorkspace(a: WorkspaceRef, b: WorkspaceRef) {
  return a.hostId === b.hostId && a.root === b.root
}

export function subscribeNotebookEvents(
  workspace: WorkspaceRef,
  documentPath: string,
  onEvent: (event: NotebookNativeEvent) => void,
): () => void {
  const handler = (ev: Event) => {
    const detail = (ev as CustomEvent<NotebookEventDetail>).detail
    if (!detail?.workspace || !detail.event) return
    if (!sameWorkspace(detail.workspace, workspace)) return
    const path = (detail.event as { documentPath?: string }).documentPath
    if (path != null && path !== documentPath) return
    onEvent(detail.event)
  }
  window.addEventListener('koma-notebook', handler as EventListener)
  return () => window.removeEventListener('koma-notebook', handler as EventListener)
}

export async function probeIpykernel(
  workspace: WorkspaceRef,
  interpreter?: string,
): Promise<{ ipykernel: boolean; interpreter?: string; exitCode?: number | null }> {
  return codingRequest(workspace, {
    op: 'notebookIpykernelProbe',
    ...(interpreter ? { interpreter } : {}),
  })
}

export async function consentKernel(
  workspace: WorkspaceRef,
  path: string,
  interpreter: string,
  documentEpoch: number,
): Promise<void> {
  await codingRequest(workspace, {
    op: 'notebookConsent',
    path,
    interpreter,
    documentEpoch,
  })
}

export async function startKernel(
  workspace: WorkspaceRef,
  path: string,
  documentEpoch: number,
  interpreter?: string,
): Promise<NotebookKernelInfo> {
  return codingRequest(workspace, {
    op: 'notebookKernelStart',
    path,
    documentEpoch,
    ...(interpreter ? { interpreter } : {}),
    kernelspecArgv: [],
  })
}

export async function stopKernel(workspace: WorkspaceRef, kernelId: string): Promise<void> {
  await codingRequest(workspace, { op: 'notebookKernelRelease', kernelId })
}

export async function interruptKernel(workspace: WorkspaceRef, kernelId: string): Promise<void> {
  await codingRequest(workspace, { op: 'notebookKernelInterrupt', kernelId })
}

export async function restartKernel(workspace: WorkspaceRef, kernelId: string): Promise<NotebookKernelInfo> {
  return codingRequest(workspace, { op: 'notebookKernelRestart', kernelId })
}

export async function executeCell(args: {
  workspace: WorkspaceRef
  kernelId: string
  path: string
  cellId?: string
  code: string
  generation: number
  documentEpoch: number
}): Promise<{ status: string; executionCount?: number | null; parentMsgId?: string; generation?: number }> {
  // Execute can run for a long time; codingRequest default timeout is 30s.
  // Use AbortSignal.timeout with a higher ceiling via a longer path:
  // the native side blocks up to 120s; extend the frontend wait by using
  // codingRequest without a short abort — callers should handle UI busy state.
  return codingRequest(args.workspace, {
    op: 'notebookExecute',
    kernelId: args.kernelId,
    path: args.path,
    ...(args.cellId ? { cellId: args.cellId } : {}),
    code: args.code,
    generation: args.generation,
    documentEpoch: args.documentEpoch,
  })
}

/** Map IOPub payload into a nbformat output object. */
export function iopubToNbformatOutput(msgType: string, payload: Record<string, unknown>): unknown | null {
  if (msgType === 'stream') {
    return {
      output_type: 'stream',
      name: typeof payload.name === 'string' ? payload.name : 'stdout',
      text: payload.text ?? '',
    }
  }
  if (msgType === 'error') {
    return {
      output_type: 'error',
      ename: payload.ename ?? 'Error',
      evalue: payload.evalue ?? '',
      traceback: Array.isArray(payload.traceback) ? payload.traceback : [],
    }
  }
  if (msgType === 'execute_result') {
    return {
      output_type: 'execute_result',
      data: payload.data ?? {},
      metadata: payload.metadata ?? {},
      execution_count: payload.execution_count ?? null,
    }
  }
  if (msgType === 'display_data') {
    return {
      output_type: 'display_data',
      data: payload.data ?? {},
      metadata: payload.metadata ?? {},
    }
  }
  return null
}

export function kernelIsRunnable(status: KernelStatus | null | undefined): boolean {
  return status === 'idle' || status === 'busy' || status === 'running'
}
