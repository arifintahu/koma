// Diagram documents stored as `<workspace>/.koma/<name>.diag`.
// The canvas and the sidebar both speak this shape. Snap is per file.

import { outlineFraction, pointInShape, SHAPE_KINDS, SHAPE_SIZES, type ShapeKind } from './diagramShapes'

export const DIAGRAM_GRID = 16
export const SHAPE_MIME = 'application/x-koma-shape'

export type DiagramKind = ShapeKind
export type DiagramSide = 'n' | 'e' | 's' | 'w'
export type DiagramHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
export type DiagramDash = 'solid' | 'dashed' | 'dotted'
export type DiagramArrow = 'none' | 'arrow' | 'open' | 'diamond' | 'diamondOpen' | 'dot' | 'circle' | 'bar'
export type DiagramCorner = 'sharp' | 'rounded'
export type DiagramRoute = 'orthogonal' | 'straight'
export type DiagramPoint = { x: number; y: number }

export type DiagramNode = {
  id: string
  kind: DiagramKind
  x: number
  y: number
  w: number
  h: number
  text: string
  /** Degrees clockwise. Omitted when the shape is unrotated. */
  rotation?: number
  /**
   * Omitted fill follows the kind: shapes are filled, text is not.
   * A color is a `#rrggbb`. Omitted uses the theme panel color.
   */
  fill?: boolean
  fillColor?: string
  /** Omitted border follows the kind: shapes are stroked, text is not. */
  stroke?: boolean
  strokeColor?: string
  /** Label color. Omitted uses the theme foreground. */
  textColor?: string
  /** Markdown description. Omitted when blank. The readable copy is the notes file. */
  detail?: string
}

export type DiagramEdge = {
  id: string
  from: string
  to: string
  /** False hides the stroke. Omitted means on. */
  stroke?: boolean
  color?: string
  width?: number
  dash?: DiagramDash
  start?: DiagramArrow
  /** Omitted means an end arrow. */
  end?: DiagramArrow
  /** Omitted means sharp corners. */
  corner?: DiagramCorner
  /** Omitted means an orthogonal route. */
  route?: DiagramRoute
  fromSide?: DiagramSide
  toSide?: DiagramSide
  /** 0..15 around the shape. Omitted keeps the side-center anchor. */
  fromPort?: number
  toPort?: number
  /** Interior waypoints in document coordinates. Endpoints stay on the shapes. */
  bends?: DiagramPoint[]
  /** Short label drawn on the line. Omitted when blank. */
  text?: string
  /** Where the label sits, as a fraction of the route length. Omitted means the middle. */
  labelAt?: number
  /** Markdown description. Omitted when blank. The readable copy is the notes file. */
  detail?: string
}

const SIDES: readonly DiagramSide[] = ['n', 'e', 's', 'w']
/** Sixteen points clockwise from the top-left: each side's corner, then 25%, 50%, 75%. */
export const DIAGRAM_PORTS = 16
const DASHES: readonly DiagramDash[] = ['solid', 'dashed', 'dotted']
const ARROWS: readonly DiagramArrow[] = ['none', 'arrow', 'open', 'diamond', 'diamondOpen', 'dot', 'circle', 'bar']
const CORNERS: readonly DiagramCorner[] = ['sharp', 'rounded']
const ROUTES: readonly DiagramRoute[] = ['orthogonal', 'straight']
const MIN_W = 32
const MIN_H = 24

export type DiagramDoc = {
  snap: boolean
  grid: number
  nodes: DiagramNode[]
  edges: DiagramEdge[]
}

const KINDS: readonly DiagramKind[] = SHAPE_KINDS

export function emptyDiagram(): DiagramDoc {
  return { snap: true, grid: DIAGRAM_GRID, nodes: [], edges: [] }
}

export function snap(n: number, grid: number, enabled: boolean): number {
  if (!enabled || !Number.isFinite(grid) || grid <= 0) return n
  return Math.round(n / grid) * grid
}

export function diagramTabId(root: string, path: string): string {
  return `diagram:${root}:${path}`
}

export function isDiagramPath(path: string): boolean {
  return path.startsWith('.koma/') && path.toLowerCase().endsWith('.diag') && !path.slice('.koma/'.length).includes('/')
}

/** Accept a typed file name and force a single `.diag` suffix. */
export function diagramFileName(raw: string): string | null {
  const cleaned = raw.trim().replace(/^\/+|\/+$/g, '')
  if (!cleaned || cleaned.includes('..') || cleaned.includes('/') || cleaned.includes('\\')) return null
  const stem = cleaned.replace(/\.diag$/i, '')
  if (!stem) return null
  return `${stem}.diag`
}

export function defaultNodeSize(kind: DiagramKind): { w: number; h: number; text: string } {
  return { ...SHAPE_SIZES[kind], text: kind === 'text' ? 'text' : 'label' }
}

export function isDiagramKind(value: unknown): value is DiagramKind {
  return typeof value === 'string' && (KINDS as readonly string[]).includes(value)
}

