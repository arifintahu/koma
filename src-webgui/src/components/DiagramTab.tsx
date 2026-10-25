import { canvasPoint, pagePoint } from '../lib/uiScale'
import { useEffect, useId, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { Circle, Diamond, HandGrab, MousePointer2, PanelRightClose, PanelRightOpen, RotateCw, Shapes, Spline, Square, Type } from 'lucide-react'
import { useKoma, type Tab } from '../store/koma'
import { recordCodingHistory } from '../lib/coding-recovery'
import { fileKey } from '../store/coding'
import { isTerminalInputTarget } from '../lib/terminalInput'
import { isTabVisible } from '../store/editorGroups'
import { BrailleSpinner } from './BrailleSpinner'
import { showCodingHistory } from './CodingHistory'
import { EditorChrome } from './EditorChrome'
import { Toggle } from './panels/form'
import { DiagramRefMenuItems } from './DiagramVisual'
import { DiagramEdgeView, themeStroke } from './diagram/DiagramEdgeView'
import { DiagramNodeView } from './diagram/DiagramNodeView'
import { Properties, type DiagramPanelSelection } from './diagram/DiagramSettings'
import {
  DIAGRAM_DRAG_THRESHOLD,
  DIAGRAM_HIT_TOLERANCE,
  DIAGRAM_UNDO_CAP,
  DIAGRAM_ZOOM_PER_PIXEL,
  DIAGRAM_ZOOM_STEP,
  clampZoom,
  clearDiagramHistory,
  diagramHistory,
  savedDiagramView,
  saveDiagramView,
  zoomViewAt,
  type DiagramView,
} from './diagram/diagramShared'
import {
  addDiagramDocToChat,
  addDiagramSelectionToChat,
  copyDiagramMermaid,
  copyDiagramSelection,
  diagramChatTitle,
} from '../lib/diagramChat'
import { syncDiagramShapeNotes } from '../lib/diagramNoteAttach'
import { diagramFolder, publishDiagramShapeNotes } from '../lib/diagramNotes'
import {
  NO_SELECTION,
  SHAPE_MIME,
  copyDiagramShapes,
  defaultNodeSize,
  deleteDiagramSelection,
  edgePoints,
  DIAGRAM_PORTS,
  hitDiagram,
  mergeSelection,
  moveDiagramNodes,
  nearestPort,
  nearestSide,
  nextRotation,
  nodeAtPoint,
  nodeBounds,
  parseDiagram,
  pointerAngle,
  portAnchor,
  resizeNode,
  rotatePoint,
  nodeCenter,
  routeMidpoint,
  selectInRect,
  selectionBounds,
  selectionSize,
  serializeDiagram,
  sideAnchor,
  slideSegment,
  snap,
  type DiagramDoc,
  type DiagramEdge,
  type DiagramHandle,
  type DiagramKind,
  type DiagramNode,
  type DiagramPoint,
  type DiagramRect,
  type DiagramSelection,
} from '../lib/diagram'

type Tool = 'select' | 'pan' | 'connect' | DiagramKind
type Drag =
  | {
      kind: 'move'
      ids: string[]
      grab: DiagramNode
      base: DiagramDoc
      sx: number
      sy: number
      pointerId: number
      moved: boolean
      remembered: boolean
    }
  | { kind: 'resize'; id: string; handle: DiagramHandle; sx: number; sy: number; node: DiagramNode; remembered: boolean }
  | { kind: 'rotate'; id: string; rotation: number; angle: number; node: DiagramNode; remembered: boolean }
  | { kind: 'segment'; edgeId: string; index: number; points: DiagramPoint[]; remembered: boolean }
  | { kind: 'anchor'; edgeId: string; end: 'from' | 'to'; remembered: boolean }
  | { kind: 'connect'; fromId: string; port: number }
  | { kind: 'pan'; sx: number; sy: number; view: DiagramView }
  | { kind: 'marquee'; x: number; y: number; sx: number; sy: number; base: DiagramSelection; additive: boolean; moved: boolean }

const TOOLS: { id: Tool; label: string; icon: typeof Square }[] = [
  { id: 'select', label: 'Select', icon: MousePointer2 },
  { id: 'pan', label: 'Move canvas', icon: HandGrab },
  { id: 'rect', label: 'Rectangle', icon: Square },
  { id: 'ellipse', label: 'Ellipse', icon: Circle },
  { id: 'diamond', label: 'Diamond', icon: Diamond },
  { id: 'text', label: 'Text', icon: Type },
  { id: 'connect', label: 'Connect', icon: Spline },
]

const HANDLES: { id: DiagramHandle; x: string; y: string; cursor: string }[] = [
  { id: 'nw', x: '0%', y: '0%', cursor: 'nwse-resize' },
  { id: 'n', x: '50%', y: '0%', cursor: 'ns-resize' },
  { id: 'ne', x: '100%', y: '0%', cursor: 'nesw-resize' },
  { id: 'e', x: '100%', y: '50%', cursor: 'ew-resize' },
  { id: 'se', x: '100%', y: '100%', cursor: 'nwse-resize' },
  { id: 's', x: '50%', y: '100%', cursor: 'ns-resize' },
  { id: 'sw', x: '0%', y: '100%', cursor: 'nesw-resize' },
  { id: 'w', x: '0%', y: '50%', cursor: 'ew-resize' },
]

function mintId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/** Last copied shapes and the lines between them. Shared across diagram tabs. */
let clipboard: { nodes: DiagramNode[]; edges: DiagramEdge[] } | null = null

function placeNode(doc: DiagramDoc, kind: DiagramKind, x: number, y: number): DiagramDoc {
  const size = defaultNodeSize(kind)
  const node: DiagramNode = {
    id: mintId('n'),
    kind,
    x: snap(x - size.w / 2, doc.grid, doc.snap),
    y: snap(y - size.h / 2, doc.grid, doc.snap),
    ...size,
  }
  return { ...doc, nodes: [...doc.nodes, node] }
}

function isKind(value: string): value is DiagramKind {
  return value === 'rect' || value === 'ellipse' || value === 'diamond' || value === 'text'
}

function tidyNode(node: DiagramNode): DiagramNode {
  const next: DiagramNode = { ...node }
  const painted = next.kind !== 'text'
  if ((next.fill ?? painted) === painted) delete next.fill
  if ((next.stroke ?? painted) === painted) delete next.stroke
  if (!next.fillColor) delete next.fillColor
  if (!next.strokeColor) delete next.strokeColor
  if (!next.rotation) delete next.rotation
  if (!next.detail?.trim()) delete next.detail
  return next
}

function tidyEdge(edge: DiagramEdge): DiagramEdge {
  const next = { ...edge }
  if (next.width === 1.5) delete next.width
  if (!next.color) delete next.color
  if (next.dash === 'solid') delete next.dash
  if (next.start === 'none') delete next.start
  if (next.end === 'arrow') delete next.end
  if (next.corner === 'sharp') delete next.corner
  if (next.route === 'orthogonal') delete next.route
  if (next.stroke !== false) delete next.stroke
  if (!next.bends?.length) delete next.bends
  if (next.fromPort != null && (!Number.isInteger(next.fromPort) || next.fromPort < 0 || next.fromPort >= DIAGRAM_PORTS)) delete next.fromPort
  if (next.toPort != null && (!Number.isInteger(next.toPort) || next.toPort < 0 || next.toPort >= DIAGRAM_PORTS)) delete next.toPort
  if (next.fromPort != null) delete next.fromSide
  if (next.toPort != null) delete next.toSide
  if (!next.text?.trim()) delete next.text
  if (!next.detail?.trim()) delete next.detail
  return next
}

/** Drops ids that no longer exist, so undo never restores a selection of ghosts. */
function liveSelection(doc: DiagramDoc, selection: DiagramSelection): DiagramSelection {
  const nodes = new Set(doc.nodes.map((node) => node.id))
  const edges = new Set(doc.edges.map((edge) => edge.id))
  return { nodes: selection.nodes.filter((id) => nodes.has(id)), edges: selection.edges.filter((id) => edges.has(id)) }
}

function sameNodeBox(a: DiagramNode, b: DiagramNode): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h && a.rotation === b.rotation
}

