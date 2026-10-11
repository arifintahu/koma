import { useState } from 'react'
import { ChevronDown, Globe, ScanEye } from 'lucide-react'
import type { ScreenBrowserObservation } from '../types/screenBrowser'
import { computerImageUrl } from './ComputerPreview'

export function ScreenBrowserObservationCard({ observation: o }: { observation: ScreenBrowserObservation }) {
  const [expanded, setExpanded] = useState(false)
  const [missing, setMissing] = useState(false)
  const src = o.image_path ? computerImageUrl(o.image_path) : null

  return <article className="overflow-hidden rounded-lg border border-koma-border bg-koma-panel/40 text-koma-fg">
    <button type="button" aria-expanded={expanded} onClick={() => setExpanded(v => !v)} className="flex w-full items-center gap-3 p-3 text-left hover:bg-koma-hover">
      <div className="flex h-12 w-20 shrink-0 items-center justify-center overflow-hidden rounded border border-koma-border bg-koma-bg">
        {!src || missing
          ? <Globe size={20} className="text-koma-dim" />
          : <img src={src} alt="" loading="lazy" onError={() => setMissing(true)} className="h-full w-full object-contain" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-[10px] text-koma-dim">
          <ScanEye size={12} /><span>Browser observation</span>
        </div>
        <p className="mt-1 truncate text-[12.5px]">{o.title || o.url || 'Page'}</p>
        <p className="mt-0.5 truncate text-[10px] text-koma-dim">{o.url}</p>
      </div>
      <ChevronDown size={14} className={`shrink-0 text-koma-dim transition-transform ${expanded ? 'rotate-180' : ''}`} />
    </button>
    {expanded && <div className="border-t border-koma-border">
      {!src || missing
        ? <p className="p-4 text-xs text-koma-dim">This saved frame is no longer available.</p>
        : <img src={src} alt={o.title || o.url} loading="lazy" onError={() => setMissing(true)} className="max-h-[65vh] w-full object-contain" />}
      <div className="border-t border-koma-border px-3 py-2 text-[11px] leading-relaxed text-koma-dim">
        <details>
          <summary className="cursor-pointer">Observation details</summary>
          <p className="mt-2 break-all">Tab: {o.tab_id}</p>
          <p className="mt-1 break-all">Observation: {o.id}</p>
          <p className="mt-1 break-all">URL: {o.url}</p>
        </details>
      </div>
    </div>}
  </article>
}
