import { useEffect, useMemo, useRef } from 'react'
import CircularProgress from '@mui/material/CircularProgress'
import { MapContainer, Pane, Rectangle, TileLayer, useMap } from 'react-leaflet'
import L from 'leaflet'
import type { GeographicRegionBounds, MapView, Strategy, ViewportBounds } from './decimate'
import BoxSelectInteraction, { BOX_SELECT_PANE } from './BoxSelectInteraction'

/** Renders above tiles (400) but below box selection (460). */
const INSAR_POINTS_PANE = 'insarPointsPane'
import type { Point } from './mockData'

/** Mexico City, MX — Leaflet [lat, lng] */
const CENTER: [number, number] = [19.4326, -99.1332]

const DEFAULT_ZOOM = 10.5

const POSITRON_URL =
  'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png'

/**
 * Separate scales so positives are not washed out when negatives dominate |d|.
 * (Symmetric treatment: each side maps to full hue range from near-white.)
 */
function maxNegativeAndPositiveMags(points: Point[]): {
  maxNegMag: number
  maxPosMag: number
} {
  let maxNegMag = 0
  let maxPosMag = 0
  for (const p of points) {
    const d = p.displacement
    if (d < 0) maxNegMag = Math.max(maxNegMag, -d)
    else if (d > 0) maxPosMag = Math.max(maxPosMag, d)
  }
  return {
    maxNegMag: maxNegMag > 1e-12 ? maxNegMag : 1e-9,
    maxPosMag: maxPosMag > 1e-12 ? maxPosMag : 1e-9,
  }
}

export type DebugSignFilter = 'all' | 'positive' | 'negative'

/** Slightly desaturated blue — contrast without competing with rose UI. */
const DOWN_RGB: [number, number, number] = [48, 118, 172]
/** Soft dusty rose aligned with UI accent (#d67fa3 family). */
const UP_RGB: [number, number, number] = [190, 105, 138]
const NEAR_ZERO_RGB: [number, number, number] = [247, 244, 246]

function mixRgb(
  a: [number, number, number],
  b: [number, number, number],
  t: number,
): [number, number, number] {
  const k = Math.max(0, Math.min(1, t))
  return [
    Math.round(a[0] + (b[0] - a[0]) * k),
    Math.round(a[1] + (b[1] - a[1]) * k),
    Math.round(a[2] + (b[2] - a[2]) * k),
  ]
}

function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n))
}

/** Stable [0, 1) from point id — jitter does not flicker on pan/zoom. */
function hashU01(id: string, salt: number): number {
  let x = salt * 0x9e3779b1
  for (let i = 0; i < id.length; i++) {
    x = Math.imul(x ^ id.charCodeAt(i), 0x85ebca6b) >>> 0
  }
  x ^= x >>> 16
  x = Math.imul(x, 0x7feb352d) >>> 0
  x ^= x >>> 15
  return (x >>> 0) / 0xffffffff
}

/** ~pixel size of grid cells from viewport area / point count. */
function estimateGridCellSizePx(
  width: number,
  height: number,
  pointCount: number,
): number {
  if (pointCount < 1) return 28
  return clamp(Math.sqrt((width * height) / pointCount), 8, 100)
}

/** Sub-degree noise: breaks residual alignment without moving structure (~meters). */
const GRID_GEO_JITTER_DEG = 1.8e-6

function usesGridStyle(strategy: Strategy): boolean {
  return strategy === 'grid' || strategy === 'hybrid'
}

/**
 * Color: per-side normalization (max negative magnitude vs max positive) so blue / rose are symmetric.
 * Uses sqrt on within-side normalized magnitude (0–1) for both signs — same curve each side.
 */
