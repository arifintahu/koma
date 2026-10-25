import { describe, expect, it } from 'vitest'
import {
  arrowHead,
  arrowTarget,
  entityRoute,
  ER_LINE,
  parseDiagram,
  routeCrossings,
  routePath,
  rowAnchor,
  rowCenterY,
  serializeDiagram,
  TABLE_HEADER,
  TABLE_ROW,
  tableHeight,
  tableRowAt,
  updateTableRows,
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
import { diagramToMermaid, parseMermaidDiagram, splitDiagramMessage } from './diagramMermaid'
import { parseSqlTables, sqlToDiagram } from './diagramSql'
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

describe('diagram lines', () => {
  it('entity relation lines leave sideways toward the other shape', () => {
    const left = box('a', 0, 0)
    const right = box('b', 300, 100)
    const route = entityRoute(left, right)
    expect(route[0]).toEqual({ x: 100, y: 25 })
    expect(route[1]).toEqual({ x: 130, y: 25 })
    expect(route[route.length - 1]).toEqual({ x: 300, y: 125 })
    expect(route[route.length - 2]).toEqual({ x: 270, y: 125 })
    // Stacked shapes: both ends leave on the same side and loop around.
    const below = box('c', 20, 200)
    const loop = entityRoute(left, below)
    expect(loop.map((point) => point.x)).toEqual([100, 150, 150, 120])
  })

  it('jumps hop only real crossings', () => {
    const across = [{ x: 0, y: 50 }, { x: 200, y: 50 }]
    const under = [[{ x: 100, y: 0 }, { x: 100, y: 100 }], [{ x: 0, y: 50 }, { x: 0, y: 90 }]]
    expect(routeCrossings(across, under)).toEqual([[{ x: 100, y: 50 }]])
    const arc = routePath(across, false, { jumps: { style: 'arc', size: 6, crossings: [[{ x: 100, y: 50 }]] } })
    expect(arc).toContain('A6 6 0 0 1 106 50')
    const gap = routePath(across, false, { jumps: { style: 'gap', size: 6, crossings: [[{ x: 100, y: 50 }]] } })
    expect(gap).toContain('M106 50')
  })

  it('curved lines are one smooth path through the route', () => {
    const d = routePath([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 200, y: 100 }], false, { curved: true })
    expect(d.match(/Q/g)).toHaveLength(2)
    expect(d).not.toContain('L')
  })

  it('tables survive a save', () => {
    const rows = [
      { id: 'r1', name: 'id', type: 'int', key: 'pk' as const },
      { id: 'r2', name: 'org_id', type: 'int', key: 'fk' as const },
    ]
    const doc: DiagramDoc = {
      ...emptyDiagram(),
      nodes: [box('users', 16, 32, { kind: 'table', text: 'users', w: 220, h: tableHeight(rows), rows })],
      edges: [{ id: 'e', from: 'users', to: 'users', fromRow: 'r1', toRow: 'r2', ...ER_LINE }],
    }
    expect(parseDiagram(serializeDiagram(doc)).doc).toEqual(doc)
  })

  it('new line options survive a save', () => {
    const doc: DiagramDoc = {
      ...threeInARow(),
      edges: [{ id: 'x', from: 'a', to: 'b', route: 'entity', jump: 'arc', start: 'erMandOne', end: 'erZeroToMany', labelAt: 0.3 }],
    }
    expect(parseDiagram(serializeDiagram(doc)).doc.edges).toEqual(doc.edges)
    const start = arrowHead('start', 'erZeroToMany')
    expect(start?.knockout).toBe(true)
    expect(start?.circle?.cx).toBe(8.5)
  })
})

const SCHEMA = `
  CREATE TABLE orgs (
    id int PRIMARY KEY,
    name text NOT NULL
  );
  CREATE TABLE users (
    id int,
    org_id int REFERENCES orgs (id),
    PRIMARY KEY (id),
    CONSTRAINT fk_org FOREIGN KEY (org_id) REFERENCES orgs (id)
  );
`

