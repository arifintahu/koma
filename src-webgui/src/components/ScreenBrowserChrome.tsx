import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import {
  ArrowLeft,
  ArrowRight, Camera, ChevronLeft, ChevronRight, FileImage, LoaderCircle, Plus, RefreshCw, Square, X,
} from 'lucide-react'
import type { ScreenBrowserStatus, ScreenBrowserTab } from '../types/screenBrowser'

type SbAction =
  | 'navigate' | 'open' | 'close' | 'select' | 'reload' | 'back' | 'forward' | 'stop'
  | 'shot' | 'shot_full'
  | 'continue_human'
  | 'win_drag' | 'win_min' | 'win_max' | 'win_close'

function post(action: SbAction, extra?: { url?: string; tab_id?: string }) {
  window.ipc?.postMessage(JSON.stringify({ t: 'sb', a: action, ...extra }))
}

function applyPalette(palette: Record<string, unknown> | null | undefined) {
  if (!palette || typeof palette !== 'object') return
  // Same roles as main GUI `applyPaletteVars` (store/initial.ts) / ComputerViewer.
  const root = document.documentElement.style
  for (const key of ['bg', 'fg', 'dim', 'accent', 'panel', 'warn', 'success', 'info', 'error'] as const) {
    const color = palette[key]
    if (typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color)) {
      root.setProperty(`--koma-${key}`, color)
    }
  }
  if (typeof palette.dark === 'boolean') {
    document.documentElement.dataset.theme = palette.dark ? 'dark' : 'light'
  }
}

function platformOs(): 'macos' | 'linux' | 'windows' {
  const os = window.__komaOS
  return os === 'macos' || os === 'windows' ? os : 'linux'
}

const CHEVRON_ON =
  'mb-0 flex h-7 w-5 flex-none items-center justify-center rounded text-koma-fg opacity-60 hover:bg-koma-hover hover:opacity-100'
const CHEVRON_OFF =
  'mb-0 flex h-7 w-5 flex-none items-center justify-center rounded text-koma-fg pointer-events-none opacity-0'

function paintChevron(button: HTMLButtonElement | null, enabled: boolean) {
  if (!button) return
  button.disabled = !enabled
  button.tabIndex = enabled ? 0 : -1
  button.setAttribute('aria-hidden', enabled ? 'false' : 'true')
  button.className = enabled ? CHEVRON_ON : CHEVRON_OFF
}

/**
 * Frameless Chrome-like strip: traffic lights + tabs in the title drag region,
 * then nav + address bar. Theme tokens come from the host palette.
 */
