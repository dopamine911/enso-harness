import { ZEN_REDACTED, ZEN_REDACTED_VALUE, type ZenLogLine } from './log.ts'
import { describeSessionEntry, type ZenThreadInspection } from './session-inspection.ts'

/**
 * The bundle (#132 item 5): ONE plaintext file a user attaches to an issue, built from
 * things that already exist — the day's records, the live threads' inspections, the
 * versions, and what the browser logged — with a manifest of what was redacted so the
 * reader knows what is missing rather than wondering.
 *
 * Pure: strings in, one string out. The server assembles the inputs (`bundle-route.ts`),
 * the drawer appends the browser's ring, `bun run logs --file` reads the result back —
 * the records are a fenced JSONL block, one `ZenLogLine` per line, exactly as on disk, so
 * the reader needs no special case: a bundle IS a log file with prose around it.
 *
 * ⚠ Never auto-uploaded, never written anywhere but where the user asks. It is theirs to
 * open before sending, and the redaction that made it safe happened at write, not here.
 */

/**
 * What the bundle says about the machine and the run — the header a triage reads first.
 * The log levels are NOT here: the first record of every process says which levels it ran
 * at (`log-process.ts`), and that record is in the records section — one home per fact.
 */
export interface ZenBundleAbout {
  /** When the bundle was made, ISO UTC. */
  readonly at: string
  /** The harness checkout's commit and branch, or why that is unknown. */
  readonly zen: string
  readonly pi: string
  readonly bun: string
  readonly os: string
  /** What the records were selected by, in words — the thread, the day, what was left out. */
  readonly selection: string
}

export interface ZenBundleInputs {
  readonly about: ZenBundleAbout
  /** The live threads' inspections — the ones the selection covers. */
  readonly threads: readonly ZenThreadInspection[]
  /** The records, oldest first, already filtered and capped by the caller. */
  readonly lines: readonly ZenLogLine[]
  /** How many records matched before the cap, so the bundle says "last N of M". */
  readonly matched: number
}

/**
 * Field name → how many records carry it redacted. What the reader is NOT seeing.
 *
 * Two passes, counted separately (#139). A field-name redaction is a record shaped right:
 * `tavilyApiKey` was never going to be written. A `values` row is a leak that was CAUGHT —
 * a known secret quoted inside a message, a `reason`, or a `trace` payload — and its count
 * is how many records that happened in, which is a different thing for a reader to know.
 */
export function redactionManifest(lines: readonly ZenLogLine[]): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {}
  for (const line of lines) {
    for (const [fieldName, fieldValue] of Object.entries(line.properties ?? {})) {
      if (fieldValue === ZEN_REDACTED) counts[fieldName] = (counts[fieldName] ?? 0) + 1
    }
    if (JSON.stringify(line).includes(ZEN_REDACTED_VALUE)) counts.values = (counts.values ?? 0) + 1
  }
  return counts
}

const FENCE = '```'
const BUNDLE_HEADING = '# zen-harness log bundle'
const RECORDS_FENCE = new RegExp(`^${FENCE}jsonl\\n([\\s\\S]*?)\\n${FENCE}$`, 'gm')

/** True for the text of a file `buildLogBundle` made — `bun run logs --file` asks before reading it as one. */
export function isLogBundle(text: string): boolean {
  return text.startsWith(BUNDLE_HEADING)
}

/**
 * The records back out of a bundle: every fenced JSONL block, in order — the server's
 * records, then the browser's ring — as one JSONL text the reader prints like a file.
 */
export function bundleRecordsText(bundle: string): string {
  const blocks: string[] = []
  for (const match of bundle.matchAll(RECORDS_FENCE)) {
    const block = match[1]
    if (block !== undefined && block.length > 0) blocks.push(block)
  }
  return blocks.join('\n')
}

/** The records as they are on disk, fenced — what `bun run logs --file` reads out of a bundle. */
function recordsSection(lines: readonly ZenLogLine[], matched: number): string {
  const heading =
    lines.length === matched
      ? `## log — ${lines.length} records`
      : `## log — the last ${lines.length} of ${matched} records`
  return `${heading}\n\n${FENCE}jsonl\n${lines.map((line) => JSON.stringify(line)).join('\n')}\n${FENCE}\n`
}

function threadSection(inspection: ZenThreadInspection): string {
  const rows = [
    `- session: \`${inspection.sessionId}\``,
    `- cwd: \`${inspection.cwd}\``,
    `- session file: ${inspection.sessionFile === null ? 'none yet (no assistant message)' : `\`${inspection.sessionFile}\``}`,
    `- mode: ${inspection.permissionMode.mode ?? '(unknown)'} · available: ${inspection.permissionMode.available.join(', ')}`,
    `- ${inspection.busy ? 'busy' : 'idle'}, run #${inspection.generation}, last activity ${inspection.lastActivityAt}`,
    `- commands: ${inspection.commands.map((command) => `/${command}`).join(' ')}`,
    `- branch (${inspection.entries.length} entries):`,
    ...inspection.entries.map((sessionEntry) => `    - ${describeSessionEntry(sessionEntry)}`),
  ]
  return `### thread ${inspection.threadId}\n\n${rows.join('\n')}\n`
}

/** The browser's own records — appended by the drawer, which is the only place that has them. */
export function browserSection(lines: readonly ZenLogLine[], pageUrl?: string): string {
  // The page's URL names the thread (#142): the line a reader opens to see it live.
  const page = pageUrl === undefined ? '' : `\nPage: ${pageUrl}\n`
  if (lines.length === 0) return `## browser logged\n${page}\nnothing — the page's ring was empty for this selection\n`
  return `## browser logged — ${lines.length} records from the page's ring (every level the page ran at)\n${page}\n${FENCE}jsonl\n${lines
    .map((line) => JSON.stringify(line))
    .join('\n')}\n${FENCE}\n`
}

export function buildLogBundle(inputs: ZenBundleInputs): string {
  const { about } = inputs
  const manifest = redactionManifest(inputs.lines)
  const redacted = Object.entries(manifest).sort(([left], [right]) => left.localeCompare(right))
  const parts = [
    BUNDLE_HEADING,
    '',
    `Made ${about.at}. Attach this file to an issue; open it first — it is yours to read before anyone else does.`,
    'Read it back with `bun run logs --file <this file>`.',
    '',
    '## about',
    '',
    `- zen: \`${about.zen}\``,
    `- pi: \`${about.pi}\``,
    `- bun: \`${about.bun}\``,
    `- os: ${about.os}`,
    `- selection: ${about.selection}`,
    '',
    '## redacted',
    '',
    redacted.length === 0
      ? 'nothing — no record carried a secret-shaped field, and no known secret value appeared in one'
      : `Two passes at write, both before the line reached this file. A **field** row is a property whose NAME is secret-shaped: its value became \`${ZEN_REDACTED}\` and the name stayed, so you can see what is missing. The \`values\` row counts records where a known secret VALUE appeared somewhere it was not named — quoted in a message, in a tool result, in a payload — and became \`${ZEN_REDACTED_VALUE}\` (#139).\n\n${redacted
          .map(([name, count]) => `- \`${name}\` × ${count}`)
          .join('\n')}`,
    '',
    `## threads — ${inputs.threads.length} live`,
    '',
    ...(inputs.threads.length === 0
      ? ['none live at the time of the bundle (the log below still names them)', '']
      : inputs.threads.map(threadSection)),
    recordsSection(inputs.lines, inputs.matched),
  ]
  return parts.join('\n')
}
