import type { Page } from '@playwright/test'
import { LOG_KEEP_DAYS } from '../../../packages/core/src/log-process.ts'
import { constantIn } from '../source-constants.ts'
import type { FeatureSpec, MarkTarget } from './spec.ts'

const PANEL: MarkTarget = { role: 'region', name: 'session eval', exact: true }
const TIMELINE: MarkTarget = { text: 'Timeline', exact: true, within: PANEL }

/** The eval command's usage line: the flags it names are the ones the page shows. */
const USAGE = constantIn('scripts/enso-eval.ts', 'USAGE')
if (typeof USAGE !== 'string') throw new Error('session-eval: scripts/enso-eval.ts USAGE is not a string')

/** The command lines the page shows without a flag: the forms `<thread> [<thread> …]` of the usage. */
const PLAIN_LINES: readonly (readonly [command: string, says: string])[] = [
  ['bun run eval <thread>', 'scorecard, agent-side signals, timeline'],
  ['bun run eval <thread-a> <thread-b>', 'each, then a table comparing them'],
]

/** Each flag the usage names, as a command line and what it prints. */
const FLAG_LINES: Readonly<Record<string, readonly [command: string, says: string]>> = {
  '--json': ['bun run eval <thread> --json', 'the raw payload, for jq'],
  '--row': ['bun run eval <thread> --row', 'one tab-separated row, for sampling over time'],
  '--row-header': ['bun run eval --row-header', "the row's column names"],
}

/** A line per flag the usage names, in its order; a flag the usage adds or drops fails the build here. */
function flagLines(usage: string): (readonly [command: string, says: string])[] {
  const flags = [...new Set(usage.match(/--[a-z-]+/g) ?? [])]
  const extra = Object.keys(FLAG_LINES).filter((flag) => !flags.includes(flag))
  if (extra.length > 0) throw new Error(`session-eval: scripts/enso-eval.ts USAGE has no ${extra.join(', ')}`)
  return flags.map((flag) => {
    const line = FLAG_LINES[flag]
    if (line === undefined) throw new Error(`session-eval: no command line for ${flag} of scripts/enso-eval.ts USAGE`)
    return line
  })
}

/** The command block, its comments lined up one column past the longest command. */
function commandBlock(usage: string): string {
  const lines = [...PLAIN_LINES, ...flagLines(usage)]
  const width = Math.max(...lines.map(([command]) => command.length)) + 1
  return ['```bash', ...lines.map(([command, says]) => `${command.padEnd(width)}# ${says}`), '```'].join('\n')
}

/** A timeline counter on its last line: the running count at the end of the thread. */
const lastCounter = (prefix: 'f' | 'r') => (page: Page) =>
  page
    .getByRole('list', { name: 'eval timeline' })
    .getByRole('listitem')
    .last()
    .getByText(new RegExp(`^${prefix}=\\d+$`))

