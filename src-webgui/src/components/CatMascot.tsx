import { Component, Suspense, lazy, type ReactNode } from 'react'

// Persistent mascot pinned at the composer's top-right corner: a small
// (~48px) rounded box. Two states only — rolling while `session.working`
// (streaming / thinking), black cat when idle. Degrades to a bare pulse if
// no animations bundled or the player throws.

const CatMascotLottie = lazy(() => import('./CatMascotLottie'))

function Pulse() {
  return (
    <div className="h-full w-full animate-pulse rounded-xl bg-koma-accent/30" aria-label="koma" />
  )
}

// Isolates any lottie-react runtime failure so the mascot box degrades to the
// pulse instead of crashing the composer.
class MascotBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? <Pulse /> : this.props.children
  }
}

export function CatMascot({ working }: { working: boolean }) {
  return (
    <div
      className="flex h-12 w-12 flex-none items-center justify-center overflow-hidden rounded-2xl border border-koma-border bg-koma-panel2 p-1.5 shadow-sm"
      aria-hidden="true"
    >
      <MascotBoundary>
        <Suspense fallback={<Pulse />}>
          <CatMascotLottie working={working} />
        </Suspense>
      </MascotBoundary>
    </div>
  )
}
