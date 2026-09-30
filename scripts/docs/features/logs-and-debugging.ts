import { ENSO_GUARD_DENIAL_ENTRY } from '../../../packages/core/src/guard.ts'
import { LOG_KEEP_DAYS } from '../../../packages/core/src/log-process.ts'
import { ENSO_REDACTED, ENSO_REDACTED_VALUE } from '../../../packages/core/src/log.ts'
import { constantIn, numberIn } from '../source-constants.ts'
import type { FeatureSpec, MarkTarget } from './spec.ts'

const LOGS_CLI = 'scripts/enso-logs.ts'
const USAGE = constantIn(LOGS_CLI, 'USAGE')
if (typeof USAGE !== 'string') throw new Error(`logs-and-debugging: ${LOGS_CLI} USAGE is not a string`)
if (!USAGE.includes('bun run logs bundle'))
  throw new Error(`logs-and-debugging: ${LOGS_CLI} USAGE no longer names \`bun run logs bundle\``)
const DEFAULT_LEVEL = constantIn(LOGS_CLI, 'DEFAULT_LEVEL')
if (typeof DEFAULT_LEVEL !== 'string') throw new Error(`logs-and-debugging: ${LOGS_CLI} DEFAULT_LEVEL is not a string`)

/** The most records a bundle carries (`bundle-route.ts`). */
const BUNDLE_MAX_RECORDS = numberIn('packages/web/src/server/bundle-route.ts', 'BUNDLE_MAX_RECORDS')

/** The flags the command block shows, each as a command line and what it prints. */
const FLAG_LINES: Readonly<Record<string, readonly [command: string, says: string]>> = {
  '--follow': ['bun run logs --follow', 'keep printing as records land'],
  '--thread': ['bun run logs --thread 01a0ea', 'one thread, by id or a prefix of it'],
  '--since': ['bun run logs --since 10m', 'the last ten minutes'],
  '--json': ['bun run logs --json | jq .', 'the raw lines'],
}

/** The flags the sentence under the block names instead. */
const FLAGS_IN_WORDS = ['--level', '--process', '--date', '--file', '--color'] as const

/** The usage's flags, in its order; one the page does not cover, or covers but the usage lacks, fails the build here. */
const USAGE_FLAGS = [...new Set(USAGE.match(/--[a-z-]+/g) ?? [])]
const COVERED: readonly string[] = [...Object.keys(FLAG_LINES), ...FLAGS_IN_WORDS]
const UNCOVERED = USAGE_FLAGS.filter((flag) => !COVERED.includes(flag))
const UNKNOWN = COVERED.filter((flag) => !USAGE_FLAGS.includes(flag))
if (UNCOVERED.length > 0 || UNKNOWN.length > 0)
  throw new Error(
    `logs-and-debugging: the page's flags differ from ${LOGS_CLI} USAGE (not on the page: ${UNCOVERED.join(', ') || 'none'}; not in the usage: ${UNKNOWN.join(', ') || 'none'})`,
  )

/** The command lines, in the usage's flag order between the plain one and the bundle. */
const COMMAND_LINES: readonly (readonly [command: string, says: string])[] = [
  ['bun run logs', `today, ${DEFAULT_LEVEL} and up, every thread`],
  ...USAGE_FLAGS.flatMap((flag) => {
    const line = FLAG_LINES[flag]
    return line === undefined ? [] : [line]
  }),
  ['bun run logs bundle > bundle.md', 'a bundle from the running server'],
]
/** Comments lined up one column past the longest command. */
const COMMENT_COLUMN = Math.max(...COMMAND_LINES.map(([command]) => command.length)) + 1
const COMMAND_BLOCK = [
  '```bash',
  ...COMMAND_LINES.map(([command, says]) => `${command.padEnd(COMMENT_COLUMN)}# ${says}`),
  '```',
].join('\n')

const DRAWER: MarkTarget = { role: 'complementary', name: 'session debug', exact: true }