export function DiagramTab({ tab }: { tab: Extract<Tab, { kind: 'diagram' }> }) {
  const key = fileKey(tab.root, tab.path)
  const file = useKoma((s) => s.diagram.docs[key])
  const updateDiagram = useKoma((s) => s.updateDiagram)
  const saveDiagram = useKoma((s) => s.saveDiagram)
  const active = useKoma((s) => s.ui.activeTabId === tab.id && isTabVisible(s.ui, tab.id))
  const canvasRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<Drag | null>(null)
  const labelNoted = useRef(false)
  const updateRef = useRef(updateDiagram)
  updateRef.current = updateDiagram
  const [view, setView] = useState<DiagramView>(() => savedDiagramView(key))
  const viewRef = useRef(view)
  const [tool, setTool] = useState<Tool>('select')
  const [selection, setSelectionState] = useState<DiagramSelection>(NO_SELECTION)
  const selectionRef = useRef(selection)
  const [connectFrom, setConnectFrom] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [cursor, setCursor] = useState<DiagramPoint | null>(null)
  const [rev, setRev] = useState(0)
  const [marquee, setMarquee] = useState<DiagramRect | null>(null)
  const [chatMenu, setChatMenu] = useState<{ x: number; y: number } | null>(null)
  const [hover, setHover] = useState<{ type: 'node' | 'edge'; id: string } | null>(null)
  const [connectDrag, setConnectDrag] = useState<{ fromId: string; port: number } | null>(null)
  const [propsOpen, setPropsOpen] = useState(false)
  const [spaceDown, setSpaceDown] = useState(false)
  const [dragCursor, setDragCursor] = useState<string | null>(null)
  const spaceRef = useRef(false)
  const markerId = useId().replace(/:/g, '')

  const setSelection = (next: DiagramSelection) => {
    selectionRef.current = next
    setSelectionState(next)
  }
  const applyView = (next: DiagramView) => {
    viewRef.current = next
    saveDiagramView(key, next)
    setView(next)
  }

  useEffect(() => {
    const saved = savedDiagramView(key)
    viewRef.current = saved
    setView(saved)
    selectionRef.current = NO_SELECTION
    setSelectionState(NO_SELECTION)
    setMarquee(null)
    setChatMenu(null)
    setHover(null)
    setConnectDrag(null)
    setDragCursor(null)
    setRev((value) => value + 1)
  }, [key])

  const history = diagramHistory(key)

  const note = (doc: DiagramDoc) => {
    history.past.push({ doc, selection: selectionRef.current })
    if (history.past.length > DIAGRAM_UNDO_CAP) history.past.shift()
    history.future = []
    setRev((value) => value + 1)
  }
  const noteRef = useRef(note)
  noteRef.current = note

  const currentDoc = () => useKoma.getState().diagram.docs[key]?.doc

  const commit = (next: DiagramDoc) => {
    const current = currentDoc()
    if (!current || current === next || serializeDiagram(current) === serializeDiagram(next)) return
    note(current)
    updateDiagram(tab.root, tab.path, next)
  }

  const travel = (from: 'past' | 'future') => {
    const entry = history[from].pop()
    if (!entry) return
    const current = currentDoc()
    if (current) history[from === 'past' ? 'future' : 'past'].push({ doc: current, selection: selectionRef.current })
    setRev((value) => value + 1)
    setEditing(null)
    setSelection(liveSelection(entry.doc, entry.selection))
    updateDiagram(tab.root, tab.path, entry.doc)
  }
  const undo = () => travel('past')
  const redo = () => travel('future')

  useEffect(() => {
    if (!dragCursor) return
    const previous = document.body.style.cursor
    document.body.style.cursor = dragCursor
    return () => {
      document.body.style.cursor = previous
    }
  }, [dragCursor])

  const toScreen = (clientX: number, clientY: number) => {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return null
    return { x: canvasPoint(clientX - rect.left), y: canvasPoint(clientY - rect.top) }
  }
  const toDoc = (e: { clientX: number; clientY: number }) => {
    const screen = toScreen(e.clientX, e.clientY)
    if (!screen) return null
    const v = viewRef.current
    return { x: (screen.x - v.x) / v.zoom, y: (screen.y - v.y) / v.zoom }
  }
  const toDocRef = useRef(toDoc)
  toDocRef.current = toDoc

  const actionsRef = useRef({ undo, redo, commit, applyView, setSelection })
  actionsRef.current = { undo, redo, commit, applyView, setSelection }

  useEffect(() => {
    const docPoint = (clientX: number, clientY: number) => toDocRef.current({ clientX, clientY })
    const docDelta = (client: number) => canvasPoint(client) / viewRef.current.zoom
    const apply = (drag: Drag, next: DiagramDoc, current: DiagramDoc) => {
      if (next === current) return
      if ('remembered' in drag && !drag.remembered) {
        noteRef.current(current)
        drag.remembered = true
      }
      updateRef.current(tab.root, tab.path, next)
    }
    const move = (e: PointerEvent) => {
      const drag = dragRef.current
      if (!drag) return
      if (drag.kind === 'pan') {
        actionsRef.current.applyView({
          ...drag.view,
          x: drag.view.x + canvasPoint(e.clientX - drag.sx),
          y: drag.view.y + canvasPoint(e.clientY - drag.sy),
        })
        return
      }
      if (drag.kind === 'marquee') {
        if (!drag.moved && Math.hypot(canvasPoint(e.clientX - drag.sx), canvasPoint(e.clientY - drag.sy)) < DIAGRAM_DRAG_THRESHOLD) return
        drag.moved = true
        const point = docPoint(e.clientX, e.clientY)
        const doc = useKoma.getState().diagram.docs[key]?.doc
        if (!point || !doc) return
        const rect = {
          x: Math.min(drag.x, point.x),
          y: Math.min(drag.y, point.y),
          w: Math.abs(point.x - drag.x),
          h: Math.abs(point.y - drag.y),
        }
        setMarquee(rect)
        const inside = selectInRect(doc, rect)
        actionsRef.current.setSelection(drag.additive ? mergeSelection(drag.base, inside, false) : inside)
        return
      }
      if (drag.kind === 'connect') {
        const point = docPoint(e.clientX, e.clientY)
        if (point) setCursor(point)
        return
      }
      const current = useKoma.getState().diagram.docs[key]
      if (!current) return
      const doc = current.doc
      if (drag.kind === 'move') {
        if (!drag.moved) {
          if (Math.hypot(canvasPoint(e.clientX - drag.sx), canvasPoint(e.clientY - drag.sy)) < DIAGRAM_DRAG_THRESHOLD) return
          drag.moved = true
          setDragCursor('move')
          try {
            canvasRef.current?.setPointerCapture(drag.pointerId)
          } catch {
            /* the pointer may already be gone */
          }
        }
        // The grabbed shape snaps; the rest of the selection follows by the same amount.
        const x = snap(drag.grab.x + docDelta(e.clientX - drag.sx), doc.grid, doc.snap)
        const y = snap(drag.grab.y + docDelta(e.clientY - drag.sy), doc.grid, doc.snap)
        const grabbed = doc.nodes.find((node) => node.id === drag.grab.id)
        if (grabbed && grabbed.x === x && grabbed.y === y) return
        apply(drag, moveDiagramNodes(drag.base, drag.ids, x - drag.grab.x, y - drag.grab.y), doc)
        return
      }
      if (drag.kind === 'resize') {
        const resized = resizeNode(drag.node, drag.handle, docDelta(e.clientX - drag.sx), docDelta(e.clientY - drag.sy), doc.grid, doc.snap)
        const existing = doc.nodes.find((node) => node.id === drag.id)
        if (!existing || sameNodeBox(existing, resized)) return
        apply(drag, { ...doc, nodes: doc.nodes.map((node) => (node.id === drag.id ? resized : node)) }, doc)
        return
      }
      const point = docPoint(e.clientX, e.clientY)
      if (!point) return
      if (drag.kind === 'rotate') {
        const rotation = nextRotation(drag.rotation, drag.angle, pointerAngle(drag.node, point), doc.snap) || undefined
        const existing = doc.nodes.find((node) => node.id === drag.id)
        if (!existing || existing.rotation === rotation) return
        apply(drag, { ...doc, nodes: doc.nodes.map((node) => (node.id === drag.id ? { ...node, rotation } : node)) }, doc)
        return
      }
      if (drag.kind === 'segment') {
        const start = drag.points[drag.index]
        const end = drag.points[drag.index + 1]
        if (!start || !end) return
        const horizontal = Math.abs(end.x - start.x) >= Math.abs(end.y - start.y)
        const slid = slideSegment(drag.points, drag.index, snap(horizontal ? point.y : point.x, doc.grid, doc.snap))
        const bends = slid.slice(1, -1)
        const existing = doc.edges.find((edge) => edge.id === drag.edgeId)
        if (!existing || JSON.stringify(existing.bends ?? []) === JSON.stringify(bends)) return
        apply(drag, { ...doc, edges: doc.edges.map((edge) => (edge.id === drag.edgeId ? tidyEdge({ ...edge, bends }) : edge)) }, doc)
        return
      }
      const edge = doc.edges.find((item) => item.id === drag.edgeId)
      if (!edge) return
      const otherId = drag.end === 'from' ? edge.to : edge.from
      const currentId = drag.end === 'from' ? edge.from : edge.to
      const node = nodeAtPoint(doc.nodes, point, otherId) ?? doc.nodes.find((item) => item.id === currentId)
      if (!node || node.id === otherId) return
      const port = nearestPort(node, point)
      const same = drag.end === 'from' ? edge.from === node.id && edge.fromPort === port : edge.to === node.id && edge.toPort === port
      if (same) return
      apply(drag, {
        ...doc,
        edges: doc.edges.map((item) =>
          item.id === edge.id
            ? tidyEdge({
                ...item,
                bends: [],
                ...(drag.end === 'from'
                  ? { from: node.id, fromPort: port, fromSide: undefined }
                  : { to: node.id, toPort: port, toSide: undefined }),
              })
            : item,
        ),
      }, doc)
    }
    const finish = () => {
      setDragCursor(null)
      setMarquee(null)
      setConnectDrag(null)
      setCursor(null)
      dragRef.current = null
    }
    const up = (e: PointerEvent) => {
      const drag = dragRef.current
      finish()
      if (drag?.kind === 'marquee' && !drag.moved && !drag.additive) actionsRef.current.setSelection(NO_SELECTION)
      if (drag?.kind === 'move' && !drag.moved && drag.ids.length > 1 && !e.shiftKey) {
        // A click inside a group selection narrows it to the clicked shape.
        actionsRef.current.setSelection({ nodes: [drag.grab.id], edges: [] })
      }
      if (drag?.kind !== 'connect') return
      const point = docPoint(e.clientX, e.clientY)
      const current = useKoma.getState().diagram.docs[key]?.doc
      if (!point || !current) return
      const target = nodeAtPoint(current.nodes, point, drag.fromId)
      if (!target) return
      const toPort = nearestPort(target, point)
      const existing = current.edges.find((edge) => edge.from === drag.fromId && edge.to === target.id && edge.fromPort === drag.port && edge.toPort === toPort)
      if (existing) {
        actionsRef.current.setSelection({ nodes: [], edges: [existing.id] })
        setPropsOpen(true)
        return
      }
      const id = mintId('e')
      noteRef.current(current)
      updateRef.current(tab.root, tab.path, {
        ...current,
        edges: [...current.edges, tidyEdge({ id, from: drag.fromId, to: target.id, fromPort: drag.port, toPort })],
      })
      actionsRef.current.setSelection({ nodes: [], edges: [id] })
      setPropsOpen(true)
    }
    // Losing the window mid-drag (alt-tab, a dialog) must not leave a drag or Space stuck on.
    const abandon = () => {
      if (document.visibilityState === 'visible' && document.hasFocus()) return
      finish()
      spaceRef.current = false
      setSpaceDown(false)
    }
    const onRestore = (event: Event) => {
      const detail = (event as CustomEvent<{ root?: string; path?: string }>).detail
      if (detail?.root !== tab.root || detail.path !== tab.path) return
      const previous = useKoma.getState().diagram.docs[key]?.doc ?? null
      if (previous) noteRef.current(previous)
      queueMicrotask(() => {
        const restored = useKoma.getState().diagram.docs[key]?.doc
        if (restored) {
          const st = useKoma.getState()
          publishDiagramShapeNotes(st.req, tab.root, tab.path, restored, { previous })
          void syncDiagramShapeNotes(
            { hostId: st.remoteState.hostId ?? 'local', root: tab.root },
            tab.path,
            restored,
            { previous },
          )
        }
      })
      setEditing(null)
      actionsRef.current.setSelection(NO_SELECTION)
      setConnectFrom(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', finish)
    window.addEventListener('blur', abandon)
    document.addEventListener('visibilitychange', abandon)
    window.addEventListener('koma-diagram-restore', onRestore)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', finish)
      window.removeEventListener('blur', abandon)
      document.removeEventListener('visibilitychange', abandon)
      window.removeEventListener('koma-diagram-restore', onRestore)
    }
  }, [key, tab.path, tab.root])

  const zoomAround = (factor: number, screen?: DiagramPoint) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const at = screen ?? { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 }
    const current = viewRef.current
    applyView(zoomViewAt(current, at.x, at.y, current.zoom * factor))
  }
  const fitView = () => {
    const doc = currentDoc()
    const canvas = canvasRef.current
    if (!doc || !canvas) return
    const box = selectionBounds(doc, { nodes: doc.nodes.map((node) => node.id), edges: [] })
    if (!box) {
      applyView({ x: 0, y: 0, zoom: 1 })
      return
    }
    const pad = 40
    const zoom = clampZoom(Math.min(1, (canvas.clientWidth - pad * 2) / Math.max(box.w, 1), (canvas.clientHeight - pad * 2) / Math.max(box.h, 1)))
    applyView({
      zoom,
      x: canvas.clientWidth / 2 - (box.x + box.w / 2) * zoom,
      y: canvas.clientHeight / 2 - (box.y + box.h / 2) * zoom,
    })
  }
  const zoomRef = useRef({ zoomAround, fitView })
  zoomRef.current = { zoomAround, fitView }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    // Wheel events arrive faster than frames. Deltas pile up and apply once per frame.
    const pending = { panX: 0, panY: 0, zoom: 1, x: 0, y: 0, frame: 0 }
    const flush = () => {
      pending.frame = 0
      let next = viewRef.current
      if (pending.zoom !== 1) next = zoomViewAt(next, pending.x, pending.y, next.zoom * pending.zoom)
      if (pending.panX || pending.panY) next = { ...next, x: next.x - pending.panX, y: next.y - pending.panY }
      pending.panX = 0
      pending.panY = 0
      pending.zoom = 1
      actionsRef.current.applyView(next)
    }
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? canvas.clientHeight : 1
      let dx = canvasPoint(event.deltaX * unit)
      let dy = canvasPoint(event.deltaY * unit)
      if (event.ctrlKey || event.metaKey) {
        const rect = canvas.getBoundingClientRect()
        pending.zoom *= Math.exp(-dy * DIAGRAM_ZOOM_PER_PIXEL)
        pending.x = canvasPoint(event.clientX - rect.left)
        pending.y = canvasPoint(event.clientY - rect.top)
      } else {
        if (event.shiftKey && !dx) {
          dx = dy
          dy = 0
        }
        pending.panX += dx
        pending.panY += dy
      }
      if (!pending.frame) pending.frame = requestAnimationFrame(flush)
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      canvas.removeEventListener('wheel', onWheel)
      if (pending.frame) cancelAnimationFrame(pending.frame)
    }
  }, [file?.loading])

  const pasteShapes = (source: { nodes: DiagramNode[]; edges: DiagramEdge[] }, shift: boolean) => {
    const doc = currentDoc()
    if (!doc) return null
    const step = shift ? (doc.snap && doc.grid > 0 ? doc.grid : 16) : 0
    const copy = copyDiagramShapes(
      { ...doc, nodes: source.nodes, edges: source.edges },
      { nodes: source.nodes.map((node) => node.id), edges: [] },
      mintId,
      step,
      step,
    )
    if (!copy.nodes.length) return null
    commit({ ...doc, nodes: [...doc.nodes, ...copy.nodes.map(tidyNode)], edges: [...doc.edges, ...copy.edges.map(tidyEdge)] })
    setSelection({ nodes: copy.nodes.map((node) => node.id), edges: copy.edges.map((edge) => edge.id) })
    setEditing(null)
    setConnectFrom(null)
    return copy
  }
  const copySelection = () => {
    const doc = currentDoc()
    const picked = selectionRef.current
    if (!doc || !picked.nodes.length) return false
    const ids = new Set(picked.nodes)
    clipboard = {
      nodes: doc.nodes.filter((node) => ids.has(node.id)).map((node) => tidyNode({ ...node })),
      edges: doc.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)).map((edge) => tidyEdge({ ...edge })),
    }
    return true
  }
  const nudge = (dx: number, dy: number, resize: boolean) => {
    const doc = currentDoc()
    const picked = selectionRef.current.nodes
    if (!doc || !picked.length) return
    if (!resize) {
      commit(moveDiagramNodes(doc, picked, dx, dy))
      return
    }
    const ids = new Set(picked)
    commit({
      ...doc,
      nodes: doc.nodes.map((node) =>
        ids.has(node.id) ? resizeNode(node, dx ? 'e' : 's', dx, dy, doc.grid, false) : node,
      ),
    })
  }
  const keyActionsRef = useRef({ copySelection, pasteShapes, nudge })
  keyActionsRef.current = { copySelection, pasteShapes, nudge }

  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (isTerminalInputTarget(e.target)) return
      const target = e.target as HTMLElement | null
      const typing = !!target?.closest('input, textarea, [contenteditable="true"], [contenteditable="plaintext-only"]')
      const mod = e.metaKey || e.ctrlKey
      const lower = e.key.toLowerCase()
      if (e.code === 'Space' && !typing) {
        spaceRef.current = true
        setSpaceDown(true)
        e.preventDefault()
      }
      if (mod && lower === 's' && !e.altKey) {
        e.preventDefault()
        saveDiagram(tab.root, tab.path)
        return
      }
      if (typing) return
      const doc = currentDoc()
      const picked = selectionRef.current
      const actions = actionsRef.current
      const keys = keyActionsRef.current
      if (mod && !e.altKey && lower === 'z') {
        e.preventDefault()
        if (e.shiftKey) actions.redo()
        else actions.undo()
        return
      }
      if (mod && !e.altKey && lower === 'y') {
        e.preventDefault()
        actions.redo()
        return
      }
      if (mod && !e.altKey && (e.key === '=' || e.key === '+')) {
        e.preventDefault()
        zoomRef.current.zoomAround(DIAGRAM_ZOOM_STEP)
        return
      }
      if (mod && !e.altKey && e.key === '-') {
        e.preventDefault()
        zoomRef.current.zoomAround(1 / DIAGRAM_ZOOM_STEP)
        return
      }
      if (mod && !e.altKey && e.key === '0') {
        e.preventDefault()
        zoomRef.current.zoomAround(1 / viewRef.current.zoom)
        return
      }
      if (mod && e.shiftKey && lower === 'h') {
        e.preventDefault()
        zoomRef.current.fitView()
        return
      }
      if (!doc) return
      if (mod && !e.shiftKey && !e.altKey && lower === 'a') {
        e.preventDefault()
        actions.setSelection({ nodes: doc.nodes.map((node) => node.id), edges: doc.edges.map((edge) => edge.id) })
        return
      }
      if (mod && !e.shiftKey && !e.altKey && lower === 'c') {
        if (keys.copySelection()) e.preventDefault()
        return
      }
      if (mod && !e.shiftKey && !e.altKey && lower === 'x') {
        if (!keys.copySelection()) return
        e.preventDefault()
        actions.commit(deleteDiagramSelection(doc, picked))
        actions.setSelection(NO_SELECTION)
        return
      }
      if (mod && !e.shiftKey && !e.altKey && lower === 'v') {
        if (!clipboard) return
        e.preventDefault()
        const pasted = keys.pasteShapes(clipboard, true)
        // The next paste lands one more step away, as in draw.io.
        if (pasted) clipboard = pasted
        setPropsOpen(true)
        return
      }
      if (mod && !e.shiftKey && !e.altKey && lower === 'd') {
        if (!picked.nodes.length) return
        e.preventDefault()
        const ids = new Set(picked.nodes)
        keys.pasteShapes(
          {
            nodes: doc.nodes.filter((node) => ids.has(node.id)),
            edges: doc.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)),
          },
          true,
        )
        return
      }
      if (e.key.startsWith('Arrow') && picked.nodes.length && !e.altKey) {
        e.preventDefault()
        const step = e.shiftKey ? (doc.grid > 0 ? doc.grid : 16) : 1
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0
        keys.nudge(dx, dy, mod)
        return
      }
      if (e.key === 'Escape') {
        setConnectFrom(null)
        setConnectDrag(null)
        dragRef.current = null
        actions.setSelection(NO_SELECTION)
        setEditing(null)
        setMarquee(null)
        setChatMenu(null)
        setCursor(null)
        return
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectionSize(picked)) {
        e.preventDefault()
        actions.commit(deleteDiagramSelection(doc, picked))
        actions.setSelection(NO_SELECTION)
        setConnectFrom(null)
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return
      spaceRef.current = false
      setSpaceDown(false)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKeyUp)
      spaceRef.current = false
    }
  }, [active, key, saveDiagram, tab.path, tab.root])

  useEffect(() => {
    if (!chatMenu) return
    const close = () => setChatMenu(null)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [chatMenu])

  // Hover is a geometric hit, sampled once per frame.
  const hoverFrame = useRef(0)
  const hoverPoint = useRef<DiagramPoint | null>(null)
  useEffect(() => () => cancelAnimationFrame(hoverFrame.current), [])
  const trackHover = (e: ReactPointerEvent) => {
    hoverPoint.current = toDoc(e)
    if (hoverFrame.current) return
    hoverFrame.current = requestAnimationFrame(() => {
      hoverFrame.current = 0
      const point = hoverPoint.current
      const doc = currentDoc()
      if (!point || !doc || dragRef.current) return
      const zoom = viewRef.current.zoom
      let hit = hitDiagram(doc, point, DIAGRAM_HIT_TOLERANCE / zoom)
      if (!hit) {
        // Ports sit on the outline, so the hover holds a few pixels past it.
        const margin = 10 / zoom
        const near = [...doc.nodes].reverse().find((node) => {
          const box = nodeBounds(node)
          return point.x >= box.x - margin && point.x <= box.x + box.w + margin && point.y >= box.y - margin && point.y <= box.y + box.h + margin
        })
        if (near) hit = { type: 'node', id: near.id }
      }
      setHover((prev) => (prev?.type === hit?.type && prev?.id === hit?.id ? prev : hit))
    })
  }

  const addAt = (kind: DiagramKind, x: number, y: number) => {
    const doc = currentDoc()
    if (!doc) return
    const next = placeNode(doc, kind, x, y)
    commit(next)
    const id = next.nodes[next.nodes.length - 1]?.id
    if (id) {
      setSelection({ nodes: [id], edges: [] })
      setPropsOpen(true)
    }
    setTool('select')
    setConnectFrom(null)
  }

  const startPan = (e: ReactPointerEvent) => {
    e.preventDefault()
    dragRef.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, view: viewRef.current }
    setDragCursor('grabbing')
  }

  const onCanvasPointerDown = (e: ReactPointerEvent) => {
    if ((e.target as HTMLElement).closest('input, textarea, [data-diagram-ui]')) return
    if (e.button === 1 || (e.button === 0 && (spaceRef.current || tool === 'pan'))) {
      startPan(e)
      return
    }
    if (e.button !== 0 || !file || file.loading) return
    setChatMenu(null)
    const p = toDoc(e)
    if (!p) return
    if (tool !== 'select' && tool !== 'connect' && tool !== 'pan') {
      addAt(tool, p.x, p.y)
      return
    }
    const doc = file.doc
    const hit = hitDiagram(doc, p, DIAGRAM_HIT_TOLERANCE / viewRef.current.zoom)
    if (editing && hit?.id !== editing) setEditing(null)
    if (tool === 'connect') {
      const node = hit?.type === 'node' ? doc.nodes.find((item) => item.id === hit.id) : undefined
      if (!node) {
        setConnectFrom(null)
        return
      }
      if (!connectFrom) {
        setConnectFrom(node.id)
        setSelection({ nodes: [node.id], edges: [] })
        setPropsOpen(true)
        return
      }
      if (connectFrom !== node.id && !doc.edges.some((edge) => edge.from === connectFrom && edge.to === node.id)) {
        commit({ ...doc, edges: [...doc.edges, { id: mintId('e'), from: connectFrom, to: node.id }] })
      }
      setConnectFrom(null)
      setSelection({ nodes: [node.id], edges: [] })
      setPropsOpen(true)
      return
    }
    const current = selectionRef.current
    if (!hit) {
      dragRef.current = { kind: 'marquee', x: p.x, y: p.y, sx: e.clientX, sy: e.clientY, base: current, additive: e.shiftKey, moved: false }
      return
    }
    setPropsOpen(true)
    setConnectFrom(null)
    if (hit.type === 'edge') {
      setSelection(e.shiftKey ? mergeSelection(current, { nodes: [], edges: [hit.id] }, true) : { nodes: [], edges: [hit.id] })
      return
    }
    if (editing === hit.id) return
    const already = current.nodes.includes(hit.id)
    if (e.shiftKey) {
      setSelection(mergeSelection(current, { nodes: [hit.id], edges: [] }, true))
      if (already) return
    } else if (!already) {
      setSelection({ nodes: [hit.id], edges: [] })
    }
    const grab = doc.nodes.find((node) => node.id === hit.id)
    if (!grab) return
    const ids = e.shiftKey || already ? [...new Set([...selectionRef.current.nodes, hit.id])] : [hit.id]
    dragRef.current = {
      kind: 'move',
      ids,
      grab,
      base: doc,
      sx: e.clientX,
      sy: e.clientY,
      pointerId: e.pointerId,
      moved: false,
      remembered: false,
    }
  }

  const onCanvasDoubleClick = (e: ReactMouseEvent) => {
    if (tool === 'pan' || !file) return
    if ((e.target as HTMLElement).closest('input, textarea, [data-diagram-ui]')) return
    const p = toDoc(e)
    if (!p) return
    const hit = hitDiagram(file.doc, p, DIAGRAM_HIT_TOLERANCE / viewRef.current.zoom)
    if (hit?.type !== 'node') return
    dragRef.current = null
    labelNoted.current = false
    setEditing(hit.id)
    setSelection({ nodes: [hit.id], edges: [] })
    setPropsOpen(true)
  }

  const patchEdge = (id: string, patch: Partial<DiagramEdge>) => {
    const doc = currentDoc()
    if (!doc) return
    commit({ ...doc, edges: doc.edges.map((edge) => (edge.id === id ? tidyEdge({ ...edge, ...patch }) : edge)) })
  }

  const patchNode = (id: string, patch: Partial<DiagramNode>) => {
    const doc = currentDoc()
    if (!doc) return
    commit({ ...doc, nodes: doc.nodes.map((node) => (node.id === id ? tidyNode({ ...node, ...patch }) : node)) })
  }

  /** Typing groups into one undo step until the field is left. */
  const editLive = (change: (doc: DiagramDoc) => DiagramDoc) => {
    const current = currentDoc()
    if (!current) return
    if (!labelNoted.current) {
      note(current)
      labelNoted.current = true
    }
    updateDiagram(tab.root, tab.path, change(current))
  }
  const editNodeText = (id: string, text: string) =>
    editLive((doc) => ({ ...doc, nodes: doc.nodes.map((node) => (node.id === id ? { ...node, text } : node)) }))
  const editEdgeText = (id: string, text: string) =>
    editLive((doc) => ({ ...doc, edges: doc.edges.map((edge) => (edge.id === id ? { ...edge, text } : edge)) }))
  const editDetail = (kind: 'node' | 'edge', id: string, detail: string) =>
    editLive((doc) =>
      kind === 'node'
        ? { ...doc, nodes: doc.nodes.map((node) => (node.id === id ? { ...node, detail } : node)) }
        : { ...doc, edges: doc.edges.map((edge) => (edge.id === id ? { ...edge, detail } : edge)) },
    )

  // The node views are memoized, so their callbacks must keep one identity.
  const editRef = useRef(editNodeText)
  editRef.current = editNodeText
  const nodeEdit = useMemo(
    () => ({
      text: (id: string, text: string) => editRef.current(id, text),
      done: () => {
        labelNoted.current = false
        setEditing(null)
      },
    }),
    [],
  )

  const revert = () => {
    if (!file?.savedText || file.saving || file.loading) return
    const parsed = parseDiagram(file.savedText)
    if (parsed.error) return
    const current = serializeDiagram(file.doc)
    if (current !== file.savedText) {
      recordCodingHistory(
        { hostId: useKoma.getState().remoteState.hostId ?? 'local', root: tab.root },
        tab.path,
        current,
        'Before revert',
      )
    }
    clearDiagramHistory(key)
    setRev((value) => value + 1)
    setEditing(null)
    const st = useKoma.getState()
    publishDiagramShapeNotes(st.req, tab.root, tab.path, parsed.doc, { previous: file.doc })
    void syncDiagramShapeNotes(
      { hostId: st.remoteState.hostId ?? 'local', root: tab.root },
      tab.path,
      parsed.doc,
      { previous: file.doc },
    )
    updateDiagram(tab.root, tab.path, parsed.doc)
  }

  if (!file) {
    return (
      <div className="flex h-full w-full items-center justify-center text-koma-dim">
        <BrailleSpinner size={18} className="opacity-70" />
      </div>
    )
  }

  const doc = file.doc
  const grid = doc.grid > 0 ? doc.grid : 16
  const byId = new Map(doc.nodes.map((node) => [node.id, node]))
  const connectNode = connectFrom ? byId.get(connectFrom) : undefined
  const selectedNodes = new Set(selection.nodes)
  const selectedEdges = new Set(selection.edges)
  const single: DiagramPanelSelection | null =
    selectionSize(selection) === 1
      ? selection.nodes.length
        ? { type: 'node', id: selection.nodes[0] }
        : { type: 'edge', id: selection.edges[0] }
      : null
  const status = file.saving
    ? 'Saving…'
    : file.loading && file.savedText == null
      ? 'Loading…'
      : file.error && !file.dirty
        ? file.error
        : file.dirty
          ? 'Modified'
          : 'Saved'
  const canSave = file.dirty && !file.saving && !file.loading
  const canRevert = file.dirty && !!file.savedText && !file.saving && !file.loading
  void rev
  const z = view.zoom
  const sx = (x: number) => x * z + view.x
  const sy = (y: number) => y * z + view.y
  const screenPoint = (point: DiagramPoint) => ({ x: sx(point.x), y: sy(point.y) })
  const gridPx = grid * z
  const dragging = !!dragCursor
  const hoverNode = hover?.type === 'node' ? byId.get(hover.id) : undefined
  const canvasCursor =
    dragCursor ??
    (tool === 'pan' || spaceDown ? 'grab' : tool !== 'select' ? 'crosshair' : hover?.type === 'edge' ? 'pointer' : hoverNode ? 'move' : 'default')
  const singleNode = single?.type === 'node' ? byId.get(single.id) : undefined
  // Ports and resize handles share the outline, so the selected shape shows only its handles.
  const portsFor =
    tool !== 'select' || editing
      ? undefined
      : connectDrag
        ? byId.get(connectDrag.fromId)
        : !dragging && hoverNode && hoverNode !== singleNode
          ? hoverNode
          : undefined
  const singleEdge = single?.type === 'edge' ? doc.edges.find((edge) => edge.id === single.id) : undefined
  const connectTarget =
    connectDrag && cursor ? nodeAtPoint(doc.nodes, cursor, connectDrag.fromId) : null

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-koma-bg text-koma-fg">
      <EditorChrome
        path={tab.path}
        icon={<Shapes size={13} className="flex-none text-koma-dim" />}
        status={status}
        canSave={canSave}
        canRevert={canRevert}
        saving={file.saving}
        canUndo={history.past.length > 0}
        canRedo={history.future.length > 0}
        onHistory={() => showCodingHistory(tab.root, tab.path)}
        onUndo={undo}
        onRedo={redo}
        onSave={() => saveDiagram(tab.root, tab.path)}
        onRevert={revert}
        trailing={
          <button
            type="button"
            title={propsOpen ? 'Hide properties' : 'Properties'}
            aria-label={propsOpen ? 'Hide properties' : 'Properties'}
            aria-pressed={propsOpen}
            onClick={() => setPropsOpen((open) => !open)}
            className={`flex h-6 w-6 flex-none items-center justify-center rounded hover:bg-koma-hover hover:text-koma-fg ${propsOpen ? 'text-koma-fg' : 'text-koma-dim'}`}
          >
            {propsOpen ? <PanelRightClose size={13} /> : <PanelRightOpen size={13} />}
          </button>
        }
      />
      {file.error ? (
        <div className="flex-none border-b border-koma-border px-3 py-1 text-[12px] text-koma-error">{file.error}</div>
      ) : null}
      <div className="flex min-h-0 min-w-0 flex-1">
      <div
        ref={canvasRef}
        className="koma-authored-canvas relative min-h-0 min-w-0 flex-1 overflow-hidden"
        style={{
          ...(doc.snap && gridPx >= 6
            ? {
                backgroundImage:
                  'radial-gradient(circle, color-mix(in srgb, var(--koma-fg, #c8d3f5) 28%, transparent) 1px, transparent 1px)',
                backgroundSize: `${gridPx}px ${gridPx}px`,
                backgroundPosition: `${view.x}px ${view.y}px`,
              }
            : {}),
          cursor: canvasCursor,
        }}
        onPointerDown={onCanvasPointerDown}
        onPointerMove={(e) => {
          trackHover(e)
          if (connectFrom) setCursor(toDoc(e))
        }}
        onPointerLeave={() => setHover(null)}
        onDoubleClick={onCanvasDoubleClick}
        onContextMenu={(e) => {
          if ((e.target as HTMLElement).closest('input, textarea')) return
          e.preventDefault()
          const p = toDoc(e)
          const hit = p ? hitDiagram(doc, p, DIAGRAM_HIT_TOLERANCE / viewRef.current.zoom) : null
          const current = selectionRef.current
          if (hit && !(hit.type === 'node' ? current.nodes : current.edges).includes(hit.id)) {
            setSelection(hit.type === 'node' ? { nodes: [hit.id], edges: [] } : { nodes: [], edges: [hit.id] })
          }
          setChatMenu({ x: e.clientX, y: e.clientY })
        }}
        onDragOver={(e) => {
          if ([...e.dataTransfer.types].some((type) => type === SHAPE_MIME || type === 'text/plain')) {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'copy'
          }
        }}
        onDrop={(e) => {
          const raw = e.dataTransfer.getData(SHAPE_MIME) || e.dataTransfer.getData('text/plain')
          if (!isKind(raw) || file.loading) return
          e.preventDefault()
          const p = toDoc(e)
          if (p) addAt(raw, p.x, p.y)
        }}
      >
        {file.loading ? (
          <div className="absolute inset-0 z-20 flex items-center justify-center">
            <BrailleSpinner size={18} className="opacity-70" />
          </div>
        ) : null}
        <div
          className="pointer-events-none absolute left-0 top-0"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${z})`, transformOrigin: '0 0' }}
        >
          <svg className="absolute left-0 top-0 h-px w-px overflow-visible">
            {doc.edges.map((edge) => {
              const from = byId.get(edge.from)
              const to = byId.get(edge.to)
              if (!from || !to) return null
              return (
                <DiagramEdgeView
                  key={edge.id}
                  edge={edge}
                  points={edgePoints(from, to, edge)}
                  selected={selectedEdges.has(edge.id)}
                  markerBase={markerId}
                />
              )
            })}
          </svg>
          {doc.edges.map((edge) => {
            const text = edge.text?.trim()
            if (!text) return null
            const from = byId.get(edge.from)
            const to = byId.get(edge.to)
            if (!from || !to) return null
            const at = routeMidpoint(edgePoints(from, to, edge))
            return (
              <div
                key={`label-${edge.id}`}
                className="absolute z-10 max-w-[140px] -translate-x-1/2 -translate-y-full truncate rounded border border-koma-border bg-koma-panel px-1.5 text-[11px] leading-5 text-koma-fg"
                style={{ left: at.x, top: at.y - 4 }}
              >
                {text}
              </div>
            )
          })}
          {doc.nodes.map((node) => (
            <DiagramNodeView
              key={node.id}
              node={node}
              highlight={connectFrom === node.id || connectTarget?.id === node.id}
              editing={editing === node.id}
              onEditText={nodeEdit.text}
              onEditDone={nodeEdit.done}
            />
          ))}
        </div>
        <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
          {doc.nodes.map((node) => {
            if (!selectedNodes.has(node.id) || (singleNode && tool === 'select' && !connectDrag)) return null
            const corners = [
              { x: node.x, y: node.y },
              { x: node.x + node.w, y: node.y },
              { x: node.x + node.w, y: node.y + node.h },
              { x: node.x, y: node.y + node.h },
            ].map((point) => screenPoint(rotatePoint(point, nodeCenter(node), node.rotation ?? 0)))
            return (
              <polygon
                key={node.id}
                points={corners.map((point) => `${point.x},${point.y}`).join(' ')}
                fill="none"
                stroke="var(--color-koma-accent)"
                strokeWidth={1}
              />
            )
          })}
          {singleEdge && tool === 'select' ? (
            <EdgeHandles
              edge={singleEdge}
              byId={byId}
              screenPoint={screenPoint}
              dragging={dragging}
              onSegment={(index, points) => {
                dragRef.current = { kind: 'segment', edgeId: singleEdge.id, index, points, remembered: false }
              }}
              onAnchor={(end) => {
                dragRef.current = { kind: 'anchor', edgeId: singleEdge.id, end, remembered: false }
                setDragCursor('crosshair')
              }}
            />
          ) : null}
          {connectNode && cursor ? (
            <line
              x1={sx(sideAnchor(connectNode, nearestSide(connectNode, cursor)).x)}
              y1={sy(sideAnchor(connectNode, nearestSide(connectNode, cursor)).y)}
              x2={sx(cursor.x)}
              y2={sy(cursor.y)}
              stroke="var(--color-koma-accent)"
              strokeWidth={1.5}
              strokeDasharray="4 3"
            />
          ) : null}
          {connectDrag && cursor ? (() => {
            const from = byId.get(connectDrag.fromId)
            if (!from) return null
            const start = screenPoint(portAnchor(from, connectDrag.port))
            const end = screenPoint(connectTarget ? portAnchor(connectTarget, nearestPort(connectTarget, cursor)) : cursor)
            return <line x1={start.x} y1={start.y} x2={end.x} y2={end.y} stroke="var(--color-koma-accent)" strokeWidth={1.5} strokeDasharray="4 3" />
          })() : null}
          {marquee ? (
            <rect
              x={sx(marquee.x)}
              y={sy(marquee.y)}
              width={Math.max(marquee.w * z, 1)}
              height={Math.max(marquee.h * z, 1)}
              fill="color-mix(in srgb, var(--color-koma-accent) 10%, transparent)"
              stroke="var(--color-koma-accent)"
              strokeWidth={1}
            />
          ) : null}
        </svg>
        {portsFor
          ? Array.from({ length: DIAGRAM_PORTS }, (_, port) => {
              const at = screenPoint(portAnchor(portsFor, port))
              return (
                <span
                  key={`${portsFor.id}-${port}`}
                  data-diagram-ui=""
                  className="absolute z-10 h-2 w-2 -translate-x-1/2 -translate-y-1/2"
                  style={{ left: at.x, top: at.y, cursor: 'crosshair' }}
                  onPointerDown={(e) => {
                    if (e.button !== 0 || spaceRef.current) return
                    e.stopPropagation()
                    e.preventDefault()
                    dragRef.current = { kind: 'connect', fromId: portsFor.id, port }
                    setConnectDrag({ fromId: portsFor.id, port })
                    setDragCursor('crosshair')
                    setCursor(toDoc(e))
                    setConnectFrom(null)
                  }}
                >
                  <svg viewBox="0 0 12 12" className="h-full w-full overflow-visible text-koma-accent" aria-hidden="true">
                    <path d="M6 1.5 V10.5 M1.5 6 H10.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
                  </svg>
                </span>
              )
            })
          : null}
        {singleNode && tool === 'select' && editing !== singleNode.id && !connectDrag ? (
          <div
            className="pointer-events-none absolute z-10 outline outline-1 outline-koma-accent"
            style={{
              left: sx(singleNode.x),
              top: sy(singleNode.y),
              width: singleNode.w * z,
              height: singleNode.h * z,
              transform: singleNode.rotation ? `rotate(${singleNode.rotation}deg)` : undefined,
            }}
          >
            {HANDLES.map((handle) => (
              <span
                key={handle.id}
                data-diagram-ui=""
                className={`absolute h-2.5 w-2.5 rounded-full border border-koma-accent bg-koma-panel ${dragging ? '' : 'pointer-events-auto'}`}
                style={{ left: handle.x, top: handle.y, transform: 'translate(-50%, -50%)', cursor: handle.cursor }}
                onPointerDown={(e) => {
                  e.stopPropagation()
                  e.preventDefault()
                  dragRef.current = { kind: 'resize', id: singleNode.id, handle: handle.id, sx: e.clientX, sy: e.clientY, node: singleNode, remembered: false }
                  setDragCursor(handle.cursor)
                }}
              />
            ))}
            <button
              type="button"
              title="Rotate"
              aria-label="Rotate"
              data-diagram-ui=""
              className={`absolute -right-3 -top-3 flex h-4 w-4 items-center justify-center rounded-full border border-koma-border bg-koma-panel text-koma-accent ${dragging ? '' : 'pointer-events-auto'}`}
              onPointerDown={(e) => {
                e.stopPropagation()
                e.preventDefault()
                const point = toDoc(e)
                if (!point) return
                setDragCursor('crosshair')
                dragRef.current = {
                  kind: 'rotate',
                  id: singleNode.id,
                  rotation: singleNode.rotation ?? 0,
                  angle: pointerAngle(singleNode, point),
                  node: singleNode,
                  remembered: false,
                }
              }}
            >
              <RotateCw size={10} />
            </button>
          </div>
        ) : null}
        {!file.loading && doc.nodes.length === 0 ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[12px] text-koma-fg opacity-35">
            Drag a shape onto the canvas
          </div>
        ) : null}
        <div
          data-diagram-ui=""
          className="absolute bottom-2 right-2 rounded border border-koma-border bg-koma-panel px-1.5 text-[11px] leading-5 text-koma-dim"
          title="Zoom (⌘ + scroll, ⌘0 for 100%, ⇧⌘H to fit)"
          onDoubleClick={() => zoomAround(1 / viewRef.current.zoom)}
        >
          {Math.round(z * 100)}%
        </div>
      </div>
      {propsOpen ? (
        <aside
          data-diagram-ui=""
          className="flex w-[260px] min-h-0 flex-none flex-col overflow-hidden border-l border-koma-border bg-koma-panel"
          onPointerDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => {
            e.preventDefault()
            e.stopPropagation()
          }}
        >
          <Properties
            doc={doc}
            root={tab.root}
            diagPath={tab.path}
            legacyAssetDir={diagramFolder(tab.path) ?? ''}
            selection={single}
            count={selectionSize(selection)}
            onEdge={(id, patch) => patchEdge(id, patch)}
            onNode={(id, patch) => patchNode(id, patch)}
            onText={(id, text) => editNodeText(id, text)}
            onEdgeText={(id, text) => editEdgeText(id, text)}
            onDetail={(kind, id, detail) => editDetail(kind, id, detail)}
            onTextDone={() => {
              labelNoted.current = false
            }}
          />
        </aside>
      ) : null}
      </div>
      {chatMenu ? (
        <div
          className="fixed z-[80] min-w-[160px] rounded border border-koma-border bg-koma-panel py-1 shadow-lg"
          style={{ left: pagePoint(chatMenu.x), top: pagePoint(chatMenu.y) }}
          data-diagram-ui=""
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <DiagramRefMenuItems
            onAdd={() => {
              const picked = selectionRef.current
              setChatMenu(null)
              const source = { root: tab.root, path: tab.path }
              if (selectionSize(picked)) addDiagramSelectionToChat(doc, picked, diagramChatTitle(tab.path), source)
              else addDiagramDocToChat(doc, diagramChatTitle(tab.path), 'This diagram is empty.', source)
            }}
            onCopy={() => {
              const picked = selectionRef.current
              setChatMenu(null)
              const source = { root: tab.root, path: tab.path }
              if (selectionSize(picked)) void copyDiagramSelection(doc, picked, diagramChatTitle(tab.path), source)
              else void copyDiagramMermaid(doc, diagramChatTitle(tab.path), 'This diagram is empty.', source)
            }}
          />
        </div>
      ) : null}
      <div className="flex h-8 flex-none items-center gap-1 border-t border-koma-border bg-koma-panel px-2">
        {TOOLS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            title={label}
            aria-label={label}
            aria-pressed={tool === id}
            onClick={() => {
              setTool(id)
              if (id !== 'connect') setConnectFrom(null)
            }}
            className={`flex h-6 w-6 flex-none items-center justify-center rounded transition ${
              tool === id
                ? 'bg-koma-accent/20 text-koma-accent ring-1 ring-inset ring-koma-accent'
                : 'text-koma-dim hover:bg-koma-hover hover:text-koma-fg'
            }`}
          >
            <Icon size={15} strokeWidth={tool === id ? 2.25 : 1.6} />
          </button>
        ))}
        <div className="ml-auto flex items-center gap-1.5">
          <span className="text-[12px] text-koma-fg opacity-70">Snap</span>
          <Toggle
            on={doc.snap}
            onChange={(on) => {
              if (file.loading) return
              commit({ ...doc, snap: on })
            }}
          />
        </div>
      </div>
    </div>
  )
}

/** Segment and end handles of the selected line, in screen space so they keep their size at any zoom. */
function EdgeHandles({
  edge,
  byId,
  screenPoint,
  dragging,
  onSegment,
  onAnchor,
}: {
  edge: DiagramEdge
  byId: Map<string, DiagramNode>
  screenPoint: (point: DiagramPoint) => DiagramPoint
  dragging: boolean
  onSegment: (index: number, points: DiagramPoint[]) => void
  onAnchor: (end: 'from' | 'to') => void
}) {
  const from = byId.get(edge.from)
  const to = byId.get(edge.to)
  if (!from || !to) return null
  const route = edgePoints(from, to, edge)
  const points = route.map(screenPoint)
  const active = dragging ? '' : 'pointer-events-auto'
  const grab = (e: ReactPointerEvent, run: () => void) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    run()
  }
  return (
    <g data-diagram-ui="">
      {points.slice(0, -1).map((point, index) => {
        const next = points[index + 1]
        if (!next) return null
        const horizontal = Math.abs(next.x - point.x) >= Math.abs(next.y - point.y)
        return (
          <circle
            key={`seg-${index}`}
            className={active}
            cx={(point.x + next.x) / 2}
            cy={(point.y + next.y) / 2}
            r={4}
            fill="var(--color-koma-accent)"
            stroke="var(--color-koma-bg)"
            strokeWidth={1}
            style={{ cursor: horizontal ? 'ns-resize' : 'ew-resize' }}
            onPointerDown={(e) => grab(e, () => onSegment(index, route))}
          />
        )
      })}
      {(['from', 'to'] as const).map((end) => {
        const point = end === 'from' ? points[0] : points[points.length - 1]
        if (!point) return null
        return (
          <circle
            key={end}
            className={active}
            cx={point.x}
            cy={point.y}
            r={5}
            fill="var(--color-koma-bg)"
            stroke={themeStroke(true)}
            strokeWidth={1.5}
            style={{ cursor: 'crosshair' }}
            onPointerDown={(e) => grab(e, () => onAnchor(end))}
          />
        )
      })}
    </g>
  )
}
