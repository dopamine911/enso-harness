import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bundleRecordsText, type EnsoLogLine, type EnsoSessionEval, readEnsoSessionEval } from '@enso/core'
import { projectIdOf, realpathOrSelf } from '@enso/core/paths'
import { ARENA_REFUSED_DETAIL, ARENA_RUNNER_STILL_RUNNING } from './actions.ts'
import { type ArenaProjectThread, projectThreads } from './evidence.ts'
import type { ArenaManifest } from './manifest.ts'
import { type ArenaEvent, readJsonLines, readTimeline } from './timeline.ts'

/**
 * A Dogfood Arena run's score (#556, #584): every log the run left, read for problems, and
 * whether the agent under test really used Enso's UI — a verdict a CI step or a person can act on.
 *
 * It follows the session eval's two rules (#441, `session-eval.ts`):
 *   1. MECHANICAL. Every line traces to a record: a timeline event, a transcript message, an Enso
 *      log record, a session eval, a stored thread, the files in the project and the threads' trees. Nothing is a reading
 *      of what the agent said, so two runs are comparable and a claim is checkable by re-scoring.
 *   2. NO COMPOSITE NUMBER. The score is named UI checks plus problems at two severities. The
 *      verdict is not a weighting: one error fails the run, and the score says which.
 *
 * ⚠ THE UI CHECKS DO NOT TAKE THE RECORDER'S WORD. `agent-only-tool` reads the manifest's boundary
 * (what the recorder saw), but `prompted-enso`, `no-thread-outside-ui` and `enso-did-the-work`
 * read ENSO's records — its session evals, its stored threads — and the project on disk. A prompt
 * that reached Enso some other way shows up as a thread the UI never named; files that changed
 * with no Enso tool call show up as work done outside Enso. A check that cannot be made is
 * `unknown`, and unknown fails like a fail: the score cannot say the UI was used without evidence.
 *
 * ⚠ NOT JUDGED HERE: whether the Snake game is good, and whether a wish is a real gap. Those are
 * the findings report's (#556 deliverables); this is what the logs show went wrong.
 */

/** How bad a problem is: an error fails the run; a warning is reported and does not. */
export type ArenaSeverity = 'error' | 'warning'

/** Which log a problem was read from. */
export type ArenaProblemSource = 'ui' | 'run' | 'timeline' | 'agent' | 'enso-log' | 'enso-eval' | 'evidence' | 'project'

/** One problem: the same kind of thing, counted once with a few examples rather than listed N times. */
export interface ArenaProblem {
  readonly severity: ArenaSeverity
  readonly source: ArenaProblemSource
  readonly message: string
  readonly count: number
  readonly examples: readonly string[]
}

/** One occurrence before grouping: a problem's kind, and one line that locates this instance of it. */
type Occurrence = Pick<ArenaProblem, 'severity' | 'source' | 'message'> & { readonly example: string }

export type ArenaCheckStatus = 'pass' | 'fail' | 'unknown'

/** One of the checks that the UI, and only the UI, was used. */
export interface ArenaUiCheck {
  readonly name: 'agent-only-tool' | 'acted-on-page' | 'prompted-enso' | 'no-thread-outside-ui' | 'enso-did-the-work'
  readonly status: ArenaCheckStatus
  readonly detail: string
}

/** What the run came to, in counts: the context for its problems, never a score of its own. */
export interface ArenaScoreMetrics {
  readonly minutes?: number
  readonly actions: ArenaManifest['actions']
  /** From Enso's own session evals: prompts that reached it (`humanMessages`), its tool calls, their errors. */
  readonly enso?: { readonly prompts: number; readonly toolCalls: number; readonly toolErrors: number }
  /** Threads the UI named, and threads Enso stores for the run's project. */
  readonly threads: { readonly shown: number; readonly stored?: number }
  readonly screenshots: number
  readonly notes: Readonly<Record<'wish' | 'friction' | 'retrospective', number>>
  readonly work?: ArenaWorkspaceState
}

/**
 * What the run built, over every place it could be: the run's project and each thread's working
 * directory. Enso runs a thread in a tree of its own (#551) — `projects/<id>/trees/<thread>`, "not
 * your checkout" — so the game can be there while `project/` stays empty (measured: a live run's
 * `snake.js` was only in the tree).
 */
