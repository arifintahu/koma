import { memo } from 'react'
import { inlineToHtml } from '../../lib/markdownNote'
import { nodeStyle, type DiagramNode } from '../../lib/diagram'

/**
 * One shape in doc coordinates. The world layer scales it, so it never reads the zoom.
 * Pointer handling lives on the canvas (geometric hits); only the label editor takes input.
 */
export const DiagramNodeView = memo(function DiagramNodeView({
  node,
  highlight,
  editing,
  onEditText,
  onEditDone,
}: {
  node: DiagramNode
  /** Accent outline: the start of a click-to-connect, or a connection target. */
  highlight: boolean
  editing: boolean
  onEditText: (id: string, text: string) => void
  onEditDone: () => void
}) {
  const paint = nodeStyle(node)
  const boxed = node.kind === 'rect' || node.kind === 'text'
  const fill = paint.fill ? paint.fillColor || 'var(--color-koma-panel)' : 'none'
  const stroke = highlight ? 'var(--color-koma-accent)' : paint.stroke ? paint.strokeColor || 'var(--color-koma-border)' : 'none'
  return (
    <div
      className="absolute flex items-center justify-center"
      style={{
        left: node.x,
        top: node.y,
        width: node.w,
        height: node.h,
        transform: node.rotation ? `rotate(${node.rotation}deg)` : undefined,
        ...(boxed
          ? {
              background: fill === 'none' ? 'transparent' : fill,
              borderRadius: node.kind === 'rect' ? 4 : 0,
              outline: stroke === 'none' ? 'none' : `1px solid ${stroke}`,
              outlineOffset: '-0.5px',
            }
          : {}),
      }}
    >
      {node.kind === 'diamond' || node.kind === 'ellipse' ? (
        <svg className="absolute inset-0 h-full w-full overflow-visible">
          {node.kind === 'diamond' ? (
            <polygon
              points={`${node.w / 2},0 ${node.w},${node.h / 2} ${node.w / 2},${node.h} 0,${node.h / 2}`}
              fill={fill}
              stroke={stroke}
              strokeWidth={stroke === 'none' ? 0 : 1}
            />
          ) : (
            <ellipse cx={node.w / 2} cy={node.h / 2} rx={node.w / 2} ry={node.h / 2} fill={fill} stroke={stroke} strokeWidth={stroke === 'none' ? 0 : 1} />
          )}
        </svg>
      ) : null}
      {editing ? (
        <input
          autoFocus
          defaultValue={node.text}
          className="pointer-events-auto z-10 w-full border-0 bg-transparent px-2 text-center text-[12px] shadow-none outline-none"
          style={{ color: paint.textColor || 'var(--color-koma-fg)' }}
          onPointerDown={(e) => e.stopPropagation()}
          onChange={(e) => onEditText(node.id, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === 'Escape') {
              e.preventDefault()
              onEditDone()
            }
          }}
          onBlur={onEditDone}
        />
      ) : (
        <span
          className="z-10 truncate px-2 text-center text-[12px]"
          style={{ color: paint.textColor || 'var(--color-koma-fg)' }}
          dangerouslySetInnerHTML={{ __html: inlineToHtml(node.text || ' ') }}
        />
      )}
    </div>
  )
})
