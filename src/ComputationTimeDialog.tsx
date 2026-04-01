import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material'
import type { Strategy } from './decimate'
import { formatComputeMs } from './strategyTiming'

export type ComputationTimeRow = {
  strategy: Strategy
  label: string
  ms: number
  pointsOut: number
  rank: number
  relativeLabel: string
  isFastest: boolean
  isCurrent: boolean
}

type Props = {
  open: boolean
  onClose: () => void
  rows: ComputationTimeRow[]
  viewportPoints: number
  retentionLabel: string
}

export default function ComputationTimeDialog({
  open,
  onClose,
  rows,
  viewportPoints,
  retentionLabel,
}: Props) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="sm"
      fullWidth
      PaperProps={{
        sx: {
          backgroundImage: 'none',
          backgroundColor: '#1b1b24',
          border: '1px solid rgba(214, 127, 163, 0.22)',
          borderRadius: 2,
          boxShadow: '0 16px 56px rgba(0, 0, 0, 0.58)',
        },
      }}
    >
      <DialogTitle
        sx={{
          py: 1.5,
          px: 2,
          fontSize: '1.05rem',
          fontWeight: 700,
          letterSpacing: '-0.02em',
          borderBottom: '1px solid rgba(214, 127, 163, 0.12)',
        }}
      >
        Computation time comparison
      </DialogTitle>
      <DialogContent sx={{ pt: 2, px: 2, pb: 1 }}>
        <Typography
          variant="body2"
          sx={{
            mb: 2,
            fontSize: '0.78rem',
            lineHeight: 1.45,
            color: 'rgba(200, 194, 214, 0.92)',
          }}
        >
          Decimate() cost for each strategy you have tried this session, for the
          current map view ({viewportPoints.toLocaleString('en-US')} pts) and{' '}
          {retentionLabel} retention. Sorted fastest → slowest. Relative column
          uses the fastest row as 1×.
        </Typography>

        {rows.length === 0 ? (
          <Box
            sx={{
              py: 4,
              px: 2,
              textAlign: 'center',
              borderRadius: 2,
              bgcolor: 'rgba(24, 24, 32, 0.6)',
              border: '1px dashed rgba(214, 127, 163, 0.2)',
            }}
          >
            <Typography sx={{ color: 'rgba(180, 174, 196, 0.9)', fontSize: '0.875rem' }}>
              No strategies measured yet. Choose a sampling strategy in the sidebar
              first.
            </Typography>
          </Box>
        ) : (
          <TableContainer
            component={Paper}
            elevation={0}
            sx={{
              borderRadius: 2,
              overflow: 'hidden',
              bgcolor: 'rgba(18, 18, 26, 0.92)',
              border: '1px solid rgba(214, 127, 163, 0.14)',
              boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.03)',
            }}
          >
            <Table size="small" sx={{ tableLayout: 'fixed' }}>
              <TableHead>
                <TableRow
                  sx={{
                    '& th': {
                      borderBottom: '1px solid rgba(214, 127, 163, 0.2)',
                      color: 'rgba(232, 226, 240, 0.75)',
                      fontSize: '0.65rem',
                      fontWeight: 700,
                      textTransform: 'uppercase',
                      letterSpacing: '0.08em',
                      py: 1.1,
                      bgcolor: 'rgba(214, 127, 163, 0.06)',
                    },
                  }}
                >
                  <TableCell width="14%" align="center">
                    Rank
                  </TableCell>
                  <TableCell width="40%">Strategy</TableCell>
                  <TableCell width="22%" align="right">
                    Time
                  </TableCell>
                  <TableCell width="24%" align="right">
                    vs fastest
                  </TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((r) => (
                  <TableRow
                    key={r.strategy}
                    sx={{
                      transition: 'background-color 0.12s ease',
                      '&:hover': {
                        bgcolor: 'rgba(214, 127, 163, 0.06)',
                      },
                      ...(r.isFastest
                        ? {
                            bgcolor: 'rgba(126, 200, 255, 0.06)',
                            '&:hover': { bgcolor: 'rgba(126, 200, 255, 0.1)' },
                          }
                        : {}),
                      '& td': {
                        borderBottom: '1px solid rgba(255,255,255,0.05)',
                        py: 1.15,
                        fontSize: '0.8125rem',
                      },
                    }}
                  >
                    <TableCell align="center">
                      <Typography
                        component="span"
                        sx={{
                          fontVariantNumeric: 'tabular-nums',
                          fontWeight: 700,
                          color:
                            r.rank <= 3
                              ? 'rgba(230, 210, 225, 0.95)'
                              : 'rgba(180, 175, 195, 0.85)',
                        }}
                      >
                        {r.rank}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25 }}>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap' }}>
                          <Typography
                            component="span"
                            sx={{
                              fontWeight: r.isCurrent ? 700 : 600,
                              color: '#f4f0f8',
                              lineHeight: 1.3,
                            }}
                          >
                            {r.label}
                          </Typography>
                          {r.isCurrent ? (
                            <Box
                              component="span"
                              sx={{
                                fontSize: '0.625rem',
                                fontWeight: 700,
                                textTransform: 'uppercase',
                                letterSpacing: '0.06em',
                                px: 0.75,
                                py: 0.2,
                                borderRadius: 1,
                                color: 'rgba(255, 235, 245, 0.95)',
                                bgcolor: 'rgba(214, 127, 163, 0.28)',
                                border: '1px solid rgba(214, 127, 163, 0.35)',
                              }}
                            >
                              Current
                            </Box>
                          ) : null}
                          {r.isFastest ? (
                            <Box
                              component="span"
                              sx={{
                                fontSize: '0.625rem',
                                fontWeight: 700,
                                textTransform: 'uppercase',
                                letterSpacing: '0.06em',
                                px: 0.75,
                                py: 0.2,
                                borderRadius: 1,
                                color: 'rgba(200, 230, 255, 0.95)',
                                bgcolor: 'rgba(100, 170, 230, 0.15)',
                                border: '1px solid rgba(120, 190, 255, 0.25)',
                              }}
                            >
                              Fastest
                            </Box>
                          ) : null}
                        </Box>
                        <Typography
                          variant="caption"
                          sx={{
                            fontSize: '0.68rem',
                            color: 'rgba(160, 155, 178, 0.88)',
                            fontVariantNumeric: 'tabular-nums',
                          }}
                        >
                          {r.pointsOut.toLocaleString('en-US')} pts displayed
                        </Typography>
                      </Box>
                    </TableCell>
                    <TableCell align="right">
                      <Typography
                        sx={{
                          fontVariantNumeric: 'tabular-nums',
                          fontWeight: 600,
                          color:
                            r.ms >= 120
                              ? 'rgba(220, 195, 165, 0.95)'
                              : 'rgba(225, 220, 235, 0.95)',
                        }}
                      >
                        {formatComputeMs(r.ms)}
                      </Typography>
                    </TableCell>
                    <TableCell align="right">
                      <Typography
                        sx={{
                          fontVariantNumeric: 'tabular-nums',
                          fontWeight: 600,
                          color: 'rgba(196, 188, 212, 0.92)',
                        }}
                      >
                        {r.relativeLabel}
                      </Typography>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}

        <Typography
          variant="caption"
          sx={{
            mt: 1.75,
            display: 'block',
            fontSize: '0.68rem',
            lineHeight: 1.45,
            color: 'rgba(150, 145, 168, 0.85)',
          }}
        >
          Times reflect a single decimate pass after you select a strategy — not React
          render. Try more strategies in the sidebar to fill this table.
        </Typography>
      </DialogContent>
      <DialogActions
        sx={{
          px: 2,
          py: 1.25,
          borderTop: '1px solid rgba(214, 127, 163, 0.1)',
        }}
      >
        <Button onClick={onClose} variant="outlined" color="inherit" size="medium">
          Close
        </Button>
      </DialogActions>
    </Dialog>
  )
}
