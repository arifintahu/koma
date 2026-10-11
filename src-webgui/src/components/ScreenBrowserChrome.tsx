import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ArrowLeft,
  ArrowRight, ChevronLeft, ChevronRight, Globe, LoaderCircle, Plus, RefreshCw, Square, X,
} from 'lucide-react'
import type { ScreenBrowserStatus, ScreenBrowserTab } from '../types/screenBrowser'

type SbAction =
  | 'navigate' | 'open' | 'close' | 'select' | 'reload' | 'back' | 'forward' | 'stop'
  | 'continue_human'

function post(action: SbAction, extra?: { url?: string; tab_id?: string }) {
  window.ipc?.postMessage(JSON.stringify({ t: 'sb', a: action, ...extra }))
}

function applyPalette(palette: Record<string, string>) {
  for (const key of ['bg', 'fg', 'dim', 'accent', 'panel', 'warn', 'success', 'info', 'error', 'border', 'hover', 'panel2']) {
    const color = palette[key]
    if (typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color)) {
      document.documentElement.style.setProperty(`--koma-${key}`, color)
    }
  }
}

const CHEVRON_ON =
  'mb-0.5 flex h-6 w-5 flex-none items-center justify-center rounded text-koma-fg opacity-60 hover:bg-koma-hover hover:opacity-100'
const CHEVRON_OFF =
  'mb-0.5 flex h-6 w-5 flex-none items-center justify-center rounded text-koma-fg pointer-events-none opacity-0'

function paintChevron(button: HTMLButtonElement | null, enabled: boolean) {
  if (!button) return
  button.disabled = !enabled
  button.tabIndex = enabled ? 0 : -1
  button.setAttribute('aria-hidden', enabled ? 'false' : 'true')
  button.className = enabled ? CHEVRON_ON : CHEVRON_OFF
}

/**
 * Normal-browser chrome only: tabs + back/forward/reload + address bar.
 * Agent pause/stop live on the main koma titlebar / Settings — not here.
 */
