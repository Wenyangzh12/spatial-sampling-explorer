/**
 * Decimation benchmark - Mexico City anchor (x = lng, y = lat, deg WGS84).
 *
 * Deliberately simple: one main basin, one fragile line, non-uniform sampling.
 * Optimized for Random vs Grid vs Hybrid, not maximum physical realism.
 */

const PHI_INV = (Math.sqrt(5) - 1) / 2

const CX = -99.1332
const CY = 19.4326
const COS_Y = Math.cos((CY * Math.PI) / 180)

export type Point = {
  x: number
  y: number
  value: number
}

function u01(i: number, salt: number): number {
  let x = (i + 1) * 0x9e3779b9 + salt * 0x517cc1b7
  x ^= x >>> 16
  x = Math.imul(x, 0x7feb352d)
  x ^= x >>> 15
  x = Math.imul(x, 0x846ca68b)
  x ^= x >>> 16
  return (x >>> 0) / 0xffffffff
}

function randn(i: number, a: number, b: number): number {
  const u1 = Math.max(1e-9, u01(i, a))
  const u2 = u01(i, b)
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
}

function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n))
}

function smoothstep01(t: number): number {
  const u = clamp(t, 0, 1)
  return u * u * (3 - 2 * u)
}

function smoothHash1D(t: number, salt: number, grid: number): number {
  const g = t * grid
  const i0 = Math.floor(g)
  const f = smoothstep01(g - i0)
  const v0 = u01(i0, salt) - 0.5
  const v1 = u01(i0 + 1, salt) - 0.5
  return v0 * (1 - f) + v1 * f
}

function xyMetric(x: number, y: number): { ex: number; ey: number } {
  return { ex: (x - CX) * COS_Y, ey: y - CY }
}

// ——— Ellipse ———

function ellipticalGaussian(
  x: number,
  y: number,
  cx: number,
  cy: number,
  sigmaU: number,
  sigmaV: number,
  theta: number,
  amplitude: number,
): number {
  const dx = x - cx
  const dy = y - cy
  const c = Math.cos(theta)
  const s = Math.sin(theta)
  const u = (dx * COS_Y) * c + dy * s
  const v = -(dx * COS_Y) * s + dy * c
  return amplitude * Math.exp(-0.5 * ((u / sigmaU) ** 2 + (v / sigmaV) ** 2))
}

/** Single dominant subsidence bowl (density + strong negative signal). */
function mainBasin(x: number, y: number): number {
  return ellipticalGaussian(
    x,
    y,
    CX - 0.015,
    CY + 0.008,
    0.058,
    0.038,
    0.33,
    -1,
  )
}

/**
 * Small nested depression inside the main bowl - multi-scale center detail.
 */
function centralSubFeature(x: number, y: number): number {
  return ellipticalGaussian(
    x,
    y,
    CX - 0.011,
    CY + 0.012,
    0.023,
    0.016,
    0.42,
    -0.12,
  )
}

/**
 * Few weak positive clusters - irregular sizes/orientations, nowhere near ring-scale.
 */
function positivePatches(x: number, y: number): number {
  return (
    ellipticalGaussian(x, y, CX + 0.092, CY + 0.055, 0.015, 0.02, 0.58, 0.075) +
    ellipticalGaussian(x, y, CX - 0.105, CY - 0.035, 0.012, 0.016, -0.28, 0.062) +
    ellipticalGaussian(x, y, CX + 0.028, CY - 0.095, 0.011, 0.014, 1.05, 0.052) +
    ellipticalGaussian(x, y, CX - 0.068, CY + 0.095, 0.009, 0.012, 0.22, 0.045)
  )
}

/** Residual texture - slightly reduced smooth waves so uplift reads as patches, not a sheet. */
function noiseField(x: number, y: number): number {
  const { ex, ey } = xyMetric(x, y)
  return (
    0.02 * Math.sin(2.4 * ex + 1.1 * ey) +
    0.016 * Math.cos(1.8 * ey - 2.2 * ex + 0.4) +
    0.02 * (smoothHash1D(ex * 16, 0x701, 5) + smoothHash1D(ey * 14, 0x702, 5))
  )
}

// ——— One fragile line (curved, jittered, slightly gappy) ———

const LINE = {
  x0: CX - 0.166,
  y0: CY - 0.105,
  x1: CX + 0.05,
  y1: CY + 0.062,
  bendAmp1: 0.012,
  freq1: 6.2 * Math.PI,
  ph1: 0.44,
  bendAmp2: 0.0065,
  freq2: 2.7 * Math.PI,
  ph2: 0.95,
  jitterAmp: 0.00145,
  jitterGrid: 350,
  /** Fine along-trace wiggle (shared by geometry + distance queries). */
  microAmp: 0.00052,
  microFreq: 38 * Math.PI,
  microPh: 0.73,
  microHashGrid: 920,
  microHashScale: 0.00038,
  baseHalfWidth: 0.00048,
  widthOsc: 0.32,
  widthFreq: 11 * Math.PI,
  peak: -0.34,
  gapBase: 0.38,
}