/** Session eval (#441): the demo thread's scorecard under its stats, then its timeline. */
export const SESSION_EVAL: FeatureSpec = {
  id: 'session-eval',
  title: 'Session eval',
  landingTagline: 'human and agent signals, kept separate',
  shows: [
    "A session eval is a thread's scorecard and timeline, computed only from what the session recorded. It counts what the person running the thread did (messages, corrections, queued prompts, interrupts, answers to questions, denials) and what the agent did (tool calls, writes, refusals, test and build runs and their outcomes). It lists the counts side by side and never combines them into a single score.",
    "It also shows the session's security signals: what the agent did after a refusal, such as trying the same thing again, reaching for an interpreter one-liner, or reading the guard's own policy. Each is marked `!S` on the timeline where it happened, and the **session risk** card gives the level they add up to. Nothing is blocked because of them.",
    'Use it to check a claim about a run ("it never needed correcting") or to compare two runs of the same task, such as the two sides of a [fork](./lineage.md).',
  ],
  opens: [
    "{steps}. Below the stats: the **Session eval** card, then **Agent-side signals**, **Not measured** and the **Timeline**. It reads again whenever the thread's usage changes.",
    [
      'From the command line, with the web app running (`bun run dev`):',
      '',
      commandBlock(USAGE),
      '',
      'A thread id is the `?thread=` value in the page URL. The command reads the same server route as the tab, so the two cannot disagree.',
    ].join('\n'),
  ],
  shots: [
    {
      image: 'session-eval',
      alt: 'The session eval on the Stats tab',
      go: async (ui) => {
        await ui.openThread()
        await ui.tab('Stats')
        await ui.page
          .getByRole('region', { name: 'session eval', exact: true })
          .getByText('Session eval', { exact: true })
          .waitFor()
        await ui.scrollTo({ text: 'Session eval', exact: true, within: PANEL })
      },
      marks: [
        {
          target: { text: 'Session eval', exact: true, within: PANEL },
          says: '**{shown}**: how many events it read, whether the thread is live or read from its file, and a reminder that nothing here is a composite score.',
        },
        {
          target: { text: 'corrections', exact: true, within: PANEL },
          says: "**{shown}**, with the person's other counts beside it: **human messages**, **queued prompts**, **interrupts**, **asks declined**.",
        },
        {
          target: { text: 'refusal channels', exact: true, within: PANEL },
          says: '**{shown}**: who refused, split four ways (guard, rule, operator, provider) and never mixed. A **rule** is the permission engine: a rule you wrote, or `auto`’s classifier.',
        },
        {
          target: { text: 'session risk', exact: true, within: PANEL },
          says: '**{shown}**: the level the security signals add up to, and how many there are. It is evidence, not a verdict, and nothing is blocked because of it.',
        },
      ],
      after: [
        "Below the scorecard, **Agent-side signals** lists the agent's own patterns, one count per kind and unweighted. **Not measured** lists what pi records nothing for, so a missing metric never reads as zero.",
      ],
      measure: {
        refusalChannels: (page) =>
          page
            .getByRole('region', { name: 'session eval', exact: true })
            .getByText(/^guard \d+ · rule \d+ · operator \d+ · provider \d+$/),
      },
    },
    {
      image: 'session-eval-timeline',
      alt: 'The eval timeline',
      go: async (ui) => {
        await ui.openThread()
        await ui.tab('Stats')
        await ui.page.getByRole('list', { name: 'eval timeline' }).waitFor()
        await ui.scrollTo(TIMELINE)
      },
      region: [TIMELINE, { role: 'list', name: 'eval timeline', within: PANEL }],
      marks: [
        {
          target: TIMELINE,
          says: '**{shown}**: one line per event, with a time, a marker, the two running counters, the kind of event and what it was.',
        },
        {
          target: { text: 'f= typed against the run · r= clicked against it', within: PANEL },
          says: 'The counters: `f=` for what the person typed against the run, `r=` for what they clicked against it.',
        },
      ],
      measure: {
        guardFlag: (page) => page.getByRole('list', { name: 'eval timeline' }).getByText('!G', { exact: true }).first(),
        lastFriction: lastCounter('f'),
        lastRefusals: lastCounter('r'),
      },
    },
  ],
  lookFor: [
    'Watch the two counters. `f=` counts friction, what the person *typed* against the run: corrections, queued prompts, confused messages and interrupts. `r=` counts refusals the person *clicked*: declined questions, and **No** on a permission prompt. They are kept apart because they move at different times. The line where either one starts climbing is where the run went wrong.',
    "In the thread above, neither one climbs: the last line still reads `{lastFriction}` and `{lastRefusals}`. The only marked lines are the guard refusals, flagged `{guardFlag}`, and **refusal channels** reads `{refusalChannels}`. The guards refused and the person refused nothing: a run that needed no correcting, with calls stopped by policy. The command line's `refusalsTotal` matches the last line's `{lastRefusals}` for the same reason: it counts only the person's refusals, the `r=` column.",
    'A security signal, marked `!S`, always follows a refusal: the agent retried what was refused, or tried another way to do it. One signal can be innocent (a command retried after fixing a typo). Several in a row, reaching for a different tool or interpreter each time, are the pattern worth reading.',
    'Compare the ratios under **per human message** (replies, tool calls and writes for each message the person sent) between two runs of the same task. A run that needs many more of them to finish is doing more work per instruction, and the timeline shows where.',
  ],
  limits: [
    'It gives no single score. Every number traces back to something in the session, and weighing the numbers is up to you.',
    'It covers the current branch only, as the rest of the Stats tab does.',
    `Queued prompts and interrupts come from the log, which keeps ${LOG_KEEP_DAYS} days. For an older thread they read as \`—\` (unknown), never as \`0\`, and the card says why.`,
    "Corrections and confusion are found with fixed word lists. They miss what the lists don't name, and a message that happens to match one can count by mistake.",
    'The comparison table for several threads is in the command line only. The tab shows one thread at a time.',
    'The security signals and their levels are uncalibrated: the counts behind `medium`, `high` and `incident` are first guesses, to be tuned against real sessions. A signal reads what a command says, not what it does, so a disguised command that the guards and the permission engine never refused raises none.',
  ],
  see: [
    {
      path: 'docs/glossary.md',
      label: 'Glossary',
      why: '*session eval*, *friction*, *refusal channel*, *operator denial*, *session risk* and *security signal*',
    },
    { path: 'docs/reference/routes.md', label: 'HTTP routes', why: '`GET /api/threads/:threadId/eval`' },
    { path: 'docs/features/stats.md', label: 'Stats', why: 'what the same thread cost' },
    {
      path: 'docs/features/lineage.md',
      label: 'Forks and lineage',
      why: 'making two runs comparable in the first place',
    },
  ],
}
