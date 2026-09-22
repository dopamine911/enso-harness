import { afterAll, expect, test } from 'bun:test'
import type { EnsoDayStats, EnsoThreadSummary } from '@enso/core'
import { act } from 'react'
import type { createRoot as CreateRoot, Root } from 'react-dom/client'
import { ensureDom, releaseDom } from '../../__tests__/dom-environment.ts'
import type { FetchLike } from '../../browser-logging.ts'
import { DayStatsScreen } from '../day-stats-screen.tsx'

// ⚠ Loaded by a DYNAMIC import, for the reason `log-tail-screen.test.tsx` gives: react-dom/client
// probes the DOM when its module evaluates, and a static import would see none.
ensureDom()
const { createRoot }: { createRoot: typeof CreateRoot } = await import('react-dom/client')

/**
 * The day's stats (#144 slice 4), MOUNTED over a scripted server: the stats route answers a
 * folded day the test wrote, the threads route the live list beside it, and the page is read
 * through the same `fetch` seam it reads them through. The fold itself is `log-stats.ts`'s
 * and has its own tests; what is asked here is that every section shows what the payload
 * says, that the two routes are one refresh, and that a failure is said verbatim.
 */
afterAll(releaseDom)

const THREAD_ID = 'thread-01ABCDEF'
const LIVE_THREAD_ID = 'thread-02LIVE'

const tick = (): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, 10)
  return promise
}

/** React's `act` with async work — typed so its Promise overload is the one seen. */
const flush = (work: () => Promise<void>): Promise<void> => act(work)

const EVENTUALLY_DEADLINE_MS = 2000

async function eventually<T>(probe: () => T): Promise<T> {
  const deadline = Date.now() + EVENTUALLY_DEADLINE_MS
  for (;;) {
    try {
      return probe()
    } catch (error) {
      if (Date.now() >= deadline) throw error
      await flush(tick)
    }
  }
}

const DAY: EnsoDayStats = {
  day: '2026-09-22',
  records: 12_345,
  malformed: 2,
  processes: [
    {
      process: 'server',
      pid: 4242,
      startedAt: '2026-09-22T08:00:00.000Z',
      file: 'info',
      console: 'warn',
      overrides: ['enso.server=debug', 'enso.guards=trace'],
      firstAt: '2026-09-22T08:00:00.100Z',
      lastAt: '2026-09-22T10:30:00.000Z',
      records: 12_000,
    },
    {
      process: 'browser',
      firstAt: '2026-09-22T09:00:00.000Z',
      lastAt: '2026-09-22T09:05:00.000Z',
      records: 345,
    },
  ],
  runs: [
    {
      threadId: THREAD_ID,
      generation: 1,
      acquiredAt: '2026-09-22T09:00:00.000Z',
      releasedAt: '2026-09-22T09:00:12.500Z',
      runMs: 12_500,
      promptMs: 11_000,
      firstDeltaMs: 800,
      input: 1000,
      output: 200,
      cacheRead: 50,
      cacheWrite: 10,
      cost: 0.0123,
      messages: 1,
    },
    {
      threadId: THREAD_ID,
      generation: 2,
      acquiredAt: '2026-09-22T09:10:00.000Z',
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      messages: 0,
    },
  ],
  threads: [
    {
      threadId: THREAD_ID,
      runs: 2,
      input: 1000,
      output: 200,
      cacheRead: 50,
      cacheWrite: 10,
      cost: 0.0123,
      messages: 1,
    },
  ],
  models: [
    { model: 'claude-sonnet', input: 1000, output: 200, cacheRead: 50, cacheWrite: 10, cost: 0.0123, messages: 1 },
  ],
  tools: [
    {
      toolName: 'read',
      calls: 3,
      results: 3,
      errors: 0,
      durations: { count: 3, minMs: 5, maxMs: 1500, meanMs: 505, totalMs: 1515 },
    },
    {
      toolName: 'bash',
      calls: 1,
      results: 0,
      errors: 0,
      durations: { count: 0, minMs: 0, maxMs: 0, meanMs: 0, totalMs: 0 },
    },
  ],
  denials: [{ rule: 'no-shell-grep', count: 4 }],
  totals: {
    runs: 2,
    prompts: { count: 1, minMs: 11_000, maxMs: 11_000, meanMs: 11_000, totalMs: 11_000 },
    firstDelta: { count: 1, minMs: 800, maxMs: 800, meanMs: 800, totalMs: 800 },
    toolCalls: 4,
    denials: 4,
    input: 1000,
    output: 200,
    cacheRead: 50,
    cacheWrite: 10,
    cost: 0.0123,
    messages: 1,
  },
}

