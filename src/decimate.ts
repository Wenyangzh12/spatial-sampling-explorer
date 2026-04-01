import {
  type Point,
  distanceToSyntheticLineDeg,
  isLineStructuralPoint,
  LINE_STRUCTURAL_MAX_DEG,
  syntheticLineParameterT,
} from './mockData'
import L from 'leaflet'

/**
 * Hybrid: line-corridor budget as a fraction of total target (remainder = density-aware basin).
 * Uses ~17.5% (within the 15–20% range).
 */
const HYBRID_STRUCT_SHARE_OF_TARGET = 0.175

export type Strategy =
  | 'original'
  | 'random'
  | 'grid'
  | 'hybrid'
  | 'blueNoise'
  | 'topology'

/**
 * Weighted blue-noise: importance = densityWeight * density + lineWeight * exp(-dLine/sigma).
 * lineWeight >= densityWeight so the spine can compete locally (probabilistic acceptance).
 */
const BN_DENSITY_WEIGHT = 0.42
const BN_LINE_WEIGHT = 0.58
const BN_LINE_SIGMA_DEG = LINE_STRUCTURAL_MAX_DEG * 2.85
const BN_EPS_IMPORTANCE = 0.05
const BN_HASH_SALT_SORT0 = 0x6b8e9d2f
const BN_HASH_SALT_ACCEPT = 0x2d7f3a91

/** Topology-aware: k-NN graph size cap (MST + backbone) for responsiveness. */
const TOPO_GRAPH_POINT_CAP = 13_000
const TOPO_KNN_K = 8
const TOPO_KNN_CELL_MULT = 1.15
const TOPO_MST_SHORT_EDGE_FRAC = 0.5
/**
 * Seed budget (MST core + corridor): enough for continuity; remainder = city-like fill.
 */
const TOPO_BACKBONE_MAX_FRAC = 0.46
/** MST corridor add-on: keep line thin vs surrounding density. */
const TOPO_CORRIDOR_WEIGHT = 0.34
/** Corridor seed band: include points with dMST < R_SEED_FRAC * sigma. */
const TOPO_CORRIDOR_SEED_FRAC = 1.12
/** Topology base: density-dominant blend (line is support, not hero). */
const TOPO_BASE_DENSITY_FRAC = 0.7
const TOPO_BASE_LINE_FRAC = 0.3
/** Screen-center basin so the urban core reads again. */
const TOPO_BASIN_K = 2.05
const TOPO_BASIN_WEIGHT = 0.34

/**
 * Viewport in WGS84, from Leaflet `map.getBounds()`:
 * south/west/north/east === getSouth(), getWest(), getNorth(), getEast().
 */
export type ViewportBounds = {
  south: number
  west: number
  north: number
  east: number
}

/**
 * Geographic region (WGS84), persisted for map selection.
 * Same corners as Leaflet `LatLngBounds`: `L.latLngBounds([south, west], [north, east])`.
 */
export type GeographicRegionBounds = ViewportBounds

/** Bounds + zoom from the map (`getBounds`, `getZoom`). */
export type MapView = {
  bounds: ViewportBounds
  zoom: number
}

/** Used in App before the map has reported a view. */
export const FALLBACK_MAP_ZOOM = 10.5

/** Fair comparison: non-original strategies aim for `floor(points.length * retentionRatio)`. */
export type DecimateOptions = {
  retentionRatio?: number
}

export const RETENTION_RATIO_MIN = 0.01
export const RETENTION_RATIO_MAX = 0.2
export const DEFAULT_RETENTION_RATIO = 0.1

/**
 * Target retained count from full input size and retention ratio (Original is exempt).
 */
export function targetCountFromRetention(
  originalPointCount: number,
  retentionRatio: number,
): number {
  if (originalPointCount <= 0) return 0
  return Math.min(
    originalPointCount,
    Math.floor(originalPointCount * retentionRatio),
  )
}

/**
 * Zoom-adaptive target for Grid (screen-space decimation).
 */
export function getAdaptiveTargetCount(zoom: number): number {
  if (zoom < 10) return 800
  if (zoom < 11.5) return 1_500
  if (zoom < 13) return 3_000
  return 5_000
}

/**
 * Random decimation uses ~25% fewer points than grid so structural loss reads more clearly.
 */
export function getRandomAdaptiveTargetCount(zoom: number): number {
  return Math.max(1, Math.floor(getAdaptiveTargetCount(zoom) * 0.75))
}

function subsampleEvenly(points: Point[], max: number): Point[] {
  if (points.length <= max) return points
  const step = points.length / max
  const out: Point[] = []
  for (let k = 0; k < max; k++) {
    out.push(points[Math.floor(k * step)]!)
  }
  return out
}

/** Partial shuffle: uniformly random `k` elements without replacement. */
function sampleRandomK(points: Point[], k: number): Point[] {
  if (k <= 0) return []
  if (k >= points.length) return [...points]
  const copy = [...points]
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(Math.random() * (copy.length - i))
    const t = copy[i]!
    copy[i] = copy[j]!
    copy[j] = t
  }
  return copy.slice(0, k)
}

/**
 * Hamilton / largest-remainder quotas: sum(quota) == effTarget, each quota <= cellCount.
 * Optionally lifts sparse non-empty cells to 1 sample when budget allows (density-aware min).
 */