/** Same card, new id, shifted. Lines are not part of the copy. */
export function copyNode(node: DiagramNode, id: string, dx: number, dy: number): DiagramNode {
  const next: DiagramNode = {
    id,
    kind: node.kind,
    x: node.x + dx,
    y: node.y + dy,
    w: node.w,
    h: node.h,
    text: node.text,
  }
  if (node.rotation) next.rotation = node.rotation
  if (node.fill != null) next.fill = node.fill
  if (node.fillColor) next.fillColor = node.fillColor
  if (node.stroke != null) next.stroke = node.stroke
  if (node.strokeColor) next.strokeColor = node.strokeColor
  if (node.textColor) next.textColor = node.textColor
  if (node.detail?.trim()) next.detail = node.detail
  return next
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function parseNodes(value: unknown): DiagramNode[] | null {
  if (!Array.isArray(value)) return null
  const nodes: DiagramNode[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') return null
    const row = item as Record<string, unknown>
    const x = num(row.x)
    const y = num(row.y)
    const w = num(row.w)
    const h = num(row.h)
    if (typeof row.id !== 'string' || !row.id || !isDiagramKind(row.kind) || x == null || y == null || w == null || h == null) return null
    if (typeof row.text !== 'string') return null
    const node: DiagramNode = { id: row.id, kind: row.kind, x, y, w, h, text: row.text }
    const rotation = num(row.rotation)
    if (rotation != null && rotation !== 0) node.rotation = ((rotation % 360) + 360) % 360
    const painted = row.kind !== 'text'
    if (typeof row.fill === 'boolean' && row.fill !== painted) node.fill = row.fill
    const fillColor = parseColor(row.fillColor)
    if (fillColor) node.fillColor = fillColor
    if (typeof row.stroke === 'boolean' && row.stroke !== painted) node.stroke = row.stroke
    const strokeColor = parseColor(row.strokeColor)
    if (strokeColor) node.strokeColor = strokeColor
    const textColor = parseColor(row.textColor)
    if (textColor) node.textColor = textColor
    const detail = parseDetail(row.detail)
    if (detail) node.detail = detail
    nodes.push(node)
  }
  return nodes
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : undefined
}

function parseColor(value: unknown): string | undefined {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : undefined
}

const DETAIL_LIMIT = 65536
const LABEL_LIMIT = 200

function parseDetail(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.length > DETAIL_LIMIT ? value.slice(0, DETAIL_LIMIT) : value
  return text.trim() ? text : undefined
}

function parseLineLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.replace(/\r?\n/g, ' ').trim()
  if (!text) return undefined
  return text.length > LABEL_LIMIT ? text.slice(0, LABEL_LIMIT) : text
}

function parsePort(value: unknown): number | undefined {
  const port = num(value)
  return port != null && Number.isInteger(port) && port >= 0 && port < DIAGRAM_PORTS ? port : undefined
}

function parseBends(value: unknown): DiagramPoint[] | undefined {
  if (!Array.isArray(value)) return undefined
  const bends: DiagramPoint[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') return undefined
    const row = item as Record<string, unknown>
    const x = num(row.x)
    const y = num(row.y)
    if (x == null || y == null) return undefined
    bends.push({ x, y })
    if (bends.length >= 32) break
  }
  return bends.length ? bends : undefined
}

function parseEdges(value: unknown): DiagramEdge[] | null {
  if (!Array.isArray(value)) return null
  const edges: DiagramEdge[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') return null
    const row = item as Record<string, unknown>
    if (typeof row.id !== 'string' || !row.id || typeof row.from !== 'string' || typeof row.to !== 'string') return null
    const edge: DiagramEdge = { id: row.id, from: row.from, to: row.to }
    if (row.stroke === false) edge.stroke = false
    const color = parseColor(row.color)
    const width = num(row.width)
    const dash = oneOf(row.dash, DASHES)
    const start = oneOf(row.start, ARROWS)
    const end = oneOf(row.end, ARROWS)
    const corner = oneOf(row.corner, CORNERS)
    const route = oneOf(row.route, ROUTES)
    const fromSide = oneOf(row.fromSide, SIDES)
    const toSide = oneOf(row.toSide, SIDES)
    const fromPort = parsePort(row.fromPort)
    const toPort = parsePort(row.toPort)
    const bends = parseBends(row.bends)
    if (color) edge.color = color
    if (width != null && width > 0 && width !== 1.5) edge.width = width
    if (dash && dash !== 'solid') edge.dash = dash
    if (start && start !== 'none') edge.start = start
    if (end && end !== 'arrow') edge.end = end
    if (corner && corner !== 'sharp') edge.corner = corner
    if (route && route !== 'orthogonal') edge.route = route
    if (fromSide && fromPort == null) edge.fromSide = fromSide
    if (toSide && toPort == null) edge.toSide = toSide
    if (fromPort != null) edge.fromPort = fromPort
    if (toPort != null) edge.toPort = toPort
    if (bends) edge.bends = bends
    const label = parseLineLabel(row.text)
    if (label) edge.text = label
    const labelAt = num(row.labelAt)
    if (labelAt != null && labelAt >= 0 && labelAt <= 1 && labelAt !== 0.5) edge.labelAt = labelAt
    const detail = parseDetail(row.detail)
    if (detail) edge.detail = detail
    edges.push(edge)
  }
  return edges
}

export function parseDiagram(text: string): { doc: DiagramDoc; error: string | null } {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { doc: emptyDiagram(), error: 'This file is not a diagram' }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { doc: emptyDiagram(), error: 'This file is not a diagram' }
  }
  const raw = value as Record<string, unknown>
  const nodes = parseNodes(raw.nodes)
  const edges = parseEdges(raw.edges)
  if (!nodes || !edges) return { doc: emptyDiagram(), error: 'This file is not a diagram' }
  const grid = num(raw.grid)
  return {
    doc: {
      snap: typeof raw.snap === 'boolean' ? raw.snap : true,
      grid: grid != null && grid > 0 ? grid : DIAGRAM_GRID,
      nodes,
      edges,
    },
    error: null,
  }
}

