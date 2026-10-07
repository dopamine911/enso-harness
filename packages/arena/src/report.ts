import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { type ArenaCheckedGap, type ArenaFindings, findingsPath, readFindings } from './findings.ts'
import type { ArenaManifest, ArenaNote, ArenaShotIndexEntry } from './manifest.ts'
import { type ArenaOutcomeOptions, type ArenaTestRun, type ArenaWorkOutcome, workOutcomes } from './outcome.ts'
import type { ArenaTurnPlace } from './run-state.ts'
import { type ArenaScore, readArenaScoreInput, runWorkspaces, scoreArenaRun } from './score.ts'
import { type ArenaEvent, isTheApplication } from './timeline.ts'

/**
 * A run's report (#556 deliverables, #584 B4 and B5, #624): `bun run arena report <run>` writes
 * `report.md` and `report.json` beside the manifest.
 *
 * ⚠ TWO PARTS THAT NEVER MIX (#556: "report app completion separately from Enso usability"). The
 * application outcome is what the work holds (`outcome.ts`). Enso's findings are three kinds kept
 * apart: friction the timeline shows, the agent's own account, and the gaps the reviewer verified
 * (`findings.ts`). A wish is never promoted to a finding here; only the reviewer does that, with
 * evidence the report checks.
 *
 * Each friction moment and each note is placed where a reader can see it: the screenshot nearest
 * that second, and the turn of its thread the screenshot shows (#608).
 */

/** Where a moment of the run can be seen. */
export interface ArenaMoment {
  readonly second: number
  /** Relative to the run directory. */
  readonly screenshot?: string
  readonly turn?: ArenaTurnPlace
}

export interface ArenaReportedNote {
  readonly kind: 'wish' | 'friction' | 'retrospective'
  readonly trying: string
  readonly happened: string
  readonly wanted?: string
  readonly moment: ArenaMoment
}

export interface ArenaReport {
  readonly runId: string
  readonly scenario: string
  readonly verdict: ArenaScore['verdict']
  readonly minutes?: number
  readonly outcome: readonly ArenaWorkOutcome[]
  readonly testsRun: boolean
  readonly friction: readonly {
    readonly pattern: string
    readonly summary: string
    readonly moments: readonly ArenaMoment[]
  }[]
  readonly problems: ArenaScore['problems']
  readonly notes: readonly ArenaReportedNote[]
  readonly findings: ArenaFindings
  /** What the agent found by using the application itself (#675); absent when it never did. */
  readonly played?: ArenaPlayed
}

/**
 * The agent's time on the built application's own page (#675): Preview's, or the dev server's
 * (`isTheApplication`). What playing found belongs to the application outcome, apart from Enso.
 */
export interface ArenaPlayed {
  /** Its moves on the application's page, and the span they took. */
  readonly moves: number
  readonly from: ArenaMoment
  readonly to: ArenaMoment
  /** What the page itself logged (the score's `application` problems). */
  readonly problems: ArenaScore['problems']
  /** The notes it wrote while the application's page was in front. */
  readonly notes: readonly ArenaReportedNote[]
}

/** The agent's time on the application's page, from the timeline; undefined when it never acted there. */
function playedIn(
  events: readonly ArenaEvent[],
  problems: ArenaScore['problems'],
  momentAt: (elapsedMs: number) => ArenaMoment,
): ArenaPlayed | undefined {
  // Whoever drove (an agent, or a person over `arena act`): what playing found is the run's either way.
  const moves = events.filter(
    (event) => event.kind === 'action' && event.outcome === 'ok' && isTheApplication(event.page?.url),
  )
  const first = moves.at(0)
  const last = moves.at(-1)
  if (first === undefined || last === undefined) return undefined
  return {
    moves: moves.length,
    from: momentAt(first.elapsedMs),
    to: momentAt(last.elapsedMs),
    problems: problems.filter((problem) => problem.source === 'application'),
    notes: events.flatMap((event) =>
      event.kind === 'note' && isTheApplication(event.page?.url)
        ? [reportedNote(event.note, event, momentAt(event.elapsedMs))]
        : [],
    ),
  }
}

