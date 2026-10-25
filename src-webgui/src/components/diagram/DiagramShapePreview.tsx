import type { DiagramKind } from '../../lib/diagram'

/** Shapes offered by the sidebar palette and by the canvas shape picker, in order. */
export const DIAGRAM_PALETTE: { kind: DiagramKind; label: string }[] = [
  { kind: 'rect', label: 'Rectangle' },
  { kind: 'text', label: 'Text' },
  { kind: 'ellipse', label: 'Ellipse' },
  { kind: 'diamond', label: 'Diamond' },
]

export function ShapePreview({ kind }: { kind: DiagramKind }) {
  if (kind === 'ellipse') {
    return (
      <svg viewBox="0 0 64 36" className="h-8 w-16" aria-hidden="true">
        <ellipse cx="32" cy="18" rx="30" ry="15" fill="var(--color-koma-bg)" stroke="currentColor" strokeWidth="1.25" />
      </svg>
    )
  }
  if (kind === 'diamond') {
    return (
      <svg viewBox="0 0 40 36" className="h-8 w-10" aria-hidden="true">
        <polygon points="20,1.5 38.5,18 20,34.5 1.5,18" fill="var(--color-koma-bg)" stroke="currentColor" strokeWidth="1.25" />
      </svg>
    )
  }
  if (kind === 'text') {
    return <span className="flex h-8 items-center px-1 text-[13px] leading-none text-koma-fg/80">Text</span>
  }
  return (
    <span className="flex h-8 items-center justify-center rounded border border-current bg-koma-bg px-2 text-[11px] leading-none text-koma-fg/80">
      Heading
    </span>
  )
}
