import { describe, expect, it } from 'vitest'
import {
  createComponentFromFrame,
  designAxisAligned,
  designChildIds,
  designDistances,
  designParentIds,
  designSnapScene,
  designCanvasBox,
  designTurnSign,
  emptyDesign,
  hitDesignDeepest,
  layoutDesign,
  makeInstance,
  moveDesignNodes,
  nodeCanvasPoint,
  nodeCenter,
  parseDesign,
  resizeDesignNode,
  resolveInstanceTree,
  sameDesign,
  serializeDesign,
  stepDesignSibling,
  syncLinkedComponents,
  type DesignDoc,
  type DesignHandle,
  type DesignNode,
} from './index'

const HANDLES: DesignHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

function docOf(...screens: DesignNode[]): DesignDoc {
  return { ...emptyDesign(), screens }
}

function rect(id: string, extra: Partial<DesignNode> = {}): DesignNode {
  return { id, kind: 'rect', x: 100, y: 100, w: 120, h: 60, ...extra }
}

/** The handle's opposite point in the node's own box. */
function opposite(handle: DesignHandle, w: number, h: number): { x: number; y: number } {
  return {
    x: handle.includes('w') ? w : handle.includes('e') ? 0 : w / 2,
    y: handle.includes('n') ? h : handle.includes('s') ? 0 : h / 2,
  }
}

function canvasPoint(node: DesignNode, x: number, y: number) {
  const point = nodeCanvasPoint(docOf(node), node.id, x, y)
  if (!point) throw new Error('missing node')
  return point
}

describe('resizeDesignNode', () => {
  for (const rotation of [0, 37, 90, 180]) {
    for (const handle of HANDLES) {
      it(`keeps the opposite handle fixed at ${rotation}° from ${handle}`, () => {
        const node = rect('r', rotation ? { rotation } : {})
        const before = opposite(handle, node.w, node.h)
        const pinned = canvasPoint(node, before.x, before.y)
        const resized = resizeDesignNode(node, handle, 30, 20, 1, false)
        const after = opposite(handle, resized.w, resized.h)
        const moved = canvasPoint(resized, after.x, after.y)
        expect(moved.x).toBeCloseTo(pinned.x, 6)
        expect(moved.y).toBeCloseTo(pinned.y, 6)
      })
    }
  }

  it('grows along the node axes, not the parent axes', () => {
    const node = rect('r', { rotation: 90 })
    const resized = resizeDesignNode(node, 'e', 50, 0, 1, false)
    expect(resized.w).toBe(170)
    expect(resized.h).toBe(60)
  })

  it('grows both sides around the center with the center option', () => {
    const node = rect('r', { rotation: 37 })
    const centerBefore = canvasPoint(node, node.w / 2, node.h / 2)
    const resized = resizeDesignNode(node, 'se', 10, 10, 1, false, false, { center: true })
    expect(resized.w).toBe(140)
    expect(resized.h).toBe(80)
    const centerAfter = canvasPoint(resized, resized.w / 2, resized.h / 2)
    expect(centerAfter.x).toBeCloseTo(centerBefore.x, 6)
    expect(centerAfter.y).toBeCloseTo(centerBefore.y, 6)
  })

  it('flips when dragged past the opposite edge', () => {
    const node = rect('r', { w: 100 })
    const resized = resizeDesignNode(node, 'e', -150, 0, 1, false)
    expect(resized.flipX).toBe(true)
    expect(resized.w).toBe(50)
    expect(designCanvasBox(docOf(resized), 'r')).toEqual({ x: 50, y: 100, w: 50, h: 60 })
  })

  it('locks the ratio from an edge handle around the cross-axis center', () => {
    const node = rect('r', { w: 100, h: 50 })
    const resized = resizeDesignNode(node, 'e', 100, 0, 1, false, true)
    expect(resized.w).toBe(200)
    expect(resized.h).toBe(100)
    expect(resized.y).toBe(75)
  })

  it('snaps the moving edge to the grid unless the axis was object-snapped', () => {
    const node = rect('r', { x: 0, y: 0, w: 100, h: 40 })
    expect(resizeDesignNode(node, 'e', 13, 0, 8, true).w).toBe(112)
    expect(resizeDesignNode(node, 'e', 13, 0, 8, true, false, { gridX: false }).w).toBe(113)
    expect(resizeDesignNode(node, 'w', 13, 0, 8, true).x).toBe(16)
  })
})

