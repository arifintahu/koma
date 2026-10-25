import { describe, expect, it } from 'vitest'
import {
  copyDiagramShapes,
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
