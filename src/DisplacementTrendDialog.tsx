import { useEffect, useMemo, useState } from 'react'
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Typography,
} from '@mui/material'
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { GeographicRegionBounds, Strategy } from './decimate'
import type { MonthlyDisplacementRecord } from './displacementRegionTrend'
import { regionAreaSqDegFromBounds } from './displacementRegionTrend'
import {
  baselineMsForPeers,
  formatComputeMs,
  formatRelativeMultiplier,
  slowComputeHint,
} from './strategyTiming'

export type DisplacementStrategySeries = {
  strategy: Strategy
  label: string
  selectedPointCount: number
  monthly: MonthlyDisplacementRecord[]
  /** Last decimate() duration for this strategy in the current viewport context. */
  computeMs: number
}

/** Canonical comparison order (matches sampling sidebar). */
const STRATEGY_CHART_ORDER: Strategy[] = [
  'original',
  'random',
  'grid',
  'hybrid',
  'blueNoise',
  'topology',
]

/** Padding above/below data range so lines are not clipped at the axis. */
const Y_AXIS_PAD = 0.08

const Y_TICK_COUNT = 10

/** Baseline / full-density reference — clean bright blue, solid, heaviest stroke. */
const CHART_BASELINE_BLUE = '#7ec8ff'

/**
 * Per-strategy encoding: distinct hue + dash pattern so lines are identifiable
 * without the legend (reference = blue solid; samples = varied rose/purple/warm).
 */
const CHART_BASELINE_GLOW_FILTER_ID = 'displacementBaselineGlow'

type LineStyleConfig = {
  color: string
  strokeDasharray?: string
  strokeWidth: number
  dotR: number
  filter?: string
}

const STRATEGY_LINE_STYLE: Record<Strategy, LineStyleConfig> = {
  original: {
    color: CHART_BASELINE_BLUE,
    strokeWidth: 3.55,
    dotR: 4.75,
    filter: `url(#${CHART_BASELINE_GLOW_FILTER_ID})`,
  },
  /** Warm sand — long dash; avoids stacking with pink family. */
  random: {
    color: '#d8b078',
    strokeDasharray: '11 7',
    strokeWidth: 2.15,
    dotR: 3.65,
  },
  /** Soft pink — medium dash (distinct from random / hybrid). */
  grid: {
    color: '#d894ae',
    strokeDasharray: '6 5',
    strokeWidth: 2.35,
    dotR: 3.85,
  },
  /** Mauve-rose — solid, cooler than grid pink. */
  hybrid: {
    color: '#cfafc8',
    strokeWidth: 2.25,
    dotR: 3.75,
  },
  /** Purple-magenta — dotted. */
  blueNoise: {
    color: '#a97fff',
    strokeDasharray: '1 4',
    strokeWidth: 2.55,
    dotR: 3.5,
  },
  /** Bright rose — solid, second-thickest after reference. */
  topology: {
    color: '#ff6fa8',
    strokeWidth: 3.05,
    dotR: 4.5,
  },
}

/** Non-reference lines when another strategy is emphasized (sidebar / hover / legend). */
const OPACITY_DIMMED_NON_REFERENCE = 0.5
/** Reference stays readable when comparing to a selected decimation strategy. */
const OPACITY_ORIGINAL_WHEN_EMPHASIS_ELSEWHERE = 0.92
/** Non-emphasized lines when Original is the focus. */
const OPACITY_DIMMED_VS_ORIGINAL = 0.52

const CHART_AXIS_TICK = { fontSize: 11, fill: '#efeaf4' } as const
const CHART_AXIS_LINE = '#4a4858'
const CHART_GRID_STROKE = 'rgba(48, 46, 58, 0.32)'

function strategySortKey(s: Strategy): number {
  const i = STRATEGY_CHART_ORDER.indexOf(s)
  return i === -1 ? 999 : i
}

function sortSeriesByStrategy(
  list: DisplacementStrategySeries[],
): DisplacementStrategySeries[] {
  return [...list].sort(
    (a, b) => strategySortKey(a.strategy) - strategySortKey(b.strategy),
  )
}

function computeYAxisFromSeries(
  ordered: DisplacementStrategySeries[],
): { domain: [number, number]; ticks: number[] } {
  let minV = Infinity
  let maxV = -Infinity
  for (const ser of ordered) {
    for (const m of ser.monthly) {
      const v = m.averageDisplacement
      if (v < minV) minV = v
      if (v > maxV) maxV = v
    }
  }

  if (!Number.isFinite(minV) || !Number.isFinite(maxV)) {
    return { domain: [0, 1], ticks: [0, 0.25, 0.5, 0.75, 1] }
  }

  if (Math.abs(maxV - minV) < 1e-12) {
    const c = minV
    const span = Math.max(Y_AXIS_PAD * 3, 0.15)
    const y0 = c - span
    const y1 = c + span
    const ticks = Array.from({ length: Y_TICK_COUNT }, (_, i) =>
      Number((y0 + ((y1 - y0) * i) / (Y_TICK_COUNT - 1)).toFixed(4)),
    )
    return { domain: [y0, y1], ticks }
  }

  const y0 = minV - Y_AXIS_PAD
  const y1 = maxV + Y_AXIS_PAD
  const span = y1 - y0
  const ticks = Array.from({ length: Y_TICK_COUNT }, (_, i) =>
    Number((y0 + (span * i) / (Y_TICK_COUNT - 1)).toFixed(4)),
  )
  return { domain: [y0, y1], ticks }
}