describe('transform helpers', () => {
  it('finds the canvas center of a rotated node in a rotated parent', () => {
    const child = rect('c', { x: 0, y: 0, w: 40, h: 20, rotation: 45 })
    const parent: DesignNode = { id: 'p', kind: 'frame', x: 0, y: 0, w: 200, h: 100, rotation: 90, children: [child] }
    const doc = docOf(parent)
    // The parent turns its content around (100, 50); the child's own turn keeps its center put.
    const center = nodeCenter(doc, 'c')
    expect(center?.x).toBeCloseTo(140, 6)
    expect(center?.y).toBeCloseTo(-30, 6)
    expect(designAxisAligned(doc, 'c')).toBe(false)
    expect(designAxisAligned(docOf(rect('r')), 'r')).toBe(true)
  })

  it('reverses the turn direction under a flipped ancestor', () => {
    const child = rect('c', { x: 0, y: 0 })
    expect(designTurnSign(docOf({ id: 'p', kind: 'frame', x: 0, y: 0, w: 300, h: 300, flipX: true, children: [child] }), 'c')).toBe(-1)
    expect(designTurnSign(docOf({ id: 'p', kind: 'frame', x: 0, y: 0, w: 300, h: 300, flipX: true, flipY: true, children: [child] }), 'c')).toBe(1)
    expect(designTurnSign(docOf({ ...rect('r'), flipX: true }), 'r')).toBe(1)
  })
})

describe('instances', () => {
  function buttonDoc(): DesignDoc {
    const button: DesignNode = {
      id: 'b', kind: 'frame', x: 0, y: 0, w: 120, h: 40, layout: 'row', justify: 'center', align: 'center',
      children: [{ id: 'label', kind: 'text', x: 0, y: 0, w: 60, h: 20, text: 'OK' }],
    }
    const doc = createComponentFromFrame(docOf(button), 'b', 'cmp', () => 'x')
    if (!doc) throw new Error('component')
    return doc
  }

  it('re-lays out a resized instance instead of capping or scaling it', () => {
    const doc = buttonDoc()
    const instance = makeInstance(doc, 'cmp', 'i', 0, 0)
    if (!instance) throw new Error('instance')
    const wide = resolveInstanceTree(doc, { ...instance, w: 300, wMode: 'fixed' })
    expect(wide?.w).toBe(300)
    expect(wide?.children?.[0]).toMatchObject({ x: 120, w: 60 })
    const placed = layoutDesign({ ...doc, screens: [...doc.screens, { ...instance, w: 300, wMode: 'fixed' }] })
    expect(placed.screens.at(-1)?.w).toBe(300)
  })

  it('reads the old size pin as hug so old files keep following the component', () => {
    const doc = buttonDoc()
    const pinned: DesignNode = { id: 'old', kind: 'instance', x: 0, y: 0, w: 120, h: 40, wMode: 'fixed', hMode: 'fixed', maxW: 120, maxH: 40, component: 'cmp' }
    const parsed = parseDesign(serializeDesign({ ...doc, screens: [pinned] })).doc.screens[0]
    expect(parsed).toMatchObject({ wMode: 'hug', hMode: 'hug' })
    expect(parsed.maxW).toBeUndefined()
  })
})

