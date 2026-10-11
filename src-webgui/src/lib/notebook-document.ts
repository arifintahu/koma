/**
 * Span-preserving notebook JSON engine.
 *
 * Mutations rewrite only the touched spans so unknown metadata, key order,
 * formatting outside the edit, and integer tokens beyond MAX_SAFE_INTEGER survive.
 * Never use JSON.parse → JSON.stringify for the full document.
 */

export const NOTEBOOK_EDITABLE_MAX_CHARS = 4 * 1024 * 1024

export type JsonSpan = { start: number; end: number }

export type JsonNode =
  | { kind: 'object'; span: JsonSpan; entries: Array<{ key: string; keySpan: JsonSpan; colon: number; value: JsonNode }> }
  | { kind: 'array'; span: JsonSpan; items: JsonNode[] }
  | { kind: 'string'; span: JsonSpan; value: string }
  | { kind: 'number'; span: JsonSpan; raw: string }
  | { kind: 'boolean'; span: JsonSpan; value: boolean }
  | { kind: 'null'; span: JsonSpan }

export type NotebookCellType = 'code' | 'markdown' | 'raw'

export type NotebookCellView = {
  index: number
  cellType: NotebookCellType
  source: string
  sourceForm: 'string' | 'array'
  /** Persisted nbformat cell id when present as a JSON string. */
  persistedId: string | null
  executionCount: number | null
  hasOutputs: boolean
  cellSpan: JsonSpan
  sourceValueSpan: JsonSpan
  cellTypeValueSpan: JsonSpan
  cellObject: Extract<JsonNode, { kind: 'object' }>
}

export type NotebookDocument = {
  text: string
  root: Extract<JsonNode, { kind: 'object' }>
  cellsNode: Extract<JsonNode, { kind: 'array' }>
  cells: NotebookCellView[]
  nbformat: number | null
  nbformatMinor: number | null
}

export type NotebookParseOk = { ok: true; doc: NotebookDocument }
export type NotebookParseErr = { ok: false; text: string; error: string }
export type NotebookParseResult = NotebookParseOk | NotebookParseErr

class ParseError extends Error {
  constructor(message: string, readonly index: number) {
    super(message)
  }
}

function isWs(c: string) {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r'
}