export function serializeDiagram(doc: DiagramDoc): string {
  return JSON.stringify({
    snap: doc.snap,
    grid: doc.grid,
    nodes: doc.nodes.map((n) => {
      const row: DiagramNode = { id: n.id, kind: n.kind, x: n.x, y: n.y, w: n.w, h: n.h, text: n.text }
      const painted = n.kind !== 'text'
      if (n.rotation) row.rotation = n.rotation
      if (typeof n.fill === 'boolean' && n.fill !== painted) row.fill = n.fill
      if (n.fillColor) row.fillColor = n.fillColor
      if (typeof n.stroke === 'boolean' && n.stroke !== painted) row.stroke = n.stroke
      if (n.strokeColor) row.strokeColor = n.strokeColor
      if (n.textColor) row.textColor = n.textColor
      if (n.detail?.trim()) row.detail = n.detail
      return row
    }),
    edges: doc.edges.map((e) => {
      const row: DiagramEdge = { id: e.id, from: e.from, to: e.to }
      if (e.stroke === false) row.stroke = false
      if (e.color) row.color = e.color
      if (e.width != null && e.width !== 1.5) row.width = e.width
      if (e.dash && e.dash !== 'solid') row.dash = e.dash
      if (e.start && e.start !== 'none') row.start = e.start
      if (e.end && e.end !== 'arrow') row.end = e.end
      if (e.corner && e.corner !== 'sharp') row.corner = e.corner
      if (e.route && e.route !== 'orthogonal') row.route = e.route
      if (e.fromPort != null) row.fromPort = e.fromPort
      else if (e.fromSide) row.fromSide = e.fromSide
      if (e.toPort != null) row.toPort = e.toPort
      else if (e.toSide) row.toSide = e.toSide
      if (e.bends?.length) row.bends = e.bends.map((p) => ({ x: p.x, y: p.y }))
      if (e.text?.trim()) row.text = e.text
      if (e.labelAt != null && e.labelAt !== 0.5) row.labelAt = e.labelAt
      if (e.detail?.trim()) row.detail = e.detail
      return row
    }),
  })
}

export type DiagramEdgeStyle = {
  stroke: boolean
  color: string
  width: number
  dash: DiagramDash
  start: DiagramArrow
  end: DiagramArrow
  corner: DiagramCorner
  route: DiagramRoute
}

/** Resolved fill and border. Text is bare unless a file says otherwise. */
export function nodeStyle(node: DiagramNode): {
  fill: boolean
  fillColor: string
  stroke: boolean
  strokeColor: string
  textColor: string
} {
  const painted = node.kind !== 'text'
  return {
    fill: node.fill ?? painted,
    fillColor: node.fillColor ?? '',
    stroke: node.stroke ?? painted,
    strokeColor: node.strokeColor ?? '',
    textColor: node.textColor ?? '',
  }
}

export function edgeStyle(edge: DiagramEdge): DiagramEdgeStyle {
  return {
    stroke: edge.stroke !== false,
    color: edge.color ?? '',
    width: edge.width != null && edge.width > 0 ? edge.width : 1.5,
    dash: edge.dash ?? 'solid',
    start: edge.start ?? 'none',
    end: edge.end ?? 'arrow',
    corner: edge.corner ?? 'sharp',
    route: edge.route ?? 'orthogonal',
  }
}

export type ArrowHead = {
  refX: number
  refY: number
  d?: string
  circle?: { cx: number; cy: number; r: number }
  fill: boolean
}

const END_HEAD: Record<Exclude<DiagramArrow, 'none'>, ArrowHead> = {
  arrow: { d: 'M0,0 L7,3 L0,6 Z', refX: 7, refY: 3, fill: true },
  open: { d: 'M0,0 L7,3 L0,6', refX: 7, refY: 3, fill: false },
  diamond: { d: 'M7,3 L3.5,0 L0,3 L3.5,6 Z', refX: 7, refY: 3, fill: true },
  diamondOpen: { d: 'M7,3 L3.5,0 L0,3 L3.5,6 Z', refX: 7, refY: 3, fill: false },
  dot: { circle: { cx: 4.5, cy: 3, r: 2.5 }, refX: 7, refY: 3, fill: true },
  circle: { circle: { cx: 4.5, cy: 3, r: 2.5 }, refX: 7, refY: 3, fill: false },
  bar: { d: 'M7,0.5 V5.5', refX: 7, refY: 3, fill: false },
}

function mirrorPath(d: string): string {
  return d.replace(/([ML])(-?\d*\.?\d+),(-?\d*\.?\d+)/g, (_, cmd: string, x: string, y: string) => `${cmd}${7 - Number(x)},${y}`)
}

/**
 * Line head in marker space. The ref point meets the node and the body lies on
 * the stroke. Start is the end head mirrored. Both use orient "auto".
 */
export function arrowHead(at: 'start' | 'end', kind: DiagramArrow): ArrowHead | null {
  if (kind === 'none') return null
  const head = END_HEAD[kind]
  if (at === 'end') return head
  return {
    refX: 7 - head.refX,
    refY: head.refY,
    fill: head.fill,
    d: head.d ? mirrorPath(head.d) : undefined,
    circle: head.circle ? { cx: 7 - head.circle.cx, cy: head.circle.cy, r: head.circle.r } : undefined,
  }
}

export function nodeCenter(node: DiagramNode): DiagramPoint {
  return { x: node.x + node.w / 2, y: node.y + node.h / 2 }
}

export function rotatePoint(point: DiagramPoint, center: DiagramPoint, degrees: number): DiagramPoint {
  if (!degrees) return point
  const rad = (degrees * Math.PI) / 180
  const dx = point.x - center.x
  const dy = point.y - center.y
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  return { x: center.x + dx * cos - dy * sin, y: center.y + dx * sin + dy * cos }
}

export function sideAnchor(node: DiagramNode, side: DiagramSide): DiagramPoint {
  const local =
    side === 'n'
      ? { x: node.x + node.w / 2, y: node.y }
      : side === 's'
        ? { x: node.x + node.w / 2, y: node.y + node.h }
        : side === 'w'
          ? { x: node.x, y: node.y + node.h / 2 }
          : { x: node.x + node.w, y: node.y + node.h / 2 }
  return rotatePoint(local, nodeCenter(node), node.rotation ?? 0)
}

export function portSide(port: number): DiagramSide {
  const index = ((Math.floor(port) % DIAGRAM_PORTS) + DIAGRAM_PORTS) % DIAGRAM_PORTS
  return SIDES[Math.floor(index / 4)]
}

