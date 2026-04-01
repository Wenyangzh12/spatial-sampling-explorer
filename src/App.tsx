import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import CssBaseline from '@mui/material/CssBaseline'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Slider from '@mui/material/Slider'
import {
  decimate,
  DEFAULT_RETENTION_RATIO,
  FALLBACK_MAP_ZOOM,
  pointsInViewport,
  RETENTION_RATIO_MAX,
  RETENTION_RATIO_MIN,
  targetCountFromRetention,
  type GeographicRegionBounds,
  type MapView,
  type Strategy,
} from './decimate'
import {
  generateMockPoints,
  isLineStructuralPoint,
  type Point,
} from './mockData'
import PointsMap from './PointsMap'
import DisplacementTrendDialog, {
  type DisplacementStrategySeries,
} from './DisplacementTrendDialog'
import {
  regionSelectionFromViewport,
  simulateRegionDisplacementTrend,
} from './displacementRegionTrend'
import {
  baselineMsForPeers,
  formatComputeMs,
  formatRelativeMultiplier,
  slowComputeHint,
} from './strategyTiming'
import './App.css'
import type { Map as LeafletMap } from 'leaflet'

const muiTheme = createTheme({
  palette: {
    mode: 'dark',
    primary: {
      main: '#d67fa3',
      dark: '#b85d86',
      light: '#e8b3cc',
    },
    background: {
      default: '#0f0f14',
      paper: '#1b1b24',
    },
    text: {
      primary: '#f8f7fa',
      secondary: '#d4ccd7',
    },
    divider: '#2b2a35',
  },
  shape: { borderRadius: 8 },
  typography: {
    fontFamily:
      'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        body: {
          backgroundColor: '#0f0f14',
          color: '#f8f7fa',
        },
      },
    },
    MuiButton: {
      styleOverrides: {
        root: { textTransform: 'none', fontWeight: 600, borderRadius: 8 },
        containedPrimary: {
          color: '#fafafa',
          background:
            'linear-gradient(180deg, #2a2429 0%, #231f26 50%, #1e1a22 100%)',
          border: '1px solid rgba(214, 127, 163, 0.28)',
          boxShadow: 'none',
          '&:hover': {
            background:
              'linear-gradient(180deg, #322630 0%, #282228 50%, #221e26 100%)',
            borderColor: 'rgba(214, 127, 163, 0.36)',
            boxShadow: 'none',
          },
          '&:active': {
            boxShadow: 'none',
          },
        },
        outlinedInherit: {
          backgroundColor: '#20202a',
          borderColor: 'rgba(214, 127, 163, 0.2)',
          color: '#f0edf2',
          '&:hover': {
            borderColor: 'rgba(214, 127, 163, 0.3)',
            backgroundColor: '#262631',
          },
        },
      },
    },
    MuiSlider: {
      styleOverrides: {
        root: { color: '#d67fa3', height: 4 },
        rail: {
          opacity: 1,
          backgroundColor: '#3f3f46',
        },
        track: {
          border: 'none',
        },
        thumb: {
          boxShadow:
            '0 0 0 2px #1b1b24, 0 1px 2px rgba(214, 127, 163, 0.25)',
          '&:hover, &.Mui-focusVisible': {
            boxShadow:
              '0 0 0 2px #1b1b24, 0 0 0 4px rgba(214, 127, 163, 0.16), 0 2px 6px rgba(214, 127, 163, 0.2)',
          },
        },
      },
    },
    MuiDialog: {
      styleOverrides: {
        paper: {
          backgroundImage: 'none',
          backgroundColor: '#1b1b24',
          border: '1px solid rgba(214, 127, 163, 0.2)',
          boxShadow: '0 16px 56px rgba(0, 0, 0, 0.58)',
        },
      },
    },
  },
})

const strategies: {
  value: Strategy
  label: string
  mapTitle: string
  blurb: string
}[] = [
  {
    value: 'original',
    label: 'Original (full density)',
    mapTitle: 'Original — Full Density',
    blurb: 'Full-density sample: every point in the viewport.',
  },
  {
    value: 'random',
    label: 'Random',
    mapTitle: 'Random (adaptive)',
    blurb: 'Uniform random subsample at the retention budget.',
  },
  {
    value: 'grid',
    label: 'Grid',
    mapTitle: 'Grid (adaptive)',
    blurb: 'Screen-space grid with density-aware cell quotas.',
  },
  {
    value: 'hybrid',
    label: 'Hybrid',
    mapTitle: 'Hybrid (adaptive)',
    blurb: 'Line corridor plus basin fill under shared budget.',
  },
  {
    value: 'blueNoise',
    label: 'Blue-Noise',
    mapTitle: 'Blue-Noise (weighted)',
    blurb: 'Weighted Poisson-disk style spacing in screen space.',
  },
  {
    value: 'topology',
    label: 'Topology-aware',
    mapTitle: 'Topology-aware (connectivity-preserving)',
    blurb: 'Graph/MST-aware importance ranking, top-K under budget.',
  },
]

