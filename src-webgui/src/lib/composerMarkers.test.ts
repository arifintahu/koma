import assert from 'node:assert/strict'
import {
  assignFreshMarkerInserts,
  attachmentMarkersRemoved,
  attachmentQueueStillPending,
  imageMarker,
  listedComposerAttachments,
  markerKeysInText,
  trailingAttachmentMarkers,
  unboundPendingChips,
} from './composerMarkers.ts'
import { pasteMarker } from './pasteText.ts'

{
  const draft = 'hello '
  assert.deepEqual([...attachmentMarkersRemoved(draft, `${draft}world`)], [])
  assert.deepEqual([...attachmentMarkersRemoved(`${draft}${imageMarker(2)}`, draft)], ['image:2'])
  assert.deepEqual([...markerKeysInText(`a ${imageMarker(1)} b`)], ['image:1'])
}

{
  const queue = [{ kind: 'image' as const, markerN: null, cancelled: false }]
  assert.equal(attachmentQueueStillPending(queue, 'image', 1), true)
  queue[0]!.markerN = 1
  assert.equal(attachmentQueueStillPending(queue, 'image', 1), true)
  queue[0]!.cancelled = true
  assert.equal(attachmentQueueStillPending(queue, 'image', 1), false)
}

{
  const seen = new Set<string>()
  const empty: { id: string; kind: 'image' | 'pasted_text'; markerN: number | null; cancelled: boolean }[] = []
  assert.deepEqual(assignFreshMarkerInserts(empty, seen, [{ markerN: 1, kind: 'image' }]), [])
  assert.equal(seen.has('image:1'), false)
  const waiting = [{ id: 'q1', kind: 'image' as const, markerN: null, cancelled: false }]
  const got = assignFreshMarkerInserts(waiting, seen, [{ markerN: 1, kind: 'image' }])
  assert.equal(got.length, 1)
  assert.equal(seen.has('image:1'), true)
}

{
  const attachments = [
    { kind: 'image' as const, markerN: 1, name: 'shot.png' },
    { kind: 'pasted_text' as const, markerN: 2, name: 'Pasted Text #2' },
    { kind: 'file' as const, markerN: 3, name: 'notes.md' },
  ]
  const emptyDraft = listedComposerAttachments('', attachments, [])
  assert.equal(emptyDraft.length, 3)
  assert.deepEqual(emptyDraft.map((item) => item.key), ['image:1', 'pasted_text:2', 'file:3'])

  const placed = listedComposerAttachments(`hello ${imageMarker(1)}`, attachments, [])
  assert.deepEqual(placed.map((item) => item.key), ['image:1', 'pasted_text:2', 'file:3'])

  const pendingOnly = listedComposerAttachments('', [], [{ id: 'p0', n: 0 }])
  assert.equal(pendingOnly.some((item) => item.key === 'p0' && item.markerN == null), true)

  const pendingWithSnapshot = listedComposerAttachments('', attachments, [{ id: 'p0', n: 0 }])
  assert.equal(pendingWithSnapshot.filter((item) => item.kind === 'pasted_text').length, 1)
  assert.equal(pendingWithSnapshot.some((item) => item.key === 'p0'), false)

  const linkedLocal = listedComposerAttachments('', attachments, [{ id: 'p2', markerN: 2, n: 2 }])
  assert.equal(linkedLocal.filter((item) => item.kind === 'pasted_text').length, 1)

  const labeled = listedComposerAttachments('', attachments, [{ id: 'p2', markerN: 2, n: 2, label: 'cascade.rs:62:67' }])
  assert.equal(labeled.find((item) => item.kind === 'pasted_text')?.name, 'cascade.rs:62:67')
  const pendingLabel = listedComposerAttachments('', attachments, [{ id: 'p0', n: 0, label: 'cascade.rs:22' }])
  assert.equal(pendingLabel.find((item) => item.kind === 'pasted_text')?.name, 'cascade.rs:22')

  const unplaced = listedComposerAttachments('hello', attachments, [])
  assert.equal(unplaced.some((item) => item.key === 'image:1'), true)

  const pendingImage = listedComposerAttachments('', [], [], [{ id: 'img', kind: 'image', name: 'shot.png' }])
  assert.equal(pendingImage.length, 1)
  assert.equal(pendingImage[0]?.loading, true)
  assert.equal(pendingImage[0]?.name, 'shot.png')

  const named = listedComposerAttachments('', [], [{ id: 'p0', n: 0, label: 'notes.md', loading: true }])
  assert.equal(named.length, 1)
  assert.equal(named[0]?.name, 'notes.md')
  assert.equal(named[0]?.loading, true)
  const bound = listedComposerAttachments('', [{ kind: 'pasted_text', markerN: 4, name: 'Pasted Text #4' }], [{ id: 'p0', markerN: 4, n: 4, label: 'notes.md' }])
  assert.equal(bound.filter((item) => item.kind === 'pasted_text').length, 1)
  assert.equal(bound[0]?.name, 'notes.md')
  assert.equal(bound[0]?.loading, undefined)

  const queue = [{ id: 'img', kind: 'image' as const, markerN: null, cancelled: false }]
  const hidden = unboundPendingChips([{ id: 'img', kind: 'image', name: 'shot.png' }], queue, [{ kind: 'image', markerN: 1 }], new Set())
  assert.equal(hidden.length, 0)
  const still = unboundPendingChips([{ id: 'img', kind: 'image', name: 'shot.png' }], queue, [], new Set())
  assert.equal(still.length, 1)
}

{
  const markers = trailingAttachmentMarkers('type here', [
    { kind: 'image', markerN: 1 },
    { kind: 'pasted_text', markerN: 2 },
  ], [{ markerN: 2 }])
  assert.deepEqual(markers, [pasteMarker(2), imageMarker(1)])

  const placed = trailingAttachmentMarkers(`type ${imageMarker(1)} here`, [
    { kind: 'image', markerN: 1 },
    { kind: 'pasted_text', markerN: 2 },
  ], [])
  assert.deepEqual(placed, [pasteMarker(2)])

  assert.deepEqual(trailingAttachmentMarkers(`x ${imageMarker(1)} ${pasteMarker(2)}`, [
    { kind: 'image', markerN: 1 },
    { kind: 'pasted_text', markerN: 2 },
  ], []), [])

  assert.deepEqual(trailingAttachmentMarkers('', [
    { kind: 'image', markerN: 5 },
    { kind: 'pasted_text', markerN: 2 },
  ], [], new Set(['image:5', 'pasted_text:2'])), [])
}

console.log('composerMarkers.test.ts ok')