class Parser {
  i = 0
  constructor(readonly s: string) {}
  peek() { return this.s[this.i] }
  eof() { return this.i >= this.s.length }
  skipWs() { while (!this.eof() && isWs(this.s[this.i]!)) this.i++ }
  expect(ch: string) {
    this.skipWs()
    if (this.s[this.i] !== ch) throw new ParseError(`expected '${ch}'`, this.i)
    this.i++
  }
  parseValue(): JsonNode {
    this.skipWs()
    const c = this.peek()
    if (c === '{') return this.parseObject()
    if (c === '[') return this.parseArray()
    if (c === '"') return this.parseString()
    if (c === 't' || c === 'f') return this.parseBool()
    if (c === 'n') return this.parseNull()
    if (c === '-' || (c != null && c >= '0' && c <= '9')) return this.parseNumber()
    throw new ParseError('unexpected token', this.i)
  }
  parseObject(): Extract<JsonNode, { kind: 'object' }> {
    const start = this.i
    this.expect('{')
    const entries: Extract<JsonNode, { kind: 'object' }>['entries'] = []
    this.skipWs()
    if (this.peek() === '}') {
      this.i++
      return { kind: 'object', span: { start, end: this.i }, entries }
    }
    while (true) {
      this.skipWs()
      if (this.peek() !== '"') throw new ParseError('expected string key', this.i)
      const keyNode = this.parseString()
      this.skipWs()
      const colon = this.i
      this.expect(':')
      const value = this.parseValue()
      entries.push({ key: keyNode.value, keySpan: keyNode.span, colon, value })
      this.skipWs()
      const n = this.peek()
      if (n === ',') { this.i++; continue }
      if (n === '}') { this.i++; break }
      throw new ParseError('expected , or }', this.i)
    }
    return { kind: 'object', span: { start, end: this.i }, entries }
  }
  parseArray(): Extract<JsonNode, { kind: 'array' }> {
    const start = this.i
    this.expect('[')
    const items: JsonNode[] = []
    this.skipWs()
    if (this.peek() === ']') {
      this.i++
      return { kind: 'array', span: { start, end: this.i }, items }
    }
    while (true) {
      items.push(this.parseValue())
      this.skipWs()
      const n = this.peek()
      if (n === ',') { this.i++; continue }
      if (n === ']') { this.i++; break }
      throw new ParseError('expected , or ]', this.i)
    }
    return { kind: 'array', span: { start, end: this.i }, items }
  }
  parseString(): Extract<JsonNode, { kind: 'string' }> {
    const start = this.i
    if (this.s[this.i] !== '"') throw new ParseError('expected string', this.i)
    this.i++
    let value = ''
    while (!this.eof()) {
      const c = this.s[this.i]!
      if (c === '"') {
        this.i++
        return { kind: 'string', span: { start, end: this.i }, value }
      }
      if (c === '\\') {
        this.i++
        if (this.eof()) throw new ParseError('unterminated string escape', this.i)
        const e = this.s[this.i]!
        this.i++
        switch (e) {
          case '"': case '\\': case '/': value += e; break
          case 'b': value += '\b'; break
          case 'f': value += '\f'; break
          case 'n': value += '\n'; break
          case 'r': value += '\r'; break
          case 't': value += '\t'; break
          case 'u': {
            const hex = this.s.slice(this.i, this.i + 4)
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new ParseError('bad unicode escape', this.i)
            value += String.fromCharCode(parseInt(hex, 16))
            this.i += 4
            break
          }
          default: throw new ParseError('bad escape', this.i - 1)
        }
        continue
      }
      if (c.charCodeAt(0) < 0x20) throw new ParseError('control character in string', this.i)
      value += c
      this.i++
    }
    throw new ParseError('unterminated string', start)
  }
  parseNumber(): Extract<JsonNode, { kind: 'number' }> {
    const start = this.i
    if (this.peek() === '-') this.i++
    if (this.peek() === '0') this.i++
    else {
      if (!this.peek() || this.peek()! < '1' || this.peek()! > '9') throw new ParseError('bad number', this.i)
      while (this.peek() && this.peek()! >= '0' && this.peek()! <= '9') this.i++
    }
    if (this.peek() === '.') {
      this.i++
      if (!this.peek() || this.peek()! < '0' || this.peek()! > '9') throw new ParseError('bad fraction', this.i)
      while (this.peek() && this.peek()! >= '0' && this.peek()! <= '9') this.i++
    }
    if (this.peek() === 'e' || this.peek() === 'E') {
      this.i++
      if (this.peek() === '+' || this.peek() === '-') this.i++
      if (!this.peek() || this.peek()! < '0' || this.peek()! > '9') throw new ParseError('bad exponent', this.i)
      while (this.peek() && this.peek()! >= '0' && this.peek()! <= '9') this.i++
    }
    return { kind: 'number', span: { start, end: this.i }, raw: this.s.slice(start, this.i) }
  }
  parseBool(): Extract<JsonNode, { kind: 'boolean' }> {
    const start = this.i
    if (this.s.startsWith('true', this.i)) { this.i += 4; return { kind: 'boolean', span: { start, end: this.i }, value: true } }
    if (this.s.startsWith('false', this.i)) { this.i += 5; return { kind: 'boolean', span: { start, end: this.i }, value: false } }
    throw new ParseError('expected boolean', this.i)
  }
  parseNull(): Extract<JsonNode, { kind: 'null' }> {
    const start = this.i
    if (!this.s.startsWith('null', this.i)) throw new ParseError('expected null', this.i)
    this.i += 4
    return { kind: 'null', span: { start, end: this.i } }
  }
}

function entry(obj: Extract<JsonNode, { kind: 'object' }>, key: string) {
  return obj.entries.find(e => e.key === key)
}

function decodeSource(node: JsonNode | undefined): { source: string; form: 'string' | 'array'; span: JsonSpan } | null {
  if (!node) return null
  if (node.kind === 'string') return { source: node.value, form: 'string', span: node.span }
  if (node.kind === 'array') {
    const parts: string[] = []
    for (const item of node.items) {
      if (item.kind !== 'string') return null
      parts.push(item.value)
    }
    return { source: parts.join(''), form: 'array', span: node.span }
  }
  return null
}

function cellTypeOf(node: JsonNode | undefined): NotebookCellType | null {
  if (!node || node.kind !== 'string') return null
  if (node.value === 'code' || node.value === 'markdown' || node.value === 'raw') return node.value
  return null
}