export interface ArenaWorkspaceState {
  /** Files changed and not committed in a git workspace, or every file in one that is not a repository. */
  readonly changedFiles: number
  readonly commits: number
  readonly workspaces: readonly string[]
}

export interface ArenaScore {
  readonly runId: string
  readonly scenario: string
  readonly verdict: 'pass' | 'fail'
  readonly errors: number
  readonly warnings: number
  /** True only when every UI check passed. */
  readonly uiUsed: boolean
  readonly uiChecks: readonly ArenaUiCheck[]
  readonly problems: readonly ArenaProblem[]
  readonly metrics: ArenaScoreMetrics
}

/** Everything the score reads, parsed. An absent optional means that log was not there: unknown. */
export interface ArenaScoreInput {
  readonly manifest: ArenaManifest
  readonly events: readonly ArenaEvent[]
  /** The agent's transcript, one message per entry; absent for a run with no agent runner. */
  readonly transcript?: readonly unknown[]
  /** Each collected session eval, by thread id. */
  readonly evals: ReadonlyMap<string, EnsoSessionEval>
  /** Enso's log records from the threads' bundles, de-duplicated; absent when no bundle was collected. */
  readonly logRecords?: readonly EnsoLogLine[]
  /** The run project's stored threads; absent when they were not collected. */
  readonly projectThreads?: readonly ArenaProjectThread[]
  /** What the project and the threads' trees hold at the end; absent when none could be read. */
  readonly project?: ArenaWorkspaceState
}

/** How many examples a problem keeps: enough to find it, few enough to read. */
const EXAMPLES_KEPT = 3
/** The moves that act on the page, as opposed to looking at it or talking to the recorder. */
const PAGE_MOVES: ReadonlySet<string> = new Set(['click', 'fill', 'press', 'select', 'hover', 'goto', 'back', 'reload'])

/** Errors before warnings; within a severity, the order the logs were read in. */
const SEVERITY_ORDER: Readonly<Record<ArenaSeverity, number>> = { error: 0, warning: 1 }

/** The severity an Enso log level carries into the score; levels below WARN carry none. */
const LOG_LEVEL_SEVERITY: Readonly<Partial<Record<EnsoLogLine['level'], ArenaSeverity>>> = {
  FATAL: 'error',
  ERROR: 'error',
  WARN: 'warning',
}

/** Occurrences with the same severity, source and message, as one problem with a count. */
function grouped(occurrences: readonly Occurrence[]): ArenaProblem[] {
  const buckets = new Map<string, Occurrence[]>()
  for (const occurrence of occurrences) {
    const key = [occurrence.severity, occurrence.source, occurrence.message].join('\u0000')
    buckets.set(key, [...(buckets.get(key) ?? []), occurrence])
  }
  const problems = [...buckets.values()].flatMap(([first, ...rest]): ArenaProblem[] => {
    if (first === undefined) return []
    const examples = [...new Set([first, ...rest].map((occurrence) => occurrence.example))].slice(0, EXAMPLES_KEPT)
    return [
      { severity: first.severity, source: first.source, message: first.message, count: rest.length + 1, examples },
    ]
  })
  return problems.toSorted((left, right) => SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity])
}

/** Where an event happened, as one example line: its time into the run, and the thread it was in. */
function placeOf(event: ArenaEvent): string {
  const seconds = Math.round(event.elapsedMs / 1000)
  return `+${seconds}s${event.page?.threadId === undefined ? '' : ` thread ${event.page.threadId}`}`
}

const short = (text: string): string => (text.length > 160 ? `${text.slice(0, 157)}…` : text)

// ── The UI checks ──────────────────────────────────────────────────────────────────────────────

function threadsShown(events: readonly ArenaEvent[]): Set<string> {
  return new Set(events.flatMap((event) => (event.page?.threadId === undefined ? [] : [event.page.threadId])))
}

function sumOverEvals(
  evals: ReadonlyMap<string, EnsoSessionEval>,
  read: (sessionEval: EnsoSessionEval) => number,
): number {
  let total = 0
  for (const sessionEval of evals.values()) total += read(sessionEval)
  return total
}

