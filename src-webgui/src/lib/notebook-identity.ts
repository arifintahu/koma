/**
 * Runtime cell identity is separate from persisted nbformat `id`.
 * Opening a notebook must not dirty the buffer just to mint or repair ids.
 */

export type CellIdentity = {
  /** Stable for the lifetime of this open controller (not written to disk). */
  runtimeId: string
  /** nbformat id when the JSON already had one; never invented on open. */
  persistedId: string | null
}

let seq = 0

export function mintRuntimeCellId(): string {
  seq += 1
  return `nb-runtime-${Date.now().toString(36)}-${seq}`
}

/** Map document cells → runtime identities without mutating the document. */
export function bindCellIdentities(
  cells: Array<{ persistedId: string | null }>,
  previous?: CellIdentity[],
): CellIdentity[] {
  const prevByPersisted = new Map<string, CellIdentity>()
  const prevByIndex = previous ?? []
  for (const id of prevByIndex) {
    if (id.persistedId) prevByPersisted.set(id.persistedId, id)
  }
  const used = new Set<string>()
  return cells.map((cell, index) => {
    if (cell.persistedId) {
      const hit = prevByPersisted.get(cell.persistedId)
      if (hit && !used.has(hit.runtimeId)) {
        used.add(hit.runtimeId)
        return { runtimeId: hit.runtimeId, persistedId: cell.persistedId }
      }
    }
    const byIndex = prevByIndex[index]
    if (byIndex && !byIndex.persistedId && !cell.persistedId && !used.has(byIndex.runtimeId)) {
      used.add(byIndex.runtimeId)
      return { runtimeId: byIndex.runtimeId, persistedId: null }
    }
    const runtimeId = mintRuntimeCellId()
    used.add(runtimeId)
    return { runtimeId, persistedId: cell.persistedId }
  })
}

/** Optional id written only when the user (or create path) explicitly adds cells. */
export function mintPersistedCellId(indexHint = 0): string {
  return `cell-${indexHint}-${Math.random().toString(36).slice(2, 10)}`
}
