import { EnsoDayStats, EnsoThreadSummary } from '@enso/core'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Static, TSchema } from 'typebox'
import { Check } from 'typebox/value'
import type { FetchLike } from '../browser-logging.ts'
import {
  Terminal,
  TerminalActions,
  TerminalContent,
  TerminalHeader,
  TerminalStatus,
  TerminalTitle,
} from '../components/ai-elements/terminal.tsx'
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert.tsx'
import { Button } from '../components/ui/button.tsx'
import { Spinner } from '../components/ui/spinner.tsx'
import {
  ABSENT,
  type Column,
  costText,
  countText,
  durationsText,
  millisecondsText,
  StatsTable,
} from '../stats-table.tsx'
import { timeOfDay } from './log-row.tsx'
import { bundleUrl, timelineUrlForThread } from './log-tail-screen.tsx'

/**
 * The day's stats and the processes view (#144 slice 4): what today cost, per thread and per
 * model; how long each run waited for its first token and for the prompt to settle; how long
 * each tool took; which guard rule refused what; who has written to today's file; and which
 * threads the server holds live right now — on the debug page at `debug.html?stats`.
 *
 * ⚠ OBSERVATION, AND ONLY OBSERVATION, the rule the tail states and every view on this page
 * keeps: two reads — `GET /api/logs/stats` and `GET /api/threads` — and nothing else. Nothing
 * here writes, makes a record, or offers a stop, abort, prompt or dialog; the one control is
 * `refresh`, which asks the same two questions again. Neither route logs a line on being
 * asked, so refreshing puts nothing into the day it is summing.
 *
 * ⚠ THE FOLD IS NOT DONE HERE. `dayStats` in `@enso/core` is the one derivation of the day
 * from the file, and the server runs it over the WHOLE day rather than the tail's capped view;
 * this file renders what the route returns and validates it against the schema the server
 * built it from. A number that could be computed on this page from the rows it already has
 * (a total, a mean) is still taken from the payload: two derivations of the same fact would
 * eventually disagree, and a debugging surface that disagrees with `bun run logs` is a second
 * bug on top of the one being chased.
 *
 * THE TWO ROUTES ARE ONE REFRESH. The live-threads list beside the day's threads is the one
 * comparison this page offers — which of today's threads the server still holds — and it only
 * holds if both lists describe the same moment, so they are fetched together and applied
 * together, or not at all. A failure of EITHER route is said verbatim in an alert over the
 * stale view (status and body, the server's own words), never quietly rendered as an empty
 * table; a payload that misses its schema is a failure too.
 *
 * TABLES, NOT A GAUGE. `ai-elements`' `context.tsx` was read first (#31): it is a hover-card
 * gauge for one model's context-window fill — used tokens against a maximum, a percent ring,
 * `tokenlens` price lookups from a model id. The day has no maximum to fill and pi has already
 * attributed the cost; what a reader wants is rows to sort by eye, so the sections are plain
 * monospace tables with a caption each. Where the schema knows nothing — a process without a
 * pid, a run with no released instant, a tool never answered — the cell says `—` rather than
 * `0`, which would be a claim.
 */

const STATS_ROUTE = '/api/logs/stats'
const THREADS_ROUTE = '/api/threads'

/** The browser's own `fetch`, as a stable value: an inline closure would re-fetch on every render. */
const browserFetch: FetchLike = (input: string, init?: RequestInit) => fetch(input, init)

/** What the two routes answered, as the page holds it. */
type DayView = {
  readonly stats: EnsoDayStats
  readonly live: readonly EnsoThreadSummary[]
}

/** One refresh's outcome, in the two ways it can go — a failure is words, never a throw. */
type DayOutcome =
  | { readonly kind: 'read'; readonly view: DayView }
  | { readonly kind: 'failed'; readonly problem: string }

/**
 * One route, read and validated by a predicate. A non-2xx is reported with the route, its status
 * and its body VERBATIM: the reader is debugging, and the body is the server's own words about
 * what went wrong. The predicate rather than a schema, because `GET /api/threads` answers a LIST
 * of `EnsoThreadSummary` and the list is not a shape of ours — `@enso/core` owns every schema
 * (`test/no-duplicate-shapes.test.ts`), so this page checks each element with the one it exports.
 */
async function readRoute<Payload>(
  route: string,
  matches: (payload: unknown) => payload is Payload,
  fetchImpl: FetchLike,
): Promise<Payload> {
  const response = await fetchImpl(route)
  if (!response.ok) throw new Error(`${route}: ${response.status} ${await response.text()}`.trim())
  const payload: unknown = await response.json()
  if (!matches(payload)) throw new Error(`${route}: the server's payload did not match its schema`)
  return payload
}

