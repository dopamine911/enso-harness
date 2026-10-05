import { type ArenaScore, readArenaScoreInput, scoreArenaRun } from './score.ts'

/**
 * Two arena runs side by side (#556 B6, #611): `bun run arena compare <runA> <runB>`. The scenario is
 * the rerunnable half (#584); this is the other half, which says what changed when the build, the
 * model or the bench did. Each run is scored afresh from its directory, so two runs folded by
 * different versions of the score are still compared by the same rules.
 *
 * ⚠ IT READS, IT DOES NOT WRITE: no `score.json` is rewritten. Comparing is not re-scoring a run on
 * disk; `arena score <run>` is that, on purpose.
 */

/** Score a run directory the way `arena score` does, without writing the score beside it. */
function scoreRunDirectory(runDirectory: string): ArenaScore {
  return scoreArenaRun(readArenaScoreInput(runDirectory))
}

/** Both runs' scores read from their directories, compared. */
export function compareRunDirectories(first: string, second: string): string {
  return compareArenaScores(scoreRunDirectory(first), scoreRunDirectory(second))
}

const cell = (value: number | string | undefined): string => (value === undefined ? '—' : String(value))

/** Two scores as Markdown: the outcome, the UI checks, the problems by which run has them, the friction. */
function compareArenaScores(first: ArenaScore, second: ArenaScore): string {
  const row = (label: string, pick: (score: ArenaScore) => number | string | undefined): string =>
    `| ${label} | ${cell(pick(first))} | ${cell(pick(second))} |`
  return [
    `# Arena compare — ${first.runId} vs ${second.runId}`,
    '',
    `| | ${first.runId} | ${second.runId} |`,
    '|---|---|---|',
    row('verdict', (score) => score.verdict.toUpperCase()),
    row('errors / warnings', (score) => `${score.errors} / ${score.warnings}`),
    row('UI used', (score) => (score.uiUsed ? 'yes' : 'not shown')),
    row('minutes', (score) => score.metrics.minutes),
    row('actions (failed)', (score) => `${score.metrics.actions.total} (${score.metrics.actions.failed})`),
    row('Enso prompts', (score) => score.metrics.enso?.prompts),
    row('Enso tool calls', (score) => score.metrics.enso?.toolCalls),
    row('files changed / commits', (score) =>
      score.metrics.work === undefined
        ? undefined
        : `${score.metrics.work.changedFiles} / ${score.metrics.work.commits}`,
    ),
    row('notes: wish / friction / retrospective', (score) => {
      const notes = score.metrics.notes
      return `${notes.wish} / ${notes.friction} / ${notes.retrospective}`
    }),
    '',
    '## UI checks',
    '',
    `| check | ${first.runId} | ${second.runId} |`,
    '|---|---|---|',
    ...namesOf(first.uiChecks, second.uiChecks).map(
      (checkName) =>
        `| \`${checkName}\` | ${cell(first.uiChecks.find((check) => check.name === checkName)?.status)} | ${cell(second.uiChecks.find((check) => check.name === checkName)?.status)} |`,
    ),
    '',
    '## Problems',
    '',
    ...problemLines(first, second),
    '',
    '## Observed friction',
    '',
    `| pattern | ${first.runId} | ${second.runId} |`,
    '|---|---|---|',
    ...namesOf(
      first.friction.map((friction) => ({ name: friction.pattern })),
      second.friction.map((friction) => ({ name: friction.pattern })),
    ).map(
      (pattern) =>
        `| ${pattern} | ${cell(first.friction.find((friction) => friction.pattern === pattern)?.count)} | ${cell(second.friction.find((friction) => friction.pattern === pattern)?.count)} |`,
    ),
    '',
  ].join('\n')
}

/** Names in first-seen order across both lists, each once. */
function namesOf(first: readonly { readonly name: string }[], second: readonly { readonly name: string }[]): string[] {
  return [...new Set([...first, ...second].map((named) => named.name))]
}

/** A thread id: each run has its own, so the same problem in two runs names two of them. */
const THREAD_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g

/**
 * Each problem once, by which run has it: only the first, only the second, or both. Thread ids read as
 * `<thread>`: a 404 on one thread's `/git` in each run is one problem the two runs share, not two.
 */
function problemLines(first: ArenaScore, second: ArenaScore): string[] {
  const label = (problem: ArenaScore['problems'][number]): string =>
    `**${problem.severity}** (${problem.source}) ${problem.message.replace(THREAD_ID, '<thread>')}`
  const firstLabels = new Set(first.problems.map(label))
  const secondLabels = new Set(second.problems.map(label))
  const section = (title: string, labels: readonly string[]): string[] =>
    labels.length === 0 ? [] : [`${title}:`, ...labels.map((problemLabel) => `- ${problemLabel}`), '']
  const lines = [
    ...section(
      `Only in ${first.runId}`,
      [...firstLabels].filter((problemLabel) => !secondLabels.has(problemLabel)),
    ),
    ...section(
      `Only in ${second.runId}`,
      [...secondLabels].filter((problemLabel) => !firstLabels.has(problemLabel)),
    ),
    ...section(
      'In both',
      [...firstLabels].filter((problemLabel) => secondLabels.has(problemLabel)),
    ),
  ]
  return lines.length === 0 ? ['None in either run.'] : lines
}