export function ScreenBrowserChrome() {
  const [status, setStatus] = useState<ScreenBrowserStatus | null>(window.__komaScreenBrowserInitial ?? null)
  const [urlDraft, setUrlDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const tabStripRef = useRef<HTMLDivElement>(null)
  const leftChevronRef = useRef<HTMLButtonElement>(null)
  const rightChevronRef = useRef<HTMLButtonElement>(null)
  const overflowRef = useRef({ left: false, right: false })

  useEffect(() => {
    // Hard defaults so chrome never paints as empty white-on-white before palette arrives.
    document.documentElement.style.setProperty('--koma-bg', document.documentElement.style.getPropertyValue('--koma-bg') || '#0b0e14')
    document.documentElement.style.setProperty('--koma-fg', document.documentElement.style.getPropertyValue('--koma-fg') || '#c8d3f5')
    setStatus(window.__komaScreenBrowserInitial ?? null)
    applyPalette(window.__komaScreenBrowserPalette ?? {})
    const receive = (event: Event) => {
      const next = (event as CustomEvent<ScreenBrowserStatus>).detail
      setStatus(next ?? null)
    }
    const palette = (event: Event) => applyPalette((event as CustomEvent<Record<string, string>>).detail)
    window.addEventListener('koma-screen-browser', receive)
    window.addEventListener('koma-screen-browser-palette', palette)
    return () => {
      window.removeEventListener('koma-screen-browser', receive)
      window.removeEventListener('koma-screen-browser-palette', palette)
    }
  }, [])

  useEffect(() => {
    const active = status?.tabs.find(t => t.id === status.active_tab) ?? status?.tabs.find(t => t.active)
    // Don't clobber while the user is typing in the address bar.
    if (document.activeElement === inputRef.current) return
    setUrlDraft(active?.url ?? '')
  }, [status?.active_tab, status?.tabs])

  // DOM-only overflow chevrons (same pattern as main TabBar — no setState).
  useEffect(() => {
    const el = tabStripRef.current
    if (!el) return
    const sync = () => {
      const left = el.scrollLeft > 1
      const right = el.scrollWidth - el.clientWidth - el.scrollLeft > 1
      if (overflowRef.current.left === left && overflowRef.current.right === right) return
      overflowRef.current = { left, right }
      paintChevron(leftChevronRef.current, left)
      paintChevron(rightChevronRef.current, right)
    }
    let raf = 0
    const schedule = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(sync)
    }
    schedule()
    el.addEventListener('scroll', schedule, { passive: true })
    const ro = new ResizeObserver(schedule)
    ro.observe(el)
    return () => {
      cancelAnimationFrame(raf)
      el.removeEventListener('scroll', schedule)
      ro.disconnect()
    }
  }, [status?.tabs?.length, status?.active_tab])

  const waiting = !!status?.waiting_human
  const tabs = status?.tabs ?? []
  const activeId = status?.active_tab ?? tabs.find(t => t.active)?.id ?? null
  const active = tabs.find(t => t.id === activeId) ?? null
  const loading = !!active?.loading

  const go = () => {
    const raw = urlDraft.trim()
    if (!raw) return
    const url = /^(https?:\/\/|about:)/i.test(raw) ? raw : `https://${raw}`
    setUrlDraft(url)
    post('navigate', { url, tab_id: activeId ?? undefined })
    inputRef.current?.blur()
  }

  const scrollTabs = (dir: -1 | 1) => {
    const el = tabStripRef.current
    if (!el) return
    el.scrollBy({ left: dir * Math.max(120, el.clientWidth * 0.6), behavior: 'smooth' })
  }

  return (
    <main
      className="flex h-full flex-col overflow-hidden text-koma-fg select-none"
      style={{ background: 'var(--koma-bg, #0b0e14)', color: 'var(--koma-fg, #c8d3f5)', height: 'fit-content' }}
    >
      {waiting && (
        <div role="status" className="flex items-center gap-2 border-b border-koma-warn/40 bg-koma-warn/15 px-3 py-1.5 text-[11px]">
          <span className="font-medium">Waiting for you</span>
          <span className="min-w-0 flex-1 truncate opacity-70">
            {status?.waiting_message || 'Finish login / CAPTCHA / 2FA, then continue.'}
          </span>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded border border-koma-border bg-koma-panel px-2 py-0.5 text-[11px] hover:bg-koma-hover"
            onClick={() => post('continue_human')}
          >
            Continue
          </button>
        </div>
      )}

      {/* Tab strip — chevrons like main koma TabBar; + after last tab */}
      <div
        className="flex min-h-0 flex-none items-end gap-0.5 border-b border-koma-border px-1 pt-1"
        style={{ background: 'color-mix(in srgb, var(--koma-fg, #c8d3f5) 4%, var(--koma-bg, #0b0e14))' }}
      >
        <button
          ref={leftChevronRef}
          type="button"
          onClick={() => scrollTabs(-1)}
          aria-label="Scroll tabs left"
          title="Scroll tabs left"
          aria-hidden="true"
          tabIndex={-1}
          className={CHEVRON_OFF}
        >
          <ChevronLeft size={14} />
        </button>
        <div
          ref={tabStripRef}
          className="flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {tabs.length === 0 && (
            <div className="mb-0.5 px-2 py-1 text-[11px] opacity-50">New Tab</div>
          )}
          {tabs.map(tab => (
            <TabChip
              key={tab.id}
              tab={tab}
              active={tab.id === activeId}
              onSelect={() => post('select', { tab_id: tab.id })}
              onClose={() => post('close', { tab_id: tab.id })}
            />
          ))}
          <button
            type="button"
            title="New tab"
            aria-label="New tab"
            className="mb-0.5 flex h-6 w-6 flex-none items-center justify-center rounded opacity-70 hover:bg-koma-hover hover:opacity-100"
            onClick={() => post('open', { url: 'about:blank' })}
          >
            <Plus size={13} />
          </button>
        </div>
        <button
          ref={rightChevronRef}
          type="button"
          onClick={() => scrollTabs(1)}
          aria-label="Scroll tabs right"
          title="Scroll tabs right"
          aria-hidden="true"
          tabIndex={-1}
          className={CHEVRON_OFF}
        >
          <ChevronRight size={14} />
        </button>
      </div>

      {/* Navigation + address bar */}
      <div
        className="flex flex-none items-center gap-1 border-b border-koma-border px-1.5 py-1"
        style={{ background: 'color-mix(in srgb, var(--koma-fg, #c8d3f5) 6%, var(--koma-bg, #0b0e14))' }}
      >
        <IconBtn label="Back" onClick={() => post('back', { tab_id: activeId ?? undefined })}>
          <ArrowLeft size={13} />
        </IconBtn>
        <IconBtn label="Forward" onClick={() => post('forward', { tab_id: activeId ?? undefined })}>
          <ArrowRight size={13} />
        </IconBtn>
        {loading
          ? (
            <IconBtn label="Stop loading" onClick={() => post('stop', { tab_id: activeId ?? undefined })}>
              <Square size={11} />
            </IconBtn>
            )
          : (
            <IconBtn label="Reload" onClick={() => post('reload', { tab_id: activeId ?? undefined })}>
              <RefreshCw size={12} />
            </IconBtn>
            )}
        <form
          className="flex min-w-0 flex-1 items-center gap-1"
          onSubmit={e => { e.preventDefault(); go() }}
        >
          <div
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-koma-border px-2 py-1"
            style={{ background: 'var(--koma-bg, #0b0e14)' }}
          >
            {loading
              ? <LoaderCircle size={12} className="shrink-0 animate-spin text-koma-accent" />
              : <Globe size={12} className="shrink-0 opacity-50" />}
            <input
              ref={inputRef}
              value={urlDraft}
              onChange={e => setUrlDraft(e.target.value)}
              onFocus={e => e.currentTarget.select()}
              onKeyDown={e => {
                if (e.key === 'Escape') {
                  const u = active?.url ?? ''
                  setUrlDraft(u)
                  inputRef.current?.blur()
                }
              }}
              spellCheck={false}
              autoComplete="off"
              className="min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:opacity-40"
              placeholder="Search or enter address"
              aria-label="Address bar"
            />
            {active?.error && (
              <span className="max-w-[8rem] truncate text-[10px] text-koma-error" title={active.error}>
                {active.error}
              </span>
            )}
          </div>
          <button
            type="submit"
            className="rounded-md border border-koma-border px-2 py-1 text-[11px] hover:bg-koma-hover"
            style={{ background: 'color-mix(in srgb, var(--koma-fg, #c8d3f5) 6%, var(--koma-bg, #0b0e14))' }}
          >
            Go
          </button>
        </form>
      </div>
    </main>
  )
}