function stylePoint(
  displacement: number,
  maxNegMag: number,
  maxPosMag: number,
  strategy: Strategy,
): { r: number; g: number; b: number; a: number; size: number } {
  let sign: -1 | 0 | 1 = 0
  let t01 = 0
  if (displacement < 0) {
    sign = -1
    t01 = clamp(-displacement / maxNegMag, 0, 1)
  } else if (displacement > 0) {
    sign = 1
    t01 = clamp(displacement / maxPosMag, 0, 1)
  }
  const magSqrt = Math.sqrt(t01)
  const rgb =
    sign < 0
      ? mixRgb(NEAR_ZERO_RGB, DOWN_RGB, magSqrt)
      : sign > 0
        ? mixRgb(NEAR_ZERO_RGB, UP_RGB, magSqrt)
        : NEAR_ZERO_RGB

  if (strategy === 'original') {
    const size = clamp(1.55 + 0.45 * magSqrt, 1.5, 2)
    const a = clamp(0.42 + 0.36 * magSqrt, 0.4, 0.78)
    return { r: rgb[0], g: rgb[1], b: rgb[2], a, size }
  }

  const base = 1.25
  const span = usesGridStyle(strategy) ? 0.8 : 0.72
  const size = clamp(base + span * magSqrt, 1.2, 2.05)
  /** Slightly higher alpha floor for positives so weak uplifts stay visible vs basemap. */
  const aBase = sign > 0 ? 0.28 : 0.22
  const a = clamp(aBase + 0.58 * magSqrt, sign > 0 ? 0.26 : 0.2, 0.82)
  return { r: rgb[0], g: rgb[1], b: rgb[2], a, size }
}

function InSarCanvasOverlay({
  points,
  strategy,
  debugSignFilter = 'all',
}: {
  points: Point[]
  strategy: Strategy
  debugSignFilter?: DebugSignFilter
}) {
  const map = useMap()
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const { maxNegMag, maxPosMag } = useMemo(
    () => maxNegativeAndPositiveMags(points),
    [points],
  )

  useEffect(() => {
    if (!canvasRef.current) {
      const canvas = L.DomUtil.create('canvas', 'insar-canvas-overlay') as HTMLCanvasElement
      canvas.style.pointerEvents = 'none'
      canvas.style.position = 'absolute'
      canvas.style.left = '0'
      canvas.style.top = '0'
      const pane = map.getPane(INSAR_POINTS_PANE) ?? map.getContainer()
      canvas.style.zIndex = ''
      pane.appendChild(canvas)
      canvasRef.current = canvas
    }

    const draw = () => {
      const canvas = canvasRef.current
      if (!canvas) return
      const size = map.getSize()
      if (size.x <= 0 || size.y <= 0) return

      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.floor(size.x * dpr)
      canvas.height = Math.floor(size.y * dpr)
      canvas.style.width = `${size.x}px`
      canvas.style.height = `${size.y}px`

      const ctx = canvas.getContext('2d')
      if (!ctx) return

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, size.x, size.y)

      const cellPx = estimateGridCellSizePx(size.x, size.y, points.length)
      const screenJitter = usesGridStyle(strategy) ? cellPx * 0.3 : 0

      const drawOne = (p: Point, i: number) => {
        const d = p.displacement
        if (debugSignFilter === 'positive' && d <= 0) return
        if (debugSignFilter === 'negative' && d >= 0) return

        const key = p.id ?? `i-${i}`

        let lat = p.lat
        let lng = p.lng
        if (usesGridStyle(strategy)) {
          lat += (hashU01(key, 0x11) - 0.5) * 2 * GRID_GEO_JITTER_DEG
          lng += (hashU01(key, 0x12) - 0.5) * 2 * GRID_GEO_JITTER_DEG
        }

        const pt = map.latLngToContainerPoint(L.latLng(lat, lng))
        let drawX = pt.x
        let drawY = pt.y
        if (usesGridStyle(strategy)) {
          drawX += (hashU01(key, 0x21) - 0.5) * 2 * screenJitter
          drawY += (hashU01(key, 0x22) - 0.5) * 2 * screenJitter
        }

        const margin = 8 + screenJitter
        if (
          drawX < -margin ||
          drawY < -margin ||
          drawX > size.x + margin ||
          drawY > size.y + margin
        ) {
          return
        }
        const { r, g, b, a, size: px } = stylePoint(
          p.displacement,
          maxNegMag,
          maxPosMag,
          strategy,
        )
        ctx.fillStyle = `rgba(${r},${g},${b},${a})`
        const w = Math.max(1, Math.round(px))
        const x = Math.round(drawX - w / 2)
        const y = Math.round(drawY - w / 2)
        ctx.fillRect(x, y, w, w)
      }

      /** Non-positive first, then positives — avoids blues painting over weak reds. */
      for (let i = 0; i < points.length; i++) {
        if (points[i]!.displacement > 0) continue
        drawOne(points[i]!, i)
      }
      for (let i = 0; i < points.length; i++) {
        if (points[i]!.displacement <= 0) continue
        drawOne(points[i]!, i)
      }
    }

    let raf = 0
    const scheduleDraw = () => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        draw()
      })
    }

    const onInteract = () => scheduleDraw()
    const onViewChange = () => draw()

    map.whenReady(onViewChange)
    map.on('move zoom zoomanim viewreset', onInteract)
    map.on('moveend zoomend resize', onViewChange)
    onViewChange()

    return () => {
      if (raf) cancelAnimationFrame(raf)
      map.off('move zoom zoomanim viewreset', onInteract)
      map.off('moveend zoomend resize', onViewChange)
    }
  }, [map, points, maxNegMag, maxPosMag, strategy, debugSignFilter])

  useEffect(() => {
    return () => {
      canvasRef.current?.remove()
      canvasRef.current = null
    }
  }, [map])

  return null
}

