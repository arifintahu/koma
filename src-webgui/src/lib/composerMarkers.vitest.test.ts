import { expect, it } from 'vitest'
import { listedComposerAttachments, unboundPendingChips } from './composerMarkers'

it('shows one loading chip, then one named chip after the marker binds', () => {
  const pending = listedComposerAttachments('', [], [], [{ id: 'img', kind: 'image', name: 'shot.png' }])
  expect(pending).toEqual([
    { key: 'img', kind: 'image', markerN: null, name: 'shot.png', id: 'img', loading: true },
  ])
  const queue = [{ id: 'img', kind: 'image' as const, markerN: null, cancelled: false }]
  expect(unboundPendingChips([{ id: 'img', kind: 'image', name: 'shot.png' }], queue, [{ kind: 'image', markerN: 1 }], new Set())).toEqual([])
  const bound = listedComposerAttachments(
    '',
    [{ kind: 'pasted_text', markerN: 4, name: 'Pasted Text #4' }],
    [{ id: 'p0', markerN: 4, n: 4, label: 'notes.md' }],
  )
  expect(bound).toHaveLength(1)
  expect(bound[0]?.name).toBe('notes.md')
  expect(bound[0]?.loading).toBeUndefined()
})
