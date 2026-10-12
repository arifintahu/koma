import assert from 'node:assert/strict'
import { assignFreshPasteMarkers, formatPasteFence, shouldCollapsePaste, splitPasteMessage } from './pasteText.ts'

assert.equal(shouldCollapsePaste('short'), false)
assert.equal(shouldCollapsePaste('a\nb'), true)
assert.equal(shouldCollapsePaste('x'.repeat(150)), true)

const fence = formatPasteFence({ n: 2, path: 'pastes/02-paste.txt', text: 'hello\nthere' })
const split = splitPasteMessage(`see\n\n${fence}\n\nthanks`)
assert.equal(split.prose, 'see\n\nthanks')
assert.equal(split.pastes.length, 1)
assert.equal(split.pastes[0]?.n, 2)
assert.equal(split.pastes[0]?.text, 'hello\nthere')

// Transcript references stay exactly between the surrounding prose; the full
// body remains available for the expandable card, not injected into the band.
const inline = splitPasteMessage(`${fence} < we should remove this logic?`, { preserveMarkers: true })
assert.equal(inline.prose, '[Pasted Text #2] < we should remove this logic?')
assert.deepEqual(inline.pastes, split.pastes)
assert.equal(splitPasteMessage(`before ${fence} after`, { preserveMarkers: true }).prose, 'before [Pasted Text #2] after')
assert.equal(splitPasteMessage(fence, { preserveMarkers: true }).prose, '[Pasted Text #2]')
const secondFence = formatPasteFence({ n: 9, path: 'pastes/09-paste.txt', text: 'other body' })
const multiple = splitPasteMessage(`first ${fence}\nsecond ${secondFence} last [Image #5]`, { preserveMarkers: true })
assert.equal(multiple.prose, 'first [Pasted Text #2]\nsecond [Pasted Text #9] last [Image #5]')
assert.deepEqual(multiple.pastes.map((item) => item.n), [2, 9])
assert.equal(multiple.pastes[1]?.text, 'other body')
// Keep the composer/recall extraction behavior unchanged.
assert.equal(splitPasteMessage(`before ${fence} after`).prose, 'before  after')
assert.equal(splitPasteMessage('plain [Pasted Text #2] [Image #5]', { preserveMarkers: true }).prose, 'plain [Pasted Text #2] [Image #5]')

const seen = new Set([1])
const queue = [
  { id: 'a', markerN: null, cancelled: false },
  { id: 'b', markerN: null, cancelled: true },
]
const attachments = [
  { markerN: 1, kind: 'pasted_text' },
  { markerN: 2, kind: 'image' },
  { markerN: 3, kind: 'pasted_text' },
  { markerN: 4, kind: 'pasted_text' },
]
const assigned = assignFreshPasteMarkers(queue, seen, attachments)
assert.equal(assigned.length, 2)
assert.equal(assigned[0]?.id, 'a')
assert.equal(assigned[0]?.markerN, 3)
assert.equal(assigned[1]?.cancelled, true)
assert.equal(queue[1]?.markerN, 4)
assert.equal(assignFreshPasteMarkers(queue, seen, attachments).length, 0)
