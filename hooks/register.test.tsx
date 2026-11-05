import type { On, RenderSurface } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import type { Bucket, Point, Summary } from '../types'

const HOUR = 3_600_000
const NOW = Date.UTC(2026, 10, 4, 12, 0, 0)

const pts = (n: number, unit: number, b: Bucket): Point[] =>
  Array.from({ length: n }, (_, i) => ({ t: NOW - (n - 1 - i) * unit, b }))

// Synthetic numbers: every bucket is in 1, out 2, cache read 3, cache write 4.
const B: Bucket = [1, 2, 3, 4]
const SUMMARY: Summary = {
  scannedAt: NOW,
  isFresh: true,
  activeSessions: 2,
  perMinute: 10,
  total: [100, 200, 300, 400],
  today: [10, 20, 30, 40],
  live: pts(60, 60_000, B),
  h24: pts(24, HOUR, B),
  d7: pts(168, HOUR, B),
  d30: pts(30, 24 * HOUR, B),
  all: pts(5, 24 * HOUR, B),
}

const PANE = {
  plugin: 'token-graph',
  component: 'Pane',
  requestId: 'tokens',
  props: {
    title: 'Tokens',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

// How many times the mod ran the scanner, across the test running now.
const scans = { count: 0 }
// The surfaces attached now, and how many times the mod opened the pane.
const roster = { surfaces: ['desktop'] as RenderSurface[], opens: 0 }

// Stands in for the engine and for scripts/scan.mjs.
function engine(on: On, stdout: string, exitCode = 0, stored: Record<string, unknown> = {}) {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on, stored)
  on('command.register', () => ({ value: { command: 'tokens' } }))
  on('session.attach', (_, e) => ({ clientId: e.clientId }))
  on('session.surfaces', () => ({ value: [...roster.surfaces] }))
  on('ui.open', () => {
    if (roster.surfaces.length === 0) throw new Error('no-surface: no surface is attached')
    roster.opens++
    return { value: { isPlaced: true } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', () => ({
    value: {
      ...(scans.count++, {}),
      exitCode,
      stdout,
      stderr: exitCode === 0 ? '' : 'node: boom',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  return clock
}

test('the pane shows the scan and switches pages, on every surface', async ($, on) => {
  const clock = engine(on, JSON.stringify(SUMMARY))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    const header = await ui.find({ type: 'Text', text: /Today/ })
    expect(header?.text).toBe('Today 100 · now 10 per minute · 2 active sessions')

    // The selection is said in words, and the numbers are there without hovering.
    expect((await ui.find({ type: 'Text', text: /^Period:/ }))?.text).toBe('Period: Live')
    expect((await ui.find({ type: 'Text', text: /^Measure:/ }))?.text).toBe('Measure: Total')
    // The time is local, so only its form is checked.
    expect((await ui.find({ type: 'Text', text: /^Latest minute/ }))?.text).toMatch(
      /^Latest minute: \d\d:\d\d, 10\.$/,
    )
    expect((await ui.find({ type: 'Text', text: /^Share:/ }))?.text).toBe(
      'Share: in 10%, out 20%, cache read 30%, cache write 40%.',
    )

    // Live: 60 minutes of total 10 each is 600.
    expect((await ui.find({ type: 'Text', text: /last 60 minutes/ }))?.text).toContain('total 600')

    await ui.press({ key: 'page-h24' })
    expect((await ui.find({ type: 'Text', text: /last 24 hours/ }))?.text).toContain('total 240')

    if (surface === 'desktop') {
      const stacked = String((await ui.find({ type: 'Svg' }))?.props.source)
      // Light and dark palettes, and stripes on every other layer.
      expect(stacked).toContain('@media (prefers-color-scheme: light)')
      expect(stacked).toContain('url(#hatch)')
      expect(stacked).toContain('font-size="12"')
    }

    await ui.press({ key: 'page-all' })
    await ui.press({ key: 'metric-out' })
    expect((await ui.find({ type: 'Text', text: /all time, running total/ }))?.text).toContain('out 10')
    expect((await ui.find({ type: 'Text', text: /^Measure:/ }))?.text).toBe('Measure: Out')
    expect((await ui.find({ type: 'Text', text: /^Running total/ }))?.text).toContain('Running total 10')

    if (surface === 'desktop') {
      const chart = await ui.find({ type: 'Svg' })
      expect(String(chart?.props.source)).toContain('<polyline')
      expect(String(chart?.props.alt)).toContain('Running total 10')
    }

    // Back to the start for the next surface.
    await ui.press({ key: 'page-live' })
    await ui.press({ key: 'metric-total' })
    await ui.unmount()
  }
})

test('cache stats show for the period, and the hit rate is a measure', async ($, on) => {
  const clock = engine(on, JSON.stringify(SUMMARY))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    // 60 minutes of in 1, cache read 3, cache write 4: hit 3 / 8 = 37.5%.
    expect((await ui.find({ type: 'Text', text: /^Cache:/ }))?.text).toBe(
      'Cache: hit 37.5% · read 180 · written 240 · uncached input 60 · each written token read 0.8 times',
    )

    await ui.press({ key: 'metric-hitRate' })
    expect((await ui.find({ type: 'Text', text: /^Measure:/ }))?.text).toBe('Measure: Cache hit %')
    expect((await ui.find({ type: 'Text', text: /^Hit rate for the period/ }))?.text).toBe(
      'Hit rate for the period: 37.5%.',
    )
    expect((await ui.find({ type: 'Text', text: /last 60 minutes/ }))?.text).toContain('cache hit % 37.5%')

    if (surface === 'desktop') {
      const svg = String((await ui.find({ type: 'Svg' }))?.props.source)
      expect(svg).toContain('>100%</text>') // the rate's axis runs to 100%
      expect(svg).toContain('class="hitRate"')
    }

    await ui.press({ key: 'metric-total' })
    await ui.unmount()
  }
})

test('a failed scan says why', async ($, on) => {
  const clock = engine(on, '', 1)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const help = (await ui.find({ type: 'Text', text: /boom/ }))?.text
  expect(help).toContain('The scan failed: node: boom.')
  expect(help).toContain('Check that Node is installed')
  expect((await ui.find({ type: 'Text', text: /^The scan failed\.$/ }))?.text).toBe('The scan failed.')
  await ui.unmount()
})

test('pausing stops the live updates until resumed', async ($, on) => {
  const clock = engine(on, JSON.stringify(SUMMARY))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await clock.advance(5000)
  const whileLive = scans.count
  expect(whileLive).toBeGreaterThan(0)

  await ui.press({ key: 'pause' })
  expect((await ui.find({ type: 'Text', text: /Today/ }))?.text).toContain('updates paused')
  await clock.advance(20_000)
  expect(scans.count).toBe(whileLive)

  await ui.press({ key: 'pause' }) // now "Resume updates"
  await clock.advance(5000)
  expect(scans.count).toBeGreaterThan(whileLive)
  await ui.unmount()
})

test('the page chosen in an earlier session is where the pane starts', async ($, on) => {
  const clock = engine(on, JSON.stringify(SUMMARY), 0, { page: 'd30', metric: 'in' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // 30 days of input 1 each.
  expect((await ui.find({ type: 'Text', text: /last 30 days/ }))?.text).toContain('in 30')
  await ui.unmount()
})

test('with no surface at start, the pane opens when the app attaches', async ($, on) => {
  roster.surfaces = []
  roster.opens = 0
  const clock = engine(on, JSON.stringify(SUMMARY))
  await $.session.start({ cwd: '/', surface: null, isInteractive: true })
  await clock.settle()
  expect(roster.opens).toBe(0)

  roster.surfaces = ['desktop']
  await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
  await clock.settle()
  expect(roster.opens).toBe(1)
  roster.surfaces = ['desktop']
})
