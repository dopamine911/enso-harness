import { ENSO_LOG_ROOT, type EnsoBrowserLogBatch, type EnsoLogLine, ensoLogLineOf } from '@enso/core'
import {
  configure,
  getConsoleSink,
  isLogLevel,
  type LogLevel,
  type LogRecord,
  type Sink,
  withFilter,
} from '@logtape/logtape'
import { createStore, type Store } from './store.ts'

/**
 * The browser's logging (#132 slice 3). Three sinks, one `configure`, called once from
 * `main.tsx` before the page mounts:
 *
 *   ring     — the last {@link LOG_RING_CAPACITY} records as {@link EnsoLogLine}s, in a
 *              store the `?debug` drawer renders and the bundle (slice 4) reads. Every
 *              level the page runs at. In memory, gone with the tab — a debugging surface
 *              puts no traffic in the trace it is reading (#86), so nothing is pulled.
 *   shipper  — `info` and up, batched to `POST /api/logs`, where the server re-emits them
 *              into the one file as `process: "browser"`. The spine and every problem cross;
 *              `debug`/`trace` stay in the ring. Batched by count or by a short timer, and
 *              flushed with `sendBeacon` when the page hides, so the last records before a
 *              close are not the ones lost. A failed POST is dropped — it is the log, and
 *              the log must never make more log.
 *   console  — devtools, at the same level, so a developer with the page open sees records
 *              as they happen.
 *
 * `?log=debug` (or `trace`) is the page's knob, beside `?debug`; the default is `info`. The
 * browser has no `AsyncLocalStorage`, so `withEnsoLogContext` is inert here: every record
 * names its `threadId` explicitly (`log.with({ threadId })` per connection).
 *
 * ⚠ `@logtape/logtape` only — the core package is browser-safe; `@logtape/file` is not
 * (`log-process.ts`), which is why this configurator is its own file and not that one.
 */

const LOG_RING_CAPACITY = 200
/** How many records, or how long, before a batch goes. */
export const SHIP_BATCH_SIZE = 20
const SHIP_FLUSH_MS = 1000
const LOGS_ROUTE = '/api/logs'

export interface LogRing extends Store<readonly EnsoLogLine[]> {
  readonly sink: Sink
}

/** The last N records, newest last, as lines — one shape with the file. */
export function createLogRing(capacity = LOG_RING_CAPACITY): LogRing {
  const store = createStore<readonly EnsoLogLine[]>([])
  return {
    get: store.get,
    subscribe: store.subscribe,
    sink: (record: LogRecord) => {
      const appended = [...store.get(), ensoLogLineOf(record)]
      store.set(appended.length > capacity ? appended.slice(-capacity) : appended)
    },
  }
}

/** `fetch` as a call, not the global's whole interface (`preconnect` and kin) — the connection's shape (#118). */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface LogShipperOptions {
  readonly fetch: FetchLike
  /** One id per page load, on every batch, so two tabs' records tell apart. */
  readonly page: string
  readonly batchSize?: number
  readonly flushMs?: number
}

export interface LogShipper {
  readonly sink: Sink
  /** Send whatever is pending now. `keepalive` for a page that is going away. */
  readonly flush: (keepalive?: boolean) => void
}

const SHIPPED_LEVELS: Readonly<Record<LogLevel, 'info' | 'warning' | 'error' | undefined>> = {
  trace: undefined,
  debug: undefined,
  info: 'info',
  warning: 'warning',
  error: 'error',
  fatal: 'error',
}

/** Batches `info`+ records to the server; the sink is what `configure` gets. */
export function createLogShipper(options: LogShipperOptions): LogShipper {
  const batchSize = options.batchSize ?? SHIP_BATCH_SIZE
  const flushMs = options.flushMs ?? SHIP_FLUSH_MS
  let pending: EnsoBrowserLogBatch['records'] = []
  // The timer in flight, by number: a flush by count or by hand bumps it, so a timer that
  // was scheduled before finds itself stale and does nothing — by count and by time are
  // mutually exclusive, with no handle to type across bun (an object) and the browser (a number).
  let schedule = 0
  const flush = (keepalive = false): void => {
    schedule += 1
    if (pending.length === 0) return
    const batch: EnsoBrowserLogBatch = { page: options.page, records: pending }
    pending = []
    // Fire and forget, and NEVER log the outcome: a failing log route must not feed itself.
    void options
      .fetch(LOGS_ROUTE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batch),
        keepalive,
      })
      .catch(() => undefined)
  }
  return {
    flush,
    sink: (record: LogRecord) => {
      const level = SHIPPED_LEVELS[record.level]
      if (level === undefined) return
      const line = ensoLogLineOf(record)
      pending.push({
        at: line['@timestamp'],
        level,
        logger: line.logger,
        message: line.message ?? '',
        properties: line.properties ?? {},
      })
      if (pending.length >= batchSize) flush()
      else if (pending.length === 1) {
        const mine = schedule
        setTimeout(() => {
          if (schedule === mine) flush()
        }, flushMs)
      }
    },
  }
}

/** The page's level: `?log=debug`, else `info`. A value that is not a level is `info`, said once in the ring. */
export function pageLogLevel(search: string): LogLevel {
  const wanted = new URLSearchParams(search).get('log')
  if (wanted === null) return 'info'
  const level = wanted === 'warn' ? 'warning' : wanted.toLowerCase()
  return isLogLevel(level) ? level : 'info'
}

export interface BrowserLoggingOptions {
  readonly fetch: FetchLike
  readonly level: LogLevel
  readonly page: string
  /** Devtools too; off in tests. */
  readonly console?: boolean
}

export interface BrowserLogging {
  readonly ring: LogRing
  readonly shipper: LogShipper
}

/** Configure the page; returns the ring the drawer reads and the shipper the page flushes on hide. */
export async function configureBrowserLogging(options: BrowserLoggingOptions): Promise<BrowserLogging> {
  const ring = createLogRing()
  const shipper = createLogShipper({ fetch: options.fetch, page: options.page })
  const outputs: Sink[] = [withFilter(ring.sink, options.level), shipper.sink]
  if (options.console === true) outputs.push(withFilter(getConsoleSink(), options.level))
  // One sink, stamping once and fanning out: a per-page count on every record — the
  // drawer's key, and the order inside one millisecond when the file has two of this
  // page's records with one `@timestamp`. One fan-out rather than three registered sinks
  // because none of these can throw (the shipper swallows, the ring is a store), so
  // LogTape's per-sink containment buys nothing here and the count must be assigned once.
  let written = 0
  const stamped: Sink = (record: LogRecord) => {
    written += 1
    const line = { ...record, properties: { pageSequence: written, ...record.properties } }
    for (const output of outputs) output(line)
  }
  await configure({
    reset: true,
    sinks: { enso: stamped },
    loggers: [
      // The tree lets everything through; the ring's and console's filters pick the level,
      // and the shipper picks its own (`info`+) regardless of the page's.
      { category: [ENSO_LOG_ROOT], lowestLevel: 'trace', sinks: ['enso'] },
      { category: ['logtape', 'meta'], sinks: [] },
    ],
  })
  return { ring, shipper }
}