function lineEmphasisState(
  strategy: Strategy,
  emphasis: Strategy,
): {
  strokeOpacity: number
  extraStrokeWidth: number
  dotFillOpacity: number
} {
  const isEmphasis = emphasis === strategy
  const isOriginal = strategy === 'original'

  if (isEmphasis) {
    return {
      strokeOpacity: 1,
      extraStrokeWidth: isOriginal ? 0.45 : 0.95,
      dotFillOpacity: 1,
    }
  }
  if (isOriginal) {
    if (emphasis === 'original') {
      return { strokeOpacity: 1, extraStrokeWidth: 0, dotFillOpacity: 1 }
    }
    return {
      strokeOpacity: OPACITY_ORIGINAL_WHEN_EMPHASIS_ELSEWHERE,
      extraStrokeWidth: 0,
      dotFillOpacity: 0.88,
    }
  }
  const o =
    emphasis === 'original' ? OPACITY_DIMMED_VS_ORIGINAL : OPACITY_DIMMED_NON_REFERENCE
  return { strokeOpacity: o, extraStrokeWidth: 0, dotFillOpacity: o * 0.92 }
}

type Props = {
  open: boolean
  onClose: () => void
  /** Geographic region used for filtering and chart copy (box or viewport). */
  regionBounds: GeographicRegionBounds
  /** One entry per cached strategy that has points in the region. */
  series: DisplacementStrategySeries[]
  /** Sidebar sampling strategy — emphasized in the chart and legend. */
  selectedStrategy: Strategy
}

