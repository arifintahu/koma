import { describe, expect, it } from 'vitest'
import {
  arrowTarget,
  connectInDirection,
  connectionEnd,
  copyDiagramShapes,
  diagramGuides,
  dropStraightBends,
  edgeRoute,
  insertBend,
  nodeCenter,
  pointInNode,
  portAnchor,
  portOffset,
  resizeNode,
  rotatePoint,
  routeFractionAt,
  routePointAt,
  deleteDiagramSelection,
  emptyDiagram,
  hitDiagram,
  mergeSelection,
  moveDiagramNodes,
  selectInRect,
  selectionDoc,
  type DiagramDoc,
  type DiagramNode,
} from './diagram'
import { diagramToMermaid, parseMermaidDiagram } from './diagramMermaid'
import { SHAPE_KINDS } from './diagramShapes'

const box = (id: string, x: number, y: number, extra: Partial<DiagramNode> = {}): DiagramNode => ({
  id,
  kind: 'rect',
  x,
  y,
  w: 100,
  h: 50,
  text: id,
  ...extra,
})

function threeInARow(): DiagramDoc {
  return {
    ...emptyDiagram(),
    nodes: [box('a', 0, 0), box('b', 200, 0), box('c', 400, 0)],
    edges: [
      { id: 'ab', from: 'a', to: 'b', bends: [{ x: 150, y: 25 }] },
      { id: 'bc', from: 'b', to: 'c' },
    ],
  }
}

describe('diagram selection', () => {
  it('marquee picks shapes fully inside and lines between them', () => {
    const doc = threeInARow()
    expect(selectInRect(doc, { x: -10, y: -10, w: 320, h: 80 })).toEqual({ nodes: ['a', 'b'], edges: ['ab'] })
    // Touching c without containing it leaves c and its line out.
    expect(selectInRect(doc, { x: -10, y: -10, w: 450, h: 80 }).nodes).toEqual(['a', 'b'])
  })

  it('shift toggles items out of a selection', () => {
    expect(mergeSelection({ nodes: ['a', 'b'], edges: [] }, { nodes: ['b', 'c'], edges: [] }, true)).toEqual({ nodes: ['a', 'c'], edges: [] })
    expect(mergeSelection({ nodes: ['a'], edges: [] }, { nodes: ['a', 'c'], edges: [] }, false).nodes).toEqual(['a', 'c'])
  })

  it('a selected line brings its ends into the chat copy', () => {
    const picked = selectionDoc(threeInARow(), { nodes: [], edges: ['bc'] })
    expect(picked.nodes.map((node) => node.id)).toEqual(['b', 'c'])
    expect(picked.edges.map((edge) => edge.id)).toEqual(['bc'])
  })
})

describe('diagram edits', () => {
  it('copies keep the lines between copied shapes with new ids', () => {
    let n = 0
    const copy = copyDiagramShapes(threeInARow(), { nodes: ['a', 'b'], edges: [] }, (prefix) => `${prefix}${++n}`, 16, 16)
    expect(copy.nodes.map((node) => [node.id, node.x, node.y])).toEqual([
      ['n1', 16, 16],
      ['n2', 216, 16],
    ])
    expect(copy.edges).toHaveLength(1)
    expect(copy.edges[0]).toMatchObject({ id: 'e3', from: 'n1', to: 'n2', bends: [{ x: 166, y: 41 }] })
  })

  it('moving both ends shifts the bends; moving one end leaves them', () => {
    const both = moveDiagramNodes(threeInARow(), ['a', 'b'], 10, 5)
    expect(both.edges[0].bends).toEqual([{ x: 160, y: 30 }])
    const one = moveDiagramNodes(threeInARow(), ['a'], 10, 5)
    expect(one.edges[0].bends).toEqual([{ x: 150, y: 25 }])
    expect(moveDiagramNodes(one, ['a'], 0, 0)).toBe(one)
  })

  it('deleting a shape drops the lines it held', () => {
    const next = deleteDiagramSelection(threeInARow(), { nodes: ['b'], edges: [] })
    expect(next.nodes.map((node) => node.id)).toEqual(['a', 'c'])
    expect(next.edges).toEqual([])
  })

  it('hits the top shape first, then a line within tolerance', () => {
    const doc = threeInARow()
    expect(hitDiagram(doc, { x: 50, y: 25 }, 6)).toEqual({ type: 'node', id: 'a' })
    expect(hitDiagram(doc, { x: 350, y: 27 }, 6)).toEqual({ type: 'edge', id: 'bc' })
    expect(hitDiagram(doc, { x: 350, y: 60 }, 6)).toBeNull()
  })
})