function allocateDensityQuotas(
  cellLists: Map<string, Point[]>,
  target: number,
): Map<string, number> {
  const quotas = new Map<string, number>()
  const entries = [...cellLists.entries()].filter(([, arr]) => arr.length > 0)
  const totalPoints = entries.reduce((s, [, a]) => s + a.length, 0)
  if (totalPoints === 0 || target === 0) return quotas

  const effTarget = Math.min(target, totalPoints)

  type Cell = { key: string; cnt: number; r: number }
  const cells: Cell[] = entries.map(([key, arr]) => ({
    key,
    cnt: arr.length,
    r: (arr.length / totalPoints) * effTarget,
  }))

  const base = new Map<string, number>()
  let sumFloor = 0
  const fracs: { key: string; f: number; cnt: number }[] = []
  for (const { key, cnt, r } of cells) {
    const fl = Math.floor(r)
    base.set(key, fl)
    sumFloor += fl
    fracs.push({ key, f: r - fl, cnt })
  }

  let leftover = effTarget - sumFloor
  fracs.sort((a, b) => b.f - a.f)
  for (const { key, cnt } of fracs) {
    if (leftover <= 0) break
    const cur = base.get(key)!
    if (cur < cnt) {
      base.set(key, cur + 1)
      leftover--
    }
  }

  while (leftover > 0) {
    let progressed = false
    for (const { key, cnt } of fracs) {
      if (leftover <= 0) break
      const cur = base.get(key)!
      if (cur < cnt) {
        base.set(key, cur + 1)
        leftover--
        progressed = true
      }
    }
    if (!progressed) break
  }

  for (const { key, cnt } of cells) {
    quotas.set(key, Math.min(base.get(key)!, cnt))
  }

  let sum = [...quotas.values()].reduce((a, b) => a + b, 0)
  while (sum < effTarget) {
    let progressed = false
    for (const { key, cnt } of cells) {
      if (sum >= effTarget) break
      const q = quotas.get(key)!
      if (q < cnt) {
        quotas.set(key, q + 1)
        sum++
        progressed = true
      }
    }
    if (!progressed) break
  }

  /** At least one sample per non-empty cell when budget allows (prefers denser cells). */
  sum = [...quotas.values()].reduce((a, b) => a + b, 0)
  const byDense = [...cells].sort((a, b) => b.cnt - a.cnt)
  for (const { key, cnt } of byDense) {
    if (sum >= effTarget) break
    const q = quotas.get(key)!
    if (q === 0 && cnt > 0) {
      quotas.set(key, 1)
      sum++
    }
  }

  sum = [...quotas.values()].reduce((a, b) => a + b, 0)
  while (sum > effTarget) {
    const candidates = [...quotas.entries()]
      .filter(([, q]) => q > 0)
      .sort((a, b) => b[1] - a[1])
    if (candidates.length === 0) break
    const [k, q] = candidates[0]!
    quotas.set(k, q - 1)
    sum--
  }

  return quotas
}

function mergeDensitySample(
  cellLists: Map<string, Point[]>,
  quotas: Map<string, number>,
): Point[] {
  const out: Point[] = []
  for (const [key, arr] of cellLists) {
    const q = quotas.get(key) ?? 0
    if (q <= 0 || arr.length === 0) continue
    out.push(...sampleRandomK(arr, Math.min(q, arr.length)))
  }
  return out
}

function partitionScreen(
  points: Point[],
  map: L.Map,
  cellSize: number,
): Map<string, Point[]> {
  const cellLists = new Map<string, Point[]>()
  for (const p of points) {
    const pt = map.latLngToContainerPoint(L.latLng(p.lat, p.lng))
    const key = `${Math.floor(pt.x / cellSize)},${Math.floor(pt.y / cellSize)}`
    let arr = cellLists.get(key)
    if (!arr) {
      arr = []
      cellLists.set(key, arr)
    }
    arr.push(p)
  }
  return cellLists
}

/** Density-aware grid: quota ∝ cell count; random sample within each cell. */
function gridScreenSpace(points: Point[], map: L.Map, target: number): Point[] {
  if (points.length === 0) return []
  const size = map.getSize()
  if (size.x <= 0 || size.y <= 0) {
    return subsampleEvenly(points, Math.min(target, points.length))
  }

  if (points.length <= target) return [...points]

  let cellSize = 14
  let best: Point[] = []
  let bestErr = Infinity

  for (let iter = 0; iter < 30; iter++) {
    cellSize = clamp(cellSize, 4, 280)
    const cells = partitionScreen(points, map, cellSize)
    const quotas = allocateDensityQuotas(cells, target)
    const sample = mergeDensitySample(cells, quotas)
    const err = Math.abs(sample.length - target)
    if (err < bestErr) {
      bestErr = err
      best = sample
    }
    if (sample.length <= Math.ceil(target * 1.06) && sample.length >= Math.floor(target * 0.88)) {
      return sample
    }
    if (sample.length > target) {
      cellSize *= 1.06
    } else {
      cellSize *= 0.94
    }
  }

  if (best.length === 0) {
    const cells = partitionScreen(points, map, 14)
    const quotas = allocateDensityQuotas(cells, target)
    best = mergeDensitySample(cells, quotas)
  }

  if (best.length > target) {
    return sampleRandomK(best, target)
  }
  if (best.length < target) {
    const need = target - best.length
    const picked = new Set(best.map((p) => p.id))
    const rest = points.filter((p) => !picked.has(p.id))
    best = best.concat(sampleRandomK(rest, Math.min(need, rest.length)))
  }
  return best
}