function TabChip({ tab, active, onSelect, onClose }: {
  tab: ScreenBrowserTab; active: boolean; onSelect: () => void; onClose: () => void
}) {
  return (
    <div
      role="tab"
      aria-selected={active}
      className={`group flex max-w-[14rem] flex-none items-center gap-1 rounded-t-md border border-b-0 px-2 py-1 text-[11px] ${
        active
          ? 'border-koma-border bg-koma-panel'
          : 'border-transparent opacity-60 hover:bg-koma-hover/60 hover:opacity-100'
      }`}
      style={active ? { background: 'color-mix(in srgb, var(--koma-fg, #c8d3f5) 6%, var(--koma-bg, #0b0e14))' } : undefined}
    >
      {/* flex row: global `svg.animate-spin { display:block }` must sit beside the
          title, not stack a new line above it (that grew the chrome strip). */}
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-1 text-left"
        title={tab.url || tab.title}
        onClick={onSelect}
      >
        {tab.loading && <LoaderCircle size={10} className="shrink-0 animate-spin text-koma-accent" />}
        <span className="min-w-0 truncate">{tab.title || tab.url || 'New Tab'}</span>
      </button>
      <button
        type="button"
        aria-label={`Close ${tab.title || 'tab'}`}
        className="flex h-4 w-4 flex-none items-center justify-center rounded opacity-0 hover:bg-koma-hover group-hover:opacity-100"
        onClick={e => { e.stopPropagation(); onClose() }}
      >
        <X size={10} />
      </button>
    </div>
  )
}

function IconBtn({ label, onClick, disabled, children }: {
  label: string; onClick: () => void; disabled?: boolean; children: ReactNode
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      className="flex h-6 w-6 items-center justify-center rounded hover:bg-koma-hover disabled:cursor-not-allowed disabled:opacity-40"
      onClick={onClick}
    >
      {children}
    </button>
  )
}
