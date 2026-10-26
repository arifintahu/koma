import { useEffect, useRef, type RefObject } from 'react'
import { canvasPoint } from '../../lib/uiScale'

/** Longest side of the miniature that rides with the cursor. */
const GHOST_MAX = 96
/** Gap between the cursor tip and the miniature, so it never covers the click point. */
const GHOST_OFFSET = 14
/** Tilt per pixel of movement in one frame, and its cap, in degrees. */
const TILT_PER_PX = 0.6
const TILT_MAX = 8
/** Screen pixels a press may travel and still count as a click that places the frame. */
const CLICK_SLOP = 4

/**
 * A downscaled frame that follows the cursor while the frame tool is armed, so it is
 * obvious that the next click on the canvas places one. It trails the cursor on a spring
 * and tilts toward the motion, then settles upright. A click shows it growing into the
 * real frame at the click point; a drag hides it, since the drag draws the frame itself.
 * Everything runs on the DOM directly, once per animation frame, without React renders.
 */
export function DesignFrameGhost({
  canvasRef,
  width,
  height,
  label,
  zoom,
}: {
  canvasRef: RefObject<HTMLDivElement | null>
  width: number
  height: number
  label: string
  /** Canvas zoom, so the click animation grows to the frame's real on-screen size. */
  zoom: number
}) {
  const ghostRef = useRef<HTMLDivElement>(null)
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  const scale = GHOST_MAX / Math.max(width, height, 1)
  const miniW = Math.max(12, Math.round(width * scale))
  const miniH = Math.max(12, Math.round(height * scale))

  useEffect(() => {
    const canvas = canvasRef.current
    const ghost = ghostRef.current
    if (!canvas || !ghost) return
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    const state = { x: 0, y: 0, tx: 0, ty: 0, tilt: 0, lastTx: 0, seen: false, pressed: false, frame: 0, down: { x: 0, y: 0 } }
    const local = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect()
      return { x: canvasPoint(event.clientX - rect.left), y: canvasPoint(event.clientY - rect.top) }
    }
    const paint = () => {
      ghost.style.transform = `translate(${state.x + GHOST_OFFSET}px, ${state.y + GHOST_OFFSET}px) rotate(${state.tilt}deg)`
    }
    const step = () => {
      state.frame = 0
      const moved = state.tx - state.lastTx
      state.lastTx = state.tx
      if (still) {
        state.x = state.tx
        state.y = state.ty
        state.tilt = 0
      } else {
        state.x += (state.tx - state.x) * 0.35
        state.y += (state.ty - state.y) * 0.35
        const target = Math.max(-TILT_MAX, Math.min(TILT_MAX, moved * TILT_PER_PX))
        state.tilt += (target - state.tilt) * 0.2
      }
      paint()
      const settled = Math.abs(state.tx - state.x) < 0.1 && Math.abs(state.ty - state.y) < 0.1 && Math.abs(state.tilt) < 0.05
      if (!settled) state.frame = requestAnimationFrame(step)
    }
    const wake = () => {
      if (!state.frame) state.frame = requestAnimationFrame(step)
    }
    const onMove = (event: PointerEvent) => {
      const point = local(event)
      state.tx = point.x
      state.ty = point.y
      if (!state.seen) {
        // The first sighting jumps straight to the cursor instead of flying in from the corner.
        state.seen = true
        state.x = point.x
        state.y = point.y
        state.lastTx = point.x
      }
      if (state.pressed) {
        const far = Math.hypot(point.x - state.down.x, point.y - state.down.y) > CLICK_SLOP
        ghost.style.opacity = far ? '0' : ''
      } else ghost.style.opacity = ''
      wake()
    }
    const onLeave = () => {
      state.seen = false
      ghost.style.opacity = '0'
    }
    const onDown = (event: PointerEvent) => {
      if (event.button !== 0) return
      state.pressed = true
      state.down = local(event)
    }
    const onUp = (event: PointerEvent) => {
      if (!state.pressed) return
      state.pressed = false
      const point = local(event)
      if (Math.hypot(point.x - state.down.x, point.y - state.down.y) > CLICK_SLOP || still) return
      // Grow a copy of the miniature into the real frame where the click placed it.
      const drop = ghost.cloneNode(true) as HTMLDivElement
      drop.style.transform = ''
      drop.style.left = `${state.down.x}px`
      drop.style.top = `${state.down.y}px`
      canvas.appendChild(drop)
      const realW = width * zoomRef.current
      const realH = height * zoomRef.current
      const animation = drop.animate(
        [
          { transform: `translate(${GHOST_OFFSET}px, ${GHOST_OFFSET}px) rotate(${state.tilt}deg)`, opacity: 1 },
          { transform: `scale(${realW / miniW}, ${realH / miniH})`, opacity: 0 },
        ],
        { duration: 120, easing: 'ease-out' },
      )
      animation.onfinish = () => drop.remove()
      animation.oncancel = () => drop.remove()
    }
    ghost.style.opacity = '0'
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerleave', onLeave)
    canvas.addEventListener('pointerdown', onDown, true)
    window.addEventListener('pointerup', onUp, true)
    return () => {
      if (state.frame) cancelAnimationFrame(state.frame)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerleave', onLeave)
      canvas.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('pointerup', onUp, true)
    }
  }, [canvasRef, width, height, miniW, miniH])

  return (
    <div
      ref={ghostRef}
      aria-hidden="true"
      className="pointer-events-none absolute left-0 top-0 z-30 flex flex-col items-start gap-1 transition-opacity duration-100"
      style={{ transformOrigin: '0 0', opacity: 0 }}
    >
      <div
        className="rounded-[2px] border border-dashed border-koma-accent bg-koma-accent/10 shadow-sm"
        style={{ width: miniW, height: miniH }}
      />
      <span className="whitespace-nowrap rounded bg-koma-panel px-1 text-[10px] leading-4 text-koma-fg shadow-sm">{label}</span>
    </div>
  )
}