function gridLatLngFallback(points: Point[], target: number): Point[] {
  if (points.length === 0) return []
  if (points.length <= target) return [...points]

  let minLat = Infinity
  let maxLat = -Infinity
  let minLng = Infinity
  let maxLng = -Infinity
  for (const p of points) {
    minLat = Math.min(minLat, p.lat)
    maxLat = Math.max(maxLat, p.lat)
    minLng = Math.min(minLng, p.lng)
    maxLng = Math.max(maxLng, p.lng)
  }
  const latSpan = maxLat - minLat || 1
  const lngSpan = maxLng - minLng || 1

  let gridN = Math.max(
    6,
    Math.round(Math.sqrt((points.length / Math.max(target, 1)) * 1.05)),
  )
  gridN = Math.min(gridN, 220)

  const partitionLng = (gn: number) => {
    const cellLists = new Map<string, Point[]>()
    for (const p of points) {
      const c = Math.min(
        gn - 1,
        Math.floor(((p.lng - minLng) / lngSpan) * gn),
      )
      const r = Math.min(
        gn - 1,
        Math.floor(((p.lat - minLat) / latSpan) * gn),
      )
      const key = `${c},${r}`
      let arr = cellLists.get(key)
      if (!arr) {
        arr = []
        cellLists.set(key, arr)
      }
      arr.push(p)
    }
    return cellLists
  }

  let best: Point[] = []
  let bestErr = Infinity

  for (let k = 0; k < 28; k++) {
    gridN = clamp(gridN, 4, 240)
    const cells = partitionLng(gridN)
    const quotas = allocateDensityQuotas(cells, target)
    const sample = mergeDensitySample(cells, quotas)
    const err = Math.abs(sample.length - target)
    if (err < bestErr) {
      bestErr = err
      best = sample
    }
    if (sample.length <= Math.ceil(target * 1.06) && sample.length >= Math.floor(target * 0.88)) {
      return sample
    }
    if (sample.length > target) {
      gridN = Math.max(4, gridN - 1)
    } else {
      gridN = Math.min(240, gridN + 1)
    }
  }

  if (best.length > target) return sampleRandomK(best, target)
  if (best.length < target && best.length > 0) {
    const need = target - best.length
    const picked = new Set(best.map((p) => p.id))
    const rest = points.filter((p) => !picked.has(p.id))
    best = best.concat(sampleRandomK(rest, Math.min(need, rest.length)))
  }
  return best
}

function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n))
}

/**
 * Structural (line-corridor) subsample: even coverage along the synthetic line, preferring
 * points closest to the spine (thinner stroke, continuity).
 */
function sampleStructuralAlongLine(points: Point[], cap: number): Point[] {
  if (cap <= 0 || points.length === 0) return []
  if (points.length <= cap) {
    return [...points].sort(
      (a, b) =>
        syntheticLineParameterT(a.lat, a.lng) -
        syntheticLineParameterT(b.lat, b.lng),
    )
  }

  const scored = points.map((p) => ({
    p,
    t: syntheticLineParameterT(p.lat, p.lng),
    d: distanceToSyntheticLineDeg(p.lat, p.lng),
  }))
  scored.sort((a, b) => a.t - b.t)

  const out: Point[] = []
  const step = scored.length / cap
  for (let k = 0; k < cap; k++) {
    const start = Math.floor(k * step)
    const end = Math.min(scored.length, Math.floor((k + 1) * step))
    if (start >= end) continue
    let best = scored[start]!
    for (let j = start + 1; j < end; j++) {
      const e = scored[j]!
      if (e.d < best.d) best = e
    }
    out.push(best.p)
  }
  return out
}

function splitStructuralRegular(points: Point[]): {
  structural: Point[]
  regular: Point[]
} {
  const structural: Point[] = []
  for (const p of points) {
    if (isLineStructuralPoint(p.lat, p.lng)) structural.push(p)
  }
  const structuralIds = new Set(structural.map((p) => p.id))
  const regular: Point[] = []
  for (const p of points) {
    if (!structuralIds.has(p.id)) regular.push(p)
  }
  return { structural, regular }
}

/** Prefer trimming basin points; then line sample if still over target. */
function trimHybridMerged(
  structuralSample: Point[],
  gridPart: Point[],
  target: number,
): Point[] {
  let structPart = structuralSample
  let grid = gridPart
  let merged = structPart.concat(grid)
  let over = merged.length - target
  if (over <= 0) return merged

  if (grid.length > 0) {
    const fromGrid = Math.min(over, grid.length)
    grid = sampleRandomK(grid, grid.length - fromGrid)
    over -= fromGrid
    merged = structPart.concat(grid)
  }
  if (over > 0 && structPart.length > 0) {
    const keep = Math.max(0, structPart.length - over)
    structPart =
      keep >= structPart.length ? structPart : sampleRandomK(structPart, keep)
    merged = structPart.concat(grid)
  }
  if (merged.length > target) {
    merged = sampleRandomK(merged, target)
  }
  return merged
}

/**
 * Hybrid: capped line sample + density-aware grid on basin fills most of the target.
 */
function hybridScreenSpace(points: Point[], map: L.Map, target: number): Point[] {
  const { structural, regular } = splitStructuralRegular(points)

  const structBudget = Math.min(
    structural.length,
    Math.max(0, Math.floor(target * HYBRID_STRUCT_SHARE_OF_TARGET)),
  )
  const structuralSample = sampleStructuralAlongLine(structural, structBudget)
  const densityTarget = Math.max(0, target - structuralSample.length)

  let gridPart: Point[] =
    regular.length === 0 || densityTarget === 0
      ? []
      : gridScreenSpace(regular, map, densityTarget)

  let merged = trimHybridMerged(structuralSample, gridPart, target)

  if (merged.length < target && regular.length > 0) {
    const need = target - merged.length
    const picked = new Set(merged.map((p) => p.id))
    const rest = regular.filter((p) => !picked.has(p.id))
    merged = merged.concat(sampleRandomK(rest, Math.min(need, rest.length)))
  }

  return merged
}

function hybridLatLngFallback(points: Point[], target: number): Point[] {
  const { structural, regular } = splitStructuralRegular(points)

  const structBudget = Math.min(
    structural.length,
    Math.max(0, Math.floor(target * HYBRID_STRUCT_SHARE_OF_TARGET)),
  )
  const structuralSample = sampleStructuralAlongLine(structural, structBudget)
  const densityTarget = Math.max(0, target - structuralSample.length)

  let gridPart: Point[] =
    regular.length === 0 || densityTarget === 0
      ? []
      : gridLatLngFallback(regular, densityTarget)

  let merged = trimHybridMerged(structuralSample, gridPart, target)

  if (merged.length < target && regular.length > 0) {
    const need = target - merged.length
    const picked = new Set(merged.map((p) => p.id))
    const rest = regular.filter((p) => !picked.has(p.id))
    merged = merged.concat(sampleRandomK(rest, Math.min(need, rest.length)))
  }

  return merged
}