describe('diagram tables', () => {
  it('reads inline and table-level keys and foreign keys', () => {
    const parsed = parseSqlTables(SCHEMA)
    const orgs = parsed.tables[0]
    const users = parsed.tables[1]
    expect(parsed.tables.map((table) => table.name)).toEqual(['orgs', 'users'])
    expect(orgs?.columns[0]).toMatchObject({ name: 'id', type: 'int', pk: true, fk: false })
    expect(orgs?.columns[1]).toMatchObject({ name: 'name', type: 'text', pk: false })
    expect(users?.columns.find((column) => column.name === 'id')).toMatchObject({ pk: true, fk: false })
    expect(users?.columns.find((column) => column.name === 'org_id')).toMatchObject({ type: 'int', fk: true })
    expect(parsed.relations).toEqual([
      { table: 'users', column: 'org_id', refTable: 'orgs', refColumn: 'id' },
      { table: 'users', column: 'org_id', refTable: 'orgs', refColumn: 'id' },
    ])
  })

  it('draws one ER line from the parent row to the child row', () => {
    let n = 0
    const built = sqlToDiagram(
      parseSqlTables('CREATE TABLE orgs (id int PRIMARY KEY); CREATE TABLE users (org_id int REFERENCES orgs(id));'),
      { x: 0, y: 0 },
      (prefix) => `${prefix}${++n}`,
    )
    const orgs = built.nodes.find((node) => node.text === 'orgs')
    const users = built.nodes.find((node) => node.text === 'users')
    expect(built.edges).toEqual([
      {
        id: 'e3',
        from: orgs?.id,
        to: users?.id,
        fromRow: orgs?.rows?.find((row) => row.name === 'id')?.id,
        toRow: users?.rows?.find((row) => row.name === 'org_id')?.id,
        ...ER_LINE,
      },
    ])
  })

  it('anchors a line on the row and drops the anchor when the row goes away', () => {
    const rows = [
      { id: 'r1', name: 'id', key: 'pk' as const },
      { id: 'r2', name: 'org_id', key: 'fk' as const },
    ]
    const table = box('t', 0, 0, { kind: 'table', w: 200, h: tableHeight(rows), rows })
    expect(rowCenterY(table, 'r2')).toBe(TABLE_HEADER + TABLE_ROW + TABLE_ROW / 2)
    expect(tableRowAt(table, { x: 10, y: 10 })).toBe(-1)
    expect(tableRowAt(table, { x: 10, y: TABLE_HEADER + 4 })).toBe(0)
    expect(rowAnchor(table, 'r1', { x: -20, y: 0 })).toEqual({ x: 0, y: TABLE_HEADER + TABLE_ROW / 2 })
    expect(rowAnchor(table, 'r1', { x: 500, y: 0 })?.x).toBe(200)
    const doc: DiagramDoc = {
      ...emptyDiagram(),
      nodes: [table, box('o', 400, 0)],
      edges: [{ id: 'e', from: 't', to: 'o', fromRow: 'r2' }],
    }
    expect(updateTableRows(doc, 't', [rows[0]]).edges[0]?.fromRow).toBeUndefined()
  })

  it('round-trips an ER diagram and leaves a table alone when the flowchart repeats it', () => {
    const orgsRows = [{ id: 'r1', name: 'id', type: 'int', key: 'pk' as const }]
    const userRows = [{ id: 'r1', name: 'org_id', type: 'int', key: 'fk' as const }]
    const doc: DiagramDoc = {
      ...emptyDiagram(),
      nodes: [
        box('orgs', 0, 0, { kind: 'table', text: 'orgs', w: 220, h: tableHeight(orgsRows), rows: orgsRows }),
        box('users', 300, 0, { kind: 'table', text: 'users', w: 220, h: tableHeight(userRows), rows: userRows }),
        box('note', 300, 200, { kind: 'text', text: 'see schema' }),
      ],
      edges: [{ id: 'e', from: 'orgs', to: 'users', ...ER_LINE, text: 'has' }],
    }
    const mermaid = diagramToMermaid(doc, 'schema')
    expect(mermaid).toContain('erDiagram')
    expect(mermaid).toContain('int id PK')
    expect(mermaid).toContain('int org_id FK')
    expect(mermaid).toContain('||--o{')
    expect(mermaid).toContain('flowchart TD')
    expect(splitDiagramMessage(mermaid).diagrams).toHaveLength(2)
    const parsed = parseMermaidDiagram(mermaid).doc
    const orgs = parsed.nodes.find((node) => node.text === 'orgs')
    const users = parsed.nodes.find((node) => node.text === 'users')
    expect(orgs?.kind).toBe('table')
    expect(orgs?.rows?.[0]).toMatchObject({ name: 'id', type: 'int', key: 'pk' })
    expect(users?.rows?.[0]).toMatchObject({ name: 'org_id', type: 'int', key: 'fk' })
    expect(parsed.nodes.filter((node) => node.kind === 'table')).toHaveLength(2)
    expect(parsed.edges.find((edge) => edge.from === orgs?.id && edge.to === users?.id)).toMatchObject({
      route: 'entity',
      start: 'erMandOne',
      end: 'erZeroToMany',
      text: 'has',
    })
    expect(parsed.nodes.find((node) => node.kind === 'text')?.text).toBe('see schema')
    const repeated = parseMermaidDiagram('```mermaid\nerDiagram\n  orgs {\n    int id PK\n  }\n```\n```mermaid\nflowchart TD\n  orgs["Nope"]\n```').doc
    expect(repeated.nodes.filter((node) => node.id === 'orgs')).toHaveLength(1)
    expect(repeated.nodes[0]).toMatchObject({ kind: 'table', text: 'orgs' })
  })

  it('copies keep row ids so lines between tables stay attached', () => {
    const rows = [{ id: 'r1', name: 'id', key: 'pk' as const }]
    const doc: DiagramDoc = {
      ...emptyDiagram(),
      nodes: [
        box('a', 0, 0, { kind: 'table', text: 'a', h: tableHeight(rows), rows }),
        box('b', 280, 0, { kind: 'table', text: 'b', h: tableHeight(rows), rows: rows.map((row) => ({ ...row })) }),
      ],
      edges: [{ id: 'e', from: 'a', to: 'b', fromRow: 'r1', toRow: 'r1', ...ER_LINE }],
    }
    let n = 0
    const copy = copyDiagramShapes(doc, { nodes: ['a', 'b'], edges: [] }, () => `c${++n}`, 16, 16)
    expect(copy.nodes.map((node) => node.rows?.map((row) => row.id))).toEqual([['r1'], ['r1']])
    expect(copy.edges[0]).toMatchObject({ fromRow: 'r1', toRow: 'r1' })
  })
})