function lineBasis() {
  const abx = LINE.x1 - LINE.x0
  const aby = LINE.y1 - LINE.y0
  const abLen = Math.hypot(abx * COS_Y, aby)
  const nx = abLen > 1e-12 ? -aby / abLen : 0
  const ny = abLen > 1e-12 ? (abx * COS_Y) / abLen : 1
  return { ax: LINE.x0, ay: LINE.y0, abx, aby, abLen, nx, ny }
}

function linePerpBend(t: number): number {
  const j = LINE.jitterAmp * smoothHash1D(t, 0xa11e, LINE.jitterGrid)
  const micro =
    LINE.microAmp * Math.sin(LINE.microFreq * t + LINE.microPh) +
    LINE.microHashScale * smoothHash1D(t, 0xc7a1, LINE.microHashGrid)
  return (
    LINE.bendAmp1 * Math.sin(LINE.freq1 * t + LINE.ph1) +
    LINE.bendAmp2 * Math.sin(LINE.freq2 * t + LINE.ph2) +
    j +
    micro
  )
}

function lineTrace(t: number): { x: number; y: number } {
  const { ax, ay, abx, aby, nx, ny } = lineBasis()
  const b = linePerpBend(t)
  return { x: ax + t * abx + nx * b, y: ay + t * aby + ny * b }
}

function distSqToLineT(px: number, py: number, t: number): number {
  const q = lineTrace(t)
  const dY = py - q.y
  const dX = (px - q.x) * COS_Y
  return dX * dX + dY * dY
}

function closestTOnLine(px: number, py: number): number {
  let a = 0
  let b = 1
  let c = b - PHI_INV * (b - a)
  let d = a + PHI_INV * (b - a)
  let fc = distSqToLineT(px, py, c)
  let fd = distSqToLineT(px, py, d)
  for (let i = 0; i < 26; i++) {
    if (fc < fd) {
      b = d
      d = c
      fd = fc
      c = b - PHI_INV * (b - a)
      fc = distSqToLineT(px, py, c)
    } else {
      a = c
      c = d
      fc = fd
      d = a + PHI_INV * (b - a)
      fd = distSqToLineT(px, py, d)
    }
  }
  return (a + b) / 2
}

/** Visible stripe along trace, thin in cross-section; gaps + hash make it decimation-fragile. */
function fragileLineFeature(x: number, y: number): number {
  const t = closestTOnLine(x, y)
  const gn = smoothHash1D(t, 0x71ab, 400)
  const gapP = clamp(LINE.gapBase + 0.22 * gn + 0.08 * Math.sin(7.5 * Math.PI * t), 0.12, 0.78)
  const seg = Math.floor(t * 5600) ^ (Math.floor(gn * 17) << 2)
  if (u01(seg, 0x7e4b) < gapP) return 0

  const q = lineTrace(t)
  const cross = Math.hypot((x - q.x) * COS_Y, y - q.y)
  const wv = smoothHash1D(t * 1.05, 0x81e, 58)
  const halfW =
    LINE.baseHalfWidth *
    (1 + LINE.widthOsc * wv + 0.2 * Math.sin(LINE.widthFreq * t + 0.35))
  if (halfW < 1e-8) return 0
  const str = 0.82 + 0.18 * smoothHash1D(t * 2.8, 0x5ae1, 49)
  return LINE.peak * str * Math.exp(-0.5 * (cross / halfW) ** 2)
}

function scalarField(x: number, y: number): number {
  return (
    mainBasin(x, y) +
    centralSubFeature(x, y) +
    positivePatches(x, y) +
    noiseField(x, y) +
    fragileLineFeature(x, y)
  )
}

const VALUE_NORM = 1.07

function normalizedValue(raw: number): number {
  return clamp(raw / VALUE_NORM, -1, 1)
}

/** Monotonic denser-in-center sampling (one core), slight wobble - no multi-blob ring. */
function samplingDensity(x: number, y: number): number {
  const core = ellipticalGaussian(x, y, CX - 0.012, CY + 0.006, 0.11, 0.076, 0.36, 1)
  const { ex, ey } = xyMetric(x, y)
  const textured = 0.92 + 0.08 * Math.sin(0.085 * ex + 0.9) * Math.cos(0.08 * ey - 0.3)
  return clamp((0.1 + 0.9 * core) * textured * softFootprint(x, y), 0.04, 1)
}

function softFootprint(x: number, y: number): number {
  const dx = (x - CX) * COS_Y
  const dy = y - CY
  const ru = 0.21
  const rv = 0.165
  const d2 = (dx / ru) ** 2 + (dy / rv) ** 2
  return 1 / (1 + Math.exp(2.9 * (d2 - 3.25)))
}