/** Box fraction clockwise from the top-left. Slot 0 is a corner, 2 is an edge center. */
export function portLocal(port: number): { x: number; y: number } {
  const index = ((Math.floor(port) % DIAGRAM_PORTS) + DIAGRAM_PORTS) % DIAGRAM_PORTS
  const side = Math.floor(index / 4)
  const t = (index % 4) / 4
  if (side === 0) return { x: t, y: 0 }
  if (side === 1) return { x: 1, y: t }
  if (side === 2) return { x: 1 - t, y: 1 }
  return { x: 0, y: 1 - t }
}

/** Where a connector plus sits, as a fraction of the node box (before rotation). */
export function portOffset(node: DiagramNode, port: number): { x: number; y: number } {
  return outlineFraction(node.kind, node.w, node.h, portLocal(port))
}

/** Outline point, then the node's rotation. */
export function portAnchor(node: DiagramNode, port: number): DiagramPoint {
  const offset = portOffset(node, port)
  const local = { x: node.x + node.w * offset.x, y: node.y + node.h * offset.y }
  return rotatePoint(local, nodeCenter(node), node.rotation ?? 0)
}

export function nearestPort(node: DiagramNode, point: DiagramPoint): number {
  let best = 0
  let dist = Infinity
  for (let port = 0; port < DIAGRAM_PORTS; port++) {
    const anchor = portAnchor(node, port)
    const d = (anchor.x - point.x) ** 2 + (anchor.y - point.y) ** 2
    if (d < dist) {
      dist = d
      best = port
    }
  }
  return best
}

/** On the shape's own outline (a triangle's empty corners do not count), rotation included. */
export function pointInNode(node: DiagramNode, point: DiagramPoint): boolean {
  const local = rotatePoint(point, nodeCenter(node), -(node.rotation ?? 0))
  return pointInShape(node.kind, node.w, node.h, local.x - node.x, local.y - node.y)
}

/** Topmost shape under the point, or a shape whose port is within 16px. */
export function nodeAtPoint(nodes: readonly DiagramNode[], point: DiagramPoint, ignoreId?: string): DiagramNode | null {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i]
    if (!node || node.id === ignoreId) continue
    if (pointInNode(node, point)) return node
  }
  let best: DiagramNode | null = null
  let dist = 16 * 16
  for (const node of nodes) {
    if (node.id === ignoreId) continue
    for (let port = 0; port < DIAGRAM_PORTS; port++) {
      const anchor = portAnchor(node, port)
      const d = (anchor.x - point.x) ** 2 + (anchor.y - point.y) ** 2
      if (d <= dist) {
        dist = d
        best = node
      }
    }
  }
  return best
}

export type DiagramRect = { x: number; y: number; w: number; h: number }

/** Axis-aligned box around the node after rotation. */
export function nodeBounds(node: DiagramNode): DiagramRect {
  const center = nodeCenter(node)
  const corners = [
    { x: node.x, y: node.y },
    { x: node.x + node.w, y: node.y },
    { x: node.x + node.w, y: node.y + node.h },
    { x: node.x, y: node.y + node.h },
  ].map((point) => rotatePoint(point, center, node.rotation ?? 0))
  const xs = corners.map((point) => point.x)
  const ys = corners.map((point) => point.y)
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
}

export type DiagramSelection = { nodes: string[]; edges: string[] }

export const NO_SELECTION: DiagramSelection = { nodes: [], edges: [] }

export function selectionSize(selection: DiagramSelection): number {
  return selection.nodes.length + selection.edges.length
}

/** Shapes fully inside the rectangle, plus the lines whose both ends are among them. */
export function selectInRect(doc: DiagramDoc, rect: DiagramRect): DiagramSelection {
  const inside = (box: DiagramRect) =>
    box.x >= rect.x && box.y >= rect.y && box.x + box.w <= rect.x + rect.w && box.y + box.h <= rect.y + rect.h
  const nodes = doc.nodes.filter((node) => inside(nodeBounds(node))).map((node) => node.id)
  const picked = new Set(nodes)
  const edges = doc.edges.filter((edge) => picked.has(edge.from) && picked.has(edge.to)).map((edge) => edge.id)
  return { nodes, edges }
}

/** Union of two selections, or the first with the second's items toggled. */
export function mergeSelection(base: DiagramSelection, extra: DiagramSelection, toggle: boolean): DiagramSelection {
  const merge = (a: string[], b: string[]) => {
    const next = new Set(a)
    for (const id of b) {
      if (toggle && next.has(id)) next.delete(id)
      else next.add(id)
    }
    return [...next]
  }
  return { nodes: merge(base.nodes, extra.nodes), edges: merge(base.edges, extra.edges) }
}

/** The selected shapes plus every line that is selected or runs between two selected shapes. */
export function selectionDoc(doc: DiagramDoc, selection: DiagramSelection): DiagramDoc {
  const edgeIds = new Set(selection.edges)
  const nodeIds = new Set(selection.nodes)
  for (const edge of doc.edges) {
    if (edgeIds.has(edge.id)) {
      nodeIds.add(edge.from)
      nodeIds.add(edge.to)
    }
  }
  return {
    ...doc,
    nodes: doc.nodes.filter((node) => nodeIds.has(node.id)),
    edges: doc.edges.filter((edge) => edgeIds.has(edge.id) || (selection.nodes.includes(edge.from) && selection.nodes.includes(edge.to))),
  }
}

export function selectionBounds(doc: DiagramDoc, selection: DiagramSelection): DiagramRect | null {
  const picked = new Set(selection.nodes)
  let box: DiagramRect | null = null
  for (const node of doc.nodes) {
    if (!picked.has(node.id)) continue
    const b = nodeBounds(node)
    if (!box) {
      box = b
      continue
    }
    const x = Math.min(box.x, b.x)
    const y = Math.min(box.y, b.y)
    box = { x, y, w: Math.max(box.x + box.w, b.x + b.w) - x, h: Math.max(box.y + box.h, b.y + b.h) - y }
  }
  return box
}