type BlueNoiseItem = {
  p: Point
  sx: number
  sy: number
  imp: number
}

/** Stable [0, 1) for shuffle and probabilistic acceptance (deterministic per id). */
function bnHashU01(id: string, salt: number): number {
  let x = (salt + 0xa341316c) >>> 0
  for (let i = 0; i < id.length; i++) {
    x = Math.imul(x ^ id.charCodeAt(i), 0x85ebca6b) >>> 0
  }
  x ^= x >>> 16
  x = Math.imul(x, 0x7feb352d) >>> 0
  x ^= x >>> 15
  return (x >>> 0) / 0xffffffff
}

/**
 * For topology strategy only: density-heavy + modest line + view-center basin
 * (blue-noise pass / spacing unchanged).
 */
function computeTopologyBaseImportance(
  entries: { p: Point; sx: number; sy: number }[],
  canvasW: number,
  canvasH: number,
): number[] {
  let maxAbs = 0
  for (const e of entries) {
    maxAbs = Math.max(maxAbs, Math.abs(e.p.displacement))
  }
  if (maxAbs < 1e-15) maxAbs = 1

  const cx = canvasW * 0.5
  const cy = canvasH * 0.5
  const maxR = Math.hypot(canvasW * 0.5, canvasH * 0.5) + 1e-6

  const imps: number[] = []
  for (const e of entries) {
    const density = Math.abs(e.p.displacement) / maxAbs
    const dLine = distanceToSyntheticLineDeg(e.p.lat, e.p.lng)
    const lineTerm = Math.exp(-dLine / BN_LINE_SIGMA_DEG)
    const distNorm = Math.hypot(e.sx - cx, e.sy - cy) / maxR
    const basinW = Math.exp(-distNorm * TOPO_BASIN_K)
    imps.push(
      Math.max(
        BN_EPS_IMPORTANCE,
        TOPO_BASE_DENSITY_FRAC * density +
          TOPO_BASE_LINE_FRAC * lineTerm +
          TOPO_BASIN_WEIGHT * basinW,
      ),
    )
  }
  return imps
}

function computeWeightedBlueImportance(
  entries: { p: Point; sx: number; sy: number }[],
): number[] {
  let maxAbs = 0
  for (const e of entries) {
    maxAbs = Math.max(maxAbs, Math.abs(e.p.displacement))
  }
  if (maxAbs < 1e-15) maxAbs = 1

  const imps: number[] = []
  for (const e of entries) {
    const density = Math.abs(e.p.displacement) / maxAbs
    const dLine = distanceToSyntheticLineDeg(e.p.lat, e.p.lng)
    const lineTerm = Math.exp(-dLine / BN_LINE_SIGMA_DEG)
    imps.push(
      Math.max(
        BN_EPS_IMPORTANCE,
        BN_DENSITY_WEIGHT * density + BN_LINE_WEIGHT * lineTerm,
      ),
    )
  }
  return imps
}

function buildBlueNoiseItems(
  points: Point[],
  project: (p: Point) => { sx: number; sy: number },
  _canvasW: number,
  _canvasH: number,
  _target: number,
): BlueNoiseItem[] {
  const entries = points.map((p) => ({ p, ...project(p) }))
  const imp = computeWeightedBlueImportance(entries)
  const items: BlueNoiseItem[] = entries.map((e, i) => ({
    p: e.p,
    sx: e.sx,
    sy: e.sy,
    imp: imp[i]!,
  }))
  items.sort(
    (a, b) =>
      bnHashU01(a.p.id, BN_HASH_SALT_SORT0) -
      bnHashU01(b.p.id, BN_HASH_SALT_SORT0 + 1),
  )
  return items
}

type WeightedSel = { sx: number; sy: number; imp: number; p: Point }

type WeightedBluePassOpts = {
  seedSels?: WeightedSel[]
  maxNewSelections?: number
}

/**
 * Variable-radius weighted Poisson-style pass: all candidates are visited in a
 * deterministic pseudo-random order (not importance-sorted). Spatial hash is only
 * used to query neighbors among already-accepted samples.
 */