export default function DisplacementTrendDialog({
  open,
  onClose,
  regionBounds,
  series,
  selectedStrategy,
}: Props) {
  const [hoveredStrategy, setHoveredStrategy] = useState<Strategy | null>(null)
  /** Click legend to pin emphasis; hover still previews. */
  const [focusedStrategy, setFocusedStrategy] = useState<Strategy | null>(null)

  useEffect(() => {
    if (!open) {
      setFocusedStrategy(null)
      setHoveredStrategy(null)
    }
  }, [open])

  const orderedSeries = useMemo(() => sortSeriesByStrategy(series), [series])

  const chartData = useMemo(() => {
    if (orderedSeries.length === 0) return []
    const n = orderedSeries[0]!.monthly.length
    const rows: Record<string, string | number>[] = []
    for (let i = 0; i < n; i += 1) {
      const month = orderedSeries[0]!.monthly[i]!.month
      const row: Record<string, string | number> = { month }
      for (const s of orderedSeries) {
        row[s.strategy] = s.monthly[i]!.averageDisplacement
      }
      rows.push(row)
    }
    return rows
  }, [orderedSeries])

  const { domain: yDomain, ticks: yTicks } = useMemo(
    () => computeYAxisFromSeries(orderedSeries),
    [orderedSeries],
  )

  const area = regionAreaSqDegFromBounds(regionBounds)

  const emphasisStrategy = useMemo(() => {
    const raw = hoveredStrategy ?? focusedStrategy ?? selectedStrategy
    const present = new Set(orderedSeries.map((s) => s.strategy))
    if (present.has(raw)) return raw
    if (present.has('original')) return 'original'
    return orderedSeries[0]?.strategy ?? raw
  }, [
    hoveredStrategy,
    focusedStrategy,
    selectedStrategy,
    orderedSeries,
  ])

  const computePeerMs = useMemo(
    () => orderedSeries.map((x) => x.computeMs),
    [orderedSeries],
  )

  const modalBaselineMs = baselineMsForPeers(computePeerMs)

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth={false}
      fullWidth
      PaperProps={{
        sx: {
          width: 'min(1360px, 96vw)',
          maxHeight: 'min(92vh, 920px)',
          display: 'flex',
          flexDirection: 'column',
          m: { xs: 1, sm: 2 },
        },
      }}
    >
      <DialogTitle
        sx={{ py: 0.85, px: 1.5, fontSize: '1.02rem', fontWeight: 600, flexShrink: 0 }}
      >
        Trend comparison across sampling strategies
      </DialogTitle>
      <DialogContent
        sx={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
          pt: 0,
          pb: 1,
          px: 1.5,
          overflow: 'hidden',
        }}
      >
        <Typography
          variant="body2"
          sx={{
            mb: 0.65,
            fontSize: '0.72rem',
            lineHeight: 1.35,
            color: '#c9c2d4',
            flexShrink: 0,
          }}
        >
          Region: lng [{regionBounds.west.toFixed(4)}, {regionBounds.east.toFixed(4)}],
          lat [{regionBounds.south.toFixed(4)}, {regionBounds.north.toFixed(4)}] · area{' '}
          ~{area.toExponential(2)} deg²
        </Typography>

        <Box
          sx={{
            flex: '1 1 auto',
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
            width: '100%',
          }}
          onMouseLeave={() => setHoveredStrategy(null)}
        >
          <Box
            sx={{
              width: '100%',
              flex: '1 1 auto',
              minHeight: { xs: 420, sm: 540 },
              height: { xs: '64vh', sm: 'min(76vh, 800px)' },
              maxHeight: 840,
            }}
          >
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={chartData}
                margin={{ top: 4, right: 10, left: 4, bottom: 8 }}
              >
                <defs>
                  <filter
                    id={CHART_BASELINE_GLOW_FILTER_ID}
                    x="-45%"
                    y="-45%"
                    width="190%"
                    height="190%"
                  >
                    <feGaussianBlur
                      in="SourceGraphic"
                      stdDeviation="1.4"
                      result="blur"
                    />
                    <feMerge>
                      <feMergeNode in="blur" />
                      <feMergeNode in="SourceGraphic" />
                    </feMerge>
                  </filter>
                </defs>
                <CartesianGrid
                  strokeDasharray="4 6"
                  stroke={CHART_GRID_STROKE}
                  vertical={false}
                />
                <XAxis
                  dataKey="month"
                  tick={CHART_AXIS_TICK}
                  axisLine={{ stroke: CHART_AXIS_LINE }}
                  tickLine={{ stroke: CHART_AXIS_LINE }}
                />
                <YAxis
                  domain={yDomain}
                  ticks={yTicks}
                  tick={CHART_AXIS_TICK}
                  tickFormatter={(v) => v.toFixed(2)}
                  width={54}
                  axisLine={{ stroke: CHART_AXIS_LINE }}
                  tickLine={{ stroke: CHART_AXIS_LINE }}
                />
                <Tooltip
                  formatter={(value, name) => {
                    const v =
                      typeof value === 'number' ? value : Number(value)
                    if (Number.isNaN(v)) return '—'
                    return [v.toFixed(3), name]
                  }}
                  labelStyle={{ color: '#f4f0f8', fontWeight: 600, marginBottom: 6 }}
                  itemStyle={{ color: '#faf8fc', fontWeight: 500 }}
                  contentStyle={{
                    fontSize: 12,
                    backgroundColor: '#1a1a24',
                    border: '1px solid rgba(214, 127, 163, 0.32)',
                    borderRadius: 8,
                    color: '#faf8fc',
                    padding: '11px 14px',
                    boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
                  }}
                  cursor={{
                    stroke: 'rgba(214, 127, 163, 0.28)',
                    strokeWidth: 1,
                  }}
                />
                {orderedSeries.map((s) => {
                  const st = STRATEGY_LINE_STYLE[s.strategy]
                  const vis = lineEmphasisState(s.strategy, emphasisStrategy)
                  const strokeW = st.strokeWidth + vis.extraStrokeWidth
                  const isHover = hoveredStrategy === s.strategy
                  const relLabel = formatRelativeMultiplier(
                    s.computeMs,
                    modalBaselineMs,
                  )
                  const lineName = `${s.label} — ${formatComputeMs(s.computeMs)} (${relLabel})`
                  return (
                    <Line
                      key={s.strategy}
                      type="natural"
                      dataKey={s.strategy}
                      name={lineName}
                      stroke={st.color}
                      strokeWidth={strokeW}
                      strokeOpacity={vis.strokeOpacity}
                      strokeDasharray={st.strokeDasharray}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      filter={st.filter}
                      dot={{
                        r: isHover ? st.dotR + 0.85 : st.dotR,
                        strokeWidth: isHover ? 2.5 : 2,
                        stroke: st.color,
                        strokeOpacity: vis.strokeOpacity,
                        fill: '#25252e',
                        fillOpacity: vis.dotFillOpacity,
                      }}
                      activeDot={{
                        r: st.dotR + 3,
                        strokeWidth: 3,
                        stroke: st.color,
                        fill: '#2e2e38',
                      }}
                      isAnimationActive={false}
                      onMouseEnter={() => setHoveredStrategy(s.strategy)}
                    />
                  )
                })}
              </LineChart>
            </ResponsiveContainer>
          </Box>
          <Box
            component="ul"
            sx={{
              listStyle: 'none',
              m: 0,
              mt: 1.1,
              pt: 1,
              borderTop: '1px solid rgba(214, 127, 163, 0.1)',
              p: 0,
              pl: 0,
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: 2.25,
              rowGap: 1.15,
              flexShrink: 0,
            }}
            aria-label="Strategy line styles and decimate times"
          >
            {orderedSeries.map((s) => {
              const st = STRATEGY_LINE_STYLE[s.strategy]
              const vis = lineEmphasisState(s.strategy, emphasisStrategy)
              const isSidebarPick = s.strategy === selectedStrategy
              const isLegendFocus =
                focusedStrategy === s.strategy || hoveredStrategy === s.strategy
              const swatchW = Math.min(st.strokeWidth + vis.extraStrokeWidth, 3.6)
              const showSlowHint = slowComputeHint(s.computeMs, computePeerMs)
              const relLabel = formatRelativeMultiplier(s.computeMs, modalBaselineMs)
              return (
                <Box
                  key={s.strategy}
                  component="li"
                  sx={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 1.1,
                    py: 0.55,
                    px: 1.15,
                    borderRadius: 1,
                    cursor: 'pointer',
                    opacity: 0.35 + vis.strokeOpacity * 0.65,
                    transition:
                      'opacity 0.15s ease, background-color 0.15s ease, border-color 0.15s ease',
                    border: isLegendFocus
                      ? '1px solid rgba(214, 127, 163, 0.45)'
                      : isSidebarPick
                        ? '1px solid rgba(214, 127, 163, 0.28)'
                        : '1px solid transparent',
                    backgroundColor: isLegendFocus
                      ? 'rgba(214, 127, 163, 0.12)'
                      : isSidebarPick
                        ? 'rgba(214, 127, 163, 0.06)'
                        : 'transparent',
                  }}
                  onMouseEnter={() => setHoveredStrategy(s.strategy)}
                  onClick={() =>
                    setFocusedStrategy((cur) =>
                      cur === s.strategy ? null : s.strategy,
                    )
                  }
                >
                  <svg
                    width={48}
                    height={14}
                    aria-hidden
                    style={{ flexShrink: 0, opacity: vis.strokeOpacity }}
                  >
                    <line
                      x1={2}
                      y1={7}
                      x2={46}
                      y2={7}
                      stroke={st.color}
                      strokeWidth={swatchW}
                      strokeDasharray={st.strokeDasharray}
                      strokeLinecap="round"
                    />
                  </svg>
                  <Typography
                    component="div"
                    variant="caption"
                    sx={{
                      fontWeight:
                        s.strategy === 'original' || isSidebarPick ? 700 : 600,
                      fontSize: '0.78rem',
                      lineHeight: 1.35,
                      color:
                        vis.strokeOpacity < 0.75
                          ? 'rgba(236, 232, 244, 0.5)'
                          : '#f4f0f8',
                    }}
                  >
                    <Box
                      component="span"
                      sx={{ whiteSpace: 'nowrap' }}
                    >
                      {s.label}
                      {s.strategy === 'original'
                        ? ' (reference)'
                        : isSidebarPick
                          ? ' · current'
                          : ''}
                    </Box>
                    <Box
                      component="span"
                      sx={{
                        display: 'inline',
                        ml: 0.35,
                        fontWeight: 500,
                        fontVariantNumeric: 'tabular-nums',
                        color:
                          showSlowHint && vis.strokeOpacity >= 0.75
                            ? 'rgba(210, 185, 155, 0.92)'
                            : vis.strokeOpacity < 0.75
                              ? 'rgba(180, 175, 190, 0.45)'
                              : 'rgba(196, 190, 208, 0.88)',
                      }}
                    >
                      {' — '}
                      {formatComputeMs(s.computeMs)} ({relLabel})
                      {showSlowHint ? (
                        <Box
                          component="span"
                          sx={{
                            ml: 0.45,
                            fontSize: '0.68rem',
                            fontWeight: 500,
                            color: 'rgba(188, 165, 138, 0.78)',
                          }}
                        >
                          slower
                        </Box>
                      ) : null}
                    </Box>
                  </Typography>
                </Box>
              )
            })}
          </Box>
          <Typography
            variant="caption"
            sx={{
              mt: 0.75,
              display: 'block',
              fontSize: '0.68rem',
              color: 'rgba(180, 174, 192, 0.75)',
              flexShrink: 0,
            }}
          >
            Only strategies you have chosen in the sidebar appear here (each is decimated on
            demand). Times are decimate() cost for the map viewport and retention (not trend
            simulation). Multipliers use the fastest series in this list as 1×.
          </Typography>
        </Box>
      </DialogContent>
      <DialogActions sx={{ px: 1.5, py: 0.75, flexShrink: 0 }}>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  )
}