/** Light coherence loss - mostly peripheral; keeps core clean for basin vs line comparison. */
function hasDataCoverage(x: number, y: number): boolean {
  const { ex, ey } = xyMetric(x, y)
  const n = 0.45 + 0.28 * Math.sin(0.055 * ex + 0.7) * Math.cos(0.052 * ey - 0.2)
  const periphery = 1 - ellipticalGaussian(x, y, CX, CY, 0.19, 0.155, 0.38, 1)
  return n + 0.22 * periphery < 0.72
}

const BBOX = {
  xMin: CX - 0.35,
  xMax: CX + 0.32,
  yMin: CY - 0.28,
  yMax: CY + 0.35,
}

const COORD_JITTER_DEG = 2.2e-5

export function generatePoints(n: number): Point[] {
  const out: Point[] = []
  const maxAttempts = Math.max(n * 100, 12_000)
  let attempts = 0

  while (out.length < n && attempts < maxAttempts) {
    attempts++
    const i = out.length + attempts * 9973

    const u = u01(i, 0x10)
    let x: number
    let y: number
    if (u < 0.04) {
      const t = u01(i, 0x11)
      const q = lineTrace(t)
      const { abx, aby, abLen, nx, ny } = lineBasis()
      const tx = abLen > 1e-12 ? (abx * COS_Y) / Math.hypot(abx * COS_Y, aby) : 1
      const ty = abLen > 1e-12 ? aby / Math.hypot(abx * COS_Y, aby) : 0
      const na = randn(i, 0x12, 0x13) * 1.05e-4
      const nc = randn(i, 0x14, 0x15) * 1.35e-4
      x = q.x + tx * na + nx * nc
      y = q.y + ty * na + ny * nc
    } else if (u < 0.77) {
      const scale = 0.065
      const r = Math.sqrt(-2 * Math.log(Math.max(1e-9, u01(i, 0x20)))) * scale
      const th = 2 * Math.PI * u01(i, 0x21)
      x = CX + (r * Math.sin(th) * 1.35) / COS_Y
      y = CY + r * Math.cos(th) * 0.88
    } else if (u < 0.92) {
      const scale = 0.11
      const r = Math.sqrt(-2 * Math.log(Math.max(1e-9, u01(i, 0x30)))) * scale
      const th = 2 * Math.PI * u01(i, 0x31)
      x = CX + (r * Math.sin(th) * 1.32) / COS_Y
      y = CY + r * Math.cos(th) * 0.9
    } else {
      const scale = 0.16
      const r = Math.sqrt(-2 * Math.log(Math.max(1e-9, u01(i, 0x40)))) * scale
      const th = 2 * Math.PI * u01(i, 0x41)
      x = CX + (r * Math.sin(th) * 1.3) / COS_Y
      y = CY + r * Math.cos(th) * 0.92
    }

    if (x < BBOX.xMin || x > BBOX.xMax || y < BBOX.yMin || y > BBOX.yMax) continue
    if (!hasDataCoverage(x, y)) continue

    const keep = samplingDensity(x, y)
    if (u01(i, 0x99) > keep) continue

    x += (u01(i, 0xa1) - 0.5) * 2 * COORD_JITTER_DEG
    y += (u01(i, 0xa2) - 0.5) * 2 * COORD_JITTER_DEG

    const meas = randn(i, 0xa3, 0xa4) * 0.022
    out.push({ x, y, value: normalizedValue(scalarField(x, y) + meas) })
  }

  let pad = 0
  while (out.length < n && pad < n * 45) {
    pad++
    const i = out.length + pad * 49999
    const scale = 0.085
    const r = Math.sqrt(-2 * Math.log(Math.max(1e-9, u01(i, 0xe0)))) * scale
    const th = 2 * Math.PI * u01(i, 0xe1)
    let x = CX + (r * Math.sin(th) * 1.35) / COS_Y
    let y = CY + r * Math.cos(th) * 0.88
    if (x < BBOX.xMin || x > BBOX.xMax || y < BBOX.yMin || y > BBOX.yMax) continue
    if (!hasDataCoverage(x, y) && u01(i, 0xef) < 0.55) continue
    if (u01(i, 0xe2) > samplingDensity(x, y) * 0.9) continue
    x += (u01(i, 0xe3) - 0.5) * 2 * COORD_JITTER_DEG
    y += (u01(i, 0xe4) - 0.5) * 2 * COORD_JITTER_DEG
    out.push({
      x,
      y,
      value: normalizedValue(scalarField(x, y) + randn(i, 0xe5, 0xe6) * 0.022),
    })
  }

  return out
}

export function distanceToSyntheticLineDeg(lat: number, lng: number): number {
  const t = closestTOnLine(lng, lat)
  return Math.sqrt(distSqToLineT(lng, lat, t))
}

export function syntheticLineParameterT(lat: number, lng: number): number {
  return clamp(closestTOnLine(lng, lat), 0, 1)
}

/** ~2.6× mean half-width of fragile line. */
export const LINE_STRUCTURAL_MAX_DEG = 0.00145

export function isLineStructuralPoint(lat: number, lng: number): boolean {
  return distanceToSyntheticLineDeg(lat, lng) <= LINE_STRUCTURAL_MAX_DEG
}