export function buildArenaReport(runDirectory: string, options: ArenaOutcomeOptions): ArenaReport {
  const input = readArenaScoreInput(runDirectory)
  const { manifest } = input
  const score = scoreArenaRun(input)
  const momentAt = (elapsedMs: number): ArenaMoment => momentOf(runDirectory, manifest.screenshots, elapsedMs)
  const played = playedIn(input.events, score.problems, momentAt)
  return {
    runId: score.runId,
    scenario: score.scenario,
    verdict: score.verdict,
    ...(score.metrics.minutes === undefined ? {} : { minutes: score.metrics.minutes }),
    outcome: workOutcomes(runDirectory, runWorkspaces(runDirectory, manifest), options),
    testsRun: options.runTests,
    friction: score.friction.map((found) => ({
      pattern: found.pattern,
      summary: found.summary,
      moments: found.at.map((second) => momentAt(second * 1000)),
    })),
    problems: score.problems,
    notes: (['wish', 'friction', 'retrospective'] as const).flatMap((kind) =>
      manifest.agentNotes[kind].map((note) => reportedNote(kind, note, momentAt(note.elapsedMs))),
    ),
    findings: readRunFindings(runDirectory, manifest),
    ...(played === undefined ? {} : { played }),
  }
}

/**
 * The run's findings, each citation checked against the run (#624): what the report shows, and
 * what `arena publish` (#677) refuses to publish while any is unresolved.
 */
export function readRunFindings(runDirectory: string, manifest: ArenaManifest): ArenaFindings {
  const findingsFile = findingsPath(runDirectory)
  return readFindings(existsSync(findingsFile) ? readFileSync(findingsFile, 'utf8') : undefined, {
    runDirectory,
    runMs: runLength(manifest),
    threadIds: threadIdsOf(manifest),
  })
}

function reportedNote(kind: ArenaReportedNote['kind'], note: ArenaNote, moment: ArenaMoment): ArenaReportedNote {
  return {
    kind,
    trying: note.trying,
    happened: note.happened,
    ...(note.wanted === undefined ? {} : { wanted: note.wanted }),
    moment,
  }
}

/** The playing part of the application outcome (#675): what the agent found on the application's own page. */
function playedLines(played: ArenaPlayed | undefined): string[] {
  if (played === undefined) {
    return [
      '### What playing found',
      '',
      'The agent never acted on the application’s own page: nothing here was found by using it.',
      '',
    ]
  }
  return [
    '### What playing found',
    '',
    `The agent made ${played.moves} move(s) on the application’s own page (Preview, or the page the work served), ` +
      `from ${momentLine(played.from)} to ${momentLine(played.to)}.`,
    '',
    ...(played.problems.length === 0
      ? ['The page logged no error while it was used.']
      : [
          'What the page itself logged:',
          ...played.problems.map(
            (problem) =>
              `- ${problem.message}${problem.count > 1 ? ` ×${problem.count}` : ''} (${problem.examples[0] ?? ''})`,
          ),
        ]),
    '',
    ...(played.notes.length === 0
      ? ['It wrote no note while the application was in front.']
      : ['What it noted while the application was in front:', ...played.notes.map(noteLine)]),
    '',
  ]
}

/** The screenshot nearest a moment, and the turn it shows — the report's, and a published finding's (#677). */
export function momentOf(runDirectory: string, shots: readonly ArenaShotIndexEntry[], elapsedMs: number): ArenaMoment {
  const nearest = shots.reduce<ArenaShotIndexEntry | undefined>(
    (best, shot) =>
      best === undefined || Math.abs(shot.elapsedMs - elapsedMs) < Math.abs(best.elapsedMs - elapsedMs) ? shot : best,
    undefined,
  )
  return {
    second: Math.round(elapsedMs / 1000),
    ...(nearest === undefined ? {} : { screenshot: relative(runDirectory, nearest.path) }),
    ...(nearest?.turn === undefined ? {} : { turn: nearest.turn }),
  }
}

