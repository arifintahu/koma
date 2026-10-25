import { memo } from 'react'
import { inlineToHtml } from '../../lib/markdownNote'
import { nodeStyle, type DiagramNode } from '../../lib/diagram'
import { DiagramShapeSvg } from './DiagramShapeSvg'

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
  /** Editing starts with the whole label selected, or with the caret after typed text. */
  editing: false | 'select' | 'end'
  onEditText: (id: string, text: string) => void
  onEditDone: () => void
}) {
  const paint = nodeStyle(node)
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
      }}
    >
      <svg className="absolute inset-0 h-full w-full overflow-visible">
        <DiagramShapeSvg kind={node.kind} w={node.w} h={node.h} fill={fill} stroke={stroke} />
      </svg>
      {editing ? (
        <textarea
          autoFocus
          defaultValue={node.text}
          rows={Math.max(1, node.text.split('\n').length)}
          className="pointer-events-auto z-10 max-h-full w-full resize-none overflow-hidden border-0 bg-transparent px-2 text-center text-[12px] leading-4 shadow-none outline-none"
          style={{ color: paint.textColor || 'var(--color-koma-fg)' }}
          onFocus={(e) => {
            const field = e.currentTarget
            if (editing === 'select') field.select()
            else field.setSelectionRange(field.value.length, field.value.length)
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onChange={(e) => {
            e.currentTarget.rows = Math.max(1, e.currentTarget.value.split('\n').length)
            onEditText(node.id, e.target.value)
          }}
          onKeyDown={(e) => {
            // Shift+Enter breaks the line; Enter and Escape finish, as in draw.io.
            if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Escape') {
              e.preventDefault()
              onEditDone()
            }
          }}
          onBlur={onEditDone}
        />
      ) : (
        <span
          className="z-10 max-h-full overflow-hidden whitespace-pre-wrap break-words px-2 text-center text-[12px] leading-4"
          style={{ color: paint.textColor || 'var(--color-koma-fg)' }}
          dangerouslySetInnerHTML={{ __html: inlineToHtml(node.text || ' ') }}
        />
      )}
    </div>
  )
})
