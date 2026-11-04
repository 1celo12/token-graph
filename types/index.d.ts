/** [input, output, cacheRead, cacheWrite] tokens. */
export type Bucket = [number, number, number, number]

/** One bar: `t` the bucket's start in ms since the epoch. */
export type Point = { t: number; b: Bucket }

/** What scripts/scan.mjs prints: every series oldest first. */
export type Summary = {
  scannedAt: number
  isFresh: boolean
  activeSessions: number
  perMinute: number
  total: Bucket
  today: Bucket
  live: Point[]
  h24: Point[]
  d7: Point[]
  d30: Point[]
  all: Point[]
}

export type Page = 'live' | 'h24' | 'd7' | 'd30' | 'all'
export type Metric = 'total' | 'in' | 'out' | 'cacheRead' | 'cacheWrite' | 'hitRate'

/** Where the scanner stands: the last error, if the last run failed. */
export type ScanStatus = { error?: string; isScanning: boolean }

declare module 'claude-code' {
  interface PluginState {
    'token-graph': {
      summary: Shaped<Summary | null>
      page: Page
      metric: Metric
      status: ScanStatus
      isPaused: boolean
    }
  }
}