function MapSizeSync() {
  const map = useMap()
  useEffect(() => {
    const el = map.getContainer()
    const fix = () => map.invalidateSize()
    fix()
    map.whenReady(fix)
    const ro = new ResizeObserver(fix)
    ro.observe(el)
    return () => ro.disconnect()
  }, [map])
  return null
}

function MapReadyBridge({ onReady }: { onReady: (map: L.Map) => void }) {
  const map = useMap()
  useEffect(() => {
    const emit = () => onReady(map)
    map.whenReady(emit)
    emit()
  }, [map, onReady])
  return null
}

function MapViewSync({
  onChange,
}: {
  onChange: (v: MapView) => void
}) {
  const map = useMap()
  useEffect(() => {
    const emit = () => {
      const b = map.getBounds()
      onChange({
        bounds: {
          south: b.getSouth(),
          west: b.getWest(),
          north: b.getNorth(),
          east: b.getEast(),
        },
        zoom: map.getZoom(),
      })
    }
    emit()
    map.whenReady(emit)
    map.on('moveend', emit)
    map.on('zoomend', emit)
    map.on('resize', emit)
    return () => {
      map.off('moveend', emit)
      map.off('zoomend', emit)
      map.off('resize', emit)
    }
  }, [map, onChange])
  return null
}

export type StructureBadge = 'broken' | 'preserved'

type Props = {
  points: Point[]
  strategy: Strategy
  /** Only the leader map should publish bounds (viewport filter + sync). */
  onMapViewChange?: (v: MapView) => void
  onMapReady: (map: L.Map) => void
  /** Live zoom for map chrome (from Leaflet via parent). */
  mapZoom: number
  strategyLabel: string
  retainedPoints: number
  viewportPoints: number
  retentionPercentLabel: string
  /** False when Original (full density) is active. */
  retentionApplies: boolean
  /** Right-map narrative badge (Random vs Grid). */
  structureBadge?: StructureBadge
  /** Debug: draw only positive or negative points (default all). */
  debugSignFilter?: DebugSignFilter
  /** Drag box to pick a geographic region (`LatLngBounds` equivalent; counts derived in app). */
  boxSelectActive?: boolean
  committedBoxBounds?: ViewportBounds | null
  onBoxSelectionComplete?: (bounds: GeographicRegionBounds) => void
  /** True while parent is applying a new sampling strategy (show map overlay). */
  strategySwitching?: boolean
}

function DisplacementLegend() {
  return (
    <div className="displacement-legend" aria-label="Displacement scale">
      <div className="displacement-legend-title">Displacement</div>
      <div className="displacement-legend-axis">
        <span className="displacement-legend-axis-label displacement-legend-axis-label--down">
          Down
        </span>
        <span className="displacement-legend-axis-label displacement-legend-axis-label--up">
          Up
        </span>
      </div>
      <div
        className="displacement-legend-gradient"
        role="img"
        aria-hidden
      />
    </div>
  )
}