describe('diagram controls', () => {
  it('guides pull a nearby edge onto another shape and report the line', () => {
    const result = diagramGuides([{ x: 0, y: 0, w: 100, h: 50 }], { x: 103, y: 200, w: 60, h: 40 }, 4)
    expect(result.dx).toBe(-3)
    expect(result.dy).toBe(0)
    expect(result.guides).toEqual([{ axis: 'x', at: 100, from: 0, to: 240 }])
    expect(diagramGuides([{ x: 0, y: 0, w: 100, h: 50 }], { x: 110, y: 200, w: 60, h: 40 }, 4).dx).toBe(0)
  })

  it('resize keeps the ratio with Shift and the center with Alt', () => {
    const node = box('a', 0, 0)
    const locked = resizeNode(node, 'se', 50, 0, 16, false, { lock: true })
    expect([locked.w, locked.h]).toEqual([150, 75])
    const centered = resizeNode(node, 'e', 10, 0, 16, false, { center: true })
    expect([centered.x, centered.w]).toEqual([-10, 120])
  })

  it('resizing a rotated shape keeps the opposite corner in place', () => {
    const node = box('a', 0, 0, { rotation: 30 })
    const corner = (n: DiagramNode) => rotatePoint({ x: n.x, y: n.y }, nodeCenter(n), 30)
    const resized = resizeNode(node, 'se', 20, 35, 16, true)
    expect(resized.w).not.toBe(100)
    expect(corner(resized).x).toBeCloseTo(corner(node).x)
    expect(corner(resized).y).toBeCloseTo(corner(node).y)
  })

  it('a hover arrow adds a blank copy one edge length away and connects it', () => {
    let n = 0
    const doc: DiagramDoc = { ...emptyDiagram(), nodes: [box('a', 0, 0, { fillColor: '#112233' })] }
    const result = connectInDirection(doc, 'a', 'e', (prefix) => `${prefix}${++n}`)
    expect(result).not.toBeNull()
    const added = result!.doc.nodes.find((node) => node.id === result!.nodeId)
    expect(added).toMatchObject({ x: 180, y: 0, w: 100, h: 50, text: '', fillColor: '#112233' })
    expect(result!.doc.edges).toEqual([{ id: 'e1', from: 'a', to: result!.nodeId }])
  })

  it('a hover arrow connects to a shape already sitting there', () => {
    const doc: DiagramDoc = { ...emptyDiagram(), nodes: [box('a', 0, 0), box('b', 170, 10)] }
    expect(arrowTarget(doc, 'a', 'e')?.id).toBe('b')
    expect(arrowTarget(doc, 'a', 's')).toBeNull()
    const result = connectInDirection(doc, 'a', 'e', (prefix) => `${prefix}1`)
    expect(result?.doc.nodes).toHaveLength(2)
    expect(result?.nodeId).toBe('b')
  })

  it('a drop near a port pins it; on the body the end floats', () => {
    const node = box('a', 0, 0)
    const port = portAnchor(node, 6)
    expect(connectionEnd(node, { x: port.x - 3, y: port.y + 2 }, 10)).toEqual({ port: 6 })
    expect(connectionEnd(node, { x: 50, y: 25 }, 10)).toEqual({})
  })

  it('bends insert per segment and straight ones drop away', () => {
    expect(insertBend([{ x: 1, y: 1 }], 1, { x: 2, y: 2 })).toEqual([{ x: 1, y: 1 }, { x: 2, y: 2 }])
    // 25,25 and 75,25 lie on the lines to their neighbors; only the peak is a real bend.
    expect(dropStraightBends({ x: 0, y: 0 }, [{ x: 25, y: 25 }, { x: 50, y: 50 }, { x: 75, y: 25 }], { x: 100, y: 0 })).toEqual([{ x: 50, y: 50 }])
    const doc = threeInARow()
    const straight = edgeRoute(doc.nodes[0], doc.nodes[1], { id: 'x', from: 'a', to: 'b', route: 'straight', bends: [{ x: 150, y: 80 }] })
    expect(straight).toHaveLength(3)
    expect(straight[1]).toEqual({ x: 150, y: 80 })
  })

  it('a label fraction maps to a point and back', () => {
    const points = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }]
    expect(routePointAt(points, 0.75)).toEqual({ x: 100, y: 50 })
    expect(routeFractionAt(points, { x: 104, y: 50 })).toBeCloseTo(0.75)
  })
})

describe('diagram shapes', () => {
  it('ports sit on each outline, not on the box', () => {
    const hexagon = box('h', 0, 0, { kind: 'hexagon', w: 160, h: 72 })
    // Port 0 aims at the top-left corner; the hexagon's slanted side pulls it inward.
    const corner = portOffset(hexagon, 0)
    expect(corner.x).toBeGreaterThan(0.05)
    expect(corner.y).toBeGreaterThan(0.05)
    // Side middles of a hexagon are its left and right points.
    expect(portOffset(hexagon, 14)).toEqual({ x: 0, y: 0.5 })
    const cylinder = box('c', 0, 0, { kind: 'cylinder', w: 80, h: 96 })
    expect(portOffset(cylinder, 2).y).toBeLessThan(0.02)
    expect(portOffset(box('r', 0, 0), 0)).toEqual({ x: 0, y: 0 })
  })

  it('a triangle hits inside its outline only', () => {
    const triangle = box('t', 0, 0, { kind: 'triangle', w: 100, h: 80 })
    expect(pointInNode(triangle, { x: 50, y: 60 })).toBe(true)
    expect(pointInNode(triangle, { x: 5, y: 5 })).toBe(false)
  })

  it('every kind survives a trip through Mermaid', () => {
    const doc: DiagramDoc = {
      ...emptyDiagram(),
      nodes: SHAPE_KINDS.map((kind, i) => box(`n${i}`, 0, i * 100, { kind, text: `${kind} "label"` })),
      edges: [],
    }
    const parsed = parseMermaidDiagram(diagramToMermaid(doc, 'kinds')).doc
    expect(parsed.nodes.map((node) => [node.id, node.kind, node.text])).toEqual(doc.nodes.map((node) => [node.id, node.kind, node.text]))
  })

  it('reads the shapes models usually write', () => {
    const parsed = parseMermaidDiagram('```mermaid\nflowchart TD\n  a([Start])\n  b[(Users)]\n  c@{ shape: doc, label: "Spec" }\n  a --> b\n```').doc
    expect(parsed.nodes.map((node) => [node.kind, node.text])).toEqual([
      ['stadium', 'Start'],
      ['cylinder', 'Users'],
      ['document', 'Spec'],
    ])
  })
})
