import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Bucket, Metric, Page, Point, ScanStatus, Summary } from '../types'

const PANE = 'tokens'
const REFRESH_MS = 5000

// Bump the shape tag when Summary's fields change: it declines what an
// earlier version stored, which outlives a reload.
const summaryAtom = atom({ plugin: 'token-graph', key: 'summary' } as const, null, {
  shape: 'summary-1',
})
const pageAtom = atom({ plugin: 'token-graph', key: 'page' } as const, 'live')
const metricAtom = atom({ plugin: 'token-graph', key: 'metric' } as const, 'total')
const statusAtom = atom({ plugin: 'token-graph', key: 'status' } as const, {
  isScanning: false,
})
const pausedAtom = atom({ plugin: 'token-graph', key: 'isPaused' } as const, false)

export const PAGES: { id: Page; label: string }[] = [
  { id: 'live', label: 'Live' },
  { id: 'h24', label: '24h' },
  { id: 'd7', label: '7d' },
  { id: 'd30', label: '30d' },
  { id: 'all', label: 'All' },
]

export const METRICS: { id: Metric; label: string }[] = [
  { id: 'total', label: 'Total' },
  { id: 'in', label: 'In' },
  { id: 'out', label: 'Out' },
  { id: 'cacheRead', label: 'Cache read' },
  { id: 'cacheWrite', label: 'Cache write' },
  { id: 'hitRate', label: 'Cache hit %' },
]

/** The four parts of a bucket, in bucket order, bottom of a stack first. */
const LAYERS = [
  { id: 'in', label: 'in', isHatched: false },
  { id: 'out', label: 'out', isHatched: true },
  { id: 'cacheRead', label: 'cache read', isHatched: false },
  { id: 'cacheWrite', label: 'cache write', isHatched: true },
] as const

/**
 * Chart colours per theme. Every one is at least 4.5:1 against its background
 * (dark #1c1c1c, light #ffffff); neighbours in a stack also differ by texture
 * (every other one striped) and by a gap, so none depends on colour alone.
 */
const PALETTE = {
  dark: {
    axis: '#b4b9bf', grid: '#b4b9bf', total: '#e4e6ea', bg: '#1c1c1c',
    in: '#a8c8ff', out: '#d4731f', cacheRead: '#e4e6ea', cacheWrite: '#2a9d88',
    hitRate: '#c9a6e8',
  },
  light: {
    axis: '#5a6068', grid: '#5a6068', total: '#30353c', bg: '#ffffff',
    in: '#1d5fd1', out: '#b8590e', cacheRead: '#4a5059', cacheWrite: '#0b7a66',
    hitRate: '#7b4fa8',
  },
} as const

// ---------------------------------------------------------------- numbers

export function fmt(n: number): string {
  const a = Math.abs(n)
  if (a >= 1e9) return `${(n / 1e9).toFixed(a >= 1e10 ? 1 : 2)}B`
  if (a >= 1e6) return `${(n / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`
  if (a >= 1e3) return `${(n / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`
  return String(Math.round(n))
}

export const pct = (part: number, whole: number) =>
  whole <= 0 ? '0%' : `${((part / whole) * 100).toFixed(part / whole >= 0.1 ? 0 : 1)}%`

/**
 * The prompt cache's hit rate: of every input token the model was sent
 * (uncached input, cache reads, cache writes), the share read from cache.
 * Undefined where nothing was sent.
 */
export function hitRate(b: Bucket): number | undefined {
  const sent = b[0] + b[2] + b[3]
  return sent > 0 ? b[2] / sent : undefined
}

/** A rate as a percentage, one decimal below 99.9%. */
export const rate = (r: number | undefined) =>
  r === undefined ? 'no input' : `${(r * 100).toFixed(r >= 0.999 || r === 0 ? 0 : 1)}%`

