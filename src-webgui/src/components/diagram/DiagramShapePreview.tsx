import { SHAPE_SIZES } from '../../lib/diagramShapes'
import type { DiagramKind } from '../../lib/diagram'
import { DiagramShapeSvg } from './DiagramShapeSvg'

export type DiagramPaletteEntry = {
  /** Stable id carried by drag-and-drop. */
  id: string
  kind: DiagramKind
  label: string
  group: 'Basic' | 'Flowchart'
  /** Size override for presets such as the circle. */
  size?: { w: number; h: number }
}

/** Shapes offered by the sidebar palette and by the canvas shape picker, in order. */
export const DIAGRAM_PALETTE: DiagramPaletteEntry[] = [
  { id: 'rect', kind: 'rect', label: 'Rectangle', group: 'Basic' },
  { id: 'rounded', kind: 'rounded', label: 'Rounded rectangle', group: 'Basic' },
  { id: 'text', kind: 'text', label: 'Text', group: 'Basic' },
  { id: 'ellipse', kind: 'ellipse', label: 'Ellipse', group: 'Basic' },
  { id: 'circle', kind: 'ellipse', label: 'Circle', group: 'Basic', size: { w: 80, h: 80 } },
  { id: 'diamond', kind: 'diamond', label: 'Diamond', group: 'Basic' },
  { id: 'triangle', kind: 'triangle', label: 'Triangle', group: 'Basic' },
  { id: 'stadium', kind: 'stadium', label: 'Terminator', group: 'Flowchart' },
  { id: 'process', kind: 'process', label: 'Predefined process', group: 'Flowchart' },
  { id: 'parallelogram', kind: 'parallelogram', label: 'Data (input/output)', group: 'Flowchart' },
  { id: 'trapezoid', kind: 'trapezoid', label: 'Manual operation', group: 'Flowchart' },
  { id: 'hexagon', kind: 'hexagon', label: 'Preparation', group: 'Flowchart' },
  { id: 'cylinder', kind: 'cylinder', label: 'Database', group: 'Flowchart' },
  { id: 'document', kind: 'document', label: 'Document', group: 'Flowchart' },
  { id: 'cloud', kind: 'cloud', label: 'Cloud', group: 'Flowchart' },
]

export function paletteEntry(id: string): DiagramPaletteEntry | undefined {
  return DIAGRAM_PALETTE.find((entry) => entry.id === id)
}

/** Tile drawing for one palette entry, fitted into a 48×30 box with the shape's own aspect. */
export function ShapePreview({ entry }: { entry: DiagramPaletteEntry }) {
  if (entry.kind === 'text') {
    return <span className="flex h-8 w-12 items-center justify-center text-[13px] leading-none text-koma-fg/80">Text</span>
  }
  const size = entry.size ?? SHAPE_SIZES[entry.kind]
  const scale = Math.min(46 / size.w, 28 / size.h)
  const w = Math.round(size.w * scale)
  const h = Math.round(size.h * scale)
  return (
    <svg viewBox={`-1 -1 ${w + 2} ${h + 2}`} width={w + 2} height={h + 2} className="m-auto block" aria-hidden="true">
      <DiagramShapeSvg kind={entry.kind} w={w} h={h} fill="var(--color-koma-bg)" stroke="currentColor" strokeWidth={1.25} />
    </svg>
  )
}
