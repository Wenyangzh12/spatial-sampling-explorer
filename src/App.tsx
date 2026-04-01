import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import CssBaseline from '@mui/material/CssBaseline'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Slider from '@mui/material/Slider'
import Typography from '@mui/material/Typography'
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
import ComputationTimeDialog, {
  type ComputationTimeRow,
} from './ComputationTimeDialog'
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

const INITIAL_STRATEGY: Strategy = 'random'

export default function App() {
  const points = useMemo(() => generateMockPoints(), [])
  /** Shown in UI immediately when the user picks from the list. */
  const [uiStrategy, setUiStrategy] = useState<Strategy>(INITIAL_STRATEGY)
  /** Drives decimate() / map points — updates after a paint so loading state can show first. */
  const [appliedStrategy, setAppliedStrategy] =
    useState<Strategy>(INITIAL_STRATEGY)
  const [strategySwitching, setStrategySwitching] = useState(false)
  const applyRafRef = useRef(0)
  const applyTimeoutRef = useRef(0)
  const pendingApplyRef = useRef<Strategy | null>(null)

  /**
   * Apply decimation on the next frame after paint so loading UI (progress + overlay)
   * is visible before synchronous heavy work blocks the main thread.
   */
  const scheduleStrategyApply = useCallback((next: Strategy) => {
    cancelAnimationFrame(applyRafRef.current)
    window.clearTimeout(applyTimeoutRef.current)
    pendingApplyRef.current = next
    setUiStrategy(next)
    setStrategySwitching(true)
    applyRafRef.current = requestAnimationFrame(() => {
      applyTimeoutRef.current = window.setTimeout(() => {
        applyRafRef.current = 0
        applyTimeoutRef.current = 0
        const target = pendingApplyRef.current
        if (target == null) return
        setAppliedStrategy(target)
        queueMicrotask(() => {
          if (pendingApplyRef.current === target) {
            setStrategySwitching(false)
          }
        })
      }, 0)
    })
  }, [])

  useEffect(
    () => () => {
      cancelAnimationFrame(applyRafRef.current)
      window.clearTimeout(applyTimeoutRef.current)
    },
    [],
  )

  const [mapView, setMapView] = useState<MapView | null>(null)
  const [map, setMap] = useState<LeafletMap | null>(null)
  const [displacementTrendOpen, setDisplacementTrendOpen] = useState(false)
  const [computationTimeOpen, setComputationTimeOpen] = useState(false)
  const [selectedRegionBounds, setSelectedRegionBounds] =
    useState<GeographicRegionBounds | null>(null)
  const [boxSelectMode, setBoxSelectMode] = useState(false)
  const [retentionRatio, setRetentionRatio] = useState(DEFAULT_RETENTION_RATIO)
  /** Strategies the user has chosen at least once — only these appear in the trend modal. */
  const visitedStrategiesRef = useRef<Set<Strategy>>(new Set())
  const [visitedEpoch, setVisitedEpoch] = useState(0)

  useLayoutEffect(() => {
    visitedStrategiesRef.current.add(uiStrategy)
    setVisitedEpoch((e) => e + 1)
  }, [uiStrategy])

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
    partial: Partial<Record<Strategy, { points: Point[]; ms: number }>>
  }>({ key: '', partial: {} })

  const computeContextKey = useMemo(
    () => `${viewId}|${filtered.length}|${map ? 1 : 0}`,
    [viewId, filtered.length, map],
  )

  /** Decimate only when a strategy is selected or needed for an open modal. */
  const getDecimated = useCallback(
    (s: Strategy): { points: Point[]; ms: number } => {
      const store = decimateCacheRef.current
      if (store.key !== computeContextKey) {
        store.key = computeContextKey
        store.partial = {}
      }
      const hit = store.partial[s]
      if (hit) return hit
      const t0 = performance.now()
      const pts = decimate(filtered, s, zoom, map, decimateOpts)
      const ms = performance.now() - t0
      const ent = { points: pts, ms }
      store.partial[s] = ent
      return ent
    },
    [computeContextKey, decimateOpts, filtered, map, zoom],
  )

  const activeDecimated = useMemo(
    () => getDecimated(appliedStrategy),
    [getDecimated, appliedStrategy],
  )

  const visiblePoints = activeDecimated.points

  const boundsForDisplacementTrend =
    selectedRegionBounds ?? mapView?.bounds ?? null

  const displacementSeries: DisplacementStrategySeries[] = useMemo(() => {
    if (
      !displacementTrendOpen ||
      !boundsForDisplacementTrend ||
      viewId === ''
    ) {
      return []
    }
    const visited = visitedStrategiesRef.current
    const order = strategies.map((s) => s.value)
    const out: DisplacementStrategySeries[] = []
    for (const s of order) {
      if (!visited.has(s)) continue
      const { points: pts, ms } = getDecimated(s)
      const n = pointsInViewport(pts, boundsForDisplacementTrend).length
      if (n === 0) continue
      const region = regionSelectionFromViewport(boundsForDisplacementTrend, n)
      out.push({
        strategy: s,
        label: strategies.find((x) => x.value === s)?.label ?? s,
        selectedPointCount: n,
        monthly: simulateRegionDisplacementTrend(region, s),
        computeMs: ms,
      })
    }
    return out
  }, [
    displacementTrendOpen,
    boundsForDisplacementTrend,
    viewId,
    getDecimated,
    visitedEpoch,
  ])

  const computationRows: ComputationTimeRow[] = useMemo(() => {
    if (!computationTimeOpen || viewId === '') return []
    const visited = visitedStrategiesRef.current
    const list: {
      strategy: Strategy
      label: string
      ms: number
      pointsOut: number
    }[] = []
    for (const s of strategies) {
      if (!visited.has(s.value)) continue
      const { points, ms } = getDecimated(s.value)
      list.push({
        strategy: s.value,
        label: s.label,
        ms,
        pointsOut: points.length,
      })
    }
    list.sort((a, b) => a.ms - b.ms)
    const baseline = baselineMsForPeers(list.map((x) => x.ms))
    return list.map((r, i) => ({
      strategy: r.strategy,
      label: r.label,
      ms: r.ms,
      pointsOut: r.pointsOut,
      rank: i + 1,
      relativeLabel: formatRelativeMultiplier(r.ms, baseline),
      isFastest: i === 0,
      isCurrent: r.strategy === uiStrategy,
    }))
  }, [computationTimeOpen, viewId, getDecimated, visitedEpoch, uiStrategy])

  const allStrategyComputeMs = useMemo(() => {
    const p = decimateCacheRef.current.partial
    const visited = visitedStrategiesRef.current
    const ms: number[] = []
    for (const { value } of strategies) {
      if (!visited.has(value)) continue
      const ent = p[value]
      if (ent) ms.push(ent.ms)
    }
    if (ms.length === 0) {
      const cur = p[appliedStrategy]
      if (cur) ms.push(cur.ms)
    }
    return ms
  }, [
    getDecimated,
    appliedStrategy,
    activeDecimated,
    displacementSeries,
    visitedEpoch,
  ])

  const currentComputeMs = activeDecimated.ms
  const fastestStrategyMs = baselineMsForPeers(allStrategyComputeMs)
  const currentRelativeLabel = formatRelativeMultiplier(
    currentComputeMs,
    fastestStrategyMs,
  )
  const currentStrategySlowHint = slowComputeHint(
    currentComputeMs,
    allStrategyComputeMs,
  )

  const {
    linePointsBefore,
    linePointsAfter,
    displacementRegionReady,
    displayedPointsInSelectedRegion,
  } = useMemo(() => {
    const viewportBounds = mapView?.bounds ?? null
    const shown = getDecimated(appliedStrategy).points
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
      linePointsBefore: filtered.filter(nearLine).length,
      linePointsAfter: shown.filter(nearLine).length,
      displacementRegionReady,
      displayedPointsInSelectedRegion,
    }
  }, [
    filtered,
    getDecimated,
    mapView,
    appliedStrategy,
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
      setComputationTimeOpen(false)
    }
  }, [displacementRegionReady])

  const fmt = (n: number) => n.toLocaleString('en-US')

  const meta = strategies.find((s) => s.value === uiStrategy)!

  const usesRetentionBudget = uiStrategy !== 'original'

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
              value={uiStrategy}
              aria-busy={strategySwitching}
              onChange={(e) =>
                scheduleStrategyApply(e.target.value as Strategy)
              }
            >
              {strategies.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
            <p className="panel-card__desc">{meta.blurb}</p>
            {strategySwitching ? (
              <Typography
                variant="caption"
                component="p"
                sx={{
                  mt: 0.75,
                  mb: 0,
                  fontSize: '0.7rem',
                  fontWeight: 600,
                  color: 'rgba(214, 180, 200, 0.95)',
                }}
                aria-live="polite"
              >
                Updating sampling…
              </Typography>
            ) : null}
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

          <section
            className="panel-card"
            aria-labelledby="panel-summary-h"
            style={{
              opacity: strategySwitching ? 0.5 : 1,
              transition: 'opacity 0.15s ease',
            }}
          >
            <h2 id="panel-summary-h" className="panel-card__heading">
              Summary
            </h2>
            <div className="panel-metric">
              <div className="panel-metric__value tabular">
                {strategySwitching ? '—' : fmt(visiblePoints.length)}
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
              {strategySwitching ? (
                <span className="panel-line-metric__empty">Updating…</span>
              ) : linePointsBefore > 0 && lineRetentionPct !== null ? (
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
                !strategySwitching && currentStrategySlowHint
                  ? 'panel-compute panel-compute--slower'
                  : 'panel-compute'
              }
              aria-live="polite"
            >
              <div className="panel-compute__label">Computation time</div>
              <div className="panel-compute__row">
                <span className="panel-compute__value tabular">
                  {strategySwitching ? (
                    '—'
                  ) : (
                    <>
                      {formatComputeMs(currentComputeMs)}{' '}
                      <span className="panel-compute__rel tabular">
                        ({currentRelativeLabel})
                      </span>
                    </>
                  )}
                </span>
                {!strategySwitching && currentStrategySlowHint ? (
                  <span className="panel-compute__hint">slower vs fastest</span>
                ) : null}
              </div>
              <p className="panel-compute__sub">
                Sampling runs only for the strategy you select. Trend chart includes
                strategies you have chosen in this session. Relative to fastest among
                those ({formatComputeMs(fastestStrategyMs)}).
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
              <Button
                variant="contained"
                color="inherit"
                size="medium"
                fullWidth
                disableElevation
                className="panel-action-btn panel-action-btn--compute"
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
                  if (displacementRegionReady) setComputationTimeOpen(true)
                }}
              >
                View computation time
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
                strategy={appliedStrategy}
                onMapViewChange={onMapViewChange}
                onMapReady={setMap}
                mapZoom={zoom}
                strategyLabel={meta.label}
                retainedPoints={visiblePoints.length}
                viewportPoints={filtered.length}
                retentionPercentLabel={retentionPercentLabel}
                retentionApplies={appliedStrategy !== 'original'}
                boxSelectActive={boxSelectMode}
                committedBoxBounds={selectedRegionBounds}
                onBoxSelectionComplete={handleRegionSelectComplete}
                strategySwitching={strategySwitching}
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
            selectedStrategy={uiStrategy}
          />
        ) : null}

        <ComputationTimeDialog
          open={computationTimeOpen}
          onClose={() => setComputationTimeOpen(false)}
          rows={computationRows}
          viewportPoints={filtered.length}
          retentionLabel={retentionPercentLabel}
        />
      </div>
    </ThemeProvider>
  )
}
