import { beforeEach, describe, expect, it } from 'vitest'
import { useKoma } from '../store/koma'
import { acceptToastConfirm, showToast, showToastConfirm } from './toast'

beforeEach(() => {
  useKoma.setState((s) => ({
    ui: { ...s.ui, toast: null, toastSeq: 0 },
    session: { ...s.session, id: 's-toast' },
  }))
})

describe('showToastConfirm', () => {
  it('resolves true on accept and clears the toast', async () => {
    const pending = showToastConfirm({
      text: 'Start kernel?',
      confirmLabel: 'Start kernel',
      session: 's-toast',
    })
    const toast = useKoma.getState().ui.toast
    expect(toast?.text).toBe('Start kernel?')
    expect(toast?.action?.label).toBe('Start kernel')
    expect(toast?.kind).toBe('warn')
    acceptToastConfirm(toast!.id)
    await expect(pending).resolves.toBe(true)
    expect(useKoma.getState().ui.toast).toBeNull()
  })

  it('resolves false on dismiss', async () => {
    const pending = showToastConfirm({
      text: 'Start kernel?',
      confirmLabel: 'Start kernel',
    })
    const id = useKoma.getState().ui.toast!.id
    useKoma.getState().dismissToast(id)
    await expect(pending).resolves.toBe(false)
    expect(useKoma.getState().ui.toast).toBeNull()
  })

  it('cancels a prior confirm when a new toast replaces it', async () => {
    const first = showToastConfirm({ text: 'one', confirmLabel: 'Go' })
    showToast('plain info')
    await expect(first).resolves.toBe(false)
    expect(useKoma.getState().ui.toast?.text).toBe('plain info')
    expect(useKoma.getState().ui.toast?.action).toBeUndefined()
  })
})