function weightedBlueNoisePass(
  items: BlueNoiseItem[],
  baseScale: number,
  area: number,
  layoutTarget: number,
  opts?: WeightedBluePassOpts,
): WeightedSel[] {
  const seedSels = opts?.seedSels ?? []
  const maxNew =
    opts?.maxNewSelections ?? Number.POSITIVE_INFINITY
  const seedIds = new Set(seedSels.map((s) => s.p.id))

  const rRef = Math.sqrt(area / (Math.PI * Math.max(1, layoutTarget)))
  const baseR = rRef * baseScale
  const gridCell = Math.max(3.5, baseR * 0.38)
  const grid = new Map<string, WeightedSel[]>()
  const keyOf = (sx: number, sy: number) =>
    `${Math.floor(sx / gridCell)},${Math.floor(sy / gridCell)}`
  const pushGrid = (s: WeightedSel) => {
    const k = keyOf(s.sx, s.sy)
    let arr = grid.get(k)
    if (!arr) {
      arr = []
      grid.set(k, arr)
    }
    arr.push(s)
  }

  for (const s of seedSels) {
    pushGrid(s)
  }

  const neighborDensity = (sx: number, sy: number, rC: number): number => {
    const sigmaK = Math.max(5, rC * 1.2)
    const denom = 2 * sigmaK * sigmaK
    const ix = Math.floor(sx / gridCell)
    const iy = Math.floor(sy / gridCell)
    let sum = 0
    for (let dx = -4; dx <= 4; dx++) {
      for (let dy = -4; dy <= 4; dy++) {
        const bucket = grid.get(`${ix + dx},${iy + dy}`)
        if (!bucket) continue
        for (const s of bucket) {
          const ddx = sx - s.sx
          const ddy = sy - s.sy
          const d2 = ddx * ddx + ddy * ddy
          sum += s.imp * Math.exp(-d2 / denom)
        }
      }
    }
    return sum
  }

  const newSel: WeightedSel[] = []
  for (const c of items) {
    if (newSel.length >= maxNew) break
    if (seedIds.has(c.p.id)) continue
    const imp = Math.max(c.imp, BN_EPS_IMPORTANCE)
    const rC = baseR / Math.sqrt(imp + BN_EPS_IMPORTANCE)
    const nd = neighborDensity(c.sx, c.sy, rC)
    const pAccept = imp / (imp + nd + 1e-8)
    const roll = bnHashU01(c.p.id, BN_HASH_SALT_ACCEPT)
    if (roll > pAccept) continue
    const entry: WeightedSel = { sx: c.sx, sy: c.sy, imp, p: c.p }
    newSel.push(entry)
    pushGrid(entry)
  }
  return [...seedSels, ...newSel]
}

function blueNoiseTrimByImp(pts: Point[], items: BlueNoiseItem[], n: number): Point[] {
  if (pts.length <= n) return pts
  const impById = new Map(items.map((it) => [it.p.id, it.imp]))
  const sorted = [...pts].sort((a, b) => {
    const ia = impById.get(a.id) ?? 0
    const ib = impById.get(b.id) ?? 0
    if (ia !== ib) return ia - ib
    return a.id.localeCompare(b.id)
  })
  return sorted.slice(sorted.length - n)
}

function blueNoiseSelect(
  items: BlueNoiseItem[],
  target: number,
  canvasW: number,
  canvasH: number,
  _zoom: number,
): Point[] {
  if (items.length === 0) return []
  if (items.length <= target) return items.map((it) => it.p)

  const area = Math.max(1, canvasW * canvasH)

  const countAt = (scale: number) =>
    weightedBlueNoisePass(items, scale, area, target, undefined).length

  let lo = 0.5
  let hi = 1.78
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2
    const n = countAt(mid)
    if (n > target) lo = mid
    else hi = mid
  }

  const scale = (lo + hi) / 2
  let out = weightedBlueNoisePass(items, scale, area, target, undefined).map(
    (s) => s.p,
  )

  if (out.length > target) {
    return blueNoiseTrimByImp(out, items, target)
  }

  if (out.length < target) {
    let s = scale
    for (let j = 0; j < 22 && out.length < target; j++) {
      s *= 0.87
      out = weightedBlueNoisePass(items, s, area, target, undefined).map(
        (x) => x.p,
      )
    }
  }

  if (out.length < target) {
    const picked = new Set(out.map((p) => p.id))
    for (const it of items) {
      if (out.length >= target) break
      if (picked.has(it.p.id)) continue
      out.push(it.p)
      picked.add(it.p.id)
    }
  }

  if (out.length > target) {
    return blueNoiseTrimByImp(out, items, target)
  }

  return out
}

type TopoEdge = { u: number; v: number; w: number }

function subsampleIndices(n: number, cap: number): number[] {
  if (n <= cap) return Array.from({ length: n }, (_, i) => i)
  const out: number[] = []
  const step = n / cap
  for (let k = 0; k < cap; k++) {
    out.push(Math.min(n - 1, Math.floor(k * step)))
  }
  return out
}

function ufFind(parent: number[], i: number): number {
  let p = i
  while (parent[p] !== p) {
    parent[p] = parent[parent[p]!]!
    p = parent[p]!
  }
  return p
}

function ufUnite(
  parent: number[],
  rank: Uint8Array,
  a: number,
  b: number,
): boolean {
  let ra = ufFind(parent, a)
  let rb = ufFind(parent, b)
  if (ra === rb) return false
  if (rank[ra]! < rank[rb]!) {
    const t = ra
    ra = rb
    rb = t
  }
  parent[rb] = ra
  if (rank[ra] === rank[rb]) rank[ra]++
  return true
}

function topoGetComponents(parent: number[], n: number): number[][] {
  const map = new Map<number, number[]>()
  for (let i = 0; i < n; i++) {
    const r = ufFind(parent, i)
    let arr = map.get(r)
    if (!arr) {
      arr = []
      map.set(r, arr)
    }
    arr.push(i)
  }
  return [...map.values()]
}

function buildKnnEdges(
  x: Float64Array,
  y: Float64Array,
  n: number,
  k: number,
  cellSize: number,
): TopoEdge[] {
  const grid = new Map<string, number[]>()
  const cellKey = (ix: number, iy: number) => `${ix},${iy}`
  for (let i = 0; i < n; i++) {
    const ix = Math.floor(x[i]! / cellSize)
    const iy = Math.floor(y[i]! / cellSize)
    const key = cellKey(ix, iy)
    let arr = grid.get(key)
    if (!arr) {
      arr = []
      grid.set(key, arr)
    }
    arr.push(i)
  }

  const edgeMap = new Map<string, TopoEdge>()
  const setEdge = (u: number, v: number, w: number) => {
    if (u === v) return
    const a = Math.min(u, v)
    const b = Math.max(u, v)
    const ek = `${a},${b}`
    const ex = edgeMap.get(ek)
    if (!ex || w < ex.w) edgeMap.set(ek, { u: a, v: b, w })
  }

  const searchR = 4
  for (let i = 0; i < n; i++) {
    const xi = x[i]!
    const yi = y[i]!
    const ix = Math.floor(xi / cellSize)
    const iy = Math.floor(yi / cellSize)
    const cand: { j: number; d2: number }[] = []
    for (let dx = -searchR; dx <= searchR; dx++) {
      for (let dy = -searchR; dy <= searchR; dy++) {
        const bucket = grid.get(cellKey(ix + dx, iy + dy))
        if (!bucket) continue
        for (const j of bucket) {
          if (j === i) continue
          const ddx = xi - x[j]!
          const ddy = yi - y[j]!
          cand.push({ j, d2: ddx * ddx + ddy * ddy })
        }
      }
    }
    cand.sort((a, b) => a.d2 - b.d2)
    const take = Math.min(k, cand.length)
    for (let t = 0; t < take; t++) {
      const c = cand[t]!
      setEdge(i, c.j, Math.sqrt(c.d2))
    }
  }
  return [...edgeMap.values()]
}