const LIVE: EnsoThreadSummary[] = [
  {
    threadId: LIVE_THREAD_ID,
    sessionId: LIVE_THREAD_ID,
    sessionDir: '/tmp/sessions',
    sessionFile: null,
    mode: 'default',
    busy: true,
    generation: 3,
    lastActivityAt: '2026-09-22T10:29:00.000Z',
  },
]

/** How a route answers: a status and a body, replaceable between requests. */
interface RouteAnswer {
  status: number
  body: unknown
}

interface MountedStats {
  readonly container: HTMLElement
  /** Every URL the page has asked for, in order. */
  readonly urls: string[]
  readonly answers: Record<'/api/logs/stats' | '/api/threads', RouteAnswer>
  readonly unmount: () => Promise<void>
}

async function mountStats(answers: MountedStats['answers']): Promise<MountedStats> {
  const urls: string[] = []
  const scriptedFetch: FetchLike = (input: string) => {
    urls.push(input)
    const answer = input === '/api/logs/stats' || input === '/api/threads' ? answers[input] : undefined
    if (answer === undefined) return Promise.resolve(new Response('no such route', { status: 404 }))
    const body = typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body)
    return Promise.resolve(new Response(body, { status: answer.status }))
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  await flush(async () => {
    root.render(<DayStatsScreen fetch={scriptedFetch} />)
  })
  await flush(tick)
  return {
    container,
    urls,
    answers,
    unmount: async () => {
      await flush(async () => root.unmount())
      container.remove()
    },
  }
}

const healthy = (): MountedStats['answers'] => ({
  '/api/logs/stats': { status: 200, body: DAY },
  '/api/threads': { status: 200, body: LIVE },
})

const rowTexts = (container: HTMLElement, caption: string): string[] =>
  [...container.querySelectorAll('table')]
    .filter((table) => table.querySelector('caption')?.textContent === caption)
    .flatMap((table) => [...table.querySelectorAll('tbody tr')].map((row) => row.textContent ?? ''))

test('the totals line says the day, its counts and its cost, and the summaries read in words', async () => {
  const page = await mountStats(healthy())
  await eventually(() => {
    const shown = page.container.textContent ?? ''
    expect(shown).toContain(
      '2026-09-22 · 12,345 records (2 malformed) · 2 runs · 4 tool calls · 4 denials · cost $0.0123 · 1,000 in / 200 out',
    )
    expect(shown).toContain('prompts: 1, 11,000/11,000/11,000 ms')
    expect(shown).toContain('first token: 1, 800/800/800 ms')
  })
  await page.unmount()
})

// A summary of nothing is said as nothing — `0/0/0 ms` would be a claim about durations that
// were never measured.
test('a day with no settled prompt says so instead of 0/0/0', async () => {
  const answers = healthy()
  answers['/api/logs/stats'] = {
    status: 200,
    body: {
      ...DAY,
      totals: { ...DAY.totals, prompts: { count: 0, minMs: 0, maxMs: 0, meanMs: 0, totalMs: 0 } },
    },
  }
  const page = await mountStats(answers)
  await eventually(() => expect(page.container.textContent).toContain('prompts: no settled prompt'))
  await page.unmount()
})