/** A value of `metric` as words: tokens, or a percentage for the hit rate. */
export const show = (v: number, metric: Metric) => (metric === 'hitRate' ? rate(v) : fmt(v))

/** One line of cache stats for a span of buckets. */
export function cacheLine(b: Bucket): string {
  const reuse = b[3] > 0 ? ` · each written token read ${(b[2] / b[3]).toFixed(1)} times` : ''
  return `Cache: hit ${rate(hitRate(b))} · read ${fmt(b[2])} · written ${fmt(b[3])} · uncached input ${fmt(b[0])}${reuse}`
}

/**
 * What the chart plots per point: the measure, or on the All page its
 * running total; for the hit rate, the rate of each point (on All, the
 * rate of everything up to that point).
 */
export function seriesValues(points: Point[], page: Page, metric: Metric): number[] {
  const isCumulative = page === 'all'
  let running = 0
  const acc: Bucket = [0, 0, 0, 0]
  return points.map(p => {
    if (metric === 'hitRate') {
      if (!isCumulative) return hitRate(p.b) ?? 0
      for (let k = 0; k < 4; k++) acc[k as 0] += p.b[k as 0]
      return hitRate(acc) ?? 0
    }
    const v = valueOf(p.b, metric)
    running += v
    return isCumulative ? running : v
  })
}

/** The period's figure: its sum, or for the hit rate the period's rate. */
export const periodValue = (points: Point[], metric: Metric) =>
  metric === 'hitRate'
    ? (hitRate(sumBuckets(points)) ?? 0)
    : points.reduce((s, p) => s + valueOf(p.b, metric), 0)

export function valueOf(b: Bucket, metric: Metric): number {
  switch (metric) {
    case 'hitRate':
      return hitRate(b) ?? 0
    case 'in':
      return b[0]
    case 'out':
      return b[1]
    case 'cacheRead':
      return b[2]
    case 'cacheWrite':
      return b[3]
    default:
      return b[0] + b[1] + b[2] + b[3]
  }
}

export const sumBuckets = (points: Point[]): Bucket =>
  points.reduce<Bucket>(
    (s, p) => [s[0] + p.b[0], s[1] + p.b[1], s[2] + p.b[2], s[3] + p.b[3]],
    [0, 0, 0, 0],
  )

const pad = (n: number) => String(n).padStart(2, '0')
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function label(page: Page, t: number): string {
  const d = new Date(t)
  switch (page) {
    case 'live':
      return `${pad(d.getHours())}:${pad(d.getMinutes())}`
    case 'h24':
      return `${pad(d.getHours())}:00`
    case 'd7':
      return `${WEEKDAYS[d.getDay()]} ${pad(d.getHours())}:00`
    default:
      return `${d.getMonth() + 1}/${d.getDate()}`
  }
}

const PAGE_TITLE: Record<Page, string> = {
  live: 'last 60 minutes, per minute',
  h24: 'last 24 hours, per hour',
  d7: 'last 7 days, per hour',
  d30: 'last 30 days, per day',
  all: 'all time, running total',
}

const BUCKET_NAME: Record<Page, string> = {
  live: 'minute',
  h24: 'hour',
  d7: 'hour',
  d30: 'day',
  all: 'day',
}

/**
 * The chart's numbers as words: the busiest bucket and the latest one (or,
 * on the running total, where it stands), and for Total each part's share.
 * Drawn under the chart and read as the chart's alt text, so nothing is
 * known only by hovering.
 */