function checks<Schema extends TSchema>(schema: Schema): (payload: unknown) => payload is Static<Schema> {
  return (payload: unknown): payload is Static<Schema> => Check(schema, payload)
}

function isThreadSummaryList(payload: unknown): payload is EnsoThreadSummary[] {
  return Array.isArray(payload) && payload.every((summary) => Check(EnsoThreadSummary, summary))
}

/** Both routes, together: one moment, or why not. */
async function fetchDay(fetchImpl: FetchLike): Promise<DayOutcome> {
  try {
    const [stats, live] = await Promise.all([
      readRoute(STATS_ROUTE, checks(EnsoDayStats), fetchImpl),
      readRoute(THREADS_ROUTE, isThreadSummaryList, fetchImpl),
    ])
    return { kind: 'read', view: { stats, live } }
  } catch (error) {
    return { kind: 'failed', problem: error instanceof Error ? error.message : String(error) }
  }
}

/** The one-line summary the page opens with. */
function describeTotals(stats: EnsoDayStats): string {
  const { totals } = stats
  return [
    stats.day,
    `${countText(stats.records)} records (${countText(stats.malformed)} malformed)`,
    `${countText(totals.runs)} runs`,
    `${countText(totals.toolCalls)} tool calls`,
    `${countText(totals.denials)} denials`,
    `${countText(totals.refusals)} provider refusals`,
    `cost ${costText(totals.cost)}`,
    `${countText(totals.input)} in / ${countText(totals.output)} out`,
  ].join(' · ')
}

/** A thread id, as a link into its timeline on this page — where a thread id leads on the observation surface. */
function ThreadLink({ threadId }: { threadId: string }): React.ReactNode {
  return (
    <a className="text-primary underline-offset-2 hover:underline" href={timelineUrlForThread(threadId)}>
      {threadId}
    </a>
  )
}

/** A row's spend, as the core schema carries it on a thread's and a model's row alike. */
type DaySpend = Pick<
  EnsoDayStats['models'][number],
  'messages' | 'cost' | 'input' | 'output' | 'cacheRead' | 'cacheWrite'
>

/**
 * The spend columns the threads and models tables both end with (#352) — one list with its
 * cells beside it, so a new token kind is a column in both or in neither.
 */
const SPEND_COLUMNS: readonly Column[] = [
  { heading: 'messages', numeric: true },
  { heading: 'cost', numeric: true },
  { heading: 'in', numeric: true },
  { heading: 'out', numeric: true },
  { heading: 'cache read', numeric: true },
  { heading: 'cache write', numeric: true },
]

/** The cells under {@link SPEND_COLUMNS}, in its order. */
function spendCells(spend: DaySpend): string[] {
  return [
    countText(spend.messages),
    costText(spend.cost),
    countText(spend.input),
    countText(spend.output),
    countText(spend.cacheRead),
    countText(spend.cacheWrite),
  ]
}

/** The knobs a process booted with, on one line; `—` for a writer whose first record said none. */
function knobsText(process: EnsoDayStats['processes'][number]): string {
  const knobs: string[] = []
  if (process.file !== undefined) knobs.push(`file ${process.file}`)
  if (process.console !== undefined) knobs.push(`console ${process.console}`)
  if (process.overrides !== undefined && process.overrides.length > 0) {
    knobs.push(`overrides ${process.overrides.join(',')}`)
  }
  return knobs.length === 0 ? ABSENT : knobs.join(' · ')
}