function mstWithBridges(
  n: number,
  edges: TopoEdge[],
  x: Float64Array,
  y: Float64Array,
): TopoEdge[] {
  const parent = Array.from({ length: n }, (_, i) => i)
  const rank = new Uint8Array(n)
  const sorted = [...edges].sort((a, b) => a.w - b.w)
  const mst: TopoEdge[] = []
  for (const e of sorted) {
    if (ufUnite(parent, rank, e.u, e.v)) mst.push(e)
  }

  const extra: TopoEdge[] = []
  while (true) {
    const comps = topoGetComponents(parent, n)
    if (comps.length <= 1) break
    const A = comps[0]!
    const B = comps[1]!
    let bu = -1
    let bv = -1
    let bw = Infinity
    const stepA = Math.max(1, Math.floor(A.length / 280))
    const stepB = Math.max(1, Math.floor(B.length / 280))
    for (let ia = 0; ia < A.length; ia += stepA) {
      const i = A[ia]!
      const xi = x[i]!
      const yi = y[i]!
      for (let ib = 0; ib < B.length; ib += stepB) {
        const j = B[ib]!
        const dx = xi - x[j]!
        const dy = yi - y[j]!
        const w = Math.hypot(dx, dy)
        if (w < bw) {
          bw = w
          bu = i
          bv = j
        }
      }
    }
    if (bu < 0 || bv < 0) break
    extra.push({ u: bu, v: bv, w: bw })
    ufUnite(parent, rank, bu, bv)
  }
  return mst.concat(extra)
}

function backboneVertexSet(tree: TopoEdge[]): Set<number> {
  if (tree.length === 0) return new Set()
  const sorted = [...tree].sort((a, b) => a.w - b.w)
  const keep = Math.max(
    1,
    Math.floor(sorted.length * TOPO_MST_SHORT_EDGE_FRAC),
  )
  const verts = new Set<number>()
  for (let i = 0; i < keep; i++) {
    const e = sorted[i]!
    verts.add(e.u)
    verts.add(e.v)
  }
  return verts
}

type MstAnchorIndex = { cellSize: number; buckets: Map<string, { x: number; y: number }[]> }

/**
 * Dense anchors on MST vertices + along each tree edge so corridor distance
 * approximates distance to the full MST polyline without scanning all edges per query.
 */
function buildMstAnchorIndex(
  tree: TopoEdge[],
  x: Float64Array,
  y: Float64Array,
  n: number,
  cellSize: number,
): MstAnchorIndex {
  const buckets = new Map<string, { x: number; y: number }[]>()
  const push = (px: number, py: number) => {
    const cx = Math.floor(px / cellSize)
    const cy = Math.floor(py / cellSize)
    const k = `${cx},${cy}`
    let arr = buckets.get(k)
    if (!arr) {
      arr = []
      buckets.set(k, arr)
    }
    arr.push({ x: px, y: py })
  }

  for (let i = 0; i < n; i++) {
    push(x[i]!, y[i]!)
  }
  for (const e of tree) {
    const x1 = x[e.u]!
    const y1 = y[e.u]!
    const x2 = x[e.v]!
    const y2 = y[e.v]!
    const w = Math.hypot(x2 - x1, y2 - y1)
    const steps = Math.min(28, Math.max(2, Math.ceil(w / 32)))
    for (let s = 0; s <= steps; s++) {
      const t = s / steps
      push(x1 + t * (x2 - x1), y1 + t * (y2 - y1))
    }
  }
  return { cellSize, buckets }
}

function minDistToMstPx(px: number, py: number, idx: MstAnchorIndex): number {
  const { cellSize, buckets } = idx
  const ix = Math.floor(px / cellSize)
  const iy = Math.floor(py / cellSize)
  let md = Infinity
  for (let dx = -5; dx <= 5; dx++) {
    for (let dy = -5; dy <= 5; dy++) {
      for (const a of buckets.get(`${ix + dx},${iy + dy}`) ?? []) {
        const ddx = px - a.x
        const ddy = py - a.y
        md = Math.min(md, Math.hypot(ddx, ddy))
      }
    }
  }
  if (!Number.isFinite(md)) {
    md = cellSize * 80
  }
  return md
}

function blueNoiseTrimWithProtected(
  pts: Point[],
  items: BlueNoiseItem[],
  n: number,
  protect: Set<string>,
): Point[] {
  if (pts.length <= n) return pts
  const impById = new Map(items.map((it) => [it.p.id, it.imp]))
  const impOf = (p: Point) => impById.get(p.id) ?? BN_EPS_IMPORTANCE
  const prot = pts.filter((p) => protect.has(p.id))
  const rest = pts.filter((p) => !protect.has(p.id))
  if (prot.length >= n) {
    const sorted = [...prot].sort((a, b) => {
      const d = impOf(a) - impOf(b)
      return d !== 0 ? d : a.id.localeCompare(b.id)
    })
    return sorted.slice(sorted.length - n)
  }
  rest.sort((a, b) => {
    const d = impOf(a) - impOf(b)
    return d !== 0 ? d : a.id.localeCompare(b.id)
  })
  const need = n - prot.length
  return prot.concat(rest.slice(rest.length - need))
}