export function readout(points: Point[], page: Page, metric: Metric): string[] {
  const lines: string[] = []
  if (points.length === 0) return ['No tokens in this period.']
  const unit = BUCKET_NAME[page]
  if (metric === 'hitRate') {
    // Lowest and latest, counting only buckets where input was sent.
    const sent = points.filter(p => hitRate(p.b) !== undefined)
    lines.push(`Hit rate for the period: ${rate(hitRate(sumBuckets(points)))}.`)
    let low: Point | undefined
    for (const p of sent) if (!low || (hitRate(p.b) ?? 1) < (hitRate(low.b) ?? 1)) low = p
    const last = sent[sent.length - 1]
    if (low) lines.push(`Lowest ${unit}: ${label(page, low.t)}, ${rate(hitRate(low.b))}.`)
    if (last) lines.push(`Latest ${unit} with input: ${label(page, last.t)}, ${rate(hitRate(last.b))}.`)
    return lines
  }
  const values = points.map(p => valueOf(p.b, metric))
  if (page === 'all') {
    const total = values.reduce((s, v) => s + v, 0)
    const first = points[0]
    lines.push(`Running total ${fmt(total)} since ${first ? label(page, first.t) : 'the start'}.`)
  }
  let peak = 0
  values.forEach((v, i) => {
    if (v > (values[peak] ?? 0)) peak = i
  })
  const peakPoint = points[peak]
  const last = points[points.length - 1]
  if (peakPoint && (values[peak] ?? 0) > 0) {
    lines.push(`Busiest ${unit}: ${label(page, peakPoint.t)}, ${fmt(values[peak] ?? 0)}.`)
  }
  if (last) lines.push(`Latest ${unit}: ${label(page, last.t)}, ${fmt(values[values.length - 1] ?? 0)}.`)
  if (metric === 'total') {
    const sum = sumBuckets(points)
    const whole = sum[0] + sum[1] + sum[2] + sum[3]
    lines.push(`Share: ${LAYERS.map((l, k) => `${l.label} ${pct(sum[k] ?? 0, whole)}`).join(', ')}.`)
  }
  return lines
}

// ---------------------------------------------------------------- chart

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** CSS for the chart: dark by default, light where the page asks for it. */
function chartStyle(): string {
  const rules = (p: Record<keyof (typeof PALETTE)['dark'], string>) =>
    [
      `.axis{fill:${p.axis}}`,
      `.grid{stroke:${p.grid}}`,
      `.total{fill:${p.total};stroke:${p.total}}`,
      `.line{stroke:${p.total}}`,
      ...LAYERS.map(l => `.${l.id}{fill:${p[l.id]};color:${p[l.id]}}`),
      `.hitRate{fill:${p.hitRate};stroke:${p.hitRate}}`,
      `.stripe{stroke:${p.bg}}`,
    ].join('')
  return `${rules(PALETTE.dark)}@media (prefers-color-scheme: light){${rules(PALETTE.light)}}`
}