/**
 * Copies of the selected shapes and of the lines between them, shifted and with fresh ids.
 * Lines that leave the selection stay behind, as in draw.io.
 */
export function copyDiagramShapes(
  doc: DiagramDoc,
  selection: DiagramSelection,
  mint: (prefix: string) => string,
  dx: number,
  dy: number,
): { nodes: DiagramNode[]; edges: DiagramEdge[] } {
  const ids = new Map<string, string>()
  const picked = new Set(selection.nodes)
  const nodes: DiagramNode[] = []
  for (const node of doc.nodes) {
    if (!picked.has(node.id)) continue
    const id = mint('n')
    ids.set(node.id, id)
    nodes.push(copyNode(node, id, dx, dy))
  }
  const edges: DiagramEdge[] = []
  for (const edge of doc.edges) {
    const from = ids.get(edge.from)
    const to = ids.get(edge.to)
    if (!from || !to) continue
    const copy: DiagramEdge = { ...edge, id: mint('e'), from, to }
    if (edge.bends) copy.bends = edge.bends.map((point) => ({ x: point.x + dx, y: point.y + dy }))
    edges.push(copy)
  }
  return { nodes, edges }
}

/** Shift shapes, and the bends of lines whose both ends move, so routes keep their shape. */
export function moveDiagramNodes(doc: DiagramDoc, ids: readonly string[], dx: number, dy: number): DiagramDoc {
  if (!dx && !dy) return doc
  const moving = new Set(ids)
  return {
    ...doc,
    nodes: doc.nodes.map((node) => (moving.has(node.id) ? { ...node, x: node.x + dx, y: node.y + dy } : node)),
    edges: doc.edges.map((edge) =>
      edge.bends?.length && moving.has(edge.from) && moving.has(edge.to)
        ? { ...edge, bends: edge.bends.map((point) => ({ x: point.x + dx, y: point.y + dy })) }
        : edge,
    ),
  }
}

/** Removes the selection and every line left without both ends. */
export function deleteDiagramSelection(doc: DiagramDoc, selection: DiagramSelection): DiagramDoc {
  const nodes = new Set(selection.nodes)
  const edges = new Set(selection.edges)
  return {
    ...doc,
    nodes: doc.nodes.filter((node) => !nodes.has(node.id)),
    edges: doc.edges.filter((edge) => !edges.has(edge.id) && !nodes.has(edge.from) && !nodes.has(edge.to)),
  }
}

export function distanceToSegment(point: DiagramPoint, a: DiagramPoint, b: DiagramPoint): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const length = dx * dx + dy * dy
  const t = length ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length)) : 0
  return Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t))
}

export type DiagramHit = { type: 'node' | 'edge'; id: string }

/** Topmost shape under the point, else the nearest line within the tolerance. */
export function hitDiagram(doc: DiagramDoc, point: DiagramPoint, tolerance: number): DiagramHit | null {
  for (let i = doc.nodes.length - 1; i >= 0; i--) {
    const node = doc.nodes[i]
    if (node && pointInNode(node, point)) return { type: 'node', id: node.id }
  }
  const byId = new Map(doc.nodes.map((node) => [node.id, node]))
  let best: DiagramHit | null = null
  let dist = tolerance
  for (const edge of doc.edges) {
    const from = byId.get(edge.from)
    const to = byId.get(edge.to)
    if (!from || !to) continue
    const points = edgePoints(from, to, edge)
    for (let i = 1; i < points.length; i++) {
      const d = distanceToSegment(point, points[i - 1], points[i])
      if (d <= dist) {
        dist = d
        best = { type: 'edge', id: edge.id }
      }
    }
  }
  return best
}

export type DiagramGuide = { axis: 'x' | 'y'; at: number; from: number; to: number }

/**
 * draw.io-style alignment: the moving box's edges and middle snap to the same lines of
 * other boxes within the tolerance. `xs`/`ys` pick which lines of the moving box take part
 * (fractions of its size), so a resize only snaps the edge being dragged.
 */
export function diagramGuides(
  targets: readonly DiagramRect[],
  moving: DiagramRect,
  tolerance: number,
  xs: readonly number[] = [0, 0.5, 1],
  ys: readonly number[] = [0, 0.5, 1],
): { dx: number; dy: number; guides: DiagramGuide[] } {
  const axis = (fractions: readonly number[], start: number, size: number, pick: (rect: DiagramRect) => [number, number]) => {
    let best: number | null = null
    for (const target of targets) {
      const [tStart, tSize] = pick(target)
      for (const f of fractions) {
        const line = start + size * f
        for (const t of [tStart, tStart + tSize / 2, tStart + tSize]) {
          const d = t - line
          if (Math.abs(d) <= tolerance && (best == null || Math.abs(d) < Math.abs(best))) best = d
        }
      }
    }
    return best ?? 0
  }
  const dx = xs.length ? axis(xs, moving.x, moving.w, (r) => [r.x, r.w]) : 0
  const dy = ys.length ? axis(ys, moving.y, moving.h, (r) => [r.y, r.h]) : 0
  const moved = { ...moving, x: moving.x + dx, y: moving.y + dy }
  const guides: DiagramGuide[] = []
  // A guide is drawn for every line of the moved box that now sits exactly on a target's line.
  const collect = (axisName: 'x' | 'y', fractions: readonly number[], pick: (rect: DiagramRect) => [number, number, number, number]) => {
    const [mStart, mSize, mCross, mCrossSize] = pick(moved)
    for (const f of fractions) {
      const line = mStart + mSize * f
      let from = mCross
      let to = mCross + mCrossSize
      let hit = false
      for (const target of targets) {
        const [tStart, tSize, tCross, tCrossSize] = pick(target)
        if (![tStart, tStart + tSize / 2, tStart + tSize].some((t) => Math.abs(t - line) < 0.5)) continue
        hit = true
        from = Math.min(from, tCross)
        to = Math.max(to, tCross + tCrossSize)
      }
      if (hit) guides.push({ axis: axisName, at: line, from, to })
    }
  }
  collect('x', xs, (r) => [r.x, r.w, r.y, r.h])
  collect('y', ys, (r) => [r.y, r.h, r.x, r.w])
  return { dx, dy, guides }
}

