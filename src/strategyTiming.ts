/** Format decimate() duration for display (milliseconds). */
export function formatComputeMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1) return `${ms.toFixed(2)} ms`
  if (ms < 10) return `${ms.toFixed(1)} ms`
  return `${Math.round(ms)} ms`
}

/** Smallest timing in a cohort; safe denominator for multipliers. */
export function baselineMsForPeers(msList: number[]): number {
  const finite = msList.filter((m) => Number.isFinite(m) && m >= 0)
  if (finite.length === 0) return 1
  const m = Math.min(...finite)
  return m < 1e-9 ? 1e-9 : m
}

/**
 * Cost vs fastest strategy in the same run (1× = fastest).
 * Examples: 1×, 2.3×, 17×
 */
export function formatRelativeMultiplier(ms: number, baselineMs: number): string {
  if (!Number.isFinite(ms) || baselineMs <= 0) return '—'
  const r = ms / baselineMs
  if (r <= 1.001) return '1×'
  if (r < 10) {
    const rounded = Math.round(r * 10) / 10
    return Number.isInteger(rounded) ? `${rounded}×` : `${rounded.toFixed(1)}×`
  }
  return `${Math.round(r)}×`
}

/**
 * Subtle "slower" hint: clearly above peers or an absolute floor.
 * Tuned for demo-scale timings — not alarming.
 */
export function slowComputeHint(ms: number, peerMs: number[]): boolean {
  if (ms < 45 || peerMs.length === 0) return false
  const sorted = [...peerMs].sort((a, b) => a - b)
  const mid = sorted[Math.floor(sorted.length / 2)]!
  return ms >= Math.max(95, mid * 2.15)
}
