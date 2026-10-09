import { type ArenaScore, scoreRunDirectory } from './score.ts'

/**
 * Two arena runs side by side (#556 B6, #611): `bun run arena compare <runA> <runB>`. The scenario is
 * the rerunnable half (#584); this is the other half, which says what changed when the build, the
 * model or the bench did. Each run is scored afresh from its directory, so two runs folded by
 * different versions of the score are still compared by the same rules.
 *
 * ⚠ IT READS, IT DOES NOT WRITE: no `score.json` is rewritten. Comparing is not re-scoring a run on
 * disk; `arena score <run>` is that, on purpose.
 */

/** Both runs' scores read from their directories, compared. */
export function compareRunDirectories(first: string, second: string): string {
  return compareArenaScores(scoreRunDirectory(first), scoreRunDirectory(second))
}

const cell = (value: number | string | undefined): string => (value === undefined ? '—' : String(value))

/** The agent's own calls at its model's listed price; `unpriced` when it lists none, `—` with no calls (#674). */
function agentCostOf(score: ArenaScore): string | undefined {
  const usage = score.metrics.modelUse.agent
  if (usage === undefined) return undefined
  return usage.costUsd === undefined
    ? `unpriced (${usage.calls} calls)`
    : `$${usage.costUsd.toFixed(2)} (${usage.calls} calls)`
}

/** Two scores as Markdown: the outcome, the UI checks, the problems by which run has them, the friction. */
function compareArenaScores(first: ArenaScore, second: ArenaScore): string {
  const row = (label: string, pick: (score: ArenaScore) => number | string | undefined): string =>
    `| ${label} | ${cell(pick(first))} | ${cell(pick(second))} |`
  return [
    `# Arena compare — ${first.runId} vs ${second.runId}`,
    '',
    `| | ${first.runId} | ${second.runId} |`,
    '|---|---|---|',
    // How each run saw the page, and who drove it (#680): a tree run and a visual run find different things.
    row('perception', (score) => score.perception),
    row('agent', (score) => score.agent),
    // What Enso's sessions ran on, and what the agent's own calls cost at its model's listed price (#674).
    row('Enso model', (score) => score.metrics.modelUse.enso.join(', ') || undefined),
    row('agent cost', (score) => agentCostOf(score)),
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

/**
 * A thread's segment of an API path: each run has its own thread ids, so the same problem in two runs
 * names two of them. Matched by its place in the path, not its shape: a thread id
 * need not be a UUID (`isEnsoThreadId`), and the routes are where problems name one.
 */
const THREAD_SEGMENT = /\/api\/threads\/[^/?\s]+/g

/**
 * Each problem once, by which run has it: only the first, only the second, or both. A thread's path
 * segment reads as `<thread>`: a 404 on one thread's `/git` in each run is one problem, not two.
 */
function problemLines(first: ArenaScore, second: ArenaScore): string[] {
  const label = (problem: ArenaScore['problems'][number]): string =>
    `**${problem.severity}** (${problem.source}) ${problem.message.replace(THREAD_SEGMENT, '/api/threads/<thread>')}`
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

/** One agent model in one perception: its runs' scores. */
interface ArenaModelGroup {
  readonly label: string
  readonly scores: readonly ArenaScore[]
}

/** The runs grouped by agent model and perception, in first-seen order. */
function groupsOf(scores: readonly ArenaScore[]): ArenaModelGroup[] {
  const groups = new Map<string, ArenaScore[]>()
  for (const score of scores) {
    const label = `${score.agent ?? 'no agent (manual)'} · ${score.perception}`
    groups.set(label, [...(groups.get(label) ?? []), score])
  }
  return [...groups].map(([label, grouped]) => ({ label, scores: grouped }))
}

/** The mean of the measured figures, to two places; undefined when none was measured. */
function meanOf(figures: readonly (number | undefined)[]): string | undefined {
  const measured = figures.filter((figure) => figure !== undefined)
  if (measured.length === 0) return undefined
  return (measured.reduce((sum, figure) => sum + figure, 0) / measured.length).toFixed(2)
}

/**
 * Runs side by side by model (#674): `bun run arena compare --by-model <run>…`. Each agent model, in
 * each perception, is one column, and says how many runs it has: one run per model cannot tell a
 * model's difference from noise, and the column says so rather than hiding it.
 */
export function compareByModel(runDirectories: readonly string[]): string {
  const groups = groupsOf(runDirectories.map((runDirectory) => scoreRunDirectory(runDirectory)))
  const header = `| | ${groups.map((group) => group.label).join(' | ')} |`
  const rule = `|---|${groups.map(() => '---').join('|')}|`
  const row = (label: string, pick: (group: ArenaModelGroup) => string | undefined): string =>
    `| ${label} | ${groups.map((group) => cell(pick(group))).join(' | ')} |`
  const labelOf = (problem: ArenaScore['problems'][number]): string =>
    `**${problem.severity}** (${problem.source}) ${problem.message.replace(THREAD_SEGMENT, '/api/threads/<thread>')}`
  const problemsOf = (group: ArenaModelGroup): Set<string> =>
    new Set(group.scores.flatMap((score) => score.problems.map(labelOf)))
  const patterns = [
    ...new Set(
      groups.flatMap((group) => group.scores.flatMap((score) => score.friction.map((friction) => friction.pattern))),
    ),
  ]
  return [
    `# Arena compare by model — ${runDirectories.length} run(s)`,
    '',
    header,
    rule,
    row('runs', (group) => String(group.scores.length)),
    row(
      'passed',
      (group) => `${group.scores.filter((score) => score.verdict === 'pass').length} of ${group.scores.length}`,
    ),
    row(
      'Enso models',
      (group) => [...new Set(group.scores.flatMap((score) => score.metrics.modelUse.enso))].join(', ') || undefined,
    ),
    row('mean agent cost ($)', (group) => meanOf(group.scores.map((score) => score.metrics.modelUse.agent?.costUsd))),
    row('mean minutes', (group) => meanOf(group.scores.map((score) => score.metrics.minutes))),
    row('mean actions', (group) => meanOf(group.scores.map((score) => score.metrics.actions.total))),
    row('mean failed actions', (group) => meanOf(group.scores.map((score) => score.metrics.actions.failed))),
    row('mean notes', (group) =>
      meanOf(
        group.scores.map(
          (score) => score.metrics.notes.wish + score.metrics.notes.friction + score.metrics.notes.retrospective,
        ),
      ),
    ),
    '',
    '## Problems by which models have them',
    '',
    ...groups.flatMap((group) => {
      const others = new Set(groups.filter((other) => other !== group).flatMap((other) => [...problemsOf(other)]))
      const only = [...problemsOf(group)].filter((problem) => !others.has(problem))
      return only.length === 0 ? [] : [`Only under ${group.label}:`, ...only.map((problem) => `- ${problem}`), '']
    }),
    '## Observed friction, mean per run',
    '',
    `| pattern | ${groups.map((group) => group.label).join(' | ')} |`,
    rule,
    ...patterns.map((pattern) =>
      row(pattern, (group) =>
        meanOf(
          group.scores.map((score) => score.friction.find((friction) => friction.pattern === pattern)?.count ?? 0),
        ),
      ),
    ),
    '',
  ].join('\n')
}
