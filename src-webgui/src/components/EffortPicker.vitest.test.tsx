import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useKoma } from '../store/koma'
import { EffortPicker } from './EffortPicker'

const postMessage = vi.fn()

beforeEach(() => {
  vi.useFakeTimers()
  postMessage.mockReset()
  window.ipc = { postMessage }
  useKoma.setState({ effortOptions: null })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  delete window.ipc
})

function advance(ms: number) {
  act(() => vi.advanceTimersByTime(ms))
}

function pushMenu(state: 'loading' | 'ready' | 'unsupported', note = '') {
  act(() => useKoma.getState().push({
    k: 'EffortOptions', state, note,
    options: state === 'ready' ? ['default', 'high'] : [], selected: 0,
  }))
}

function toggle() {
  fireEvent.click(screen.getByTitle('Reasoning effort'))
}

function expectRequests(count: number) {
  expect(postMessage).toHaveBeenCalledTimes(count)
  for (const [message] of postMessage.mock.calls) {
    expect(JSON.parse(message)).toMatchObject({ r: 'GetEffortOptions' })
  }
}

describe('EffortPicker loading repolls', () => {
  it('backs off by 800/1500/2500ms and stops after three repolls even without replies', () => {
    render(<EffortPicker />)
    toggle()
    expectRequests(1)
    for (const [index, delay] of [800, 1500, 2500].entries()) {
      advance(delay - 1)
      expectRequests(index + 1)
      advance(1)
      expectRequests(index + 2)
    }
    advance(30_000)
    expectRequests(4)
  })

  it('does not restart timers or replenish the budget on repeated loading replies', () => {
    render(<EffortPicker />)
    toggle()
    for (const [index, delay] of [800, 1500, 2500].entries()) {
      advance(delay - 1)
      pushMenu('loading', `still fetching ${index}`)
      advance(1)
      expectRequests(index + 2)
    }
    pushMenu('loading', 'still fetching after the budget is exhausted')
    advance(30_000)
    expectRequests(4)
  })

  it.each(['ready', 'unsupported'] as const)('cancels pending repolls on %s and still accepts later pushes', (state) => {
    render(<EffortPicker />)
    toggle()
    advance(800)
    advance(100)
    pushMenu(state, 'resolved')
    advance(30_000)
    expectRequests(2)
    pushMenu('ready')
    expect(screen.getByRole('button', { name: 'high' })).toBeTruthy()
  })

  it.each(['toggle', 'escape', 'outside'] as const)('cancels on %s close and resets the budget on reopening', (close) => {
    render(<EffortPicker />)
    toggle()
    advance(800)
    if (close === 'toggle') toggle()
    else if (close === 'escape') fireEvent.keyDown(window, { key: 'Escape' })
    else fireEvent.mouseDown(document.body)
    advance(30_000)
    expectRequests(2)

    toggle()
    expectRequests(3)
    advance(799)
    expectRequests(3)
    advance(1)
    expectRequests(4)
    advance(1500 + 2500 + 30_000)
    expectRequests(6)
  })

  it('does not replenish the budget on ready-to-loading transitions while open', () => {
    render(<EffortPicker />)
    toggle()
    advance(800)
    pushMenu('ready')
    pushMenu('loading')
    advance(1499)
    expectRequests(2)
    advance(1)
    expectRequests(3)
    advance(2500)
    expectRequests(4)
    pushMenu('unsupported')
    pushMenu('loading')
    advance(30_000)
    expectRequests(4)
  })

  it('cleans up a pending repoll on unmount', () => {
    const { unmount } = render(<EffortPicker />)
    toggle()
    advance(800)
    unmount()
    advance(30_000)
    expectRequests(2)
  })
})
