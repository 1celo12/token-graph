#!/usr/bin/env node
// Token scanner for the token-graph mod.
//
// Reads every Claude Code transcript under ~/.claude/projects (all sessions,
// subagents included), counts each API response's usage once, and keeps
// minute / hour / day buckets in ~/.claude/token-graph/state.json. Each run
// reads only the bytes appended since the last run. Prints a JSON summary.
//
// Usage: node scan.mjs [--projects <dir>] [--state <dir>] [--now <ms>]

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const args = process.argv.slice(2)
const flag = name => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

const PROJECTS = flag('--projects') ?? path.join(os.homedir(), '.claude', 'projects')
const STATE_DIR = flag('--state') ?? path.join(os.homedir(), '.claude', 'token-graph')
const NOW = Number(flag('--now') ?? Date.now())
const STATE_FILE = path.join(STATE_DIR, 'state.json')
const LOCK_FILE = path.join(STATE_DIR, 'scan.lock')
const STATE_VERSION = 1

const MIN = 60_000
const HOUR = 3_600_000
const KEEP_MINUTES = 48 * 60 // 48 h of minute buckets
const KEEP_HOURS = 35 * 24 // 35 days of hour buckets
const RECENT_IDS_MS = 48 * HOUR // ids whose usage may still grow
const ACTIVE_MS = 5 * MIN

// A bucket is [input, output, cacheRead, cacheWrite].
const zero = () => [0, 0, 0, 0]
const add = (map, key, u, sign = 1) => {
  const b = (map[key] ??= zero())
  for (let k = 0; k < 4; k++) b[k] += sign * u[k]
}

const pad = n => String(n).padStart(2, '0')
const dayKey = ms => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function emptyState() {
  return {
    version: STATE_VERSION,
    cursors: {}, // file -> { offset, size }
    recent: {}, // message id -> [ms, i, o, cr, cw]: counted usage, may grow
    old: [], // message ids past RECENT_IDS_MS, counted for good
    minutes: {}, // epoch minute -> bucket
    hours: {}, // epoch hour -> bucket
    days: {}, // local YYYY-MM-DD -> bucket
  }
}

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    if (s.version === STATE_VERSION) return s
  } catch {}
  return emptyState()
}