function blueNoiseSelectWithSeeds(
  items: BlueNoiseItem[],
  target: number,
  canvasW: number,
  canvasH: number,
  seedPoints: Point[],
): Point[] {
  if (items.length === 0) return []
  const byId = new Map(items.map((it) => [it.p.id, it]))
  let seeds = seedPoints.filter((p) => byId.has(p.id))
  const seedIds = new Set(seeds.map((p) => p.id))

  if (seeds.length > target) {
    seeds = blueNoiseTrimWithProtected(seeds, items, target, new Set())
    return seeds
  }

  const seedSels: WeightedSel[] = seeds.map((p) => {
    const it = byId.get(p.id)!
    return {
      sx: it.sx,
      sy: it.sy,
      imp: Math.max(it.imp, BN_EPS_IMPORTANCE),
      p: it.p,
    }
  })

  const maxNew = Math.max(0, target - seedSels.length)
  const pool = items.filter((it) => !seedIds.has(it.p.id))
  if (maxNew === 0) {
    return seedSels.map((s) => s.p)
  }

  const area = Math.max(1, canvasW * canvasH)
  const run = (scale: number) =>
    weightedBlueNoisePass(pool, scale, area, target, {
      seedSels: seedSels,
      maxNewSelections: maxNew,
    })

  const countAt = (scale: number) => run(scale).length

  let lo = 0.5
  let hi = 1.78
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2
    const c = countAt(mid)
    if (c > target) lo = mid
    else hi = mid
  }

  let scale = (lo + hi) / 2
  let out = run(scale).map((s) => s.p)

  if (out.length > target) {
    return blueNoiseTrimWithProtected(out, items, target, seedIds)
  }

  if (out.length < target) {
    for (let j = 0; j < 22 && out.length < target; j++) {
      scale *= 0.87
      out = run(scale).map((s) => s.p)
    }
  }

  if (out.length < target) {
    const picked = new Set(out.map((p) => p.id))
    for (const it of items) {
      if (out.length >= target) break
      if (picked.has(it.p.id)) continue
      out.push(it.p)
      picked.add(it.p.id)
    }
  }

  if (out.length > target) {
    return blueNoiseTrimWithProtected(out, items, target, seedIds)
  }

  return out
}

function topologySample(
  points: Point[],
  project: (p: Point) => { sx: number; sy: number },
  canvasW: number,
  canvasH: number,
  target: number,
): Point[] {
  if (points.length === 0) return []
  if (points.length <= target) return [...points]

  const idx = subsampleIndices(points.length, TOPO_GRAPH_POINT_CAP)
  const n = idx.length
  const x = new Float64Array(n)
  const y = new Float64Array(n)
  let maxAbs = 0
  for (let i = 0; i < n; i++) {
    const p = points[idx[i]!]!
    const { sx, sy } = project(p)
    x[i] = sx
    y[i] = sy
    maxAbs = Math.max(maxAbs, Math.abs(p.displacement))
  }
  if (maxAbs < 1e-15) maxAbs = 1

  const area = Math.max(1, canvasW * canvasH)
  const cellSize = Math.max(
    4,
    Math.sqrt(area / Math.max(n, 1)) * TOPO_KNN_CELL_MULT,
  )
  const knnEdges = buildKnnEdges(x, y, n, TOPO_KNN_K, cellSize)
  const tree = mstWithBridges(n, knnEdges, x, y)
  const backboneLocal = backboneVertexSet(tree)

  const coreBackboneIds = new Set<string>()
  for (const li of backboneLocal) {
    coreBackboneIds.add(points[idx[li]!]!.id)
  }

  const indexCell = Math.max(
    26,
    Math.min(70, Math.sqrt(area / Math.max(target * 0.45, 1)) * 0.48),
  )
  const mstIdx = buildMstAnchorIndex(tree, x, y, n, indexCell)
  const sigma = Math.max(16, Math.sqrt(area / Math.max(target, 1)) * 0.26)
  const seedBandPx = sigma * TOPO_CORRIDOR_SEED_FRAC

  const projEntries = points.map((p) => ({ p, ...project(p) }))
  const baseImps = computeTopologyBaseImportance(
    projEntries,
    canvasW,
    canvasH,
  )
  const dists: number[] = new Array(points.length)
  for (let i = 0; i < points.length; i++) {
    const e = projEntries[i]!
    dists[i] = minDistToMstPx(e.sx, e.sy, mstIdx)
  }

  const items: BlueNoiseItem[] = projEntries.map((e, i) => {
    const corridor = TOPO_CORRIDOR_WEIGHT * Math.exp(-dists[i]! / sigma)
    return {
      p: e.p,
      sx: e.sx,
      sy: e.sy,
      imp: Math.max(BN_EPS_IMPORTANCE, baseImps[i]! + corridor),
    }
  })
  items.sort(
    (a, b) =>
      bnHashU01(a.p.id, BN_HASH_SALT_SORT0) -
      bnHashU01(b.p.id, BN_HASH_SALT_SORT0 + 1),
  )

  type SeedCand = { p: Point; d: number; core: boolean; line: boolean }
  const seedCandidates: SeedCand[] = []
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!
    const d = dists[i]!
    const line = isLineStructuralPoint(p.lat, p.lng)
    const core = coreBackboneIds.has(p.id)
    if (d < seedBandPx || core || line) {
      seedCandidates.push({ p, d, core, line })
    }
  }

  seedCandidates.sort((a, b) => {
    if (a.line !== b.line) return (b.line ? 1 : 0) - (a.line ? 1 : 0)
    if (a.core !== b.core) return (b.core ? 1 : 0) - (a.core ? 1 : 0)
    if (a.d !== b.d) return a.d - b.d
    const da = Math.abs(a.p.displacement) / maxAbs
    const db = Math.abs(b.p.displacement) / maxAbs
    if (db !== da) return db - da
    return a.p.id.localeCompare(b.p.id)
  })

  const backboneBudget = Math.min(
    Math.floor(target * TOPO_BACKBONE_MAX_FRAC),
    seedCandidates.length,
    Math.max(0, target - 1),
  )
  const seedSlice = seedCandidates.slice(0, backboneBudget).map((c) => c.p)

  return blueNoiseSelectWithSeeds(items, target, canvasW, canvasH, seedSlice)
}

