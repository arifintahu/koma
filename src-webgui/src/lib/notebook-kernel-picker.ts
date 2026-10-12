/**
 * VS Code–style notebook kernel / Python environment selection.
 *
 * Mirrors Microsoft Jupyter extension behavior (docs + wiki):
 * - Always-visible "Select Kernel" control on the notebook chrome
 * - List Python environments whether or not ipykernel is installed
 * - Remember selection per notebook document
 * - Only ipykernel is required (not full jupyter)
 * - Missing ipykernel → surface path + re-open picker; never silent pip install
 */

import { codingRequest, type WorkspaceRef } from './coding-service'

const storagePrefix = 'koma.notebook.kernel.v1:'

export type PythonEnvironment = {
  path: string
  label: string
  /** workspace default from Language Packs / toolchains.python */
  workspaceDefault?: boolean
  /** project .venv / venv */
  projectVenv?: boolean
}

export type PacksStatus = {
  packs: Array<{
    id: string
    label: string
    selected: string
    candidates: string[]
    runtime?: string | null
  }>
  fingerprint: string
}

function storageKey(workspace: WorkspaceRef, documentPath: string) {
  return `${storagePrefix}${workspace.hostId}\0${workspace.root}\0${documentPath}`
}

/** Short label like VS Code kernel chip (basename + parent hint). */
export function shortInterpreterLabel(path: string | null | undefined): string {
  if (!path) return 'Select Kernel'
  const normalized = path.replace(/\\/g, '/')
  const parts = normalized.split('/').filter(Boolean)
  if (parts.length === 0) return path
  const base = parts[parts.length - 1]!
  // .venv/bin/python → .venv  (not /usr/bin/python3 → usr)
  if (parts.length >= 3 && /^(python(\d+(\.\d+)*)?|python\.exe)$/i.test(base)) {
    const parent = parts[parts.length - 2]!
    if (parent === 'bin' || parent === 'Scripts') {
      const env = parts[parts.length - 3]!
      const systemish = new Set([
        'usr', 'local', 'bin', 'sbin', 'System', 'Windows', 'Program Files', 'ProgramFiles',
        'homebrew', 'opt', 'Cellar', 'shims', 'versions',
      ])
      if (!systemish.has(env)) return env
      return base
    }
  }
  return base
}

export function readRememberedInterpreter(
  workspace: WorkspaceRef,
  documentPath: string,
): string | null {
  try {
    const v = sessionStorage.getItem(storageKey(workspace, documentPath))
    return v && v.trim() ? v.trim() : null
  } catch {
    return null
  }
}

export function rememberInterpreter(
  workspace: WorkspaceRef,
  documentPath: string,
  interpreter: string,
) {
  try {
    sessionStorage.setItem(storageKey(workspace, documentPath), interpreter)
  } catch {
    /* private mode */
  }
}

export function clearRememberedInterpreter(workspace: WorkspaceRef, documentPath: string) {
  try {
    sessionStorage.removeItem(storageKey(workspace, documentPath))
  } catch {
    /* ignore */
  }
}

/** Load Python environments from Coding packs (same discovery as Language Packs). */
export async function listPythonEnvironments(
  workspace: WorkspaceRef,
  signal?: AbortSignal,
): Promise<PythonEnvironment[]> {
  const status = await codingRequest<PacksStatus>(workspace, { op: 'packs' }, signal)
  const pack = status.packs.find(p => p.id === 'python')
  if (!pack) return []
  const seen = new Set<string>()
  const out: PythonEnvironment[] = []
  const push = (path: string, extra?: Partial<PythonEnvironment>) => {
    const p = path.trim()
    if (!p || seen.has(p)) return
    seen.add(p)
    const projectVenv = /[/\\](\.venv|venv)[/\\]/.test(p)
    out.push({
      path: p,
      label: shortInterpreterLabel(p),
      projectVenv,
      ...extra,
    })
  }
  if (pack.selected) push(pack.selected, { workspaceDefault: true })
  for (const c of pack.candidates ?? []) push(c)
  if (pack.runtime) push(String(pack.runtime))
  // Prefer project venv, then workspace default, then others.
  out.sort((a, b) => {
    const score = (e: PythonEnvironment) =>
      (e.projectVenv ? 0 : 2) + (e.workspaceDefault ? 0 : 1)
    return score(a) - score(b) || a.path.localeCompare(b.path)
  })
  return out
}
