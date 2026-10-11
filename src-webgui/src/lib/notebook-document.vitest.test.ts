import { describe, expect, it } from 'vitest'
import {
  deleteCell,
  insertCell,
  moveCell,
  parseNotebook,
  setCellSource,
  setCellType,
  sliceSpan,
  encodeSourceArrayLiteral,
  jsonStringLiteral,
} from './notebook-document'

const BIG = '9007199254740993'

const FIXTURE = `{
  "cells": [
    {
      "cell_type": "code",
      "execution_count": null,
      "id": "cell-0",
      "metadata": { "exact": ${BIG}, "tags": ["keep"] },
      "outputs": [],
      "source": [
        "print(1)\\n",
        "print(2)"
      ]
    },
    {
      "cell_type": "markdown",
      "metadata": {},
      "source": "# Title"
    }
  ],
  "metadata": {
    "language_info": { "name": "python" },
    "custom": { "n": ${BIG} }
  },
  "nbformat": 4,
  "nbformat_minor": 5
}
`

describe('notebook-document lossless engine', () => {
  it('parses cells and preserves big integer tokens outside the edit', () => {
    const parsed = parseNotebook(FIXTURE)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.doc.cells).toHaveLength(2)
    expect(parsed.doc.cells[0]!.source).toBe('print(1)\nprint(2)')
    expect(parsed.doc.cells[0]!.sourceForm).toBe('array')
    expect(parsed.doc.cells[0]!.persistedId).toBe('cell-0')
    expect(parsed.doc.text).toContain(BIG)
    const next = setCellSource(parsed.doc, 0, 'x = 1\n')
    expect(next.text).toContain(BIG)
    expect(next.text).toContain('"exact":')
    expect(next.cells[0]!.source).toBe('x = 1\n')
    // Unrelated second cell object text still present
    expect(next.text).toContain('# Title')
  })

  it('does not dirty-parse invalid JSON into an empty notebook', () => {
    const bad = '{ not a notebook'
    const parsed = parseNotebook(bad)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.text).toBe(bad)
    expect(parsed.error.length).toBeGreaterThan(0)
  })

  it('preserves string vs array source form on edit', () => {
    const asString = parseNotebook(`{"cells":[{"cell_type":"raw","metadata":{},"source":"abc"}],"nbformat":4,"nbformat_minor":5}`)
    expect(asString.ok).toBe(true)
    if (!asString.ok) return
    expect(asString.doc.cells[0]!.sourceForm).toBe('string')
    const next = setCellSource(asString.doc, 0, 'xyz')
    expect(sliceSpan(next.text, next.cells[0]!.sourceValueSpan)).toBe(jsonStringLiteral('xyz'))
  })

  it('encodes array sources with nbformat line splits', () => {
    expect(encodeSourceArrayLiteral('a\nb')).toBe(`["a\\n", "b"]`)
    expect(encodeSourceArrayLiteral('')).toBe('[]')
  })

  it('supports type change, insert, delete, move without dropping unknown metadata keys', () => {
    const parsed = parseNotebook(FIXTURE)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    let doc = setCellType(parsed.doc, 1, 'code')
    expect(doc.cells[1]!.cellType).toBe('code')
    expect(doc.cells[1]!.hasOutputs).toBe(true)
    expect(doc.text).toContain(BIG)
    doc = insertCell(doc, 1, 'raw', 'hello', 'cell-new')
    expect(doc.cells).toHaveLength(3)
    expect(doc.cells[1]!.cellType).toBe('raw')
    expect(doc.cells[1]!.persistedId).toBe('cell-new')
    doc = moveCell(doc, 1, 0)
    expect(doc.cells[0]!.persistedId).toBe('cell-new')
    doc = deleteCell(doc, 0)
    expect(doc.cells).toHaveLength(2)
    expect(doc.text).toContain('"tags": ["keep"]')
    expect(doc.text).toContain(BIG)
  })

  it('round-trips a create-template shaped notebook', () => {
    const template = `{
  "cells": [
    {
      "cell_type": "code",
      "execution_count": null,
      "id": "cell-0",
      "metadata": {},
      "outputs": [],
      "source": []
    }
  ],
  "metadata": { "language_info": { "name": "python" } },
  "nbformat": 4,
  "nbformat_minor": 5
}
`
    const parsed = parseNotebook(template)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const next = setCellSource(parsed.doc, 0, 'print("hi")')
    const again = parseNotebook(next.text)
    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(again.doc.cells[0]!.source).toBe('print("hi")')
    expect(again.doc.nbformat).toBe(4)
  })
})
