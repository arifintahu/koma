/** How long a live reply can sit before the terminal paints it again. */
export const STREAM_PAINT_MS = 150

/** New characters that force a paint before the timer. */
export const STREAM_PAINT_CHARS = 200

export type StreamPaint = {
  shown: string
  paintedAt: number
}

/**
 * The string to put on screen.
 * A burst inside the window keeps the previous paint.
 * A 200-character jump or a 150 ms gap publishes.
 * A shorter string publishes immediately.
 * A settled reply always publishes.
 */
export function nextStreamPaint(previous: StreamPaint, next: string, now: number, streaming: boolean): StreamPaint {
  if (!streaming) return { shown: next, paintedAt: now }
  if (next === previous.shown) return previous
  const added = next.length - previous.shown.length
  const due = added < 0 || now - previous.paintedAt >= STREAM_PAINT_MS || added >= STREAM_PAINT_CHARS
  return due ? { shown: next, paintedAt: now } : previous
}