function saveState(state) {
  const tmp = `${STATE_FILE}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state))
  fs.renameSync(tmp, STATE_FILE)
}

function takeLock() {
  try {
    fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx' })
    return true
  } catch {
    try {
      // A lock older than two minutes belongs to a scan that died.
      if (NOW - fs.statSync(LOCK_FILE).mtimeMs > 2 * MIN) {
        fs.rmSync(LOCK_FILE, { force: true })
        fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx' })
        return true
      }
    } catch {}
    return false
  }
}

function* walk(dir) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) yield* walk(p)
    else if (e.isFile() && e.name.endsWith('.jsonl')) yield p
  }
}

function usageOf(row) {
  const m = row?.message
  const u = m?.usage
  if (!u || typeof m.id !== 'string') return undefined
  const ms = Date.parse(row.timestamp)
  if (!Number.isFinite(ms)) return undefined
  return {
    id: m.id,
    ms,
    u: [
      u.input_tokens | 0,
      u.output_tokens | 0,
      u.cache_read_input_tokens | 0,
      u.cache_creation_input_tokens | 0,
    ],
  }
}

function count(state, oldIds, row) {
  const hit = usageOf(row)
  if (!hit) return
  if (oldIds.has(hit.id)) return
  const seen = state.recent[hit.id]
  let delta
  let ms = hit.ms
  if (seen) {
    // The same response written again (one row per content block, or a
    // resumed session's copy): count only what grew.
    ms = seen[0]
    delta = hit.u.map((v, k) => Math.max(0, v - seen[k + 1]))
    if (delta.every(v => v === 0)) return
    for (let k = 0; k < 4; k++) seen[k + 1] += delta[k]
  } else {
    delta = hit.u
    state.recent[hit.id] = [ms, ...hit.u]
  }
  add(state.minutes, Math.floor(ms / MIN), delta)
  add(state.hours, Math.floor(ms / HOUR), delta)
  add(state.days, dayKey(ms), delta)
}

function scanFile(state, oldIds, file, stat) {
  let cur = state.cursors[file]
  if (!cur || stat.size < cur.offset) cur = { offset: 0, size: 0 } // new or rewritten
  if (stat.size === cur.offset) {
    state.cursors[file] = { offset: cur.offset, size: stat.size }
    return
  }
  const length = stat.size - cur.offset
  const buf = Buffer.alloc(length)
  const fd = fs.openSync(file, 'r')
  try {
    fs.readSync(fd, buf, 0, length, cur.offset)
  } finally {
    fs.closeSync(fd)
  }
  // Only whole lines: a line still being written waits for the next scan.
  const end = buf.lastIndexOf(0x0a)
  if (end < 0) return
  const text = buf.toString('utf8', 0, end)
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"')) continue
    try {
      count(state, oldIds, JSON.parse(line))
    } catch {}
  }
  state.cursors[file] = { offset: cur.offset + end + 1, size: stat.size }
}

function prune(state) {
  const minMinute = Math.floor(NOW / MIN) - KEEP_MINUTES
  for (const k of Object.keys(state.minutes)) if (+k < minMinute) delete state.minutes[k]
  const minHour = Math.floor(NOW / HOUR) - KEEP_HOURS
  for (const k of Object.keys(state.hours)) if (+k < minHour) delete state.hours[k]
  for (const [id, v] of Object.entries(state.recent)) {
    if (NOW - v[0] > RECENT_IDS_MS) {
      state.old.push(id)
      delete state.recent[id]
    }
  }
}

function scan(state) {
  const oldIds = new Set(state.old)
  const live = new Set()
  let active = 0
  for (const file of walk(PROJECTS)) {
    let stat
    try {
      stat = fs.statSync(file)
    } catch {
      continue
    }
    live.add(file)
    // Subagent transcripts are part of their session, not a session of their own.
    if (NOW - stat.mtimeMs < ACTIVE_MS && !file.includes(`${path.sep}subagents${path.sep}`)) active++
    const cur = state.cursors[file]
    if (cur && cur.size === stat.size && cur.offset === stat.size) continue
    try {
      scanFile(state, oldIds, file, stat)
    } catch {}
  }
  for (const f of Object.keys(state.cursors)) if (!live.has(f)) delete state.cursors[f]
  prune(state)
  return active
}

function activeCount() {
  let active = 0
  for (const file of walk(PROJECTS)) {
    if (file.includes(`${path.sep}subagents${path.sep}`)) continue
    try {
      if (NOW - fs.statSync(file).mtimeMs < ACTIVE_MS) active++
    } catch {}
  }
  return active
}

// The summary the mod draws from: every series oldest first, each point
// { t: start ms, b: [in, out, cacheRead, cacheWrite] }.
function summarize(state, active, isFresh) {
  const series = (map, unit, n) => {
    const last = Math.floor(NOW / unit)
    const out = []
    for (let k = last - n + 1; k <= last; k++) out.push({ t: k * unit, b: map[k] ?? zero() })
    return out
  }
  const dayKeys = Object.keys(state.days).sort()
  const all = dayKeys.map(k => {
    const [y, m, d] = k.split('-').map(Number)
    return { t: new Date(y, m - 1, d).getTime(), b: state.days[k] }
  })
  const d30 = []
  for (let i = 29; i >= 0; i--) {
    const d = new Date(NOW)
    d.setHours(0, 0, 0, 0)
    d.setDate(d.getDate() - i)
    d30.push({ t: d.getTime(), b: state.days[dayKey(d.getTime())] ?? zero() })
  }
  const total = zero()
  for (const k of dayKeys) for (let j = 0; j < 4; j++) total[j] += state.days[k][j]
  const lastFive = series(state.minutes, MIN, 5)
  const perMinute = lastFive.reduce((s, p) => s + p.b[0] + p.b[1] + p.b[2] + p.b[3], 0) / 5
  return {
    scannedAt: NOW,
    isFresh,
    activeSessions: active,
    perMinute: Math.round(perMinute),
    total,
    today: state.days[dayKey(NOW)] ?? zero(),
    live: series(state.minutes, MIN, 60),
    h24: series(state.hours, HOUR, 24),
    d7: series(state.hours, HOUR, 7 * 24),
    d30,
    all,
  }
}

fs.mkdirSync(STATE_DIR, { recursive: true })
if (takeLock()) {
  try {
    const state = loadState()
    const active = scan(state)
    saveState(state)
    process.stdout.write(JSON.stringify(summarize(state, active, true)))
  } finally {
    fs.rmSync(LOCK_FILE, { force: true })
  }
} else {
  // Another session is scanning: answer from the last saved state.
  process.stdout.write(JSON.stringify(summarize(loadState(), activeCount(), false)))
}