function topologyScreenSpace(points: Point[], map: L.Map, target: number): Point[] {
  if (points.length === 0) return []
  const size = map.getSize()
  if (size.x <= 0 || size.y <= 0) {
    return topologyLatLngFallback(points, target, map.getZoom())
  }
  const w = size.x
  const h = size.y
  const project = (p: Point) => {
    const pt = map.latLngToContainerPoint(L.latLng(p.lat, p.lng))
    return { sx: pt.x, sy: pt.y }
  }
  return topologySample(points, project, w, h, target)
}

function topologyLatLngFallback(
  points: Point[],
  target: number,
  _zoom: number,
): Point[] {
  if (points.length === 0) return []
  let minLat = Infinity
  let maxLat = -Infinity
  let minLng = Infinity
  let maxLng = -Infinity
  for (const p of points) {
    minLat = Math.min(minLat, p.lat)
    maxLat = Math.max(maxLat, p.lat)
    minLng = Math.min(minLng, p.lng)
    maxLng = Math.max(maxLng, p.lng)
  }
  const latSpan = maxLat - minLat || 1
  const lngSpan = maxLng - minLng || 1
  const aspect = latSpan / lngSpan
  const base = 1000
  const canvasW = base
  const canvasH = Math.max(320, base * aspect)
  const project = (p: Point) => ({
    sx: ((p.lng - minLng) / lngSpan) * canvasW,
    sy: ((maxLat - p.lat) / latSpan) * canvasH,
  })
  return topologySample(points, project, canvasW, canvasH, target)
}

function blueNoiseScreenSpace(
  points: Point[],
  map: L.Map,
  target: number,
): Point[] {
  if (points.length === 0) return []
  const size = map.getSize()
  if (size.x <= 0 || size.y <= 0) {
    return blueNoiseLatLngFallback(points, target, map.getZoom())
  }
  const w = size.x
  const h = size.y
  const z = map.getZoom()
  const project = (p: Point) => {
    const pt = map.latLngToContainerPoint(L.latLng(p.lat, p.lng))
    return { sx: pt.x, sy: pt.y }
  }
  const items = buildBlueNoiseItems(points, project, w, h, target)
  return blueNoiseSelect(items, target, w, h, z)
}

function blueNoiseLatLngFallback(
  points: Point[],
  target: number,
  zoom: number,
): Point[] {
  if (points.length === 0) return []
  let minLat = Infinity
  let maxLat = -Infinity
  let minLng = Infinity
  let maxLng = -Infinity
  for (const p of points) {
    minLat = Math.min(minLat, p.lat)
    maxLat = Math.max(maxLat, p.lat)
    minLng = Math.min(minLng, p.lng)
    maxLng = Math.max(maxLng, p.lng)
  }
  const latSpan = maxLat - minLat || 1
  const lngSpan = maxLng - minLng || 1
  const aspect = latSpan / lngSpan
  const base = 1000
  const canvasW = base
  const canvasH = Math.max(320, base * aspect)
  const project = (p: Point) => ({
    sx: ((p.lng - minLng) / lngSpan) * canvasW,
    sy: ((maxLat - p.lat) / latSpan) * canvasH,
  })
  const items = buildBlueNoiseItems(
    points,
    project,
    canvasW,
    canvasH,
    target,
  )
  return blueNoiseSelect(items, target, canvasW, canvasH, zoom)
}

/**
 * Filter to points inside the map’s visible bounds (before decimation).
 * `bounds === null` until the map has reported a view once; then all points are used briefly.
 */
export function pointsInViewport(
  points: Point[],
  bounds: ViewportBounds | null,
): Point[] {
  if (!bounds) return points
  const { south, west, north, east } = bounds
  return points.filter(
    (p) =>
      p.lat >= south && p.lat <= north && p.lng >= west && p.lng <= east,
  )
}

export function decimate(
  points: Point[],
  strategy: Strategy,
  zoom: number,
  map: L.Map | null,
  options?: DecimateOptions,
): Point[] {
  const ratio = options?.retentionRatio
  const useRetentionBudget =
    ratio != null &&
    ratio > 0 &&
    ratio <= 1 &&
    Number.isFinite(ratio)

  const target = useRetentionBudget
    ? targetCountFromRetention(points.length, ratio)
    : getAdaptiveTargetCount(zoom)

  if (strategy === 'original') {
    return points
  }

  if (target === 0) {
    return []
  }

  if (strategy === 'random') {
    return sampleRandomK(points, target)
  }

  if (strategy === 'grid') {
    if (map) return gridScreenSpace(points, map, target)
    return gridLatLngFallback(points, target)
  }

  if (strategy === 'hybrid') {
    if (map) return hybridScreenSpace(points, map, target)
    return hybridLatLngFallback(points, target)
  }

  if (strategy === 'blueNoise') {
    if (map) return blueNoiseScreenSpace(points, map, target)
    return blueNoiseLatLngFallback(points, target, zoom)
  }

  if (strategy === 'topology') {
    if (map) return topologyScreenSpace(points, map, target)
    return topologyLatLngFallback(points, target, zoom)
  }

  return points
}