export type DiagramDirection = 'n' | 'e' | 's' | 'w'

/** draw.io `defaultEdgeLength`: the gap between a shape and the one its arrow adds. */
export const DIAGRAM_EDGE_LENGTH = 80

function intersects(a: DiagramRect, b: DiagramRect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

/** Point one edge length out from the middle of a side of the shape's box. */
function directionPoint(box: DiagramRect, direction: DiagramDirection, length: number): DiagramPoint {
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  if (direction === 'n') return { x: cx, y: box.y - length }
  if (direction === 's') return { x: cx, y: box.y + box.h + length }
  if (direction === 'w') return { x: box.x - length, y: cy }
  return { x: box.x + box.w + length, y: cy }
}

/**
 * The shape a hover arrow would connect to: one that already sits near the arrow's target
 * point and does not overlap the source (draw.io `connectVertex`).
 */
export function arrowTarget(doc: DiagramDoc, sourceId: string, direction: DiagramDirection): DiagramNode | null {
  const source = doc.nodes.find((node) => node.id === sourceId)
  if (!source) return null
  const box = nodeBounds(source)
  const point = directionPoint(box, direction, DIAGRAM_EDGE_LENGTH)
  const probe = { x: point.x - 40, y: point.y - 40, w: 80, h: 80 }
  for (let i = doc.nodes.length - 1; i >= 0; i--) {
    const node = doc.nodes[i]
    if (!node || node.id === sourceId) continue
    const bounds = nodeBounds(node)
    if (intersects(bounds, probe) && !intersects(bounds, box)) return node
  }
  return null
}

/**
 * Click on a hover arrow: connect to the shape already there, or add one an edge length
 * away (a blank copy of the source, or `shape` when the picker chose one) and connect it.
 */
export function connectInDirection(
  doc: DiagramDoc,
  sourceId: string,
  direction: DiagramDirection,
  mint: (prefix: string) => string,
  shape?: Pick<DiagramNode, 'kind' | 'w' | 'h'>,
  edgeStyle?: Partial<DiagramEdge>,
): { doc: DiagramDoc; nodeId: string; edgeId: string } | null {
  const source = doc.nodes.find((node) => node.id === sourceId)
  if (!source) return null
  const existing = shape ? null : arrowTarget(doc, sourceId, direction)
  const edgeId = mint('e')
  const line = (to: string): DiagramEdge => ({ ...edgeStyle, id: edgeId, from: sourceId, to })
  if (existing) return { doc: { ...doc, edges: [...doc.edges, line(existing.id)] }, nodeId: existing.id, edgeId }
  const w = shape?.w ?? source.w
  const h = shape?.h ?? source.h
  const half = direction === 'e' || direction === 'w' ? w / 2 : h / 2
  const center = directionPoint(nodeBounds(source), direction, DIAGRAM_EDGE_LENGTH + half)
  const node: DiagramNode = shape
    ? { id: mint('n'), kind: shape.kind, x: center.x - w / 2, y: center.y - h / 2, w, h, text: '' }
    : { ...copyNode(source, mint('n'), 0, 0), x: center.x - w / 2, y: center.y - h / 2, text: '' }
  delete node.detail
  delete node.rotation
  return {
    doc: { ...doc, nodes: [...doc.nodes, node], edges: [...doc.edges, line(node.id)] },
    nodeId: node.id,
    edgeId,
  }
}

/** Screen-space tolerance, in doc units, inside which a drop pins a port instead of floating. */
export const DIAGRAM_PORT_SNAP = 10

/**
 * Where a connection dropped at `point` attaches: a fixed port when the point is near one,
 * else a floating end that follows the nearest side as shapes move (draw.io outline connect).
 */
export function connectionEnd(node: DiagramNode, point: DiagramPoint, portSnap: number): { port?: number } {
  const port = nearestPort(node, point)
  const anchor = portAnchor(node, port)
  return Math.hypot(anchor.x - point.x, anchor.y - point.y) <= portSnap ? { port } : {}
}

export function nearestSide(node: DiagramNode, point: DiagramPoint): DiagramSide {
  let best: DiagramSide = 'e'
  let dist = Infinity
  for (const side of SIDES) {
    const anchor = sideAnchor(node, side)
    const d = (anchor.x - point.x) ** 2 + (anchor.y - point.y) ** 2
    if (d < dist) {
      dist = d
      best = side
    }
  }
  return best
}

export type DiagramResizeOptions = {
  /** Keep the width-to-height ratio (Shift). */
  lock?: boolean
  /** Grow both sides around the center (Alt). */
  center?: boolean
}

/**
 * Drag one handle by a doc-space delta. The math runs in the shape's own axes, and the
 * opposite handle (or the center) stays put on screen, so rotated shapes do not drift.
 * Grid snap applies only to unrotated shapes, where an edge can actually sit on the grid.
 */
export function resizeNode(
  node: DiagramNode,
  handle: DiagramHandle,
  dx: number,
  dy: number,
  grid: number,
  enabled: boolean,
  options: DiagramResizeOptions = {},
): DiagramNode {
  const rotation = node.rotation ?? 0
  const rad = (-rotation * Math.PI) / 180
  const lx = dx * Math.cos(rad) - dy * Math.sin(rad)
  const ly = dx * Math.sin(rad) + dy * Math.cos(rad)
  const snapOn = enabled && !rotation
  const xSide = handle.includes('w') ? -1 : handle.includes('e') ? 1 : 0
  const ySide = handle.includes('n') ? -1 : handle.includes('s') ? 1 : 0
  const grow = (size: number, side: number, delta: number, origin: number) => {
    if (!side) return size
    const factor = options.center ? 2 : 1
    let next = size + side * delta * factor
    if (snapOn) {
      // Snap the dragged edge itself, then derive the size from the fixed edge (or the center).
      const fixed = options.center ? origin + size / 2 : side > 0 ? origin : origin + size
      const edge = snap(side > 0 ? fixed + (options.center ? next / 2 : next) : fixed - (options.center ? next / 2 : next), grid, true)
      next = Math.abs(edge - fixed) * factor
    }
    return next
  }
  let w = grow(node.w, xSide, lx, node.x)
  let h = grow(node.h, ySide, ly, node.y)
  if (options.lock && node.w > 0 && node.h > 0) {
    const ratio = node.w / node.h
    if (xSide && ySide) {
      // Corners follow whichever axis moved further, relative to its size.
      if (Math.abs(w / node.w - 1) >= Math.abs(h / node.h - 1)) h = w / ratio
      else w = h * ratio
    } else if (xSide) h = w / ratio
    else if (ySide) w = h * ratio
  }
  w = Math.max(MIN_W, w)
  h = Math.max(MIN_H, h)
  // Fraction of the box that must not move: the opposite side, or the middle for an
  // axis no handle drags (it only changes under the aspect lock) and for Alt.
  const pin = (side: number) => (options.center || !side ? 0.5 : side > 0 ? 0 : 1)
  const fx = pin(xSide)
  const fy = pin(ySide)
  const before = rotatePoint({ x: node.x + node.w * fx, y: node.y + node.h * fy }, nodeCenter(node), rotation)
  const offset = rotatePoint({ x: w * fx - w / 2, y: h * fy - h / 2 }, { x: 0, y: 0 }, rotation)
  const cx = before.x - offset.x
  const cy = before.y - offset.y
  return { ...node, x: cx - w / 2, y: cy - h / 2, w, h }
}

export function pointerAngle(node: DiagramNode, point: DiagramPoint): number {
  const center = nodeCenter(node)
  return (Math.atan2(point.y - center.y, point.x - center.x) * 180) / Math.PI
}

export function nextRotation(start: number, startAngle: number, angle: number, snapOn: boolean): number {
  let degrees = start + (angle - startAngle)
  degrees = ((degrees % 360) + 360) % 360
  if (snapOn) degrees = Math.round(degrees / 15) * 15 % 360
  return degrees === 360 ? 0 : degrees
}

function outgoing(point: DiagramPoint, side: DiagramSide, distance: number): DiagramPoint {
  if (side === 'n') return { x: point.x, y: point.y - distance }
  if (side === 's') return { x: point.x, y: point.y + distance }
  if (side === 'w') return { x: point.x - distance, y: point.y }
  return { x: point.x + distance, y: point.y }
}

function dedupe(points: DiagramPoint[]): DiagramPoint[] {
  const kept: DiagramPoint[] = []
  for (const point of points) {
    const prev = kept[kept.length - 1]
    if (prev && Math.abs(prev.x - point.x) < 0.5 && Math.abs(prev.y - point.y) < 0.5) continue
    const before = kept[kept.length - 2]
    if (
      prev &&
      before &&
      ((Math.abs(before.x - prev.x) < 0.5 && Math.abs(prev.x - point.x) < 0.5) ||
        (Math.abs(before.y - prev.y) < 0.5 && Math.abs(prev.y - point.y) < 0.5))
    ) {
      kept[kept.length - 1] = point
      continue
    }
    kept.push(point)
  }
  return kept
}

function routeEnd(
  node: DiagramNode,
  other: DiagramNode,
  port: number | undefined,
  side: DiagramSide | undefined,
  toward?: DiagramPoint,
): { point: DiagramPoint; side: DiagramSide } {
  if (port != null && port >= 0 && port < DIAGRAM_PORTS) {
    return { point: portAnchor(node, port), side: portSide(port) }
  }
  const resolved = side ?? nearestSide(node, toward ?? nodeCenter(other))
  return { point: sideAnchor(node, resolved), side: resolved }
}

export function edgeRoute(from: DiagramNode, to: DiagramNode, edge: DiagramEdge): DiagramPoint[] {
  const style = edgeStyle(edge)
  // A straight line with bends aims each floating end at its nearest bend, not the far shape.
  const straight = style.route === 'straight'
  const first = straight ? edge.bends?.[0] : undefined
  const last = straight ? edge.bends?.[edge.bends.length - 1] : undefined
  const startEnd = routeEnd(from, to, edge.fromPort, edge.fromSide, first)
  const endEnd = routeEnd(to, from, edge.toPort, edge.toSide, last)
  const fromSide = startEnd.side
  const toSide = endEnd.side
  const start = startEnd.point
  const end = endEnd.point
  if (straight) return edge.bends?.length ? [start, ...edge.bends, end] : [start, end]
  if (edge.bends?.length) return dedupe([start, ...edge.bends, end])
  const stub = 24
  const leave = outgoing(start, fromSide, stub)
  const enter = outgoing(end, toSide, stub)
  const horizontal = (side: DiagramSide) => side === 'e' || side === 'w'
  let mid: DiagramPoint[]
  if (horizontal(fromSide) && horizontal(toSide)) {
    const x = (leave.x + enter.x) / 2
    mid = [leave, { x, y: leave.y }, { x, y: enter.y }, enter]
  } else if (!horizontal(fromSide) && !horizontal(toSide)) {
    const y = (leave.y + enter.y) / 2
    mid = [leave, { x: leave.x, y }, { x: enter.x, y }, enter]
  } else if (horizontal(fromSide)) {
    mid = [leave, { x: enter.x, y: leave.y }, enter]
  } else {
    mid = [leave, { x: leave.x, y: enter.y }, enter]
  }
  return dedupe([start, ...mid, end])
}

const routeCache = new WeakMap<DiagramEdge, { from: DiagramNode; to: DiagramNode; points: DiagramPoint[] }>()

/**
 * `edgeRoute`, remembered per line. Docs share unchanged nodes and lines between edits,
 * so a drag only reroutes the lines touching what moved.
 */
export function edgePoints(from: DiagramNode, to: DiagramNode, edge: DiagramEdge): DiagramPoint[] {
  const hit = routeCache.get(edge)
  if (hit && hit.from === from && hit.to === to) return hit.points
  const points = edgeRoute(from, to, edge)
  routeCache.set(edge, { from, to, points })
  return points
}

/** Move one segment of an orthogonal route and keep both anchors fixed. */
export function slideSegment(points: DiagramPoint[], index: number, value: number): DiagramPoint[] {
  if (index < 0 || index >= points.length - 1 || points.length < 2) return points
  const start = points[index]
  const end = points[index + 1]
  const horizontal = Math.abs(end.x - start.x) >= Math.abs(end.y - start.y)
  const shift = (point: DiagramPoint): DiagramPoint => (horizontal ? { x: point.x, y: value } : { x: value, y: point.y })
  const next = points.map((point) => ({ ...point }))
  next[index] = shift(next[index])
  next[index + 1] = shift(next[index + 1])
  if (index === 0) {
    next[0] = { ...points[0] }
    next.splice(1, 0, shift(points[0]))
  }
  const last = next.length - 1
  const endIndex = index === 0 ? index + 2 : index + 1
  if (endIndex === last) {
    next[last] = { ...points[points.length - 1] }
    next.splice(last, 0, shift(points[points.length - 1]))
  }
  return dedupe(next)
}

export function routePath(points: DiagramPoint[], rounded: boolean): string {
  if (points.length < 2) return ''
  if (!rounded || points.length < 3) {
    return points.map((point, index) => `${index ? 'L' : 'M'}${point.x} ${point.y}`).join(' ')
  }
  const radius = 8
  let path = `M${points[0].x} ${points[0].y}`
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1]
    const current = points[i]
    const next = points[i + 1]
    const inX = current.x - prev.x
    const inY = current.y - prev.y
    const outX = next.x - current.x
    const outY = next.y - current.y
    const inLen = Math.hypot(inX, inY) || 1
    const outLen = Math.hypot(outX, outY) || 1
    const rad = Math.min(radius, inLen / 2, outLen / 2)
    const enter = { x: current.x - (inX / inLen) * rad, y: current.y - (inY / inLen) * rad }
    const leave = { x: current.x + (outX / outLen) * rad, y: current.y + (outY / outLen) * rad }
    path += ` L${enter.x} ${enter.y} Q${current.x} ${current.y} ${leave.x} ${leave.y}`
  }
  const last = points[points.length - 1]
  return `${path} L${last.x} ${last.y}`
}