/** One check's verdict: `pass` when `passed`, else `fail`; the detail says which way and why. */
function verdictOf(name: ArenaUiCheck['name'], passed: boolean, ifPassed: string, ifFailed: string): ArenaUiCheck {
  return { name, status: passed ? 'pass' : 'fail', detail: passed ? ifPassed : ifFailed }
}

function promptedEnso(input: ArenaScoreInput): ArenaUiCheck {
  if (input.evals.size === 0) {
    return {
      name: 'prompted-enso',
      status: 'unknown',
      detail: 'no session eval was collected: no prompt can be counted',
    }
  }
  const prompts = sumOverEvals(input.evals, (sessionEval) => sessionEval.scorecard.humanMessages)
  return verdictOf(
    'prompted-enso',
    prompts > 0,
    `${prompts} prompt(s) reached Enso across ${input.evals.size} thread(s)`,
    'Enso recorded no prompt: the agent never gave it work',
  )
}

/**
 * Every stored thread of the run's project that holds messages was shown by the UI, or is a fork
 * of one that was. A prompted thread the page never named was driven some other way.
 */
function noThreadOutsideUi(input: ArenaScoreInput): ArenaUiCheck {
  const stored = input.projectThreads
  if (stored === undefined) {
    return {
      name: 'no-thread-outside-ui',
      status: 'unknown',
      detail: "the project's stored threads were not collected",
    }
  }
  const shown = threadsShown(input.events)
  const parentOf = new Map(
    stored.flatMap((thread) =>
      thread.parentThreadId === undefined ? [] : [[thread.threadId, thread.parentThreadId] as const],
    ),
  )
  // A fork of a fork of a shown thread came from the UI too (PR #585 review): walk the whole chain.
  const fromShown = (threadId: string): boolean => {
    const walked = new Set<string>()
    for (let current: string | undefined = threadId; current !== undefined; current = parentOf.get(current)) {
      if (shown.has(current)) return true
      if (walked.has(current)) return false
      walked.add(current)
    }
    return false
  }
  const unseen = stored.filter((thread) => thread.messageCount > 0 && !fromShown(thread.threadId))
  return verdictOf(
    'no-thread-outside-ui',
    unseen.length === 0,
    `every prompted thread of the project was on screen (${stored.length} stored)`,
    `prompted but never shown by the UI: ${unseen.map((thread) => thread.threadId).join(', ')}`,
  )
}

/** The project changed only if Enso ran tools: the agent under test has no hands of its own. */
function ensoDidTheWork(input: ArenaScoreInput): ArenaUiCheck {
  const work = input.project
  const unknown = (detail: string): ArenaUiCheck => ({ name: 'enso-did-the-work', status: 'unknown', detail })
  if (work === undefined) return unknown('neither the project nor a thread tree could be read')
  const changed = work.changedFiles + work.commits > 0
  if (changed && input.evals.size === 0) return unknown('the work changed, and no session eval says who changed it')
  const toolCalls = sumOverEvals(input.evals, (sessionEval) => sessionEval.scorecard.toolCalls)
  return verdictOf(
    'enso-did-the-work',
    !changed || toolCalls > 0,
    changed
      ? `the work changed, and Enso ran ${toolCalls} tool call(s)`
      : 'nothing changed in the project or its trees',
    'the work changed, but Enso ran no tool: it was done outside Enso',
  )
}

function uiChecksOf(input: ArenaScoreInput): ArenaUiCheck[] {
  const boundary = input.manifest.boundary
  const moves = input.events.filter(
    (event) =>
      event.kind === 'action' && event.via === 'agent' && event.outcome === 'ok' && PAGE_MOVES.has(event.action),
  ).length
  return [
    { name: 'agent-only-tool', status: boundary.held ? 'pass' : 'fail', detail: boundary.why },
    verdictOf(
      'acted-on-page',
      moves > 0,
      `${moves} move(s) on the page through the agent's tool`,
      'the agent made no move on the page through its tool',
    ),
    promptedEnso(input),
    noThreadOutsideUi(input),
    ensoDidTheWork(input),
  ]
}

// ── The logs, read for problems ────────────────────────────────────────────────────────────────