test('a process row shows its pid and knobs; one without a pid shows —', async () => {
  const page = await mountStats(healthy())
  await eventually(() => {
    const rows = rowTexts(page.container, 'processes')
    expect(rows[0]).toContain('server')
    expect(rows[0]).toContain('4242')
    expect(rows[0]).toContain('12,000')
    expect(rows[0]).toContain('file info · console warn · overrides enso.server=debug,enso.guards=trace')
    expect(rows[1]).toContain('browser')
    expect(rows[1]).toContain('—')
  })
  await page.unmount()
})

// A thread id on the observation surface drills into its timeline on this same page.
test('a live thread is a link into its timeline, with its state beside it', async () => {
  const page = await mountStats(healthy())
  await eventually(() => {
    const link = page.container.querySelector(`a[href="/debug?thread=${LIVE_THREAD_ID}"]`)
    expect(link?.textContent).toBe(LIVE_THREAD_ID)
    const [row] = rowTexts(page.container, 'live threads')
    expect(row).toContain('busy')
    expect(row).toContain('default')
    expect(row).toContain('(in memory)')
  })
  await page.unmount()
})

test('an empty live list says no live thread', async () => {
  const answers = healthy()
  answers['/api/threads'] = { status: 200, body: [] }
  const page = await mountStats(answers)
  await eventually(() => expect(rowTexts(page.container, 'live threads')).toEqual(['no live thread']))
  await page.unmount()
})

test('a run without a released instant shows — for the spans it does not have', async () => {
  const page = await mountStats(healthy())
  await eventually(() => {
    const rows = rowTexts(page.container, 'runs')
    expect(rows[0]).toContain('12,500')
    expect(rows[0]).toContain('11,000')
    expect(rows[0]).toContain('800')
    expect(rows[1]).toContain('—')
    expect(page.container.querySelectorAll(`a[href="/debug?thread=${THREAD_ID}"]`).length).toBeGreaterThan(1)
  })
  await page.unmount()
})

test('a tool never answered shows — for its durations, not 0', async () => {
  const page = await mountStats(healthy())
  await eventually(() => {
    const rows = rowTexts(page.container, 'tools')
    expect(rows[0]).toContain('read')
    expect(rows[0]).toContain('1,515')
    expect(rows[1]).toContain('bash')
    expect(rows[1]).toContain('—')
    expect(rows[1]).not.toContain('0 ms')
  })
  await page.unmount()
})

test('a denial row is its rule and count', async () => {
  const page = await mountStats(healthy())
  await eventually(() => {
    const [row] = rowTexts(page.container, 'denials by rule')
    expect(row).toContain('no-shell-grep')
    expect(row).toContain('4')
  })
  await page.unmount()
})

// The two routes are one refresh: the live list beside the day's threads describes the same moment.
test('refresh re-reads both routes', async () => {
  const page = await mountStats(healthy())
  await eventually(() => expect(page.urls).toEqual(['/api/logs/stats', '/api/threads']))
  const refresh = [...page.container.querySelectorAll('button')].find((button) => button.textContent === 'refresh')
  expect(refresh).toBeDefined()
  await flush(async () => {
    refresh?.click()
    await tick()
  })
  await eventually(() =>
    expect(page.urls).toEqual(['/api/logs/stats', '/api/threads', '/api/logs/stats', '/api/threads']),
  )
  await page.unmount()
})

// A failure is said, verbatim: a debugging surface never drops what it could not read.
test('⚠ a failing stats route is named in an alert with the server’s own words', async () => {
  const answers = healthy()
  answers['/api/logs/stats'] = { status: 500, body: 'the fold fell over' }
  const page = await mountStats(answers)
  await eventually(() => {
    const shown = page.container.textContent ?? ''
    expect(shown).toContain('the day')
    expect(shown).toContain('/api/logs/stats: 500 the fold fell over')
  })
  await page.unmount()
})
