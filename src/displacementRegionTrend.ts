import type { Strategy, ViewportBounds } from './decimate'

export type RegionSelection = {
  minX: number
  minY: number
  maxX: number
  maxY: number
  selectedPointCount: number
}

export type MonthlyDisplacementRecord = {
  month: string
  averageDisplacement: number
}

const MONTH_LABELS = [
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
  'Jan',
  'Feb',
  'Mar',
] as const

/**
 * Map viewport as region: x = longitude, y = latitude (WGS84).
 */
export function regionSelectionFromViewport(
  bounds: ViewportBounds,
  selectedPointCount: number,
): RegionSelection {
  return {
    minX: bounds.west,
    maxX: bounds.east,
    minY: bounds.south,
    maxY: bounds.north,
    selectedPointCount,
  }
}

/** ~square degrees; used for UI copy. */
export function regionAreaSqDeg(r: RegionSelection): number {
  return Math.abs((r.maxX - r.minX) * (r.maxY - r.minY))
}

export function regionAreaSqDegFromBounds(b: ViewportBounds): number {
  return Math.abs((b.east - b.west) * (b.north - b.south))
}

/**
 * Deterministic, ~uniform on [-0.5, 0.5] (symmetric around 0 per draw).
 * Avoids `|sin|` bias that skewed some strategy seeds high or low.
 */
function symmetricSeededNoise(seed: string, index: number): number {
  let h = 2166136261
  const value = `${seed}|${index}`
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  const u = (h >>> 0) / 0x1_0000_0000
  return u - 0.5
}

function mean12(values: number[]): number {
  let s = 0
  for (const v of values) s += v
  return s / values.length
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * Relative sampling-noise amplitude (strategy only). Shared base trend is unchanged across strategies.
 * Order: original (lowest) → topology → hybrid → blueNoise → grid → random (highest).
 */
const STRATEGY_NOISE_SIGMA: Record<Strategy, number> = {
  original: 0.11,
  topology: 0.17,
  hybrid: 0.32,
  blueNoise: 0.39,
  grid: 0.5,
  random: 0.68,
}

function strategyNoiseSigma(strategy: Strategy | undefined): number {
  const key = strategy ?? 'original'
  return STRATEGY_NOISE_SIGMA[key]
}

/** Circular 3-tap smoothing (Apr→Mar) for plausible month-to-month continuity. */
function smoothCircular(values: number[]): number[] {
  const n = values.length
  return values.map((_, i) => {
    const p = values[(i - 1 + n) % n]!
    const c = values[i]!
    const nx = values[(i + 1) % n]!
    return 0.22 * p + 0.56 * c + 0.22 * nx
  })
}

/** Zero-mean over the 12 months so strategy noise cannot lift or depress the whole series. */
function zeroMeanOverYear(values: number[]): number[] {
  const m = mean12(values)
  return values.map((v) => v - m)
}

/**
 * Shared mock displacement shape for a geographic region only (no strategy, no sample count).
 */
function sharedBaseMonthlyValues(
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): { baseLevel: number; perMonth: { seasonal: number; drift: number }[] } {
  const centerX = (minX + maxX) / 2
  const centerY = (minY + maxY) / 2
  const area = Math.max((maxX - minX) * (maxY - minY), 1)

  const baseLevel =
    4 +
    (Math.abs(centerX * 0.0001) % 2) +
    (Math.abs(centerY * 0.0001) % 2) +
    Math.log10(area + 1) * 0.32

  const perMonth = MONTH_LABELS.map((_, index) => ({
    seasonal: Math.sin((index / 12) * Math.PI * 2) * 0.58,
    drift: (index - 5.5) * 0.078,
  }))

  return { baseLevel, perMonth }
}

/**
 * Demo-only deterministic mock: one shared geographic trend per region; `strategy` scales
 * noise amplitude only. Noise is forced to ~zero mean over the year so strategies do not
 * appear systematically higher or lower than the base signal.
 */
export function simulateRegionDisplacementTrend(
  region: RegionSelection,
  strategy?: Strategy,
): MonthlyDisplacementRecord[] {
  const { minX, minY, maxX, maxY } = region
  const area = Math.max((maxX - minX) * (maxY - minY), 1)
  const geoKey = `${minX}|${minY}|${maxX}|${maxY}`
  const stratKey = strategy ?? 'original'

  const { baseLevel, perMonth } = sharedBaseMonthlyValues(
    minX,
    minY,
    maxX,
    maxY,
  )

  const sigma = strategyNoiseSigma(strategy)
  const areaNoiseScale = clamp(
    1.12 - Math.log10(area + 1) * 0.035,
    0.9,
    1.1,
  )

  const rawNoise = MONTH_LABELS.map((_, index) =>
    symmetricSeededNoise(`${geoKey}|noise|${stratKey}`, index),
  )
  let shaped = smoothCircular(smoothCircular(rawNoise))
  shaped = zeroMeanOverYear(shaped)
  shaped = smoothCircular(shaped)
  shaped = zeroMeanOverYear(shaped)

  return MONTH_LABELS.map((month, index) => {
    const { seasonal, drift } = perMonth[index]!
    const noise = shaped[index]! * sigma * areaNoiseScale
    const averageDisplacement = Number(
      Math.max(baseLevel + seasonal + drift + noise, 0).toFixed(2),
    )
    return { month, averageDisplacement }
  })
}