function runLength(manifest: ArenaManifest): number {
  if (manifest.startedAt !== undefined && manifest.stoppedAt !== undefined) {
    return Date.parse(manifest.stoppedAt) - Date.parse(manifest.startedAt)
  }
  return Math.max(0, ...manifest.screenshots.map((shot) => shot.elapsedMs))
}

/** The threads the run was in: the ones the UI showed, and the ones whose record the stop collected. */
function threadIdsOf(manifest: ArenaManifest): Set<string> {
  const collected = manifest.evidence.flatMap((row) => {
    const named = /^thread (\S+)$/.exec(row.kind)
    return named?.[1] !== undefined && row.status === 'collected' ? [named[1]] : []
  })
  return new Set([...manifest.threads.map((thread) => thread.threadId), ...collected])
}

/** Build the report and write `report.json` and `report.md` beside the manifest. */
export function writeArenaReport(runDirectory: string, options: ArenaOutcomeOptions): ArenaReport {
  const report = buildArenaReport(runDirectory, options)
  writeFileSync(join(runDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  writeFileSync(join(runDirectory, 'report.md'), renderArenaReport(report))
  return report
}

// ── Saying it ──────────────────────────────────────────────────────────────────────────────────

export function renderArenaReport(report: ArenaReport): string {
  return [
    `# Arena report — ${report.runId}`,
    '',
    `${report.scenario} · ${report.verdict.toUpperCase()}${report.minutes === undefined ? '' : ` · ${report.minutes} minutes`}. ` +
      'The application outcome and Enso’s findings are reported apart (#556).',
    '',
    '## Application outcome',
    '',
    ...(report.outcome.length === 0
      ? ['No workspace of the run is left to read.', '']
      : report.outcome.flatMap((work) => workLines(work, report.testsRun))),
    ...playedLines(report.played),
    '## Enso findings',
    '',
    '### Observed friction',
    '',
    'Read off the timeline, whatever the agent said; never part of the verdict.',
    '',
    ...(report.friction.length === 0
      ? ['None past its threshold.']
      : report.friction.flatMap((found) => [
          `- **${found.pattern}** — ${found.summary}`,
          ...found.moments.map((moment) => `  - ${momentLine(moment)}`),
        ])),
    '',
    ...(report.problems.length === 0
      ? ['The score found no problems.']
      : [
          'Problems the score found:',
          ...report.problems.map(
            (problem) =>
              `- **${problem.severity}** (${problem.source}) ${problem.message}${problem.count > 1 ? ` ×${problem.count}` : ''}`,
          ),
        ]),
    '',
    '### The agent’s account',
    '',
    'Its notes as it wrote them: observations, not requirements, and not verified here.',
    '',
    ...(report.notes.length === 0 ? ['No notes.'] : report.notes.map(noteLine)),
    '',
    '### Verified gaps',
    '',
    ...findingsLines(report.findings),
  ].join('\n')
}

const kilobytes = (bytes: number): string => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`)

function workLines(work: ArenaWorkOutcome, testsRun: boolean): string[] {
  const git =
    work.git.kind === 'none'
      ? 'not a git repository of its own'
      : `${work.git.commits.length} commit(s), ${work.git.uncommitted} file(s) uncommitted`
  return [
    `### \`${work.path}\``,
    '',
    `${work.fileCount} file(s), ${kilobytes(work.bytes)}; ${git}.`,
    ...(work.files.length === 0
      ? []
      : ['', ...work.files.map((file) => `- \`${file.path}\` (${kilobytes(file.bytes)})`)]),
    ...(work.git.kind === 'repository' && work.git.commits.length > 0
      ? [
          '',
          'Commits, newest first:',
          ...work.git.commits.slice(0, 10).map((commit) => `- \`${commit.hash}\` ${commit.subject}`),
        ]
      : []),
    '',
    ...testLines(work, testsRun),
    '',
  ]
}

