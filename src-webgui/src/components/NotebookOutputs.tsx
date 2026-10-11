import { useEffect, useMemo, useRef } from 'react'
import { Streamdown } from 'streamdown'
import {
  classifyNotebookOutput,
  notebookImageObjectUrl,
  notebookMarkdownComponents,
  type NotebookSafeOutput,
} from '../lib/notebook-output-policy'
import { notebookHtmlSrcdoc } from '../lib/notebook-html'
import { komaCode } from './komaShiki'
import { komaLinkSafety } from './LinkSafetyModal'
import { useKoma } from '../store/koma'
import { luminance } from '../lib/luminance'

function joinText(v: unknown): string | string[] | undefined {
  if (v == null) return undefined
  if (typeof v === 'string' || Array.isArray(v)) return v as string | string[]
  return String(v)
}

function asOutput(raw: unknown): {
  output_type?: string
  name?: string
  text?: string | string[]
  data?: Record<string, unknown>
  ename?: string
  evalue?: string
  traceback?: string[]
} {
  if (!raw || typeof raw !== 'object') return {}
  const o = raw as Record<string, unknown>
  return {
    output_type: typeof o.output_type === 'string' ? o.output_type : undefined,
    name: typeof o.name === 'string' ? o.name : undefined,
    text: joinText(o.text),
    data: o.data && typeof o.data === 'object' ? (o.data as Record<string, unknown>) : undefined,
    ename: typeof o.ename === 'string' ? o.ename : undefined,
    evalue: typeof o.evalue === 'string' ? o.evalue : undefined,
    traceback: Array.isArray(o.traceback) ? o.traceback.map(String) : undefined,
  }
}

function ImageOutput({ bytes, mime }: { bytes: Uint8Array; mime: 'image/png' | 'image/jpeg' }) {
  const url = useMemo(() => notebookImageObjectUrl(bytes, mime), [bytes, mime])
  useEffect(() => () => URL.revokeObjectURL(url), [url])
  return (
    // eslint-disable-next-line jsx-a11y/alt-text
    <img src={url} className="max-h-96 max-w-full object-contain" draggable={false} />
  )
}

function HtmlOutput({ html }: { html: string }) {
  const ref = useRef<HTMLIFrameElement | null>(null)
  const srcdoc = useMemo(() => notebookHtmlSrcdoc(html), [html])
  useEffect(() => {
    const frame = ref.current
    if (!frame) return
    const fit = () => {
      try {
        const doc = frame.contentDocument
        const h = doc?.documentElement?.scrollHeight ?? doc?.body?.scrollHeight
        if (h && h > 0) frame.style.height = `${Math.min(480, Math.max(40, h + 8))}px`
      } catch {
        /* cross-origin shouldn't happen with srcdoc + sandbox without allow-same-origin scripts */
      }
    }
    frame.addEventListener('load', fit)
    fit()
    return () => frame.removeEventListener('load', fit)
  }, [srcdoc])
  return (
    <iframe
      ref={ref}
      title="Notebook HTML output"
      sandbox=""
      referrerPolicy="no-referrer"
      srcDoc={srcdoc}
      className="w-full min-h-[40px] rounded border border-koma-border bg-koma-bg"
    />
  )
}

function SafeOne({ safe }: { safe: NotebookSafeOutput }) {
  const bg = useKoma((s) => s.palette.bg)
  const theme = luminance(bg) >= 0.5 ? 'github-light' : 'github-dark'
  if (safe.kind === 'stream' || safe.kind === 'text' || safe.kind === 'error') {
    return (
      <pre
        className={`m-0 whitespace-pre-wrap break-words font-mono text-[11px] ${
          safe.kind === 'error' ? 'text-koma-error' : 'text-koma-fg'
        }`}
      >
        {safe.text}
      </pre>
    )
  }
  if (safe.kind === 'markdown') {
    return (
      <Streamdown
        className="koma-md text-[12px]"
        mode="static"
        parseIncompleteMarkdown={false}
        plugins={{ code: komaCode }}
        shikiTheme={[theme, theme]}
        lineNumbers={false}
        controls={{ code: { copy: true, download: false }, table: false, mermaid: false }}
        linkSafety={komaLinkSafety}
        components={notebookMarkdownComponents as never}
      >
        {safe.text}
      </Streamdown>
    )
  }
  if (safe.kind === 'image-png' || safe.kind === 'image-jpeg') {
    return <ImageOutput bytes={safe.bytes} mime={safe.kind === 'image-png' ? 'image/png' : 'image/jpeg'} />
  }
  if (safe.kind === 'html') {
    return <HtmlOutput html={safe.html} />
  }
  if (safe.kind === 'html-blocked' || safe.kind === 'unsupported') {
    return (
      <div className="text-[11px] text-koma-dim">
        {safe.kind === 'html-blocked' ? `HTML blocked: ${safe.reason}` : `Unsupported: ${safe.reason}`}
      </div>
    )
  }
  return null
}

/** Shared renderer for disk-restored and live IOPub outputs. */
export function NotebookOutputs({ outputs }: { outputs: unknown[] }) {
  if (!outputs.length) return null
  const safes = outputs.map((raw) => classifyNotebookOutput(asOutput(raw)))
  return (
    <div className="flex flex-col gap-1 border-t border-koma-border bg-koma-bg/40 px-2 py-1.5">
      {safes.map((safe, i) => (
        <div key={i} className="min-w-0 overflow-auto">
          <SafeOne safe={safe} />
        </div>
      ))}
    </div>
  )
}