/** The sections, in reading order: what it cost, who was here, what ran, what it used, what was refused. */
function DaySections({ view }: { view: DayView }): React.ReactNode {
  const { stats, live } = view
  const threads = stats.threads.toSorted((left, right) => right.cost - left.cost)
  const models = stats.models.toSorted((left, right) => right.cost - left.cost)
  const tools = stats.tools.toSorted((left, right) => right.calls - left.calls)
  return (
    <>
      <section className="mb-4">
        <h2 className="pb-1 text-xs font-semibold text-foreground">totals</h2>
        <p className="text-xs">{describeTotals(stats)}</p>
        <p className="text-xs text-muted-foreground">
          prompts: {durationsText(stats.totals.prompts, 'no settled prompt')} · first token:{' '}
          {durationsText(stats.totals.firstDelta, 'none')}
        </p>
      </section>
      <StatsTable
        caption="processes"
        empty="no writer today"
        columns={[
          { heading: 'process' },
          { heading: 'pid', numeric: true },
          { heading: 'started' },
          { heading: 'first write' },
          { heading: 'last write' },
          { heading: 'records', numeric: true },
          { heading: 'knobs' },
        ]}
        rows={stats.processes.map((process) => ({
          key: process.process,
          cells: [
            process.process,
            process.pid === undefined ? ABSENT : String(process.pid),
            process.startedAt === undefined ? ABSENT : timeOfDay(process.startedAt),
            timeOfDay(process.firstAt),
            timeOfDay(process.lastAt),
            countText(process.records),
            knobsText(process),
          ],
        }))}
      />
      <StatsTable
        caption="live threads"
        empty="no live thread"
        columns={[
          { heading: 'thread' },
          { heading: 'busy' },
          { heading: 'generation', numeric: true },
          { heading: 'mode' },
          { heading: 'last activity' },
          { heading: 'session file' },
        ]}
        rows={live.map((thread) => ({
          key: thread.threadId,
          cells: [
            <ThreadLink key="thread" threadId={thread.threadId} />,
            thread.busy ? 'busy' : 'idle',
            countText(thread.generation),
            thread.mode,
            timeOfDay(thread.lastActivityAt),
            thread.sessionFile ?? '(in memory)',
          ],
        }))}
      />
      <StatsTable
        caption="threads (the day)"
        empty="no attributed thread today"
        columns={[{ heading: 'thread' }, { heading: 'runs', numeric: true }, ...SPEND_COLUMNS]}
        rows={threads.map((thread) => ({
          key: thread.threadId,
          cells: [
            <ThreadLink key="thread" threadId={thread.threadId} />,
            countText(thread.runs),
            ...spendCells(thread),
          ],
        }))}
      />
      <StatsTable
        caption="models"
        empty="no attributed model today"
        columns={[{ heading: 'model' }, ...SPEND_COLUMNS]}
        rows={models.map((model) => ({ key: model.model, cells: [model.model, ...spendCells(model)] }))}
      />
      <StatsTable
        caption="runs"
        empty="no run today"
        columns={[
          { heading: 'thread' },
          { heading: 'generation', numeric: true },
          { heading: 'acquired' },
          { heading: 'run ms', numeric: true },
          { heading: 'prompt ms', numeric: true },
          { heading: 'first token ms', numeric: true },
          { heading: 'cost', numeric: true },
        ]}
        rows={stats.runs.map((run) => ({
          key: `${run.threadId}#${run.generation}`,
          cells: [
            <ThreadLink key="thread" threadId={run.threadId} />,
            countText(run.generation),
            run.acquiredAt === undefined ? ABSENT : timeOfDay(run.acquiredAt),
            millisecondsText(run.runMs),
            millisecondsText(run.promptMs),
            millisecondsText(run.firstDeltaMs),
            costText(run.cost),
          ],
        }))}
      />
      <StatsTable
        caption="tools"
        empty="no tool call today"
        columns={[
          { heading: 'tool' },
          { heading: 'calls', numeric: true },
          { heading: 'results', numeric: true },
          { heading: 'errors', numeric: true },
          { heading: 'min ms', numeric: true },
          { heading: 'mean ms', numeric: true },
          { heading: 'max ms', numeric: true },
          { heading: 'total ms', numeric: true },
        ]}
        rows={tools.map((tool) => {
          const timed = tool.durations.count > 0
          return {
            key: tool.toolName,
            cells: [
              tool.toolName,
              countText(tool.calls),
              countText(tool.results),
              countText(tool.errors),
              timed ? millisecondsText(tool.durations.minMs) : ABSENT,
              timed ? millisecondsText(tool.durations.meanMs) : ABSENT,
              timed ? millisecondsText(tool.durations.maxMs) : ABSENT,
              timed ? millisecondsText(tool.durations.totalMs) : ABSENT,
            ],
          }
        })}
      />
      <CountTable
        caption="denials by rule"
        empty="no denial today"
        headings={['rule']}
        counts={stats.denials.map((denial) => [[denial.rule], denial.count])}
      />
      <CountTable
        caption="provider refusals by provider and status (#340)"
        empty="no provider refusal today"
        headings={['provider', 'status']}
        counts={stats.refusals.map((refusal) => [
          [refusal.provider, refusal.status === undefined ? ABSENT : String(refusal.status)],
          refusal.count,
        ])}
      />
      {securityTables(stats.security).map((table) => (
        <CountTable key={table.caption} {...table} />
      ))}
    </>
  )
}