function testLines(work: ArenaWorkOutcome, testsRun: boolean): string[] {
  if (work.tests.length === 0 && work.testScript === undefined) return ['No test files.']
  const lines = [`Tests: ${work.tests.map((test) => `\`${test.path}\``).join(', ') || 'the package’s test script'}.`]
  if (!testsRun) return [...lines, 'Not run: `bun run arena report <run> --run-tests` runs them.']
  const runs = [
    ...(work.testScript === undefined ? [] : [work.testScript]),
    ...work.tests.flatMap((test) => (test.run === undefined ? [] : [test.run])),
  ]
  return [
    ...lines,
    ...work.tests.flatMap((test) => (test.notRun === undefined ? [] : [`- \`${test.path}\` not run: ${test.notRun}.`])),
    ...runs.flatMap(testRunLines),
  ]
}

function testEnding(exit: ArenaTestRun['exit']): string {
  if (exit === 'timeout') return 'ran past its time limit'
  return exit === 0 ? 'passed (exit 0)' : `failed (exit ${exit})`
}

function testRunLines(run: ArenaTestRun): string[] {
  return ['', `\`${run.command}\` ${testEnding(run.exit)}:`, '', '```', run.tail, '```']
}

function momentLine(moment: ArenaMoment): string {
  const shot = moment.screenshot === undefined ? 'no screenshot' : `[screenshot](${moment.screenshot})`
  const turn = moment.turn === undefined ? '' : ` · turn \`${moment.turn.turnId}\`, at \`${moment.turn.messageId}\``
  return `${moment.second}s — ${shot}${turn}`
}

function noteLine(note: ArenaReportedNote): string {
  const wanted = note.wanted === undefined ? '' : ` **Wanted:** ${note.wanted}`
  return `- **${note.kind}** (${momentLine(note.moment)}) **Trying:** ${note.trying} **Happened:** ${note.happened}${wanted}`
}

function findingsLines(findings: ArenaFindings): string[] {
  if (findings.status === 'absent') {
    return ['No `findings.json`: the review has not recorded its gaps (`bun run arena brief --review --run <run>`).']
  }
  if (findings.status === 'invalid') return [`\`findings.json\` could not be read: ${findings.reason}.`]
  if (findings.gaps.length === 0) return ['The review recorded no gaps.']
  return findings.gaps.flatMap(gapLines)
}

function gapLines(gap: ArenaCheckedGap): string[] {
  const standing = gap.verified ? '✓ evidence resolves' : `⚠ unverified — ${gap.unresolved.join('; ')}`
  const issue = gap.issue ?? (gap.unmapped ? '⚠ not mapped to an issue' : 'no issue')
  const optional = (label: string, value: string | undefined): string[] =>
    value === undefined ? [] : [`  - ${label}: ${value}`]
  return [
    `- **${gap.title}** — ${gap.classification} — ${issue} — ${standing}`,
    `  - Reproduction: ${gap.reproduction}`,
    `  - Impact: ${gap.impact}`,
    `  - Observed: ${gap.observed}`,
    ...optional('Inferred', gap.inferred),
    ...optional('Workaround', gap.workaround),
    `  - Evidence: ${gap.evidence.map(citationText).join('; ') || 'none'}`,
    '',
  ]
}

function citationText(citation: {
  readonly elapsedMs?: number
  readonly screenshot?: string
  readonly threadId?: string
}): string {
  return [
    ...(citation.elapsedMs === undefined ? [] : [`${Math.round(citation.elapsedMs / 1000)}s`]),
    ...(citation.screenshot === undefined ? [] : [`[${citation.screenshot}](${citation.screenshot})`]),
    ...(citation.threadId === undefined ? [] : [`thread \`${citation.threadId}\``]),
  ].join(', ')
}
