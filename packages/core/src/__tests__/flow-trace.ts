import type { LogRecord } from '@logtape/logtape'
import type { LogRecorder } from '@logtape/testing/recorder'

/**
 * A flow's sequence as one test observed it (#482): the diagram on a `docs/flows/` page is this
 * recorder's output, held by `toMatchSnapshot`, never drawn by hand. A behaviour change changes the
 * snapshot in the same diff, where review sees it; `scripts/docs/flow-pages.ts` only wraps it.
 *
 * TWO KINDS OF STEP, and the diagram keeps them apart:
 *   • an ARROW is a message the test sent or a test double received: a request and its answer, a
 *     call the fake runtime took, an event the fake emitted. The test names these through
 *     `send`/`request`/`respond`.
 *   • a NOTE is a record the code under test logged at `debug` or above, over the participant its
 *     category maps to. The server's log spine (#132) is its own account of what it did, so the
 *     notes are read, not written.
 *
 * ⚠ ORDER IS EXACT ONLY BECAUSE EVERYTHING HERE IS IN ONE PROCESS. Log records arrive through a
 * synchronous sink and every arrow is recorded where it happens, so each step first takes the
 * records logged since the last one. A frame read back off an SSE socket would arrive on the
 * network's schedule, which is why follow frames are not steps: the registry logs what it told
 * followers, and that record is the note.
 *
 * Values that differ between runs are masked, so the snapshot holds the flow's shape: a UUID reads
 * `[id]`, a property whose name ends in `Ms` reads `[ms]`. `;` is mermaid's statement separator
 * (`test/mermaid-gate.test.ts`), so it is written `·`; `#` opens an entity, so it is written as
 * the entity for itself (after the `;` pass, which would otherwise split that entity).
 */
export interface FlowTrace {
  /** A message from one participant to another. */
  readonly send: (from: string, to: string, label: string) => void
  /** An answer to an earlier message that is not HTTP (a callback's result, an exit), drawn dashed. */
  readonly reply: (from: string, to: string, label: string) => void
  /** An HTTP request (`POST /path`), its JSON body's keys and short values shown. */
  readonly request: (from: string, to: string, request: string, body?: unknown) => void
  /** An HTTP answer, drawn as a reply (dashed). */
  readonly respond: (from: string, to: string, status: number, body?: unknown) => void
  /** The whole diagram, `sequenceDiagram` first — the value a test snapshots. */
  readonly diagram: () => string
}

export interface FlowTraceOptions {
  /** Participant alias → the label drawn over its column, in column order. */
  readonly participants: Readonly<Record<string, string>>
  /** A log category, dotted (`enso.server.threads`), → the participant its records are notes over. */
  readonly categories: Readonly<Record<string, string>>
  readonly logs: LogRecorder
}

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
const LEVELS_DRAWN = new Set(['debug', 'info', 'warning', 'error', 'fatal'])

function mermaidText(text: string): string {
  return text.replaceAll(';', ' ·').replaceAll('#', '#35;').replaceAll(UUID, '[id]')
}

function shown(key: string, value: unknown): string {
  if (key.endsWith('Ms')) return '[ms]'
  if (typeof value === 'string') return value
  if (value === undefined) return 'undefined'
  return JSON.stringify(value)
}

/** A record's own message template with its properties put back, masked where they vary. */
function noteText(record: LogRecord): string {
  const template = typeof record.rawMessage === 'string' ? record.rawMessage : record.rawMessage.join('{}')
  return template.replaceAll(/\{(\w+)\}/g, (_whole, key: string) => shown(key, record.properties[key]))
}

/** A JSON body as `{key: value, …}`: strings quoted when short, anything long or nested named only. */
function bodyText(body: unknown): string {
  if (body === undefined) return ''
  if (typeof body !== 'object' || body === null) return ` ${JSON.stringify(body)}`
  const fields = Object.entries(body).map(([key, value]) => {
    if (typeof value === 'string') return value.length <= 24 ? `${key}: "${value}"` : key
    if (typeof value === 'number' || typeof value === 'boolean') return `${key}: ${String(value)}`
    return key
  })
  return ` {${fields.join(', ')}}`
}

export function flowTrace(options: FlowTraceOptions): FlowTrace {
  const steps: string[] = []
  let cursor = options.logs.records.length

  function participant(alias: string): string {
    if (!(alias in options.participants)) throw new Error(`flow trace: no participant ${alias}`)
    return alias
  }

  function push(step: string): void {
    // A stream of one kind — text deltas — is one step: the flow's shape, not its length.
    if (steps.at(-1) !== step) steps.push(step)
  }

  /** The records logged since the last step, as notes, before the step that follows them. */
  function takeLogs(): void {
    const records = options.logs.records
    if (records.length < cursor) throw new Error('flow trace: the log recorder was cleared under a trace')
    for (const record of records.slice(cursor)) {
      if (!LEVELS_DRAWN.has(record.level)) continue
      const over = options.categories[record.category.join('.')]
      if (over === undefined) continue
      push(`  Note over ${participant(over)}: ${mermaidText(noteText(record))}`)
    }
    cursor = records.length
  }

  return {
    send: (from, to, label) => {
      takeLogs()
      push(`  ${participant(from)}->>${participant(to)}: ${mermaidText(label)}`)
    },
    reply: (from, to, label) => {
      takeLogs()
      push(`  ${participant(from)}-->>${participant(to)}: ${mermaidText(label)}`)
    },
    request: (from, to, request, body) => {
      takeLogs()
      push(`  ${participant(from)}->>${participant(to)}: ${mermaidText(`${request}${bodyText(body)}`)}`)
    },
    respond: (from, to, status, body) => {
      takeLogs()
      push(`  ${participant(from)}-->>${participant(to)}: ${mermaidText(`${status}${bodyText(body)}`)}`)
    },
    diagram: () => {
      takeLogs()
      const columns = Object.entries(options.participants).map(
        ([alias, label]) => `  participant ${alias} as ${mermaidText(label)}`,
      )
      return ['sequenceDiagram', ...columns, ...steps].join('\n')
    },
  }
}