export function ScreenBrowserChrome() {
  const [status, setStatus] = useState<ScreenBrowserStatus | null>(window.__komaScreenBrowserInitial ?? null)
  const [urlDraft, setUrlDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const tabStripRef = useRef<HTMLDivElement>(null)
  const leftChevronRef = useRef<HTMLButtonElement>(null)
  const rightChevronRef = useRef<HTMLButtonElement>(null)
  const overflowRef = useRef({ left: false, right: false })
  const os = platformOs()

  useEffect(() => {
    document.documentElement.style.setProperty('--koma-bg', document.documentElement.style.getPropertyValue('--koma-bg') || '#0b0e14')
    document.documentElement.style.setProperty('--koma-fg', document.documentElement.style.getPropertyValue('--koma-fg') || '#c8d3f5')
    document.documentElement.classList.add(`os-${os}`)
    // Match main app canvas rounding on macOS frameless windows.
    document.documentElement.style.background = 'transparent'
    if (document.body) document.body.style.background = 'transparent'
    setStatus(window.__komaScreenBrowserInitial ?? null)
    applyPalette(window.__komaScreenBrowserPalette as Record<string, unknown> | undefined)
    const receive = (event: Event) => {
      const next = (event as CustomEvent<ScreenBrowserStatus>).detail
      setStatus(next ?? null)
    }
    const palette = (event: Event) => applyPalette((event as CustomEvent<Record<string, unknown>>).detail)
    window.addEventListener('koma-screen-browser', receive)
    window.addEventListener('koma-screen-browser-palette', palette)
    return () => {
      window.removeEventListener('koma-screen-browser', receive)
      window.removeEventListener('koma-screen-browser-palette', palette)
    }
  }, [os])

  useEffect(() => {
    const active = status?.tabs.find(t => t.id === status.active_tab) ?? status?.tabs.find(t => t.active)
    if (document.activeElement === inputRef.current) return
    setUrlDraft(active?.url ?? '')
  }, [status?.active_tab, status?.tabs])

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

  const openNewTab = () => {
    post('open', { url: 'about:blank' })
    setUrlDraft('')
    queueMicrotask(() => {
      inputRef.current?.focus()
    })
  }

  /** Empty chrome / tab gutter starts a window drag (not buttons / inputs). */
  function handleTitleDrag(e: MouseEvent<HTMLElement>) {
    if (e.button !== 0) return
    const target = e.target as HTMLElement
    if (target.closest('button, a, input, [data-no-drag]')) return
    if (e.detail === 2) {
      post('win_max')
      return
    }
    post('win_drag')
  }

  return (
    <main
      className="sb-chrome flex flex-col overflow-hidden bg-koma-bg text-koma-fg select-none"
      style={{
        height: 'fit-content',
        width: '100%',
        borderTopLeftRadius: os === 'macos' ? 12 : 10,
        borderTopRightRadius: os === 'macos' ? 12 : 10,
      }}
    >
      {waiting && (
        <div role="status" className="flex items-center gap-2 border-b border-koma-warn/40 bg-koma-warn/15 px-3 py-1.5 text-[11px] text-koma-fg">
          <span className="font-medium">Waiting for you</span>
          <span className="min-w-0 flex-1 truncate text-koma-dim">
            {status?.waiting_message || 'Finish login / CAPTCHA / 2FA, then continue.'}
          </span>
          <button
            type="button"
            data-no-drag
            className="inline-flex items-center gap-1 rounded border border-koma-border bg-koma-panel px-2 py-0.5 text-[11px] text-koma-fg hover:bg-koma-hover"
            onClick={() => post('continue_human')}
          >
            Continue
          </button>
        </div>
      )}

      {/* Title tab strip — gutter is the drag region; only chips/buttons block drag. */}
      <div
        className="sb-titlebar flex min-h-0 flex-none items-end gap-1 bg-koma-panel2 px-1.5 pt-1.5"
        onMouseDown={handleTitleDrag}
      >
        <div
          id="winctl"
          className={`mb-1.5 flex flex-none items-center ${os === 'macos' ? 'order-first gap-2 pl-1 pr-2' : 'order-last gap-0.5 pl-1'}`}
          data-no-drag
        >
          {os === 'macos'
            ? (
              <>
                <button type="button" id="btn-close" className="sb-traffic sb-close" aria-label="Close" title="Close" onClick={() => post('win_close')} />
                <button type="button" id="btn-min" className="sb-traffic sb-min" aria-label="Minimize" title="Minimize" onClick={() => post('win_min')} />
                <button type="button" id="btn-max" className="sb-traffic sb-max" aria-label="Maximize" title="Maximize" onClick={() => post('win_max')} />
              </>
              )
            : (
              <>
                <button type="button" className="sb-winbtn" aria-label="Minimize" title="Minimize" onClick={() => post('win_min')}>&#x2013;</button>
                <button type="button" className="sb-winbtn" aria-label="Maximize" title="Maximize" onClick={() => post('win_max')}>&#x2610;</button>
                <button type="button" className="sb-winbtn sb-winclose" aria-label="Close" title="Close" onClick={() => post('win_close')}>&#x2715;</button>
              </>
              )}
        </div>

        <button
          ref={leftChevronRef}
          type="button"
          data-no-drag
          onClick={() => scrollTabs(-1)}
          aria-label="Scroll tabs left"
          title="Scroll tabs left"
          aria-hidden="true"
          tabIndex={-1}
          className={CHEVRON_OFF}
        >
          <ChevronLeft size={14} />
        </button>

        {/* flex-1 strip: tabs hug content; leftover gray is window-drag (no data-no-drag). */}
        <div
          ref={tabStripRef}
          className="flex min-w-0 flex-1 items-end gap-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {tabs.length === 0 && (
            <div className="mb-0 px-3 py-1.5 text-[11px] text-koma-dim">New Tab</div>
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
            data-no-drag
            className="mb-1 ml-0.5 flex h-6 w-6 flex-none items-center justify-center rounded-md text-koma-dim hover:bg-koma-hover hover:text-koma-fg"
            onClick={openNewTab}
          >
            <Plus size={14} />
          </button>
        </div>

        <button
          ref={rightChevronRef}
          type="button"
          data-no-drag
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

      {/* Navigation + address bar — sits on canvas bg like main content under TabBar */}
      <div className="flex flex-none items-center gap-1 bg-koma-bg px-2 py-1.5">
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
          <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-full bg-koma-panel2 px-3 py-1">
            {loading
              ? <LoaderCircle size={12} className="shrink-0 animate-spin text-koma-accent" />
              : (
                <img
                  src="koma://localhost/product-icon.png"
                  alt=""
                  width={12}
                  height={12}
                  className="shrink-0 rounded-[3px] opacity-90"
                  draggable={false}
                />
                )}
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
              className="min-w-0 flex-1 bg-transparent text-[12px] text-koma-fg outline-none ring-0 placeholder:text-koma-dim placeholder:opacity-70 focus:outline-none focus:ring-0"
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
            className="rounded-full bg-koma-panel px-3 py-1 text-[11px] text-koma-fg hover:bg-koma-hover"
          >
            Go
          </button>
          <IconBtn
            label="SS"
            onClick={() => post('shot', { tab_id: activeId ?? undefined })}
          >
            <Camera size={13} />
          </IconBtn>
          <IconBtn
            label="SS whole page"
            onClick={() => post('shot_full', { tab_id: activeId ?? undefined })}
          >
            <FileImage size={13} />
          </IconBtn>
        </form>
      </div>

      <style>{`
        .sb-traffic {
          width: 12px; height: 12px; border-radius: 50%; border: none; padding: 0;
          cursor: pointer; flex: none;
        }
        .sb-close { background: #ff5f57; }
        .sb-min { background: #febc2e; }
        .sb-max { background: #28c840; }
        .sb-traffic:hover { filter: brightness(0.92); }
        .sb-winbtn {
          width: 34px; height: 24px; border: none; background: transparent;
          color: var(--koma-fg, #c8d3f5); font-size: 13px; line-height: 1;
          cursor: pointer; border-radius: 4px;
          display: flex; align-items: center; justify-content: center;
        }
        .sb-winbtn:hover { background: var(--color-koma-hover); }
        .sb-winclose:hover { background: #e81123; color: #fff; }
      `}</style>
    </main>
  )
}

function isBlankTab(tab: ScreenBrowserTab): boolean {
  const u = (tab.url || '').trim().toLowerCase()
  return !u || u === 'about:blank' || u.starts_with('about:blank?')
}

function TabChip({ tab, active, onSelect, onClose }: {
  tab: ScreenBrowserTab; active: boolean; onSelect: () => void; onClose: () => void
}) {
  // Mirror main TabBar active language — no border/outline, just fill + hairline.
  const blank = isBlankTab(tab)
  return (
    <div
      role="tab"
      aria-selected={active}
      data-no-drag
      className={`group relative flex min-w-[200px] max-w-[14rem] flex-none items-center gap-1.5 rounded-t-md px-2.5 py-1.5 text-[12px] transition-colors outline-none ring-0 ${
        active
          ? 'z-[1] bg-koma-bg text-koma-fg'
          : 'text-koma-dim hover:bg-koma-hover hover:text-koma-fg'
      }`}
    >
      {active && <span className="absolute inset-x-1 top-0 h-0.5 rounded-full bg-koma-fg/80" aria-hidden />}
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left outline-none ring-0 focus:outline-none"
        title={tab.url || tab.title}
        onClick={onSelect}
      >
        {tab.loading
          ? <LoaderCircle size={11} className="shrink-0 animate-spin text-koma-accent" />
          : (
            <img
              src="koma://localhost/product-icon.png"
              alt=""
              width={12}
              height={12}
              className={`shrink-0 rounded-[3px] ${active ? 'opacity-95' : 'opacity-70'}`}
              draggable={false}
            />
            )}
        <span className="min-w-0 truncate">{blank ? (tab.title || 'New Tab') : (tab.title || tab.url || 'New Tab')}</span>
      </button>
      <button
        type="button"
        aria-label={`Close ${tab.title || 'tab'}`}
        className={`flex h-4 w-4 flex-none items-center justify-center rounded outline-none transition hover:bg-koma-hover hover:!opacity-100 focus:outline-none ${
          active ? 'opacity-70' : 'opacity-0 group-hover:opacity-70'
        }`}
        onClick={e => { e.stopPropagation(); onClose() }}
      >
        <X size={11} />
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
      className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-koma-hover disabled:cursor-not-allowed disabled:opacity-40"
      onClick={onClick}
    >
      {children}
    </button>
  )
}