interface CountTableProps {
  readonly caption: string
  readonly empty: string
  /** The label columns, before the count. */
  readonly headings: readonly string[]
  readonly countHeading?: string
  readonly counts: readonly (readonly [labels: readonly string[], count: number])[]
}

/** A table of labelled counts — one of the day's tallies. */
function CountTable({ caption, empty, headings, countHeading = 'count', counts }: CountTableProps): React.ReactNode {
  return (
    <StatsTable
      caption={caption}
      empty={empty}
      columns={[...headings.map((heading) => ({ heading })), { heading: countHeading, numeric: true }]}
      rows={counts.map(([labels, count]) => ({ key: labels.join('|'), cells: [...labels, countText(count)] }))}
    />
  )
}

/** The day's security record (#468), as its tables: what the guard saw, what it opened, the reports, the resolutions. */
function securityTables(security: EnsoDayStats['security']): CountTableProps[] {
  const { incidents, reports } = security
  const anyIncident = incidents.opened > 0 || reports.filed + reports.missing > 0
  const incidentCounts: CountTableProps['counts'] = [
    [['opened'], incidents.opened],
    [['halted'], incidents.halted],
    [['reports filed'], reports.filed],
    [['reports that checked'], reports.checked],
    [['reports missing'], reports.missing],
  ]
  const noIncident = 'no security incident today'
  return [
    {
      caption: 'security signals by kind (#464)',
      empty: 'no security signal today',
      headings: ['signal'],
      counts: security.signals.map((signal) => [[signal.signal], signal.count]),
    },
    {
      caption: 'security incidents (#466, #467)',
      empty: noIncident,
      headings: ['what'],
      counts: anyIncident ? incidentCounts : [],
    },
    {
      caption: 'security incidents by model',
      empty: noIncident,
      headings: ['model'],
      countHeading: 'incidents',
      counts: security.models.map((row) => [[row.model], row.incidents]),
    },
    {
      caption: 'incident resolutions',
      empty: 'no incident resolved today',
      headings: ['classification', 'outcome'],
      counts: security.resolutions.map((resolution) => [
        [resolution.classification, resolution.outcome],
        resolution.count,
      ]),
    },
  ]
}

/** The page. `fetch` is the test seam (#118's convention) — the browser's own otherwise. */
export function DayStatsScreen({ fetch: pageFetch }: { fetch?: FetchLike } = {}): React.ReactNode {
  const fetchImpl = pageFetch ?? browserFetch
  const [view, setView] = useState<DayView | undefined>(undefined)
  const [problem, setProblem] = useState<string | undefined>(undefined)
  const [reading, setReading] = useState(true)
  /**
   * Only the LATEST request's outcome may be applied: a second `refresh` can overtake the
   * first, and the older answer must not land on top of the newer one. Bumped on unmount too,
   * so an answer that arrives after the page has gone sets nothing.
   */
  const latestRequest = useRef(0)

  const refresh = useCallback(async (): Promise<void> => {
    latestRequest.current += 1
    const ticket = latestRequest.current
    setReading(true)
    const outcome = await fetchDay(fetchImpl)
    if (ticket !== latestRequest.current) return
    setReading(false)
    if (outcome.kind === 'failed') {
      setProblem(outcome.problem)
      return
    }
    setProblem(undefined)
    setView(outcome.view)
  }, [fetchImpl])

  useEffect(() => {
    void refresh()
    return () => {
      latestRequest.current += 1
    }
  }, [refresh])

  return (
    <Terminal className="h-dvh" isStreaming={reading}>
      <TerminalHeader>
        <TerminalTitle>enso · day</TerminalTitle>
        <Button variant="outline" size="sm" onClick={() => void refresh()}>
          refresh
        </Button>
        <TerminalActions>
          <a className="px-2 text-xs text-primary underline-offset-2 hover:underline" href="/debug">
            the day's log
          </a>
          <a className="px-2 text-xs text-primary underline-offset-2 hover:underline" href={bundleUrl()} download>
            download the day's bundle
          </a>
          <TerminalStatus>
            <Spinner />
          </TerminalStatus>
        </TerminalActions>
      </TerminalHeader>
      {problem === undefined ? null : (
        <div className="px-4 pt-1">
          <Alert variant="destructive">
            <AlertTitle>the day</AlertTitle>
            <AlertDescription>{problem}</AlertDescription>
          </Alert>
        </div>
      )}
      <TerminalContent className="px-4 py-2 text-xs">
        {view === undefined ? null : <DaySections view={view} />}
      </TerminalContent>
    </Terminal>
  )
}