function runProblems(input: ArenaScoreInput): Occurrence[] {
  const { manifest } = input
  const found: Occurrence[] = []
  const at = (severity: ArenaSeverity, message: string, example: string): void => {
    found.push({ severity, source: 'run', message, example })
  }
  if (manifest.stoppedAt === undefined)
    at('error', 'the run never stopped cleanly: the recorder died', manifest.stopReason)
  if (manifest.stopReason.startsWith('budget'))
    at('warning', 'the run ran out of budget before the agent finished', manifest.stopReason)
  if (manifest.stopReason.includes('runner failed')) at('error', 'the agent runner failed', manifest.stopReason)
  const endReason = manifest.driver.kind === 'agent' ? manifest.driver.endReason : undefined
  if (manifest.driver.kind === 'agent' && endReason === undefined)
    at('warning', "the agent runner's end was not recorded", manifest.stopReason)
  if (endReason?.startsWith(ARENA_RUNNER_STILL_RUNNING) === true)
    at('warning', 'the agent runner was still running when the run was folded', endReason)
  if (endReason?.includes('without stopping') === true)
    at('warning', 'the agent ended without stopping the run', endReason)
  if (endReason?.startsWith('the model call failed') === true) at('error', "the agent's model call failed", endReason)
  if (manifest.agentNotes.retrospective.length === 0)
    at('warning', 'the agent wrote no retrospective', manifest.stopReason)
  return found
}

/** A failed request worth reporting: an aborted one is the page cancelling its own fetch on navigation. */
function requestPath(request: string): string {
  const [method, url] = request.split(' ')
  try {
    return `${method ?? ''} ${new URL(url ?? '').pathname}`
  } catch {
    return request
  }
}

function eventOccurrence(event: ArenaEvent): Occurrence | undefined {
  const where = placeOf(event)
  switch (event.kind) {
    case 'page-crash':
      return { severity: 'error', source: 'timeline', message: 'the page crashed', example: where }
    case 'enso-exit':
      return { severity: 'error', source: 'timeline', message: `Enso exited (${event.exit})`, example: where }
    case 'page-error':
      return {
        severity: 'error',
        source: 'timeline',
        message: `uncaught error in the page: ${short(event.text)}`,
        example: where,
      }
    case 'recorder-error':
      return {
        severity: 'error',
        source: 'timeline',
        message: `the recorder failed during ${event.during}`,
        example: `${where} ${short(event.error)}`,
      }
    case 'console-error':
      return { severity: 'warning', source: 'timeline', message: `console error: ${short(event.text)}`, example: where }
    case 'request-failed':
      return event.failure === 'net::ERR_ABORTED'
        ? undefined
        : {
            severity: 'warning',
            source: 'timeline',
            message: `request failed: ${requestPath(event.request)} (${event.failure})`,
            example: where,
          }
    case 'response-error':
      return {
        severity: event.status >= 500 ? 'error' : 'warning',
        source: 'timeline',
        message: `HTTP ${event.status}: ${requestPath(event.request)}`,
        example: where,
      }
    case 'agent-tool-refused':
      return {
        severity: 'warning',
        source: 'agent',
        message: `the agent asked for a tool it was not given: ${event.tool}`,
        example: where,
      }
    case 'action':
      if (event.outcome === 'ok') return undefined
      return event.detail === ARENA_REFUSED_DETAIL
        ? {
            severity: 'warning',
            source: 'agent',
            message: `refused before the page: ${event.action} — ${short(event.error ?? '')}`,
            example: where,
          }
        : {
            severity: 'warning',
            source: 'timeline',
            message: `action failed: ${short(event.detail)}`,
            example: `${where} ${short(event.error ?? '')}`,
          }
    default:
      return undefined
  }
}

function timelineProblems(events: readonly ArenaEvent[]): Occurrence[] {
  return events.flatMap((event) => {
    const occurrence = eventOccurrence(event)
    return occurrence === undefined ? [] : [occurrence]
  })
}

