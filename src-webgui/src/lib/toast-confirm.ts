/**
 * Toast-confirm resolvers live outside the zustand store (callbacks are not state)
 * and outside `toast.ts` so `session` actions can settle them without importing
 * `useKoma` (which would cycle: koma → session → toast → koma).
 */

const confirmResolvers = new Map<number, (ok: boolean) => void>()

export function registerToastConfirm(id: number, resolve: (ok: boolean) => void) {
  confirmResolvers.set(id, resolve)
}

/** Resolve and drop a pending confirm. No-op if none. Returns whether one was settled. */
export function settleToastConfirm(id: number, ok: boolean): boolean {
  const resolve = confirmResolvers.get(id)
  if (!resolve) return false
  confirmResolvers.delete(id)
  resolve(ok)
  return true
}
