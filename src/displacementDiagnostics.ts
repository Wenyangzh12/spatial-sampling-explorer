import type { Point } from './mockData'

export type DisplacementSummary = {
  count: number
  positiveCount: number
  negativeCount: number
  zeroCount: number
  min: number
  max: number
  mean: number
  maxPositive: number
  maxNegativeMag: number
}

/**
 * Aggregate displacement stats for diagnostics (full dataset, viewport, decimated, etc.).
 */
export function summarizeDisplacement(points: Point[]): DisplacementSummary {
  let positiveCount = 0
  let negativeCount = 0
  let zeroCount = 0
  let min = Infinity
  let max = -Infinity
  let sum = 0
  let maxPositive = 0
  let maxNegativeMag = 0

  for (const p of points) {
    const d = p.displacement
    sum += d
    if (d > 0) {
      positiveCount++
      maxPositive = Math.max(maxPositive, d)
    } else if (d < 0) {
      negativeCount++
      maxNegativeMag = Math.max(maxNegativeMag, -d)
    } else {
      zeroCount++
    }
    min = Math.min(min, d)
    max = Math.max(max, d)
  }

  const n = points.length
  return {
    count: n,
    positiveCount,
    negativeCount,
    zeroCount,
    min: n === 0 ? 0 : min,
    max: n === 0 ? 0 : max,
    mean: n === 0 ? 0 : sum / n,
    maxPositive,
    maxNegativeMag,
  }
}