/** Logs and debugging (#132, #86): the day's log in the browser, and the demo thread's session debug drawer. */
export const LOGS_AND_DEBUGGING: FeatureSpec = {
  id: 'logs-and-debugging',
  title: 'Logs and debugging',
  landingTagline: 'live logs · debug state · bundles',
  shows: [
    "Every Enso process writes one log file per day under `ENSO_HOME/logs`: the server, the web proxy and pi itself. You can read that log in the terminal, watch it in a browser, or see one thread's state from inside the chat. When something goes wrong, a bundle collects the day's records into one file you can attach to an issue.",
  ],
  opens: [
    [
      'In a terminal:',
      '',
      COMMAND_BLOCK,
      '',
      "`--level`, `--process` (`server`, `web` or `pi`) and `--date` narrow it further. `--file` reads a bundle someone sent you as if it were today's log. `--color` keeps the colours when the output goes through a pipe.",
    ].join('\n'),
    [
      'In the browser:',
      '',
      "- {steps} for the day's log, live.",
      "- Add `?debug` to a thread's URL to open the **session debug** drawer beside the chat.",
    ].join('\n'),
  ],
  shots: [
    {
      image: 'debug-log-tail',
      alt: "The day's log in the browser",
      go: async (ui) => {
        await ui.logPage()
      },
      marks: [
        {
          target: { text: 'level', exact: true },
          says: '**{shown}** and the other filters: thread, process, and how far back.',
        },
        { target: { text: /download the day.s bundle/ }, says: '**{shown}**.' },
      ],
    },
    {
      image: 'debug-drawer',
      alt: 'The session debug drawer beside a thread',
      go: async (ui) => {
        await ui.openThread()
        await ui.debugDrawer()
      },
      marks: [
        {
          target: { text: 'session debug', exact: true, within: DRAWER },
          says: "**{shown}**: what the page believes about the thread, what pi's session holds, what the server sent, and its **fork point** (see [Forks and lineage](./lineage.md)).",
        },
        {
          target: { role: 'button', name: 'download log bundle', within: DRAWER },
          says: "**{shown}**: the server's bundle with this page's own log added.",
        },
      ],
    },
  ],
  lookFor: [
    `When the page and pi seem to disagree, open the drawer. **browser believes** is the page's view: the mode, the last run, the cost. **pi's session has** is pi's: where its session file is, its mode, its commands, and the branch entry by entry. In the thread above you can read the refusals as \`custom:${ENSO_GUARD_DENIAL_ENTRY}\` entries, each just before the error result it explains. On a thread with nothing running, this section says there is no live session, and that is the answer to "why is nothing running?".`,
    `A bundle is safe to read before you share it, and you should read it. Secrets are removed when a record is written, not when the bundle is made: a field whose name looks secret is replaced with \`${ENSO_REDACTED}\`, and any known secret value, wherever it appears, with \`${ENSO_REDACTED_VALUE}\`. The bundle's \`## redacted\` section counts both.`,
  ],
  limits: [
    `A bundle covers today's file only, at most the newest ${BUNDLE_MAX_RECORDS} records. A thread that crossed midnight says so in the bundle.`,
    '`bun run logs bundle` needs the server running. Without it, `bun run logs --json` is the file alone.',
    'Nothing is uploaded. The bundle is a file; you decide where it goes.',
    `The log keeps ${LOG_KEEP_DAYS} days.`,
    'pi cannot read the logs itself. They are under `ENSO_HOME`, which the guards keep pi out of.',
  ],
  see: [
    { path: 'docs/seams/logging.md', label: 'Logging seam', why: 'the day file, redaction and the bundle' },
    {
      path: 'docs/seams/observation.md',
      label: 'Observation seam',
      also: { path: 'docs/reference/observations.md', label: 'Observations reference' },
      why: 'every record Enso writes',
    },
    { path: 'docs/reference/routes.md', label: 'HTTP routes', why: '`/api/logs/bundle` and the log tail' },
  ],
}