/** The agent's own session: model calls that failed, and how often it had to be nudged to go on. */
function agentProblems(transcript: readonly unknown[] | undefined): Occurrence[] {
  if (transcript === undefined) return []
  const found: Occurrence[] = []
  let userMessages = 0
  for (const message of transcript) {
    if (typeof message !== 'object' || message === null || !('role' in message)) continue
    if (message.role === 'user') userMessages += 1
    if (message.role === 'assistant' && 'stopReason' in message && message.stopReason === 'error') {
      const text =
        'errorMessage' in message && typeof message.errorMessage === 'string' ? message.errorMessage : 'no message'
      found.push({
        severity: 'error',
        source: 'agent',
        message: `a model call failed: ${short(text)}`,
        example: 'agent/transcript.jsonl',
      })
    }
  }
  for (let nudge = 1; nudge < userMessages; nudge += 1) {
    found.push({
      severity: 'warning',
      source: 'agent',
      message: 'the agent ended a turn without stopping and was nudged',
      example: `nudge ${nudge}`,
    })
  }
  return found
}

/** Enso's own log records for the run's threads: an ERROR or FATAL fails the run, a WARN is reported. */
function ensoLogProblems(records: readonly EnsoLogLine[] | undefined): Occurrence[] {
  if (records === undefined) return []
  return records.flatMap((record): Occurrence[] => {
    const severity = LOG_LEVEL_SEVERITY[record.level]
    if (severity === undefined) return []
    return [
      {
        severity,
        source: 'enso-log',
        message: `${record.logger}: ${short(record.message ?? '(no message)')}`,
        example: record['@timestamp'],
      },
    ]
  })
}

/** What each thread's session eval counted that went wrong inside Enso's own session. */
function ensoEvalProblems(evals: ReadonlyMap<string, EnsoSessionEval>): Occurrence[] {
  const found: Occurrence[] = []
  for (const [threadId, sessionEval] of evals) {
    const card = sessionEval.scorecard
    const counted = (severity: ArenaSeverity, message: string, count: number): void => {
      for (let occurrence = 0; occurrence < count; occurrence += 1)
        found.push({ severity, source: 'enso-eval', message, example: `thread ${threadId}` })
    }
    counted('error', "the provider refused Enso's request", card.providerRefusals)
    counted('warning', "a tool call in Enso's session failed", card.signals.toolErrors)
    counted('warning', 'a gate run failed', card.gateFailed)
    counted('warning', 'a guard or rule refused a call in Enso', card.guardRefusals + card.ruleRefusals)
    counted('warning', 'the agent denied a permission prompt', card.operatorDenials)
    counted('warning', 'Enso retried after an error (S3)', card.signals.S3_retryAfterErrorFires)
  }
  return found
}

function evidenceProblems(manifest: ArenaManifest): Occurrence[] {
  return manifest.evidence.flatMap((row): Occurrence[] =>
    row.status === 'missing'
      ? [
          {
            severity: 'warning',
            source: 'evidence',
            message: `not collected: ${row.kind.replace(/ [0-9a-f-]{36}/, '')}`,
            example: short(row.reason),
          },
        ]
      : [],
  )
}

function uiCheckProblems(checks: readonly ArenaUiCheck[]): Occurrence[] {
  return checks.flatMap((check): Occurrence[] =>
    check.status === 'pass'
      ? []
      : [
          {
            severity: 'error',
            source: 'ui',
            message: `UI check ${check.name} is ${check.status}`,
            example: check.detail,
          },
        ],
  )
}

function metricsOf(input: ArenaScoreInput): ArenaScoreMetrics {
  const { manifest, evals } = input
  const minutes =
    manifest.startedAt === undefined || manifest.stoppedAt === undefined
      ? undefined
      : Math.round((Date.parse(manifest.stoppedAt) - Date.parse(manifest.startedAt)) / 6000) / 10
  const enso =
    evals.size === 0
      ? undefined
      : {
          prompts: sumOverEvals(evals, (sessionEval) => sessionEval.scorecard.humanMessages),
          toolCalls: sumOverEvals(evals, (sessionEval) => sessionEval.scorecard.toolCalls),
          toolErrors: sumOverEvals(evals, (sessionEval) => sessionEval.scorecard.signals.toolErrors),
        }
  const notes = manifest.agentNotes
  return {
    ...(minutes === undefined ? {} : { minutes }),
    actions: manifest.actions,
    ...(enso === undefined ? {} : { enso }),
    threads: {
      shown: threadsShown(input.events).size,
      ...(input.projectThreads === undefined ? {} : { stored: input.projectThreads.length }),
    },
    screenshots: manifest.screenshots.length,
    notes: { wish: notes.wish.length, friction: notes.friction.length, retrospective: notes.retrospective.length },
    ...(input.project === undefined ? {} : { work: input.project }),
  }
}