export default function App() {
  const points = useMemo(() => generateMockPoints(), [])
  const [strategy, setStrategy] = useState<Strategy>('random')
  const [mapView, setMapView] = useState<MapView | null>(null)
  const [map, setMap] = useState<LeafletMap | null>(null)
  const [displacementTrendOpen, setDisplacementTrendOpen] = useState(false)
  const [selectedRegionBounds, setSelectedRegionBounds] =
    useState<GeographicRegionBounds | null>(null)
  const [boxSelectMode, setBoxSelectMode] = useState(false)
  const [retentionRatio, setRetentionRatio] = useState(DEFAULT_RETENTION_RATIO)

  const decimateOpts = useMemo(
    () => ({ retentionRatio }),
    [retentionRatio],
  )

  const handleRegionSelectComplete = useCallback(
    (bounds: GeographicRegionBounds) => {
      setSelectedRegionBounds(bounds)
      setBoxSelectMode(false)
    },
    [],
  )

  const onMapViewChange = useCallback((v: MapView) => {
    setMapView(v)
  }, [])

  const zoom = mapView?.zoom ?? FALLBACK_MAP_ZOOM

  const viewId = useMemo(() => {
    if (!mapView?.bounds) return ''
    const b = mapView.bounds
    return `${zoom}|${b.west}|${b.south}|${b.east}|${b.north}|${retentionRatio}`
  }, [mapView, zoom, retentionRatio])

  const filtered = useMemo(
    () => pointsInViewport(points, mapView?.bounds ?? null),
    [points, mapView],
  )

  const decimateCacheRef = useRef<{
    key: string
    result: Record<Strategy, { points: Point[]; ms: number }>
  } | null>(null)

  /**
   * All strategies timed together (decimate only — not React render).
   * Cached per viewport + retention + input size so identical inputs reuse results
   * and timings stay stable (less flicker).
   */
  const decimatedByStrategy = useMemo(() => {
    const cacheKey = `${viewId}|${filtered.length}|${map ? 1 : 0}`
    const hit = decimateCacheRef.current
    if (hit?.key === cacheKey) return hit.result

    const out = {} as Record<Strategy, { points: Point[]; ms: number }>
    for (const { value } of strategies) {
      const t0 = performance.now()
      const pts = decimate(filtered, value, zoom, map, decimateOpts)
      out[value] = { points: pts, ms: performance.now() - t0 }
    }
    decimateCacheRef.current = { key: cacheKey, result: out }
    return out
  }, [filtered, zoom, map, decimateOpts, viewId])

  const visiblePoints = decimatedByStrategy[strategy].points

  const allStrategyComputeMs = useMemo(
    () => strategies.map((s) => decimatedByStrategy[s.value].ms),
    [decimatedByStrategy],
  )

  const currentComputeMs = decimatedByStrategy[strategy].ms
  const fastestStrategyMs = baselineMsForPeers(allStrategyComputeMs)
  const currentRelativeLabel = formatRelativeMultiplier(
    currentComputeMs,
    fastestStrategyMs,
  )
  const currentStrategySlowHint = slowComputeHint(
    currentComputeMs,
    allStrategyComputeMs,
  )

  const boundsForDisplacementTrend =
    selectedRegionBounds ?? mapView?.bounds ?? null

  const displacementSeries: DisplacementStrategySeries[] = useMemo(() => {
    if (!boundsForDisplacementTrend || viewId === '') return []
    const order = strategies.map((s) => s.value)
    const out: DisplacementStrategySeries[] = []
    for (const s of order) {
      const pts = decimatedByStrategy[s].points
      const n = pointsInViewport(pts, boundsForDisplacementTrend).length
      if (n === 0) continue
      const region = regionSelectionFromViewport(boundsForDisplacementTrend, n)
      out.push({
        strategy: s,
        label: strategies.find((x) => x.value === s)?.label ?? s,
        selectedPointCount: n,
        monthly: simulateRegionDisplacementTrend(region, s),
        computeMs: decimatedByStrategy[s].ms,
      })
    }
    return out
  }, [decimatedByStrategy, viewId, boundsForDisplacementTrend])

  const {
    linePointsBefore,
    linePointsAfter,
    displacementRegionReady,
    displayedPointsInSelectedRegion,
  } = useMemo(() => {
    const viewportBounds = mapView?.bounds ?? null
    const full = decimatedByStrategy.original.points
    const shown = decimatedByStrategy[strategy].points
    const nearLine = (p: (typeof points)[number]) =>
      isLineStructuralPoint(p.lat, p.lng)

    const displayedPointsInSelectedRegion =
      selectedRegionBounds != null
        ? pointsInViewport(shown, selectedRegionBounds).length
        : null

    const displacementRegionReady =
      viewportBounds != null &&
      (selectedRegionBounds != null
        ? displayedPointsInSelectedRegion! > 0
        : filtered.length > 0)

    return {
      linePointsBefore: full.filter(nearLine).length,
      linePointsAfter: shown.filter(nearLine).length,
      displacementRegionReady,
      displayedPointsInSelectedRegion,
    }
  }, [
    decimatedByStrategy,
    filtered,
    mapView,
    strategy,
    selectedRegionBounds,
  ])

  const sharedRetentionTarget = targetCountFromRetention(
    filtered.length,
    retentionRatio,
  )

  const lineRetentionPct =
    linePointsBefore > 0
      ? (100 * linePointsAfter) / linePointsBefore
      : null

  useEffect(() => {
    if (!displacementRegionReady) {
      setDisplacementTrendOpen(false)
    }
  }, [displacementRegionReady])

  const fmt = (n: number) => n.toLocaleString('en-US')

  const meta = strategies.find((s) => s.value === strategy)!

  const usesRetentionBudget = strategy !== 'original'

  const retentionPercentLabel = `${(retentionRatio * 100).toFixed(1)}%`

  return (
    <ThemeProvider theme={muiTheme}>
      <CssBaseline />
      <div className="app">
        <aside className="panel">
          <header className="panel-brand">
            <span className="panel-brand__title">Spatial Sampling Explorer</span>
            <span className="panel-brand__sub">
              Explore sampling strategies within the current map view
            </span>
          </header>

          <section className="panel-card" aria-labelledby="panel-strategy-h">
            <h2 id="panel-strategy-h" className="panel-card__heading">
              Sampling strategy
            </h2>
            <label className="visually-hidden" htmlFor="strategy">
              Strategy
            </label>
            <select
              id="strategy"
              className="panel-select"
              value={strategy}
              onChange={(e) => setStrategy(e.target.value as Strategy)}
            >
              {strategies.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
            <p className="panel-card__desc">{meta.blurb}</p>
          </section>

          {usesRetentionBudget && (
            <section className="panel-card" aria-labelledby="panel-retention-h">
              <h2 id="panel-retention-h" className="panel-card__heading">
                Retention budget
              </h2>
              <Box sx={{ px: 0.5, pt: 0.5, pb: 0.25 }}>
                <Slider
                  size="small"
                  min={RETENTION_RATIO_MIN}
                  max={RETENTION_RATIO_MAX}
                  step={0.005}
                  value={retentionRatio}
                  onChange={(_, v) => setRetentionRatio(v as number)}
                  valueLabelDisplay="auto"
                  valueLabelFormat={(v) => `${(v * 100).toFixed(1)}%`}
                  getAriaValueText={(v) => `${(v * 100).toFixed(1)} percent`}
                  aria-label="Retention ratio"
                />
              </Box>
              <p className="panel-card__meta">
                Target <strong>{fmt(sharedRetentionTarget)}</strong> pts ·{' '}
                {retentionPercentLabel} of {fmt(filtered.length)} in view
              </p>
            </section>
          )}

          <section className="panel-card" aria-labelledby="panel-summary-h">
            <h2 id="panel-summary-h" className="panel-card__heading">
              Summary
            </h2>
            <div className="panel-metric">
              <div className="panel-metric__value tabular">
                {fmt(visiblePoints.length)}
              </div>
              <div className="panel-metric__label">Displayed points</div>
              <div className="panel-metric__sub tabular">
                {usesRetentionBudget ? (
                  <>of {fmt(filtered.length)} in viewport</>
                ) : (
                  <>
                    Full density — all {fmt(filtered.length)} points in the
                    viewport are shown
                  </>
                )}
              </div>
            </div>
            <div className="panel-line-metric" aria-live="polite">
              {linePointsBefore > 0 && lineRetentionPct !== null ? (
                <>
                  <div className="panel-line-metric__label">
                    Line structure retained
                  </div>
                  <div className="panel-line-metric__row">
                    <span className="panel-line-metric__pct tabular">
                      {lineRetentionPct.toFixed(1)}%
                    </span>
                    <span className="panel-line-metric__detail tabular">
                      {fmt(linePointsAfter)} / {fmt(linePointsBefore)} pts
                    </span>
                  </div>
                </>
              ) : (
                <span className="panel-line-metric__empty">No line in view</span>
              )}
            </div>
            <div
              className={
                currentStrategySlowHint
                  ? 'panel-compute panel-compute--slower'
                  : 'panel-compute'
              }
              aria-live="polite"
            >
              <div className="panel-compute__label">Computation time</div>
              <div className="panel-compute__row">
                <span className="panel-compute__value tabular">
                  {formatComputeMs(currentComputeMs)}{' '}
                  <span className="panel-compute__rel tabular">
                    ({currentRelativeLabel})
                  </span>
                </span>
                {currentStrategySlowHint ? (
                  <span className="panel-compute__hint">slower vs fastest</span>
                ) : null}
              </div>
              <p className="panel-compute__sub">
                Sampling (decimate) for the map viewport and retention. Relative to
                fastest strategy in this view ({formatComputeMs(fastestStrategyMs)}).
                {selectedRegionBounds != null
                  ? ' Region box affects the trend chart, not this timing.'
                  : ''}
              </p>
            </div>
          </section>

          <section
            className="panel-card panel-card--actions"
            aria-labelledby="panel-actions-h"
          >
            <h2 id="panel-actions-h" className="panel-card__heading">
              Actions
            </h2>
            <div className="panel-actions-stack">
              <Button
                variant="contained"
                color="inherit"
                size="medium"
                fullWidth
                disableElevation
                className="panel-action-btn panel-action-btn--region"
                onClick={() => setBoxSelectMode((v) => !v)}
                aria-pressed={boxSelectMode}
              >
                {boxSelectMode ? 'Cancel region selection' : 'Select region'}
              </Button>
              <Button
                variant="contained"
                color="inherit"
                size="medium"
                fullWidth
                disableElevation
                className="panel-action-btn panel-action-btn--trend"
                disabled={!displacementRegionReady}
                title={
                  displacementRegionReady
                    ? undefined
                    : selectedRegionBounds != null &&
                        displayedPointsInSelectedRegion === 0
                      ? 'No points in the selected region for this strategy'
                      : 'Map bounds and at least one point in view are required'
                }
                onClick={() => {
                  if (displacementRegionReady) setDisplacementTrendOpen(true)
                }}
              >
                View displacement trend
              </Button>
            </div>
            {selectedRegionBounds != null ? (
              <p className="panel-region-pill" aria-live="polite">
                Region ·{' '}
                <span className="tabular">
                  {fmt(displayedPointsInSelectedRegion ?? 0)} pts
                </span>
              </p>
            ) : null}
          </section>
        </aside>

        <main className="map">
          <div className="map-single">
            <div className="map-viewport">
              <PointsMap
                points={visiblePoints}
                strategy={strategy}
                onMapViewChange={onMapViewChange}
                onMapReady={setMap}
                mapZoom={zoom}
                strategyLabel={meta.label}
                retainedPoints={visiblePoints.length}
                viewportPoints={filtered.length}
                retentionPercentLabel={retentionPercentLabel}
                retentionApplies={strategy !== 'original'}
                boxSelectActive={boxSelectMode}
                committedBoxBounds={selectedRegionBounds}
                onBoxSelectionComplete={handleRegionSelectComplete}
              />
            </div>
          </div>
        </main>

        {displacementTrendOpen &&
        boundsForDisplacementTrend &&
        displacementSeries.length > 0 ? (
          <DisplacementTrendDialog
            open={displacementTrendOpen}
            onClose={() => setDisplacementTrendOpen(false)}
            regionBounds={boundsForDisplacementTrend}
            series={displacementSeries}
            selectedStrategy={strategy}
          />
        ) : null}
      </div>
    </ThemeProvider>
  )
}