function buildCells(text: string, cellsNode: Extract<JsonNode, { kind: 'array' }>): NotebookCellView[] {
  const cells: NotebookCellView[] = []
  for (let index = 0; index < cellsNode.items.length; index++) {
    const item = cellsNode.items[index]!
    if (item.kind !== 'object') throw new ParseError(`cells[${index}] must be an object`, item.span.start)
    const typeEntry = entry(item, 'cell_type')
    const cellType = cellTypeOf(typeEntry?.value)
    if (!cellType || !typeEntry) throw new ParseError(`cells[${index}].cell_type invalid`, item.span.start)
    const sourceEntry = entry(item, 'source')
    const decoded = decodeSource(sourceEntry?.value)
    if (!decoded || !sourceEntry) throw new ParseError(`cells[${index}].source invalid`, item.span.start)
    const idEntry = entry(item, 'id')
    const persistedId = idEntry?.value.kind === 'string' ? idEntry.value.value : null
    const execEntry = entry(item, 'execution_count')
    let executionCount: number | null = null
    if (execEntry?.value.kind === 'null') executionCount = null
    else if (execEntry?.value.kind === 'number' && /^-?\d+$/.test(execEntry.value.raw)) {
      const n = Number(execEntry.value.raw)
      executionCount = Number.isSafeInteger(n) ? n : null
    }
    cells.push({
      index,
      cellType,
      source: decoded.source,
      sourceForm: decoded.form,
      persistedId,
      executionCount,
      hasOutputs: !!entry(item, 'outputs'),
      cellSpan: item.span,
      sourceValueSpan: decoded.span,
      cellTypeValueSpan: typeEntry.value.span,
      cellObject: item,
    })
  }
  return cells
}

/** Parse notebook text into a span-backed document. Invalid JSON stays recoverable as raw text. */
export function parseNotebook(text: string): NotebookParseResult {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  try {
    const p = new Parser(normalized)
    const root = p.parseValue()
    p.skipWs()
    if (!p.eof()) throw new ParseError('trailing content after JSON value', p.i)
    if (root.kind !== 'object') return { ok: false, text: normalized, error: 'notebook root must be a JSON object' }
    const cellsEntry = entry(root, 'cells')
    if (!cellsEntry || cellsEntry.value.kind !== 'array') {
      return { ok: false, text: normalized, error: 'notebook must contain a cells array' }
    }
    const cells = buildCells(normalized, cellsEntry.value)
    const nb = entry(root, 'nbformat')
    const nbm = entry(root, 'nbformat_minor')
    const nbformat = nb?.value.kind === 'number' && /^\d+$/.test(nb.value.raw) ? Number(nb.value.raw) : null
    const nbformatMinor = nbm?.value.kind === 'number' && /^\d+$/.test(nbm.value.raw) ? Number(nbm.value.raw) : null
    return {
      ok: true,
      doc: {
        text: normalized,
        root,
        cellsNode: cellsEntry.value,
        cells,
        nbformat,
        nbformatMinor,
      },
    }
  } catch (e) {
    const message = e instanceof ParseError ? e.message : e instanceof Error ? e.message : String(e)
    return { ok: false, text: normalized, error: message }
  }
}

export function jsonStringLiteral(value: string): string {
  let out = '"'
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!
    const code = c.charCodeAt(0)
    switch (c) {
      case '"': out += '\\"'; break
      case '\\': out += '\\\\'; break
      case '\b': out += '\\b'; break
      case '\f': out += '\\f'; break
      case '\n': out += '\\n'; break
      case '\r': out += '\\r'; break
      case '\t': out += '\\t'; break
      default:
        if (code < 0x20) out += `\\u${code.toString(16).padStart(4, '0')}`
        else out += c
    }
  }
  return out + '"'
}

/** nbformat-friendly array source: lines keep trailing \\n except a final incomplete line. */
export function encodeSourceArrayLiteral(source: string): string {
  if (source === '') return '[]'
  const parts: string[] = []
  let idx = 0
  while (idx < source.length) {
    const nl = source.indexOf('\n', idx)
    if (nl < 0) {
      parts.push(source.slice(idx))
      break
    }
    parts.push(source.slice(idx, nl + 1))
    idx = nl + 1
  }
  return `[${parts.map(jsonStringLiteral).join(', ')}]`
}

function replaceSpan(text: string, span: JsonSpan, replacement: string): string {
  return text.slice(0, span.start) + replacement + text.slice(span.end)
}

function reparseOrThrow(text: string): NotebookDocument {
  const parsed = parseNotebook(text)
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed.doc
}

export function setCellSource(doc: NotebookDocument, index: number, source: string): NotebookDocument {
  const cell = doc.cells[index]
  if (!cell) throw new Error(`cell ${index} missing`)
  const literal = cell.sourceForm === 'string' ? jsonStringLiteral(source) : encodeSourceArrayLiteral(source)
  return reparseOrThrow(replaceSpan(doc.text, cell.sourceValueSpan, literal))
}

