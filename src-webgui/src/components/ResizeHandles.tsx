import type { MouseEvent } from 'react'

function post(msg: unknown) {
  try {
    window.ipc?.postMessage(JSON.stringify(msg))
  } catch {
    /* ipc unavailable */
  }
}

const DIRS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const

export type ResizeDir = (typeof DIRS)[number]

type ResizeHandlesProps = {
  /** Subset of edges; default is all eight (main koma window). */
  dirs?: readonly ResizeDir[]
  /** Override the ipc payload (screen-browser chrome uses `{ t:'sb', a:'win_resize' }`). */
  message?: (dir: ResizeDir) => unknown
}

// Custom edge/corner resize handles — the window is undecorated, so these
// drive tao's drag_resize_window() instead of native OS chrome.
export function ResizeHandles({ dirs = DIRS, message }: ResizeHandlesProps = {}) {
  function handleMouseDown(dir: ResizeDir) {
    return (e: MouseEvent<HTMLDivElement>) => {
      if (e.button !== 0) return
      e.preventDefault()
      post(message ? message(dir) : { t: 'winresize', dir })
    }
  }

  return (
    <>
      {dirs.map((dir) => (
        <div key={dir} className={`rz rz-${dir}`} onMouseDown={handleMouseDown(dir)} />
      ))}
    </>
  )
}