function MapChrome({
  mapZoom,
  strategyLabel,
  retainedPoints,
  viewportPoints,
  retentionPercentLabel,
  retentionApplies,
}: {
  mapZoom: number
  strategyLabel: string
  retainedPoints: number
  viewportPoints: number
  retentionPercentLabel: string
  retentionApplies: boolean
}) {
  const fmt = (n: number) => n.toLocaleString('en-US')
  return (
    <>
      <div className="map-zoom-badge" title="Current map zoom">
        <span className="map-zoom-badge__label">Zoom</span>
        <span className="map-zoom-badge__value tabular">
          {mapZoom.toFixed(1)}
        </span>
      </div>
      <div className="map-status-toolbar" role="status">
        <div className="map-status-toolbar__col map-status-toolbar__col--zoom">
          <span className="map-status-toolbar__label">Zoom</span>
          <span className="map-status-toolbar__value map-status-toolbar__value--accent tabular">
            {mapZoom.toFixed(1)}
          </span>
        </div>
        <div className="map-status-toolbar__col map-status-toolbar__col--strategy">
          <span className="map-status-toolbar__label">Strategy</span>
          <span
            className="map-status-toolbar__value map-status-toolbar__value--truncate tabular"
            title={strategyLabel}
          >
            {strategyLabel}
          </span>
        </div>
        <div className="map-status-toolbar__col map-status-toolbar__col--displayed">
          <span className="map-status-toolbar__label">Displayed</span>
          <span className="map-status-toolbar__value tabular">
            <span className="map-status-toolbar__value-num">
              {fmt(retainedPoints)}
            </span>
            <span className="map-status-toolbar__muted"> / {fmt(viewportPoints)}</span>
          </span>
        </div>
        <div className="map-status-toolbar__col map-status-toolbar__col--retention">
          <span className="map-status-toolbar__label">
            {retentionApplies ? 'Retention' : 'Mode'}
          </span>
          <span
            className={
              retentionApplies
                ? 'map-status-toolbar__value map-status-toolbar__value--accent tabular'
                : 'map-status-toolbar__value map-status-toolbar__value--stat tabular'
            }
          >
            {retentionApplies ? retentionPercentLabel : 'Full density'}
          </span>
        </div>
      </div>
    </>
  )
}

export default function PointsMap({
  points,
  strategy,
  onMapViewChange,
  onMapReady,
  mapZoom,
  strategyLabel,
  retainedPoints,
  viewportPoints,
  retentionPercentLabel,
  retentionApplies,
  structureBadge,
  debugSignFilter = 'all',
  boxSelectActive = false,
  committedBoxBounds = null,
  onBoxSelectionComplete,
  strategySwitching = false,
}: Props) {
  return (
    <div className="points-map-host">
      <div className="map-pane-inner">
        {structureBadge === 'broken' ? (
          <div className="map-structure-flag map-structure-flag--bad" role="note">
            Structure stressed
          </div>
        ) : null}
        {structureBadge === 'preserved' ? (
          <div className="map-structure-flag map-structure-flag--good" role="note">
            Structure preserved
          </div>
        ) : null}
        <MapContainer
          center={CENTER}
          zoom={DEFAULT_ZOOM}
          zoomSnap={0.5}
          className="points-map"
          style={{ height: '100%', width: '100%' }}
          scrollWheelZoom
        >
          <MapReadyBridge onReady={onMapReady} />
          <MapSizeSync />
          {onMapViewChange ? (
            <MapViewSync onChange={onMapViewChange} />
          ) : null}
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
            url={POSITRON_URL}
            subdomains="abcd"
            maxZoom={20}
          />
          <Pane name={INSAR_POINTS_PANE} style={{ zIndex: 430 }} />
          <Pane name={BOX_SELECT_PANE} style={{ zIndex: 460 }}>
            {committedBoxBounds ? (
              <Rectangle
                bounds={[
                  [committedBoxBounds.south, committedBoxBounds.west],
                  [committedBoxBounds.north, committedBoxBounds.east],
                ]}
                pathOptions={{
                  color: '#b85d86',
                  weight: 2,
                  fillColor: '#d67fa3',
                  fillOpacity: 0.08,
                }}
              />
            ) : null}
          </Pane>
          {boxSelectActive && onBoxSelectionComplete ? (
            <BoxSelectInteraction
              active={boxSelectActive}
              onComplete={onBoxSelectionComplete}
            />
          ) : null}
          <InSarCanvasOverlay
            points={points}
            strategy={strategy}
            debugSignFilter={debugSignFilter}
          />
        </MapContainer>
        {strategySwitching ? (
          <div
            className="map-strategy-loading"
            role="status"
            aria-live="polite"
            aria-label="Updating map sampling"
          >
            <CircularProgress
              size={40}
              thickness={3.6}
              sx={{
                color: 'rgba(232, 190, 210, 0.95)',
              }}
            />
            <span className="map-strategy-loading__text">Updating sampling…</span>
          </div>
        ) : null}
        <div className="map-vignette" aria-hidden />
        <MapChrome
          mapZoom={mapZoom}
          strategyLabel={strategyLabel}
          retainedPoints={retainedPoints}
          viewportPoints={viewportPoints}
          retentionPercentLabel={retentionPercentLabel}
          retentionApplies={retentionApplies}
        />
        <DisplacementLegend />
      </div>
    </div>
  )
}