export function setCellType(doc: NotebookDocument, index: number, cellType: NotebookCellType): NotebookDocument {
  const cell = doc.cells[index]
  if (!cell) throw new Error(`cell ${index} missing`)
  if (cell.cellType === cellType) return doc
  let text = replaceSpan(doc.text, cell.cellTypeValueSpan, jsonStringLiteral(cellType))
  let next = reparseOrThrow(text)
  const updated = next.cells[index]!
  // Ensure code cells expose outputs / execution_count; leave unknown fields alone.
  if (cellType === 'code') {
    const obj = updated.cellObject
    if (!entry(obj, 'outputs')) {
      text = insertObjectField(next.text, obj, 'outputs', '[]')
      next = reparseOrThrow(text)
    }
    const again = next.cells[index]!
    if (!entry(again.cellObject, 'execution_count')) {
      text = insertObjectField(next.text, again.cellObject, 'execution_count', 'null')
      next = reparseOrThrow(text)
    }
  }
  return next
}

function insertObjectField(text: string, obj: Extract<JsonNode, { kind: 'object' }>, key: string, valueLiteral: string): string {
  // Insert before closing brace: `, "key": value` or `"key": value` if empty.
  const close = obj.span.end - 1
  if (obj.entries.length === 0) {
    return text.slice(0, close) + `${jsonStringLiteral(key)}: ${valueLiteral}` + text.slice(close)
  }
  return text.slice(0, close) + `, ${jsonStringLiteral(key)}: ${valueLiteral}` + text.slice(close)
}

function serializeNewCell(cellType: NotebookCellType, source = '', id?: string): string {
  const sourceLit = encodeSourceArrayLiteral(source)
  const idField = id != null ? `\n      "id": ${jsonStringLiteral(id)},` : ''
  if (cellType === 'code') {
    return `{
      "cell_type": "code",
      "execution_count": null,${idField}
      "metadata": {},
      "outputs": [],
      "source": ${sourceLit}
    }`
  }
  return `{
      "cell_type": ${jsonStringLiteral(cellType)},${idField}
      "metadata": {},
      "source": ${sourceLit}
    }`
}

function cellsArrayInner(doc: NotebookDocument, cellTexts: string[]): string {
  if (cellTexts.length === 0) return ''
  // Prefer multi-line indent similar to create template when rebuilding.
  return '\n' + cellTexts.map(t => '    ' + t.trim()).join(',\n') + '\n  '
}

export function deleteCell(doc: NotebookDocument, index: number): NotebookDocument {
  if (doc.cells.length <= 1) throw new Error('notebook must keep at least one cell')
  if (!doc.cells[index]) throw new Error(`cell ${index} missing`)
  const remaining = doc.cells.filter((_, i) => i !== index).map(c => doc.text.slice(c.cellSpan.start, c.cellSpan.end))
  const inner = cellsArrayInner(doc, remaining)
  const text = replaceSpan(doc.text, doc.cellsNode.span, `[${inner}]`)
  return reparseOrThrow(text)
}

export function insertCell(
  doc: NotebookDocument,
  index: number,
  cellType: NotebookCellType,
  source = '',
  id?: string,
): NotebookDocument {
  const at = Math.max(0, Math.min(index, doc.cells.length))
  const texts = doc.cells.map(c => doc.text.slice(c.cellSpan.start, c.cellSpan.end))
  texts.splice(at, 0, serializeNewCell(cellType, source, id))
  const inner = cellsArrayInner(doc, texts)
  return reparseOrThrow(replaceSpan(doc.text, doc.cellsNode.span, `[${inner}]`))
}

export function moveCell(doc: NotebookDocument, from: number, to: number): NotebookDocument {
  if (!doc.cells[from]) throw new Error(`cell ${from} missing`)
  if (to < 0 || to >= doc.cells.length) throw new Error(`cell ${to} missing`)
  if (from === to) return doc
  const texts = doc.cells.map(c => doc.text.slice(c.cellSpan.start, c.cellSpan.end))
  const [item] = texts.splice(from, 1)
  texts.splice(to, 0, item!)
  const inner = cellsArrayInner(doc, texts)
  return reparseOrThrow(replaceSpan(doc.text, doc.cellsNode.span, `[${inner}]`))
}

export function replaceRawText(text: string): NotebookParseResult {
  return parseNotebook(text)
}

/** Slice raw text for a value/object — used by tests to assert surgical edits. */
export function sliceSpan(text: string, span: JsonSpan): string {
  return text.slice(span.start, span.end)
}