/** The page's chart as an SVG document, `width` CSS pixels across. */
export function chartSvg(points: Point[], page: Page, metric: Metric, width: number): string {
  const W = Math.max(240, Math.round(width))
  const isTotal = metric === 'total'
  const legendH = isTotal ? 20 : 0
  const H = 190 + legendH
  const L = 54 // room for the y labels
  const R = 8
  const T = 10
  const B = 22 // room for the x labels
  const plotW = W - L - R
  const plotH = H - T - B - legendH
  const n = Math.max(1, points.length)

  const isCumulative = page === 'all'
  const values = seriesValues(points, page, metric)
  // A rate runs 0 to 100%; token counts scale to the period's top.
  const max = metric === 'hitRate' ? 1 : Math.max(1, ...values)
  const y = (v: number) => T + plotH - (v / max) * plotH
  const metricClass = isTotal ? 'total' : metric

  const parts: string[] = [
    `<style>${chartStyle()}</style>`,
    // Stripes in the background colour: the texture that sets every other
    // layer apart from its neighbours.
    `<defs><pattern id="hatch" patternUnits="userSpaceOnUse" width="5" height="5" patternTransform="rotate(45)"><line class="stripe" x1="0" y1="0" x2="0" y2="5" stroke-width="2"/></pattern></defs>`,
  ]
  // Grid lines at 0, half and max, with their values.
  for (const f of [0, 0.5, 1]) {
    const gy = y(max * f).toFixed(1)
    parts.push(
      `<line class="grid" x1="${L}" x2="${W - R}" y1="${gy}" y2="${gy}" stroke-opacity="0.3"/>`,
      `<text class="axis" x="${L - 6}" y="${gy}" dy="4" text-anchor="end" font-size="12">${show(max * f, metric)}</text>`,
    )
  }

  if (isCumulative) {
    const dots = points.map((p, i) => ({
      p,
      v: values[i] ?? 0,
      x: L + (n === 1 ? plotW : (i / (n - 1)) * plotW),
    }))
    const line = dots.map(d => `${d.x.toFixed(1)},${y(d.v).toFixed(1)}`).join(' ')
    const lastX = dots[dots.length - 1]?.x ?? L
    parts.push(
      `<polygon class="${metricClass}" points="${L},${T + plotH} ${line} ${lastX.toFixed(1)},${T + plotH}" fill-opacity="0.2" stroke="none"/>`,
      `<polyline class="${metricClass}" points="${line}" fill="none" stroke-width="2.5"/>`,
    )
    for (const d of dots) {
      parts.push(
        `<circle cx="${d.x.toFixed(1)}" cy="${y(d.v).toFixed(1)}" r="4" fill-opacity="0" stroke="none"><title>${esc(label(page, d.p.t))}: ${show(d.v, metric)} so far (${show(valueOf(d.p.b, metric), metric)} that day)</title></circle>`,
      )
    }
  } else {
    const slot = plotW / n
    const barW = Math.max(1, slot * 0.8)
    points.forEach((p, i) => {
      const x = (L + i * slot + (slot - barW) / 2).toFixed(1)
      const hit = `<rect x="${(L + i * slot).toFixed(1)}" y="${T}" width="${slot.toFixed(1)}" height="${plotH}" fill="transparent"/>`
      const tip = `<title>${esc(label(page, p.t))}: ${show(valueOf(p.b, metric), metric)}${
        isTotal
          ? ` (in ${fmt(p.b[0])}, out ${fmt(p.b[1])}, cache read ${fmt(p.b[2])}, cache write ${fmt(p.b[3])})`
          : ''
      }</title>`
      if (isTotal) {
        // Stacked, input at the bottom; a 1.5 px gap between layers and
        // every other layer striped.
        let base = 0
        const rects = LAYERS.map((layer, k) => {
          const v = p.b[k] ?? 0
          if (v <= 0) return ''
          const top = y(base + v)
          const bottom = y(base)
          base += v
          const h = Math.max(1.5, bottom - top - 1.5)
          const r = `<rect class="${layer.id}" x="${x}" y="${(bottom - h).toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}"/>`
          return layer.isHatched
            ? `${r}<rect x="${x}" y="${(bottom - h).toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" fill="url(#hatch)"/>`
            : r
        }).join('')
        parts.push(`<g>${tip}${rects}${hit}</g>`)
      } else {
        const v = valueOf(p.b, metric)
        const layer = LAYERS.find(l => l.id === metric)
        const bar =
          v > 0
            ? `<rect class="${metric}" x="${x}" y="${y(v).toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(1, T + plotH - y(v)).toFixed(1)}"/>${
                layer?.isHatched
                  ? `<rect x="${x}" y="${y(v).toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(1, T + plotH - y(v)).toFixed(1)}" fill="url(#hatch)"/>`
                  : ''
              }`
            : ''
        parts.push(`<g>${tip}${bar}${hit}</g>`)
      }
    })
  }

  // X labels: first, middle, last.
  if (points.length > 0) {
    const ends = [0, Math.floor((points.length - 1) / 2), points.length - 1]
    const anchors = ['start', 'middle', 'end']
    const xs = [L, L + plotW / 2, W - R]
    ends.forEach((idx, k) => {
      const p = points[idx]
      if (!p) return
      parts.push(
        `<text class="axis" x="${xs[k]}" y="${T + plotH + 17}" text-anchor="${anchors[k]}" font-size="12">${esc(label(page, p.t))}</text>`,
      )
    })
  }

  // Legend for the stacked view, in stack order, swatches carrying the
  // same stripes as their layers.
  if (isTotal) {
    let lx = L
    const ly = H - 8
    for (const layer of LAYERS) {
      parts.push(
        `<rect class="${layer.id}" x="${lx}" y="${ly - 10}" width="12" height="12"/>`,
        layer.isHatched ? `<rect x="${lx}" y="${ly - 10}" width="12" height="12" fill="url(#hatch)"/>` : '',
        `<text class="axis" x="${lx + 16}" y="${ly}" font-size="12">${layer.label}</text>`,
      )
      lx += 16 + layer.label.length * 7 + 14
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="system-ui, sans-serif">${parts.join('')}</svg>`
}

const SPARK = '▁▂▃▄▅▆▇█'

/** A one-line sparkline for surfaces without Svg. */
export function sparkline(points: Point[], metric: Metric, columns: number): string {
  const values = points.map(p => valueOf(p.b, metric))
  const n = Math.max(1, Math.min(columns, values.length))
  const per = values.length / n
  const cells: number[] = []
  for (let i = 0; i < n; i++) {
    let s = 0
    for (let j = Math.floor(i * per); j < Math.floor((i + 1) * per); j++) s += values[j] ?? 0
    cells.push(s)
  }
  const max = Math.max(1, ...cells)
  return cells.map(v => (v <= 0 ? ' ' : SPARK[Math.min(7, Math.floor((v / max) * 7.999))])).join('')
}

// ---------------------------------------------------------------- scanning

let isBusy = false

async function refresh($: EngineInterface, isAsked = false): Promise<void> {
  if (isBusy) return
  if (!isAsked && (await read($, pausedAtom))) return
  isBusy = true
  try {
    await update($, statusAtom, s => ({ ...s, isScanning: true }))
    const run = await $.process.run(['node', `${$.plugin.root}/scripts/scan.mjs`], {
      timeoutMs: 180_000,
    })
    if (run.exitCode !== 0) {
      const why = run.stderr.trim().split('\n').slice(-1)[0] || `exit ${run.exitCode}`
      await update($, statusAtom, () => ({ isScanning: false, error: why }))
      return
    }
    const summary = JSON.parse(run.stdout) as Summary
    await update($, summaryAtom, () => summary)
    await update($, statusAtom, () => ({ isScanning: false }))
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    await update($, statusAtom, () => ({ isScanning: false, error: why }))
  } finally {
    isBusy = false
  }
}

// ---------------------------------------------------------------- hooks

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)

    await $.command.register({
      name: 'tokens',
      description: 'Show token use across every Claude Code session in a pane',
    })

    // The page and metric last chosen, from any session.
    const page = (await $.store.get('page')) as Page | undefined
    const metric = (await $.store.get('metric')) as Metric | undefined
    if (page && PAGES.some(p => p.id === page)) await update($, pageAtom, () => page)
    if (metric && METRICS.some(m => m.id === metric)) await update($, metricAtom, () => metric)

    void $.ui.open({ id: PANE, title: 'Tokens' })
    void refresh($)
    $.clock.every(REFRESH_MS, () => void refresh($))

    return started
  })

  on('command.run', { command: 'tokens' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: 'Tokens', focus: true })
    void refresh($, true)

    return { text: opened.isPlaced ? 'Token graph opened.' : `Token graph waits: ${opened.reason}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const page = await read($, pageAtom)
    const metric = await read($, metricAtom)
    const summary = await read($, summaryAtom)
    const status: ScanStatus = await read($, statusAtom)
    const isPaused = await read($, pausedAtom)
    const columns = e.props.bodyColumns

    const choosePage = (id: Page) => async () => {
      await update($, pageAtom, () => id)
      await $.store.set('page', id)
    }
    const chooseMetric = (id: Metric) => async () => {
      await update($, metricAtom, () => id)
      await $.store.set('metric', id)
    }
    const togglePause = async () => {
      const wasPaused = await read($, pausedAtom)
      await update($, pausedAtom, () => !wasPaused)
      if (wasPaused) void refresh($, true)
    }

    const points: Point[] = summary ? summary[page] : []
    const periodTotal = periodValue(points, metric)
    const pageLabel = PAGES.find(p => p.id === page)!.label
    const metricLabel = METRICS.find(m => m.id === metric)!.label

    const header = summary
      ? `Today ${fmt(valueOf(summary.today, 'total'))} · now ${fmt(summary.perMinute)} per minute · ${summary.activeSessions} active ${summary.activeSessions === 1 ? 'session' : 'sessions'}${isPaused ? ' · updates paused' : ''}`
      : status.error
        ? 'The scan failed.'
        : 'Reading transcripts for the first time…'
    const footer = summary
      ? `${PAGE_TITLE[page]} · ${metricLabel.toLowerCase()} ${show(periodTotal, metric)} · all time ${fmt(valueOf(summary.total, 'total'))}`
      : ''
    // The cache stats for the period shown, whatever the measure.
    const lines = summary ? [...readout(points, page, metric), cacheLine(sumBuckets(points))] : []
    const errorHelp = status.error
      ? `The scan failed: ${status.error}. Check that Node is installed and on your PATH, then run node "${$.plugin.root}/scripts/scan.mjs" in a terminal to see the full error.`
      : undefined

    const { Box, Text, Button } = $.ui.resolve(e)

    // The selected page and measure are said in words, not only by the
    // button's colour.
    const controls = (
      <Box flexDirection="column" gap={1}>
        <Text>Period: {pageLabel}</Text>
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          {PAGES.map(p => (
            <Button key={`page-${p.id}`} label={p.label} variant={p.id === page ? 'primary' : 'secondary'} onPress={choosePage(p.id)} />
          ))}
        </Box>
        <Text>Measure: {metricLabel}</Text>
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          {METRICS.map(m => (
            <Button key={`metric-${m.id}`} label={m.label} variant={m.id === metric ? 'primary' : 'secondary'} onPress={chooseMetric(m.id)} />
          ))}
        </Box>
      </Box>
    )
    const pause = (
      <Button key="pause" label={isPaused ? 'Resume updates' : 'Pause updates'} onPress={togglePause} />
    )

    if (e.surface === 'terminal' || e.surface === 'mobile') {
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>{header}</Text>
          {controls}
          {summary && <Text>{sparkline(points, metric, Math.max(10, columns - 2))}</Text>}
          {lines.map(line => (
            <Text>{line}</Text>
          ))}
          {footer !== '' && <Text color="subtle">{footer}</Text>}
          {errorHelp && <Text color="error">{errorHelp}</Text>}
          {pause}
        </Box>
      )
    }

    const { Svg } = $.ui.resolve(e)
    // A desktop cell is about 8 CSS pixels across.
    const width = Math.max(240, columns * 8)

    return (
      <Box flexDirection="column" gap={1}>
        <Text weight="semibold">{header}</Text>
        {controls}
        {summary && (
          <Svg
            source={chartSvg(points, page, metric, width)}
            alt={`Token use, ${PAGE_TITLE[page]}, ${metricLabel.toLowerCase()} ${show(periodTotal, metric)}. ${lines.join(' ')}`}
            isInteractive
          />
        )}
        {lines.map(line => (
          <Text>{line}</Text>
        ))}
        {footer !== '' && <Text color="subtle">{footer}</Text>}
        {errorHelp && <Text color="error">{errorHelp}</Text>}
        {pause}
      </Box>
    )
  })
}