/** Point halfway along a route, measured by segment length. */
export function routeMidpoint(points: DiagramPoint[]): DiagramPoint {
  return routePointAt(points, 0.5)
}

/** Point at fraction `t` of the route length. */
export function routePointAt(points: DiagramPoint[], t: number): DiagramPoint {
  if (!points.length) return { x: 0, y: 0 }
  if (points.length === 1) return points[0]
  const lengths = points.slice(1).map((point, i) => Math.hypot(point.x - points[i].x, point.y - points[i].y))
  const total = lengths.reduce((sum, length) => sum + length, 0)
  if (total === 0) return points[0]
  let walk = Math.max(0, Math.min(1, t)) * total
  for (let i = 0; i < lengths.length; i++) {
    const length = lengths[i]
    if (walk <= length || i === lengths.length - 1) {
      const k = length === 0 ? 0 : Math.min(1, walk / length)
      return { x: points[i].x + (points[i + 1].x - points[i].x) * k, y: points[i].y + (points[i + 1].y - points[i].y) * k }
    }
    walk -= length
  }
  return points[points.length - 1]
}

/** Fraction of the route length closest to the point (inverse of `routePointAt`). */
export function routeFractionAt(points: DiagramPoint[], point: DiagramPoint): number {
  let total = 0
  let best = 0
  let bestDist = Infinity
  const lengths: number[] = []
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    const length = Math.hypot(b.x - a.x, b.y - a.y)
    const k = length ? Math.max(0, Math.min(1, ((point.x - a.x) * (b.x - a.x) + (point.y - a.y) * (b.y - a.y)) / (length * length))) : 0
    const d = Math.hypot(point.x - (a.x + (b.x - a.x) * k), point.y - (a.y + (b.y - a.y) * k))
    if (d < bestDist) {
      bestDist = d
      best = total + length * k
    }
    lengths.push(length)
    total += length
  }
  return total ? best / total : 0.5
}

/** New bend on segment `index` of the route (0 is the segment leaving the source). */
export function insertBend(bends: readonly DiagramPoint[] | undefined, index: number, point: DiagramPoint): DiagramPoint[] {
  const list = [...(bends ?? [])]
  list.splice(Math.max(0, Math.min(index, list.length)), 0, point)
  return list
}

/** Bends that sit on the straight line between their neighbors add nothing, so they go (draw.io straightRemove). */
export function dropStraightBends(start: DiagramPoint, bends: readonly DiagramPoint[], end: DiagramPoint, tolerance = 2): DiagramPoint[] {
  const kept: DiagramPoint[] = []
  for (let i = 0; i < bends.length; i++) {
    const prev = kept[kept.length - 1] ?? start
    const next = bends[i + 1] ?? end
    if (distanceToSegment(bends[i], prev, next) > tolerance) kept.push(bends[i])
  }
  return kept
}
