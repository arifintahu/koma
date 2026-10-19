'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { GuideStep } from '../guide'

export type { GuideStep }

export function Guide({ steps }: { steps: GuideStep[] }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<{ write: (data: string) => void; reset: () => void; resize: (cols: number, rows: number) => void; cols: number; rows: number; dispose: () => void } | null>(null)
  const stepsRef = useRef(steps)
  stepsRef.current = steps
  const [step, setStep] = useState(0)
  const [ready, setReady] = useState(false)
  const current = steps[Math.min(step, Math.max(steps.length - 1, 0))]
  const total = steps.length

  useEffect(() => {
    const host = containerRef.current
    if (!host) return
    let cancelled = false
    let term: { dispose: () => void } | null = null
    ;(async () => {
      const [{ Terminal }, css] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/xterm/css/xterm.css'),
      ])
      void css
      if (cancelled) return
      const first = stepsRef.current[0]?.frame
      const next = new Terminal({
        cols: first?.cols ?? 80,
        rows: first?.rows ?? 38,
        convertEol: true,
        cursorBlink: false,
        disableStdin: true,
        scrollback: 0,
        fontFamily: "'JetBrains Mono', 'Fira Code', ui-monospace, monospace",
        fontSize: 13,
        lineHeight: 1.25,
        theme: {
          background: '#000000',
          foreground: '#e6e6e6',
          cursor: '#39ff14',
          cursorAccent: '#000000',
          selectionBackground: '#39ff14',
          selectionForeground: '#000000',
          black: '#000000',
          red: '#ff3c3c',
          green: '#39ff14',
          yellow: '#ffb43c',
          blue: '#50c8ff',
          magenta: '#c8d3f5',
          cyan: '#50c8ff',
          white: '#e6e6e6',
          brightBlack: '#adadad',
          brightRed: '#ff3c3c',
          brightGreen: '#00c853',
          brightYellow: '#ffb43c',
          brightBlue: '#50c8ff',
          brightMagenta: '#c8d3f5',
          brightCyan: '#50c8ff',
          brightWhite: '#ffffff',
        },
      })
      next.open(host)
      term = next
      termRef.current = next
      setReady(true)
    })()
    return () => {
      cancelled = true
      term?.dispose()
      termRef.current = null
      setReady(false)
    }
  }, [])

  useEffect(() => {
    const term = termRef.current
    if (!term || !ready || !current) return
    const { cols, rows, ansi } = current.frame
    if (term.cols !== cols || term.rows !== rows) term.resize(cols, rows)
    term.reset()
    term.write(ansi)
  }, [current, ready])

  const prev = useCallback(() => setStep((value) => Math.max(0, value - 1)), [])
  const next = useCallback(() => setStep((value) => Math.min(total - 1, value + 1)), [total])

  useEffect(() => {
    const node = frameRef.current
    if (!node) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
        event.preventDefault()
        prev()
      } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown' || event.key === ' ') {
        event.preventDefault()
        next()
      }
    }
    node.addEventListener('keydown', onKey)
    return () => node.removeEventListener('keydown', onKey)
  }, [prev, next])

  if (!current) return null

  return (
    <div
      ref={frameRef}
      className="koma-guide"
      tabIndex={0}
      role="group"
      aria-label={`${current.title}, step ${step + 1} of ${total}`}
    >
      <div className="koma-guide-bar">
        <span>Step {step + 1} of {total}</span>
        <span className="koma-guide-dots">
          {steps.map((item, index) => (
            <button
              key={item.title + index}
              type="button"
              aria-label={`Go to step ${index + 1}: ${item.title}`}
              className={index === step ? 'is-current' : index < step ? 'is-done' : ''}
              onClick={() => setStep(index)}
            />
          ))}
        </span>
        <strong>{current.title}</strong>
      </div>
      <div className="koma-guide-copy">
        <p>{current.narration}</p>
        {current.points && current.points.length > 0 ? (
          <ul>
            {current.points.map((point) => <li key={point}>{point}</li>)}
          </ul>
        ) : null}
      </div>
      <div className="koma-guide-term">
        <div ref={containerRef} />
      </div>
      <div className="koma-guide-nav">
        <button type="button" onClick={prev} disabled={step === 0}>Previous</button>
        <span>Click here, then use the arrow keys or the space bar</span>
        <button type="button" onClick={next} disabled={step === total - 1}>Next</button>
      </div>
      <p className="koma-guide-note">A sample of the terminal. Nothing here is your conversation.</p>
    </div>
  )
}
