import { Globe, LoaderCircle, Power, UserRound } from 'lucide-react'
import { useKoma } from '../store/koma'

/**
 * Titlebar control for the on-screen browser.
 * Globe = start / focus window. Power = stop (when running).
 */
export function ScreenBrowserShortcut() {
  const session = useKoma(s => s.session.id)
  const remote = useKoma(s => s.remoteState.state)
  const browser = useKoma(s => s.screenBrowser)
  const error = useKoma(s => s.screenBrowserError)
  const req = useKoma(s => s.req)
  const status = browser?.session === session ? browser : null
  // Treat empty-session optimistic "Stopped" payloads as off too.
  const enabled = !!status?.enabled && (!status.session || status.session === session)
  if (!session || ['ready', 'connected', 'connecting'].includes(remote)) return null

  const waiting = enabled && status.waiting_human
  const busy = enabled && status.busy && !waiting
  const place = !enabled ? 'off' : waiting ? 'waiting' : busy ? 'busy' : 'ready'
  const label =
    place === 'off' ? 'Start on-screen browser'
    : place === 'waiting' ? (status.waiting_message || 'Waiting for you')
    : place === 'busy' ? 'Browser busy — click to show window'
    : 'Show on-screen browser'
  const Icon =
    place === 'busy' ? LoaderCircle
    : place === 'waiting' ? UserRound
    : Globe
  const control = (action: string) => req({ r: 'ScreenBrowser', action })

  return (
    <div className="flex flex-none items-center gap-1" role="group" aria-label="On-screen browser" title={error ?? undefined}>
      <button
        type="button"
        aria-label={label}
        title={label}
        aria-pressed={enabled}
        className={`pointer-events-auto flex h-[22px] w-[22px] flex-none items-center justify-center rounded-md border transition-colors hover:bg-koma-hover ${
          enabled
            ? 'border-koma-accent/40 bg-koma-accent/10 text-koma-accent'
            : 'border-koma-border bg-koma-panel text-koma-fg'
        }`}
        onClick={() => {
          if (enabled) {
            control('open_window')
            window.ipc?.postMessage(JSON.stringify({ t: 'win', a: 'screen-browser' }))
          } else {
            // Always enable from off — never leave a stuck green globe without a session.
            control('enable')
            window.ipc?.postMessage(JSON.stringify({ t: 'win', a: 'screen-browser' }))
          }
        }}
      >
        <Icon size={13} className={place === 'busy' ? 'animate-spin' : undefined} />
      </button>
      {enabled && (
        <button
          type="button"
          className="pointer-events-auto flex h-[22px] w-[22px] items-center justify-center rounded-md border border-koma-border bg-koma-panel text-koma-fg hover:bg-koma-hover hover:text-koma-error"
          aria-label="Stop browser"
          title="Stop browser and close window"
          onClick={() => {
            // Daemon stop first, then local close (close also stops + greys UI).
            control('stop')
            window.ipc?.postMessage(JSON.stringify({ t: 'win', a: 'screen-browser-close' }))
          }}
        >
          <Power size={12} />
        </button>
      )}
    </div>
  )
}
