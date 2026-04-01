import {
  generatePoints,
  distanceToSyntheticLineDeg,
  syntheticLineParameterT,
  LINE_STRUCTURAL_MAX_DEG,
  isLineStructuralPoint,
} from './syntheticDataset'

/** `x` = longitude, `y` = latitude (deg); `value` ∈ [-1, 1]. */
export type { Point as SyntheticPoint } from './syntheticDataset'
export {
  generatePoints,
  distanceToSyntheticLineDeg,
  syntheticLineParameterT,
  LINE_STRUCTURAL_MAX_DEG,
  isLineStructuralPoint,
}

/** Leaflet / app record. */
export type Point = {
  id: string
  lat: number
  lng: number
  displacement: number
  timestamp: number
}

const COUNT = 100_000

export function generateMockPoints(): Point[] {
  const baseTime = Date.UTC(2020, 0, 1)
  const synthetic = generatePoints(COUNT)
  return synthetic.map((p, i) => ({
    id: `p-${i}`,
    lat: p.y,
    lng: p.x,
    displacement: p.value,
    timestamp:
      baseTime + i * 3_600_000 + ((i * 2654435761 + 0x83) >>> 0) % 86_400_000,
  }))
}