/** The score for a run, from everything it left. Pure: the reading is `readArenaScoreInput`'s. */
export function scoreArenaRun(input: ArenaScoreInput): ArenaScore {
  const uiChecks = uiChecksOf(input)
  const nothingBuilt: Occurrence[] =
    input.project !== undefined && input.project.changedFiles + input.project.commits === 0
      ? [
          {
            severity: 'warning',
            source: 'project',
            message: 'nothing was built: no file in the project or its threads’ trees',
            example: input.project.workspaces.join(', '),
          },
        ]
      : []
  const problems = grouped([
    ...uiCheckProblems(uiChecks),
    ...runProblems(input),
    ...timelineProblems(input.events),
    ...agentProblems(input.transcript),
    ...ensoLogProblems(input.logRecords),
    ...ensoEvalProblems(input.evals),
    ...evidenceProblems(input.manifest),
    ...nothingBuilt,
  ])
  const errors = problems.filter((problem) => problem.severity === 'error').length
  return {
    runId: input.manifest.runId,
    scenario: input.manifest.scenario,
    verdict: errors === 0 ? 'pass' : 'fail',
    errors,
    warnings: problems.length - errors,
    uiUsed: uiChecks.every((check) => check.status === 'pass'),
    uiChecks,
    problems,
    metrics: metricsOf(input),
  }
}

// ── Reading a run directory ────────────────────────────────────────────────────────────────────

function evalsIn(evidenceDirectory: string, files: readonly string[]): Map<string, EnsoSessionEval> {
  const evals = new Map<string, EnsoSessionEval>()
  for (const file of files.filter((fileName) => fileName.startsWith('thread-') && fileName.endsWith('-eval.json'))) {
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(join(evidenceDirectory, file), 'utf8'))
    } catch {
      continue
    }
    const sessionEval = readEnsoSessionEval(parsed)
    if (sessionEval !== undefined) evals.set(sessionEval.threadId, sessionEval)
  }
  return evals
}

/** Every record in the threads' bundles, once: two bundles of one day share records. */
function logRecordsIn(evidenceDirectory: string, files: readonly string[]): EnsoLogLine[] | undefined {
  const bundles = files.filter((fileName) => fileName.startsWith('thread-') && fileName.endsWith('-bundle.md'))
  if (bundles.length === 0) return undefined
  const seen = new Set<string>()
  const records: EnsoLogLine[] = []
  for (const bundle of bundles) {
    const text = bundleRecordsText(readFileSync(join(evidenceDirectory, bundle), 'utf8'))
    for (const line of text.split('\n')) {
      if (line.trim().length === 0 || seen.has(line)) continue
      seen.add(line)
      try {
        records.push(JSON.parse(line) as EnsoLogLine)
      } catch {
        // a torn line is not a record
      }
    }
  }
  return records
}

/** Every file under a directory but `.git`: what a workspace that is not a repository holds. */
function filesUnder(directory: string): number {
  let count = 0
  for (const directoryEntry of readdirSync(directory, { withFileTypes: true })) {
    if (directoryEntry.name === '.git') continue
    count += directoryEntry.isDirectory() ? filesUnder(join(directory, directoryEntry.name)) : 1
  }
  return count
}

/** One workspace's work: git's view when it is a repository, its files when it is not; undefined when it is gone. */
function workspaceWork(directory: string): { readonly changedFiles: number; readonly commits: number } | undefined {
  if (!existsSync(directory)) return undefined
  const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: directory,
    encoding: 'utf8',
  })
  if (status.status !== 0) return { changedFiles: filesUnder(directory), commits: 0 }
  const changedFiles = status.stdout.split('\n').filter((line) => line.trim().length > 0).length
  const count = spawnSync('git', ['rev-list', '--count', 'HEAD'], { cwd: directory, encoding: 'utf8' })
  // No HEAD yet is a repository with no commit: zero, not unknown.
  return { changedFiles, commits: count.status === 0 ? Number(count.stdout.trim()) : 0 }
}

