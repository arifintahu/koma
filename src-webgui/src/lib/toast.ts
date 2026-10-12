import { useKoma, type ToastEntry } from '../store/koma'
import { registerToastConfirm, settleToastConfirm } from './toast-confirm'

function replaceToast(entry: Omit<ToastEntry, 'id'>): number {
  let minted = 0
  useKoma.setState((state) => {
    const prev = state.ui.toast
    if (prev?.action) settleToastConfirm(prev.id, false)
    minted = state.ui.toastSeq + 1
    return {
      ui: {
        ...state.ui,
        toastSeq: minted,
        toast: { ...entry, id: minted },
      },
    }
  })
  return minted
}

export function showToast(
  text: string,
  kind: ToastEntry['kind'] = 'info',
  scope?: { session: string | null; source?: string },
) {
  replaceToast({ text, kind, ...scope })
}

/**
 * Toast-confirm: show a toast with a primary action button.
 * Resolves `true` on action click, `false` on dismiss / replace.
 * Never uses `window.confirm` (silent no-op inside wry).
 */
export function showToastConfirm(opts: {
  text: string
  confirmLabel: string
  kind?: ToastEntry['kind']
  session?: string | null
  source?: string
}): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const id = replaceToast({
      text: opts.text,
      kind: opts.kind ?? 'warn',
      session: opts.session,
      source: opts.source ?? 'confirm',
      action: { label: opts.confirmLabel },
    })
    registerToastConfirm(id, resolve)
  })
}

/** Accept the primary action on a toast-confirm; dismisses and resolves true. */
export function acceptToastConfirm(id: number) {
  if (!settleToastConfirm(id, true)) return
  useKoma.setState((state) =>
    state.ui.toast?.id === id ? { ui: { ...state.ui, toast: null } } : state,
  )
}
