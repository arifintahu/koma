import { Check, ExternalLink, Globe, Minus, Pause, Play, Square, Trash2 } from 'lucide-react'
import { useKoma } from '../store/koma'
import { DEFAULT_SCREEN_BROWSER_PREFS, type ScreenBrowserPrefs } from '../types/screenBrowser'
import { Toggle } from './panels/form'

const button = 'inline-flex items-center gap-2 rounded-md border border-koma-border bg-koma-panel px-3 py-2 text-xs transition-colors hover:bg-koma-hover disabled:opacity-40 disabled:cursor-not-allowed'
const capabilityLabels: Record<string, string> = {
  tabs: 'Multi-tab browsing',
  capture: 'Screenshots',
  input: 'Pointer and keyboard',
  eval: 'Page evaluate',
  downloads: 'Downloads',
  floating: 'Detached window',
}

export function ScreenBrowserSettings() {
  const session = useKoma(s => s.session.id)
  const remote = useKoma(s => s.remoteState.state)
  const browser = useKoma(s => s.screenBrowser)
  const error = useKoma(s => s.screenBrowserError)
  const req = useKoma(s => s.req)
  const status = browser?.session === session ? browser : null
  const local = !['ready', 'connected', 'connecting'].includes(remote)
  const available = !!session && local
  const enabled = !!status?.enabled
  const waiting = !!status?.waiting_human
  const prefs = status?.prefs ?? DEFAULT_SCREEN_BROWSER_PREFS
  const label = !enabled
    ? 'Off'
    : waiting
      ? 'Waiting'
      : status.paused
        ? 'Paused (you browse)'
        : status.busy
          ? 'Working'
          : 'Ready'
  const control = (action: string, extra?: { prefs?: Partial<ScreenBrowserPrefs>; url?: string }) =>
    req({ r: 'ScreenBrowser', action, ...(extra?.prefs ? { prefs: { ...prefs, ...extra.prefs } } : {}), ...(extra?.url ? { url: extra.url } : {}) })

  const setPref = <K extends keyof ScreenBrowserPrefs>(key: K, value: ScreenBrowserPrefs[K]) => {
    control('set_prefs', { prefs: { [key]: value } as Partial<ScreenBrowserPrefs> })
  }

  return <div className="space-y-5 text-[12.5px]">
    <div className="rounded-lg border border-koma-border bg-koma-panel/40 p-4">
      <div className="flex items-center gap-3">
        <div className="rounded-lg border border-koma-border bg-koma-bg p-2.5 text-koma-accent"><Globe size={20} strokeWidth={1.5} /></div>
        <h3 className="min-w-0 flex-1 font-medium">On-screen browser</h3>
        <span className={`flex items-center gap-1.5 rounded-full border border-koma-border px-2 py-1 text-[10px] ${enabled ? 'text-koma-accent' : 'text-koma-dim'}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${enabled ? 'bg-koma-accent' : 'bg-koma-dim'}`} />{label}
        </span>
      </div>
      <p className="mt-3 text-xs leading-relaxed text-koma-dim">
        A normal multi-tab browser window. Type URLs and switch tabs yourself; the model can drive the same window when agent control is not paused.
      </p>
      {waiting && <p className="mt-3 text-xs text-koma-fg">{status?.waiting_message || 'The model is waiting for you to finish a step (login, CAPTCHA, 2FA…).'}</p>}
      <div className="mt-4 flex flex-wrap gap-2">
        {!enabled
          ? <button type="button" disabled={!available} className={`${button} text-koma-accent`} onClick={() => {
              control('enable')
              window.ipc?.postMessage(JSON.stringify({ t: 'win', a: 'screen-browser' }))
            }}><Globe size={14} />Start browser</button>
          : <>
              {waiting
                ? <button type="button" className={button} onClick={() => control('continue_human')}><Play size={14} />Continue</button>
                : <button type="button" className={button} onClick={() => control(status?.paused ? 'resume' : 'pause')}>
                    {status?.paused ? <Play size={14} /> : <Pause size={14} />}
                    {status?.paused ? 'Let agent control' : 'Pause agent control'}
                  </button>}
              <button type="button" className={button} onClick={() => {
                control('stop')
                window.ipc?.postMessage(JSON.stringify({ t: 'win', a: 'screen-browser-close' }))
              }}><Square size={13} />Stop</button>
              <button type="button" className={button} disabled={status?.busy} onClick={() => {
                control('open_window')
                window.ipc?.postMessage(JSON.stringify({ t: 'win', a: 'screen-browser' }))
              }}><ExternalLink size={14} />Open window</button>
            </>}
      </div>
      <p role="status" className="mt-3 text-xs leading-relaxed text-koma-dim">
        {!available
          ? 'Available in a local GUI session.'
          : status?.message || 'Start the browser, type a URL in the window, or let the model navigate.'}
      </p>
      {error && <p role="alert" className="mt-2 text-xs text-koma-error">{error}</p>}
    </div>

    <div>
      <h3 className="font-medium">Preferences</h3>
      <p className="mt-1 text-xs leading-relaxed text-koma-dim">Apply immediately while the browser is running, or the next time it starts.</p>
      <div className="mt-3 space-y-3">
        <ToggleRow label="Always on top" desc="Keep the browser window above other apps. Off by default — agent control does not raise the window." checked={!!prefs.always_on_top} onChange={v => setPref('always_on_top', v)} disabled={!available} />
        <ToggleRow label="Auto screenshot" desc="Capture a fresh observation after model actions." checked={prefs.auto_screenshot !== false} onChange={v => setPref('auto_screenshot', v)} disabled={!available} />
        <ToggleRow label="Stop on close" desc="Turn the browser off when its window is closed (same as Stop). Always on for window close." checked={!!prefs.stop_on_close} onChange={v => setPref('stop_on_close', v)} disabled={!available} />
        <ToggleRow label="Allow page evaluate" desc="Let the model run JavaScript in page context (powerful; use carefully)." checked={!!prefs.allow_eval} onChange={v => setPref('allow_eval', v)} disabled={!available} />
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" className={button} disabled={!available || !enabled} onClick={() => control('clear_data')}>
          <Trash2 size={14} />Clear browsing data
        </button>
      </div>
      <p className="mt-2 text-xs text-koma-dim">Clears cookies and site data for this project&apos;s browser profile only (same workdir = shared logins). Tabs are never saved.</p>
    </div>

    {(prefs.allowed_nav?.length ?? 0) > 0 && (
      <div>
        <h3 className="font-medium">Site permissions</h3>
        <p className="mt-1 text-xs leading-relaxed text-koma-dim">
          Navigations you chose Always allow. Same idea as Chrome/Firefox site settings.
        </p>
        <ul className="mt-3 space-y-1">
          {prefs.allowed_nav!.map(key => (
            <li key={key} className="flex items-center justify-between gap-3 rounded-md border border-koma-border/70 px-3 py-2">
              <span className="min-w-0 truncate font-mono text-[11px]">{key.replace(/^scheme:/, '').replace(/^host:/, '')}{key.startsWith('scheme:') ? ':' : ''}</span>
              <button
                type="button"
                className={button}
                disabled={!available || !enabled}
                onClick={() => control('forget_nav', { url: key })}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      </div>
    )}

    {status && <details>
      <summary className="cursor-pointer font-medium">Capability details</summary>
      <dl className="mt-3 grid grid-cols-1 gap-x-6 sm:grid-cols-2">
        {Object.entries(capabilityLabels).map(([key, title]) => {
          const supported = status.capabilities[key as keyof typeof status.capabilities] === true
          return <div key={key} className="flex items-center justify-between border-b border-koma-border/60 py-2 text-xs">
            <dt>{title}</dt>
            <dd className={`flex items-center gap-1 ${supported ? 'text-koma-accent' : 'text-koma-dim'}`}>
              {supported ? <Check size={12} /> : <Minus size={12} />}{supported ? 'Available' : 'Unavailable'}
            </dd>
          </div>
        })}
      </dl>
      <div className="mt-3 space-y-2 text-xs leading-relaxed text-koma-dim">
        {status.capabilities.limitations.map(message => <p key={message}>{message}</p>)}
        {status.observation && <p><span className="text-koma-fg">Last page: </span>{status.observation.title || status.observation.url}</p>}
        {status.tabs.length > 0 && <p><span className="text-koma-fg">Open tabs: </span>{status.tabs.length}</p>}
      </div>
    </details>}
    <p className="text-xs leading-relaxed text-koma-dim">
      <strong className="text-koma-fg">Pause agent control</strong> blocks model clicks/navigation while you browse normally.
      Resume with “Let agent control”. <strong className="text-koma-fg">Stop</strong> turns the browser off and closes the window.
    </p>
  </div>
}

function ToggleRow({ label, desc, checked, onChange, disabled }: {
  label: string; desc: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean
}) {
  return <div className={`flex items-start justify-between gap-4 rounded-md border border-koma-border/70 px-3 py-2.5 ${disabled ? 'opacity-50' : ''}`}>
    <div className="min-w-0">
      <p className="font-medium">{label}</p>
      <p className="mt-0.5 text-xs text-koma-dim">{desc}</p>
    </div>
    <div className={disabled ? 'pointer-events-none' : undefined}>
      <Toggle on={checked} onChange={onChange} />
    </div>
  </div>
}