/** The work across the project and the threads' working directories, each counted once. */
function workspaceState(directories: readonly string[]): ArenaWorkspaceState | undefined {
  let changedFiles = 0
  let commits = 0
  const workspaces: string[] = []
  for (const directory of new Set(directories)) {
    const work = workspaceWork(directory)
    if (work === undefined) continue
    changedFiles += work.changedFiles
    commits += work.commits
    workspaces.push(directory)
  }
  return workspaces.length === 0 ? undefined : { changedFiles, commits, workspaces }
}

/** The working directory each collected thread record names (`thread-<id>.json`'s `cwd`). */
function threadDirectories(evidenceDirectory: string, files: readonly string[]): string[] {
  return files
    .filter((fileName) => /^thread-[0-9a-f-]+\.json$/.test(fileName))
    .flatMap((fileName) => {
      try {
        const record: unknown = JSON.parse(readFileSync(join(evidenceDirectory, fileName), 'utf8'))
        return typeof record === 'object' && record !== null && 'cwd' in record && typeof record.cwd === 'string'
          ? [record.cwd]
          : []
      } catch {
        return []
      }
    })
}

/** Everything a run directory holds that the score reads. Throws when there is no manifest to score. */
export function readArenaScoreInput(runDirectory: string): ArenaScoreInput {
  const manifest = JSON.parse(readFileSync(join(runDirectory, 'manifest.json'), 'utf8')) as ArenaManifest
  const transcriptPath = join(runDirectory, 'agent', 'transcript.jsonl')
  const evidenceDirectory = join(runDirectory, 'enso', 'evidence')
  const files = existsSync(evidenceDirectory) ? readdirSync(evidenceDirectory) : []
  const storedPath = join(evidenceDirectory, 'stored-threads.json')
  const stored = existsSync(storedPath)
    ? projectThreads(readFileSync(storedPath, 'utf8'), projectIdOf(realpathOrSelf(manifest.project)))
    : undefined
  const logRecords = logRecordsIn(evidenceDirectory, files)
  const project = workspaceState([manifest.project, ...threadDirectories(evidenceDirectory, files)])
  return {
    manifest,
    events: readTimeline(join(runDirectory, 'timeline.jsonl')),
    ...(existsSync(transcriptPath) ? { transcript: readJsonLines(transcriptPath) } : {}),
    evals: evalsIn(evidenceDirectory, files),
    ...(logRecords === undefined ? {} : { logRecords }),
    ...(stored === undefined ? {} : { projectThreads: stored }),
    ...(project === undefined ? {} : { project }),
  }
}

// ── Saying it ──────────────────────────────────────────────────────────────────────────────────

const STATUS_MARK: Readonly<Record<ArenaCheckStatus, string>> = { pass: '✓', fail: '✗', unknown: '?' }

/** The score as Markdown: verdict, the UI checks, the problems by severity, the metrics. */
export function renderArenaScore(score: ArenaScore): string {
  const lines = [
    `# Arena score — ${score.runId}`,
    '',
    `**${score.verdict.toUpperCase()}** — ${score.errors} error(s), ${score.warnings} warning(s). UI used: ${score.uiUsed ? 'yes' : 'not shown'}.`,
    '',
    '## UI checks',
    '',
    ...score.uiChecks.map((check) => `- ${STATUS_MARK[check.status]} \`${check.name}\` — ${check.detail}`),
    '',
    '## Problems',
    '',
    ...(score.problems.length === 0
      ? ['None.']
      : score.problems.map(
          (problem) =>
            `- **${problem.severity}** (${problem.source}) ${problem.message}${problem.count > 1 ? ` ×${problem.count}` : ''}` +
            (problem.examples.length === 0 ? '' : ` — ${problem.examples.join('; ')}`),
        )),
    '',
    '## Metrics',
    '',
    '```json',
    JSON.stringify(score.metrics, null, 2),
    '```',
    '',
  ]
  return lines.join('\n')
}

/** Score a run directory and write `score.json` and `score.md` beside its manifest. */
export function writeArenaScore(runDirectory: string): ArenaScore {
  const score = scoreArenaRun(readArenaScoreInput(runDirectory))
  writeFileSync(join(runDirectory, 'score.json'), `${JSON.stringify(score, null, 2)}\n`)
  writeFileSync(join(runDirectory, 'score.md'), renderArenaScore(score))
  return score
}