describe('smoothness helpers', () => {
  it('compares documents by content, reusing shared parts', () => {
    const doc = docOf(rect('a'), rect('b'))
    expect(sameDesign(doc, { ...doc, screens: [...doc.screens] })).toBe(true)
    expect(sameDesign(doc, { ...doc, screens: [rect('a'), { ...rect('b'), x: 1 }] })).toBe(false)
    expect(sameDesign(doc, { ...doc, grid: 4 })).toBe(false)
  })

  it('snaps only to root screens, its own screen, unclipped shapes and the viewport', () => {
    const hidden = rect('hidden', { x: 500, y: 0, w: 20, h: 20 })
    const home: DesignNode = { id: 'home', kind: 'frame', x: 0, y: 0, w: 200, h: 200, children: [rect('mover', { x: 10, y: 10, w: 20, h: 20 }), rect('peer', { x: 100, y: 100, w: 20, h: 20 }), hidden] }
    const away: DesignNode = { id: 'away', kind: 'frame', x: 400, y: 0, w: 200, h: 200, children: [rect('inner', { x: 10, y: 10, w: 20, h: 20 })] }
    const far = rect('far', { x: 5000, y: 5000, w: 10, h: 10 })
    const doc = docOf(home, away, far)
    const scene = designSnapScene(doc, ['mover'], { x: -50, y: -50, w: 800, h: 400 })
    const xs = scene?.targets.map((box) => box.x).sort((a, b) => a - b)
    // home, peer, away; not inner (another screen), hidden (clipped out) or far (off screen).
    expect(xs).toEqual([0, 100, 400])
  })

  it('leaves linked components alone when their screen did not change', () => {
    const doc = createComponentFromFrame(docOf({ id: 'b', kind: 'frame', x: 0, y: 0, w: 80, h: 40 }), 'b', 'cmp', () => 'x')
    if (!doc) throw new Error('component')
    const synced = syncLinkedComponents(doc)
    expect(syncLinkedComponents(synced).components).toBe(synced.components)
  })

  it('caches a resolved instance until its node or component changes', () => {
    const doc = createComponentFromFrame(docOf({ id: 'b', kind: 'frame', x: 0, y: 0, w: 80, h: 40 }), 'b', 'cmp', () => 'x')
    const instance = doc && makeInstance(doc, 'cmp', 'i', 0, 0)
    if (!doc || !instance) throw new Error('instance')
    expect(resolveInstanceTree(doc, instance)).toBe(resolveInstanceTree({ ...doc, screens: [] }, instance))
    expect(resolveInstanceTree(doc, { ...instance })).not.toBe(resolveInstanceTree(doc, instance))
  })
})

describe('selection navigation', () => {
  const group: DesignNode = { id: 'g', kind: 'group', x: 0, y: 0, w: 100, h: 100, children: [rect('a', { x: 0, y: 0, w: 50, h: 50 }), rect('b', { x: 50, y: 50, w: 50, h: 50 })] }
  const screen: DesignNode = { id: 's', kind: 'frame', x: 0, y: 0, w: 300, h: 300, children: [group, rect('c', { x: 200, y: 200, w: 50, h: 50 }), rect('d', { x: 0, y: 200, w: 50, h: 50 })] }
  const doc = docOf(screen)

  it('reaches through groups on a deep click', () => {
    expect(hitDesignDeepest(doc, 60, 60)?.id).toBe('b')
    expect(hitDesignDeepest(doc, 290, 10)?.id).toBe('s')
  })

  it('steps through siblings down the layers list and wraps', () => {
    expect(stepDesignSibling(doc, 'd', 1)).toBe('c')
    expect(stepDesignSibling(doc, 'g', 1)).toBe('d')
    expect(stepDesignSibling(doc, 'g', -1)).toBe('c')
  })

  it('selects children and parents', () => {
    expect(designChildIds(doc, ['g'])).toEqual(['a', 'b'])
    expect(designChildIds(doc, ['c'])).toEqual(['c'])
    expect(designParentIds(doc, ['a', 'b'])).toEqual(['g'])
    expect(designParentIds(doc, ['s'])).toEqual(['s'])
  })

  it('moves several layers next to a row in the order the panel lists them', () => {
    const ids = (d: DesignDoc) => d.screens[0].children?.map((child) => child.id)
    // Panel order is front to back: d, c, g. Dropping [d, c] above g puts them in front, d frontmost.
    expect(ids(moveDesignNodes(doc, ['d', 'c'], 's', 'g', 'before'))).toEqual(['g', 'c', 'd'])
    // Below g sends them behind it, keeping d above c.
    expect(ids(moveDesignNodes(doc, ['d', 'c'], 's', 'g', 'after'))).toEqual(['c', 'd', 'g'])
  })

  it('measures from a box to the edges of the box around it', () => {
    const inner = { x: 10, y: 20, w: 30, h: 40 }
    const outer = { x: 0, y: 0, w: 100, h: 100 }
    expect(designDistances(inner, outer).map((gap) => gap.label)).toEqual(['10', '60', '20', '40'])
  })
})
