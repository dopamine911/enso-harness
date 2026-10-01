/**
 * A process's sink (#132 item 2): ONE log for the harness — `.enso/logs/enso-YYYY-MM-DD.jsonl`,
 * every process appending to the same day's file, every record redacted by field name
 * before it is written, and — for a terminal — a pretty console sink beside it at its own
 * level.
 *
 * And THE KNOB: `ENSO_LOG_LEVEL` picks the tier the file holds, per subsystem if wanted;
 * `ENSO_LOG_CONSOLE` the terminal's.
 *
 * Called by a LAUNCHER (`dev.ts`, `dev-web.ts`, the harness extension when pi is a child),
 * never by `startEnsoServer`: a library configures nothing, so a test that starts the server
 * sees no output it did not ask for, and a test that wants the records installs
 * `@logtape/testing`'s recorder in its own `configure`.
 *
 * ⚠ Imported as `@enso/core/log-process`, NEVER from the barrel. `@logtape/file` builds its
 * sinks at module evaluation (`createFileSinks()` on `node:fs`), so it is not tree-shaken
 * the way `paths.ts`'s unused `node:fs` is — exported from `index.ts` it took the page down
 * (`ReferenceError: import_node_fs4 is not defined`, the slice-2 receipt). The barrel stays
 * browser-safe; this module is for processes with a filesystem.
 *
 * ⚠ One file, several processes — so the file is named by DATE, never rotated by size. The
 * sink opens with `O_APPEND` and (below) writes each record in one `writeSync`, which is
 * safe for any number of writers: every line lands whole at the end (measured: two
 * processes, 400 records each, 800 lines, none torn). A size-rotated file is not: rotation
 * RENAMES the file under the other process, whose descriptor then points at the rotated
 * copy and keeps writing there. Date-named files are never renamed; each process computes
 * the same name for the same day. `process` is on every record so the writer is still
 * known, and `sequence` — a per-process count — orders two of one process's records inside
 * one millisecond. Old days are deleted by age.
 *
 * ⚠ Blocking and UNBUFFERED, on purpose — measured, not assumed (the first live receipt).
 * LogTape's blocking file sink has no flush timer: `flushInterval` belongs to the
 * non-blocking sink alone, and the buffered blocking sink flushes only when the NEXT record
 * arrives or on dispose. A record over 200 bytes — every one of ours with properties — sat
 * in the buffer until something else was logged; the web launcher's file stayed empty for
 * minutes after its banner. For a debugging log that is the wrong property exactly when it
 * matters: the last record before a hang is the one you need, and it would be the one not
 * on disk. So `bufferSize: 0` — each record is one `writeSync` + `flushSync` when the call
 * returns. Our volume is tens of records per run at `info`, hundreds at `trace`; the
 * syscall pair is the price of the file being the record.
 *
 * Why not `nonBlocking`: its failures are reported on the meta logger too (2.3.4, contrary
 * to its doc), but a background flush can lose the tail on a crash, and a synchronous
 * `writeSync` that throws is caught by LogTape and reported on `["logtape", "meta"]` at
 * `fatal`, bypassing the sink that failed — routed to the console here, so a full disk is
 * seen, not silent.
 *
 * @module
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { closeSync, fchmodSync, fstatSync, mkdirSync, openSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { getTimeRotatingFileSink } from '@logtape/file'
import {
  compareLogLevel,
  configure,
  dispose,
  getConfig,
  getConsoleSink,
  getJsonLinesFormatter,
  getLogger,
  isLogLevel,
  type LogLevel,
  type LogRecord,
  type Sink,
  withFilter,
} from '@logtape/logtape'
import { getPrettyFormatter } from '@logtape/pretty'
import { redactByField } from '@logtape/redaction'
import { Check } from 'typebox/value'
import { ENSO_LOG_EVENTS } from './log-stats.ts'
import { type EnsoLogFilter, LOG_TAIL_MAX_RECORDS, logLineMatches, logLineMessageParts } from './log-tail.ts'
import {
  ENSO_LOG_ROOT,
  ENSO_REDACT_FIELDS,
  ENSO_REDACTED,
  ENSO_REDACTED_VALUE,
  type EnsoLogger,
  type EnsoLogLayer,
  EnsoLogLine,
  ensoLogger,
} from './log.ts'
import {
  ensoAgentDir,
  ensoHome,
  ensoLogsDir,
  ensoProjectsDir,
  migrateCheckoutEnsoOnLaunch,
  migrateSessionsIntoProjects,
} from './paths.ts'
import {
  type EnsoProcessMarker,
  reconcileProcessMarkers,
  removeProcessMarker,
  writeProcessMarker,
} from './process-marker.ts'
import { knownSecretValuesTracking } from './secrets.ts'

/**
 * A per-category override: `enso.host.events=trace` turns one subtree up without the rest.
 *
 * @group Logging
 */
export interface EnsoLogOverride {
  readonly category: readonly string[]
  readonly level: LogLevel
}

/** @group Logging */
export interface EnsoLogLevels {
  /** The file's lowest level for everything under `enso` not named by an override. */
  readonly file: LogLevel
  /** The terminal's; undefined for no console sink. Global — overrides are for the file. */
  readonly console: LogLevel | undefined
  readonly overrides: readonly EnsoLogOverride[]
}

/**
 * The tier every process starts in: the spine, and what went wrong.
 *
 * @group Logging
 */
export const DEFAULT_FILE_LEVEL: LogLevel = 'info'

/**
 * A knob value that is not a level. Thrown at startup, naming the value — never a silent default.
 *
 * @group Logging
 */
export class EnsoLogLevelError extends Error {
  constructor(variable: string, value: string) {
    super(
      `${variable}=${JSON.stringify(value)} is not a log level. Use one of trace, debug, info, warning, error, fatal; ` +
        `per-category overrides as \`info,enso.host.events=trace\`.`,
    )
    this.name = 'EnsoLogLevelError'
  }
}

/**
 * A variable from before the rename, still set. Thrown at startup, naming every one of them.
 *
 * ⚠ A RENAMED KNOB THAT NOBODY READS IS SILENT, AND SILENCE IS THE WORST OUTCOME HERE. Every
 * `ZEN_*` variable became `ENSO_*`; a shell profile or a CI job still exporting the old spelling
 * would simply get the default — a session logging at `info` when its author asked for `trace`,
 * and nothing anywhere saying why. So a stale variable is a REFUSAL, not a shrug.
 *
 * Thrown from `parseEnsoLogLevels`, which every process that configures logging calls with its
 * own environment — the launchers, the server, the pi extension — so there is one check and no
 * process that skips it.
 *
 * @group Logging
 */
export class RetiredEnvironmentError extends Error {
  constructor(names: readonly string[]) {
    super(
      `${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} from before the Enso rename and nothing reads ` +
        `${names.length === 1 ? 'it' : 'them'}. Rename to ${names.map((name) => name.replace(/^ZEN_/, 'ENSO_')).join(', ')}.`,
    )
    this.name = 'RetiredEnvironmentError'
  }
}

/**
 * Every `ZEN_*` name the given environment still carries, in the order a reader would fix them.
 *
 * @group Logging
 */
export function retiredEnvironmentNames(environment: Readonly<Record<string, string | undefined>>): string[] {
  return Object.keys(environment)
    .filter((name) => name.startsWith('ZEN_') && environment[name] !== undefined)
    .sort()
}

/**
 * The knobs, from the environment a launcher was started with:
 *   ENSO_LOG_LEVEL="info"                              — the file's tier (default `info`)
 *   ENSO_LOG_LEVEL="info,enso.host.events=trace"        — plus one subtree turned up
 *   ENSO_LOG_CONSOLE="warning"                          — the terminal's (the launcher's default otherwise)
 * `warn` is accepted for `warning`, since that is what `EnsoLogger` calls it.
 *
 * @group Logging
 */
export function parseEnsoLogLevels(
  environment: Readonly<Record<string, string | undefined>>,
  defaults: { readonly console: LogLevel | undefined },
): EnsoLogLevels {
  const retired = retiredEnvironmentNames(environment)
  if (retired.length > 0) throw new RetiredEnvironmentError(retired)
  let file: LogLevel = DEFAULT_FILE_LEVEL
  const overrides: EnsoLogOverride[] = []
  const levelValue = environment.ENSO_LOG_LEVEL
  if (levelValue !== undefined && levelValue.trim().length > 0) {
    for (const token of levelValue.split(',')) {
      const part = token.trim()
      if (part.length === 0) continue
      const separator = part.indexOf('=')
      if (separator === -1) {
        file = levelOf('ENSO_LOG_LEVEL', part)
        continue
      }
      const category = part.slice(0, separator).trim().split('.')
      if (category[0] !== ENSO_LOG_ROOT || category.some((segment) => segment.length === 0)) {
        throw new EnsoLogLevelError('ENSO_LOG_LEVEL', part)
      }
      overrides.push({ category, level: levelOf('ENSO_LOG_LEVEL', part.slice(separator + 1)) })
    }
  }
  const consoleValue = environment.ENSO_LOG_CONSOLE
  const console =
    consoleValue === undefined || consoleValue.trim().length === 0
      ? defaults.console
      : levelOf('ENSO_LOG_CONSOLE', consoleValue)
  return { file, console, overrides }
}

function levelOf(variable: string, raw: string): LogLevel {
  const value = raw.trim().toLowerCase()
  const level = value === 'warn' ? 'warning' : value
  if (!isLogLevel(level)) throw new EnsoLogLevelError(variable, raw)
  return level
}

/**
 * The level a record's category must reach to be written: the longest override prefix that
 * matches, else the file's level.
 *
 * `["enso","host","events"]` is matched by an override on `enso.host.events`, then `enso.host`,
 * then `enso`.
 *
 * @group Logging
 */
export function effectiveFileLevel(levels: EnsoLogLevels, category: readonly string[]): LogLevel {
  let best: EnsoLogOverride | undefined
  for (const override of levels.overrides) {
    if (override.category.length > category.length) continue
    if (best !== undefined && override.category.length <= best.category.length) continue
    if (override.category.every((segment, index) => category[index] === segment)) best = override
  }
  return best?.level ?? levels.file
}

/** The lowest of every configured level — what the logger tree must let through for the sinks to choose. */
function lowestOf(levels: EnsoLogLevels): LogLevel {
  let lowest: LogLevel = levels.file
  for (const candidate of [levels.console, ...levels.overrides.map((override) => override.level)]) {
    if (candidate !== undefined && compareLogLevel(candidate, lowest) < 0) lowest = candidate
  }
  return lowest
}

/**
 * The value pass (#139): every known secret VALUE, wherever it appears, replaced with
 * `ENSO_REDACTED_VALUE` — in the rendered message, in the raw template, and in every string
 * property, however deeply the property nests. `undefined` when there is nothing to scan
 * for, so a process with no secret store pays nothing on the write path.
 *
 * One pre-built alternation over the known values, so the cost is a single regex pass per
 * string rather than one pass per secret.
 *
 * ⚠ LONGEST FIRST (PR #153 review). A JS alternation takes the first branch that matches at
 * a position, not the longest, so with `sk-live-abc` listed before `sk-live-abcdef99` the
 * longer secret is redacted down to its prefix and its tail stays in the file — silent
 * under-redaction, in exactly the case that matters most: two live keys from one provider,
 * or a key and its rotation. Reproduced before this line existed: `[REDACTED:value]def99`.
 */
function valueScrubber(values: readonly string[]): ((value: unknown) => unknown) | undefined {
  const scannable = values.filter((secret) => secret.length > 0).sort((left, right) => right.length - left.length)
  if (scannable.length === 0) return undefined
  const pattern = new RegExp(scannable.map((secret) => secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g')
  const scrubbed = (value: unknown): unknown => {
    if (typeof value === 'string') return value.replace(pattern, ENSO_REDACTED_VALUE)
    if (Array.isArray(value)) return value.map(scrubbed)
    // ⚠ An Error's `message` and `stack` are own but NON-ENUMERABLE, so the structural
    // rebuild below turns `log.error('…: {error}', { error })` into `{}` — and the records
    // that carry an Error are exactly the ones someone is reading to find out why (the
    // guard's analyzer-failure deny, the server's handler failure). Named explicitly, and
    // the text still goes through the value pass.
    if (value instanceof Error) {
      return {
        name: value.name,
        message: scrubbed(value.message),
        ...(value.stack === undefined ? {} : { stack: scrubbed(value.stack) }),
        ...(value.cause === undefined ? {} : { cause: scrubbed(value.cause) }),
      }
    }
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([name, nested]) => [name, scrubbed(nested)]))
    }
    return value
  }
  return scrubbed
}

/**
 * A sink wrapper that runs the value pass over every record.
 *
 * A plain array is compiled once, at configure, and with an empty one the wrapper is the
 * identity: no allocation, no scan, nothing on the write path at all.
 *
 * ⚠ A THUNK is asked per record, which is the point (#207): the READER is per call —
 * `readSecret` re-reads `.enso/secrets.env` every time, and web-search's own refusal tells the
 * operator to rotate a key with the launcher running — so a snapshot taken at configure left
 * every rotated key readable and unredactable for the rest of the process's life. The
 * alternation is rebuilt only when the thunk hands back a DIFFERENT array
 * (`knownSecretValuesTracking` changes identity exactly when the file does), so the steady
 * state costs one `stat` and one reference compare per record PER WRAPPED SINK: measured over
 * 20k records, 9.4 µs per record tracking against 7.5 µs snapshot and 7.3 µs with no value
 * pass at all (`.local` benchmark, #207). ⚠ The wrapper is applied to each sink separately
 * (file, and console when it is configured), and each closure asks the thunk itself — so a
 * process logging to both pays the `stat` twice per record, not once (PR #318 review). They
 * converge on the same cached alternation, so only the cost doubles, never the answer. A
 * 50k-record `trace` day pays ~0.1 s for it, ~0.2 s with the console sink on.
 */
function redactingKnownValues(values: readonly string[] | (() => readonly string[])): (sink: Sink) => Sink {
  const rotating = typeof values === 'function' ? values : undefined
  let scrubbed = typeof values === 'function' ? undefined : valueScrubber(values)
  if (rotating === undefined && scrubbed === undefined) return (sink: Sink): Sink => sink
  let source: readonly string[] | undefined
  return (sink: Sink): Sink =>
    (record: LogRecord): void => {
      if (rotating !== undefined) {
        const latest = rotating()
        if (latest !== source) {
          source = latest
          scrubbed = valueScrubber(latest)
        }
      }
      if (scrubbed === undefined) {
        sink(record)
        return
      }
      const scrub = scrubbed
      sink({
        ...record,
        message: record.message.map(scrub),
        rawMessage: typeof record.rawMessage === 'string' ? (scrub(record.rawMessage) as string) : record.rawMessage,
        properties: scrub(record.properties) as LogRecord['properties'],
      })
    }
}

/** @group Logging */
export interface ProcessLoggingOptions {
  /** `logsDirFrom(environment)` — created if absent. */
  readonly logsDir: string
  /** Which launcher this is — `server`, `web`, `pi` — on every record it writes, since the file is shared. */
  readonly process: string
  /** From `parseEnsoLogLevels`; the defaults when omitted: file `info`, no console. */
  readonly levels?: EnsoLogLevels
  /**
   * The secret values to scrub wherever they appear, from `knownSecretValues` (#139).
   * Omitted — a test, a process with no secret store — means the value pass does not run.
   *
   * A THUNK — `knownSecretValuesTracking(home)` — is what a launcher passes (#207): it is
   * asked per record, so a key rotated in `ENSO_HOME/secrets.env` while the process runs is
   * redacted from the next record on, matching the reader, which was always per call. An
   * array is a snapshot of the set at configure time and stays one.
   */
  readonly secretValues?: readonly string[] | (() => readonly string[])
}

/**
 * A dev launcher's start (#132, #421), in the one order that works: the checkout's old `.enso/`
 * migrated into `ENSO_HOME` FIRST — before the logs, the secrets and pi's agent dir are opened
 * where they now live — then logging configured there, what the migration did reported (an `info`
 * line for what moved, a `warn` per file left because `ENSO_HOME` already had one: nothing is
 * overwritten), and the shutdown flush installed. One function, so the two dev launchers cannot
 * drift into different orders; `bun run dev` starts both at once, and either may migrate first.
 *
 * @group Logging
 */
export async function startLauncher(options: {
  readonly repoRoot: string
  readonly environment: Readonly<Record<string, string | undefined>>
  /** The `process` field on this launcher's records: `server`, `web`. */
  readonly process: string
  /** This launcher's own logger: `['server', 'dev']`. */
  readonly logger: readonly [EnsoLogLayer, ...string[]]
  /** What to end before the flush on a stop or a crash — `scripts/dev.ts` stops its children here (#385). */
  readonly beforeStop?: () => Promise<void>
}): Promise<{
  readonly home: string
  readonly logsDir: string
  readonly log: EnsoLogger
  /** Flush and close the log — for a launcher that exits on its own, not by signal. */
  readonly dispose: () => Promise<void>
}> {
  const home = ensoHome(options.environment)
  const migration = migrateCheckoutEnsoOnLaunch(options.repoRoot, options.environment)
  const logsDir = ensoLogsDir(home)
  const dispose = await configureProcessLogging({
    logsDir,
    process: options.process,
    levels: parseEnsoLogLevels(options.environment, { console: 'info' }),
    // The value pass (#139): what a token quoted in a message or a trace payload is scrubbed
    // against — asked per record, so a key rotated while the launcher runs is redacted too (#207).
    secretValues: knownSecretValuesTracking(home, options.environment),
  })
  installLoggingShutdown(dispose, options.beforeStop)
  const [layer, ...subcategory] = options.logger
  const log = ensoLogger(layer, ...subcategory)
  const { from, to } = migration
  if (migration.moved.length > 0) {
    log.info('moved {count} file(s) from {from} to {to}: Enso keeps its state in ENSO_HOME now', {
      count: migration.moved.length,
      from,
      to,
    })
  }
  for (const path of migration.kept) {
    log.warn('{path} stays in {from}: {to} already has one, and nothing is overwritten — keep one by hand', {
      path,
      from,
      to,
    })
  }
  if (migration.held) {
    log.warn(
      '{from} was not moved: ENSO_HOME is set to {to}, and a launch moves it into ~/.enso only — move it by hand if you mean to',
      {
        from,
        to,
      },
    )
  }
  // The sessions pi filed by cwd move into their project folders (#552), after the `.enso` move
  // above put the agent dir where it now lives. Said like the move above: what moved, what stayed.
  const sessions = migrateSessionsIntoProjects(ensoAgentDir(home), ensoProjectsDir(home))
  if (sessions.moved.length > 0) {
    log.info('moved {count} session file(s) into their project folders under {projectsDir} (#552)', {
      count: sessions.moved.length,
      projectsDir: ensoProjectsDir(home),
    })
  }
  for (const path of sessions.kept) {
    log.warn('{path} stays where it was: its project folder already holds a file of that name — keep one by hand', {
      path,
    })
  }
  for (const directory of sessions.orphaned) {
    log.warn(
      '{directory} stays where it was: the directory its sessions ran in no longer exists, so they have no project',
      {
        directory,
      },
    )
  }
  for (const path of sessions.unreadable) {
    log.warn(
      '{path} stays where it was: no session header on its first line — a tail a running pre-#552 process kept appending after the move, or not a session file; join it by hand',
      {
        path,
      },
    )
  }
  return { home, logsDir, log, dispose }
}

/**
 * Where this process writes: `ENSO_HOME/logs` (`ensoHome`, `ensoLogsDir`, #421). A test keeps its
 * records out of the user's home by giving the environment its own `ENSO_HOME`.
 *
 * One rule for every launcher and for the extension, so they land in the same file.
 *
 * @group Logging
 */
export function logsDirFrom(environment: Readonly<Record<string, string | undefined>>): string {
  return ensoLogsDir(ensoHome(environment))
}

/**
 * `enso-2026-09-09.jsonl`: the harness's one log for that day — the machine's LOCAL day, not
 * UTC.
 *
 * The file is for the person at the machine: at 19:05 local `bun run logs` must not say "no log
 * for today" because it is 00:05 tomorrow in Greenwich (found live). The timestamps inside stay
 * ISO UTC.
 *
 * @group Logging
 */
export function ensoLogFilename(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `enso-${date.getFullYear()}-${month}-${day}.jsonl`
}

const ENSO_LOG_FILENAME = /^enso-(\d{4}-\d{2}-\d{2})\.jsonl$/

/**
 * The local day a log file is for — `2026-09-23` from `enso-2026-09-23.jsonl` — or `undefined`
 * for any other name in the directory. The inverse of `ensoLogFilename`.
 *
 * @group Logging
 */
export function ensoLogDay(filename: string): string | undefined {
  return ENSO_LOG_FILENAME.exec(filename)?.[1]
}

/**
 * Days a log day file is kept before the sink prunes it. Exported so what the docs say is this number (#482).
 *
 * @group Logging
 */
export const LOG_KEEP_DAYS = 14
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Create today's file before anything opens it, owner-only, and tighten it if an earlier
 * build or a wider umask left it readable by the group (#207).
 *
 * The day file quotes the material of files that are themselves `0600` — `.enso/secrets.env`
 * through a record that carries a value the redactor did not know yet, a guard `reason`
 * echoing a command, a `trace` payload — and it was created `0664`, because LogTape's node
 * driver opens with `fs.openSync(path, 'a')` and the sink takes no mode. "The file stays safe
 * at rest" then rested on redaction alone. Every reader is the same user: `bun run logs`, the
 * bundle route inside the server, and the three writers (`server`, `web`, `pi`) are all
 * processes the operator started.
 *
 * Returned as a closure the writer calls per record because the sink re-opens at LOCAL
 * midnight: without this, a launcher running across the boundary creates tomorrow's file
 * `0664`. One `Date.now()` and one compare per record; the open happens once per day.
 *
 * Owner bits are left alone — an operator who made it `0400` meant it. Only group and other
 * are stripped.
 */
function owningTheDayFile(logsDir: string): () => void {
  let ownedThrough = 0
  return (): void => {
    const now = Date.now()
    if (now < ownedThrough) return
    const today = new Date(now)
    const descriptor = openSync(join(logsDir, ensoLogFilename(today)), 'a', 0o600)
    try {
      const mode = fstatSync(descriptor).mode & 0o777
      if ((mode & 0o077) !== 0) fchmodSync(descriptor, mode & 0o700)
    } finally {
      closeSync(descriptor)
    }
    today.setHours(24, 0, 0, 0) // the next local midnight: when the sink will name a new file
    ownedThrough = today.getTime()
  }
}

/**
 * True once some configurator has run in this process — pi in-process shares the server's.
 *
 * @group Logging
 */
export function isLoggingConfigured(): boolean {
  return getConfig() !== null
}

/**
 * Configure the process; resolves to the disposer that flushes and closes the file.
 *
 * @group Logging
 */
export async function configureProcessLogging(options: ProcessLoggingOptions): Promise<() => Promise<void>> {
  const levels: EnsoLogLevels = options.levels ?? { file: DEFAULT_FILE_LEVEL, console: undefined, overrides: [] }
  mkdirSync(options.logsDir, { recursive: true })
  // Before the sink opens the file: it opens eagerly, with no mode of its own (#207).
  const ownTheDayFile = owningTheDayFile(options.logsDir)
  ownTheDayFile()
  const fileSink = getTimeRotatingFileSink({
    directory: options.logsDir,
    interval: 'daily',
    filename: ensoLogFilename,
    parseFilename: (filename: string): Date | null => {
      const day = ensoLogDay(filename)
      return day === undefined ? null : new Date(`${day}T00:00:00`) // local midnight, as the name was made
    },
    maxAgeMs: LOG_KEEP_DAYS * DAY_MS,
    // The template as the message and the values as properties — an event name a bundle
    // can filter on, not a sentence with the values rendered into it.
    formatter: getJsonLinesFormatter({ message: 'template' }),
    bufferSize: 0,
  })
  // The writer and its count on every record, since the file is shared. First, so a
  // record's own `process`, should one ever carry it, wins.
  let written = 0
  const stamped: Sink = (record: LogRecord) => {
    written += 1
    // Today's file may be tomorrow's by now: own it before the sink rotates into it.
    ownTheDayFile()
    fileSink({ ...record, properties: { process: options.process, sequence: written, ...record.properties } })
  }
  const file: Sink = withFilter(
    stamped,
    (record: LogRecord) => compareLogLevel(record.level, effectiveFileLevel(levels, record.category)) >= 0,
  )
  // ⚠ Redaction wraps EVERY output, not the file alone. The terminal renders properties too
  // (the pretty formatter, `properties: true`), and a secret-shaped value on stdout is the
  // same leak with a different reader — the #134 review caught the console sink bare.
  // Each sink is wrapped on its own so LogTape's per-sink error containment still holds.
  const redaction = { fieldPatterns: [...ENSO_REDACT_FIELDS], action: (): string => ENSO_REDACTED }
  // …and the VALUE pass outside it (#139): field names cannot see a token quoted in a
  // message, a guard's `reason`, or a `trace` payload. Measured before it was written —
  // 193 ns for an ordinary record, 725 ns for a 20 KB payload, so a 50k-record `trace` day
  // costs ~10 ms: the write path is the right place, and the file stays safe at rest (#132).
  const redactValues = redactingKnownValues(options.secretValues ?? [])
  const sinks: Record<string, Sink> = { file: redactValues(redactByField(file, redaction)) }
  const ensoSinks = ['file']
  const metaSinks: string[] = []
  if (levels.console !== undefined) {
    const pretty = getConsoleSink({
      formatter: getPrettyFormatter({ timestamp: 'time', properties: true, categoryWidth: 24 }),
    })
    sinks.console = redactValues(redactByField(withFilter(pretty, levels.console), redaction))
    ensoSinks.push('console')
    metaSinks.push('console')
  }
  await configure({
    sinks,
    loggers: [
      // The tree lets the lowest configured level through; each sink's filter decides.
      { category: [ENSO_LOG_ROOT], lowestLevel: lowestOf(levels), sinks: ensoSinks },
      // LogTape's own reports — a sink that threw, a misconfiguration. Never to the file
      // that may be the thing failing.
      { category: ['logtape', 'meta'], lowestLevel: 'warning', sinks: metaSinks },
    ],
    contextLocalStorage: new AsyncLocalStorage(),
  })
  // The first record: what this process will and will not write, so a bundle that lacks
  // the debug lines says why — and WHO is writing (#144). A shared file makes "the
  // processes" mean "who has written to today's file"; with a pid and a start time,
  // liveness is inferable from the last write without any process asking to be counted.
  const startedAt = new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString()
  const logLogger = getLogger([ENSO_LOG_ROOT, 'log'])
  logLogger.info(ENSO_LOG_EVENTS.loggingConfigured, {
    file: levels.file,
    console: levels.console ?? 'off',
    overrides: levels.overrides.map((override) => `${override.category.join('.')}=${override.level}`),
    logsDir: options.logsDir,
    pid: process.pid,
    startedAt,
  })
  // The marker this process leaves while it runs (#385), and the ones a previous process of any
  // role left and never removed: each is an end nothing could record — SIGKILL, OOM, power loss —
  // said now, with the dead process's own pid and start time, never this one's.
  for (const dead of reconcileProcessMarkers(options.logsDir)) {
    if (dead.kind === 'ended') {
      const { process: role, pid, startedAt: diedStartedAt } = dead.marker
      logLogger.warn(ENSO_LOG_EVENTS.processEndedWithoutRecord, { role, pid, startedAt: diedStartedAt })
    } else logLogger.warn('removed an unreadable process marker at {path}', { path: dead.path })
  }
  const marker: EnsoProcessMarker = { process: options.process, pid: process.pid, startedAt }
  const markerPath = writeProcessMarker(options.logsDir, marker)
  markersOfThisProcess.add(markerPath)
  return async (): Promise<void> => {
    // Disposed is ended cleanly: the marker goes with the flush, not only at `exit`.
    markersOfThisProcess.delete(markerPath)
    removeProcessMarker(markerPath)
    await dispose()
  }
}

/**
 * The markers this process holds, removed when it exits by any path that still runs code — a
 * normal end, `process.exit`, a handled signal, a recorded crash. One listener for all of them:
 * a test configures many times in one process, and a listener per configure would pile up.
 */
const markersOfThisProcess = new Set<string>()
process.on('exit', () => {
  for (const path of markersOfThisProcess) removeProcessMarker(path)
})

/** The error as a record carries it: the message, the name, the stack if there is one. */
function crashPropertiesOf(reason: unknown): Record<string, unknown> {
  if (reason instanceof Error) {
    return { error: reason.message, name: reason.name, ...(reason.stack === undefined ? {} : { stack: reason.stack }) }
  }
  return { error: String(reason), name: typeof reason }
}

/**
 * How a launcher ends, recorded (#267, #385): the stop contract every launcher owes a
 * supervisor — flush the file, then exit the way the signal would have, `128 + the signal's
 * number`, so 130 for `SIGINT` and 143 for `SIGTERM` — with a `process stopping on {signal}`
 * record written BEFORE the flush, so the flush carries it; and a crash recorded: an error
 * outside every handler, or an unhandled rejection, is one `fatal` record with the stack, then
 * the flush, then exit 1. ⚠ Installing the crash handlers replaces the runtime's default of
 * printing and exiting, so the explicit exit is what keeps a crashed server from running on
 * half-dead.
 *
 * `128 + n` is read by a hub, a shell and systemd alike, which makes the table a CONTRACT and
 * not an implementation detail; it lived twice, verbatim, in the two dev launchers, where a
 * third signal or a changed flush order would have reached one of them.
 *
 * ⚠ `on`, not `once`, for the signals, with one guard for everything. A `once` handler is
 * consumed by the first signal, and a SECOND one arriving on its heels can then meet the
 * runtime's default — killed on the spot, flush lost, marker left. A second signal is the
 * normal case: a supervisor signals the process group AND the dev launcher signals its
 * children. Measured on #385 with `timeout -s TERM … bun run dev`: a web marker left behind in
 * 2 of 3 runs under `once`, 0 of 5 under `on`. A unit test cannot land the second signal in
 * that window (a repeat sent by a parent is coalesced or absorbed), so the proof is that smoke.
 * The guard makes a repeat a no-op, so the one dispose runs to its exit; a second throw during
 * the flush is a no-op the same way.
 *
 * @group Logging
 */
export function installLoggingShutdown(dispose: () => Promise<void>, beforeStop?: () => Promise<void>): void {
  let ending = false
  const end = (code: number): void => {
    if (ending) return
    ending = true
    // ⚠ Whatever `beforeStop` does or fails to do, the flush and the exit follow: a child that
    // will not die is not a reason for the launcher to hang or to lose its records.
    void Promise.resolve()
      .then(() => beforeStop?.())
      .catch(() => undefined)
      .then(dispose)
      .finally(() => process.exit(code))
  }
  for (const [signal, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const) {
    process.on(signal, () => {
      if (ending) return
      getLogger([ENSO_LOG_ROOT, 'log']).info(ENSO_LOG_EVENTS.processStopping, { signal })
      end(code)
    })
  }
  const crash = (reason: unknown): void => {
    if (!ending) getLogger([ENSO_LOG_ROOT, 'log']).fatal(ENSO_LOG_EVENTS.processCrashed, crashPropertiesOf(reason))
    end(1)
  }
  process.on('uncaughtException', crash)
  process.on('unhandledRejection', crash)
}

// ── Reading the file back (#132: `bun run logs`, and the bundle's reader) ─────────────────

const LEVEL_OF_LINE: Readonly<Record<EnsoLogLine['level'], LogLevel>> = {
  TRACE: 'trace',
  DEBUG: 'debug',
  INFO: 'info',
  WARN: 'warning',
  ERROR: 'error',
  FATAL: 'fatal',
}

/**
 * One raw line of the file → the record, or the reason it is not one.
 *
 * THE parser (the reader, the bundle route, and the bundle reader all go through it): a line
 * that is not a record is said, never skipped silently — the file is the honest place.
 *
 * @group Logging
 */
export function parseEnsoLogLine(raw: string): EnsoLogLine | string {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return 'not JSON'
  }
  return Check(EnsoLogLine, parsed) ? parsed : 'not a EnsoLogLine'
}

/**
 * A line of the file, back into the record it was: the category split, the level and the
 * instant read back, and the message re-joined from its template and properties by
 * `logLineMessageParts` — the grammar the browser shares — so any LogTape formatter renders
 * it exactly as the console did when it was written.
 *
 * @group Logging
 */
export function logRecordOf(line: EnsoLogLine): LogRecord {
  return {
    category: line.logger.split('.'),
    level: LEVEL_OF_LINE[line.level],
    timestamp: Date.parse(line['@timestamp']),
    message: logLineMessageParts(line),
    rawMessage: line.message ?? '',
    properties: line.properties ?? {},
  }
}

/**
 * The terminal's formatter, for the file's records: what `bun run logs` prints.
 *
 * `wordWrap` as the pretty formatter takes it — `true` wraps to the terminal's width, `false`
 * keeps each record's lines whole (for a pipe), a number is a width. `colors` off for a pipe.
 *
 * @group Logging
 */
export function ensoLogLineRenderer(
  options: { readonly wordWrap?: boolean | number; readonly colors?: boolean } = {},
): (line: EnsoLogLine) => string {
  const pretty = getPrettyFormatter({
    timestamp: 'time',
    properties: true,
    categoryWidth: 24,
    wordWrap: options.wordWrap ?? true,
    colors: options.colors ?? true,
  })
  return (line: EnsoLogLine): string => pretty(logRecordOf(line))
}

// ── Following the file (#144 slice 2: `--follow`, and the tail route) ─────────────────────

/**
 * The decoder a poll-based reader needs. Two different things straddle a poll boundary and
 * both are the same carry: BYTES — a multibyte character cut in half by the byte range
 * decodes to U+FFFD unless the incomplete sequence waits for the next chunk (a 🚀 split
 * across a poll printed `launch ??? done`) — and LINES, where a partial last record waits for
 * its newline.
 *
 * ⚠ The carry is BYTES, not text, and the split is at the last `0x0A` (PR #336 review). A
 * newline never occurs inside a multibyte UTF-8 sequence, so cutting at one never cuts a
 * character — which is why one carry serves both cases — and, more to the point, the carry's
 * LENGTH is then a byte count a reader can subtract from its file offset. The tail publishes
 * `offset − carried()` as the byte a reconnect resumes from; publishing the raw read offset
 * put a reconnecting page mid-record, and the record's tail parsed as malformed and was lost.
 *
 * `decode` returns the complete lines in this chunk, newline-separated and without a trailing
 * one, or the empty string when nothing completed.
 *
 * @group Logging
 */
export interface LogChunkDecoder {
  readonly decode: (chunk: Buffer) => string
  /** Bytes held back — the partial line after the last newline seen. */
  readonly carried: () => number
}

/** @group Logging */
export function logChunkDecoder(): LogChunkDecoder {
  let carry: Buffer = Buffer.alloc(0)
  return {
    decode: (chunk: Buffer): string => {
      const pending = carry.length === 0 ? chunk : Buffer.concat([carry, chunk])
      const lastNewline = pending.lastIndexOf(0x0a)
      if (lastNewline === -1) {
        carry = pending
        return ''
      }
      // A COPY, not a view (PR #336 review, round two): `pending` is the read buffer, and on
      // the backlog read that buffer is the whole day. A view onto its last hundred bytes
      // pinned the whole allocation for as long as no newline arrived — on an idle log, for
      // the life of the connection, per tab. The carry is the bytes after the last newline,
      // so the copy is tiny by construction.
      carry = Buffer.from(pending.subarray(lastNewline + 1))
      return pending.subarray(0, lastNewline).toString('utf8')
    },
    carried: (): number => carry.length,
  }
}

/**
 * What one step of a tail found.
 *
 * @group Logging
 */
export interface EnsoLogTailStep {
  /** `backlog` — this is the file's whole view; `records` — these landed since the last step. */
  readonly type: 'backlog' | 'records'
  /** The local day the file is named for: a change is the midnight rotation. */
  readonly day: string
  /** The byte the next step continues from, and what a reconnecting client passes as `?from=`. */
  readonly offset: number
  /** The matching records, oldest first, capped to the newest `maxRecords`. */
  readonly lines: readonly EnsoLogLine[]
  /** How many matched BEFORE the cap — `matched > lines.length` is "the last N of M". */
  readonly matched: number
  /** Lines that were not records at all. A count, not the text: enough to send a reader to the file. */
  readonly malformed: number
}

/**
 * An open tail: one `step` per poll, and the `close` that releases the descriptor.
 *
 * ⚠ `close` is not optional housekeeping. One descriptor is held for the life of the tail so
 * a poll is a `statSync` and a `readSync` rather than an open per tick; a caller that drops
 * the handle instead of closing it leaks one descriptor per connection, which on a page the
 * operator leaves open and reloads is the kind of leak that surfaces as `EMFILE` hours later.
 *
 * @group Logging
 */
export interface EnsoLogTail {
  readonly step: () => EnsoLogTailStep
  readonly close: () => void
}

/**
 * Open a tail over the day's file; the returned step reads whatever has appeared since the
 * last call, filters it, and caps it.
 *
 * ⚠ `type` is not a flag anyone sets: A STEP THAT BEGAN AT BYTE 0 IS THE FILE'S WHOLE VIEW,
 * and any other step is an append. That one rule covers the first step with no `from`, the
 * local-midnight rotation onto a new filename, a file truncated in place, and — with one check
 * the rule alone did not give (PR #336 review) — a file REPLACED under the same name: `stat` is
 * by path and `read` is by descriptor, so an unlink-and-recreate that grew past the old offset
 * read zero bytes from the old inode forever. The inode is compared on every step, and a
 * change is a restart from the head.
 *
 * ⚠ TWO SHAPES ARE NOT COVERED, and are stated rather than claimed (PR #336 review, round
 * two). A file truncated and regrown past the old offset WITHIN ONE POLL — the `> file` or
 * `cp` shape — keeps its inode and its size, so nothing here fires and the read starts
 * mid-content of the rewritten file, which the reader sees as one malformed line and the
 * records before it missing. And a `from` carries the day it belongs to but not the inode, so
 * a reconnect after an unlink-and-recreate resumes at a byte of the OLD file applied to the
 * new one. Closing either needs the token to describe the file's content, not its position;
 * until then, `bun run logs` reads the day whole and is the reader that cannot be fooled.
 *
 * ⚠ ONE `stat`, never `exists` then `stat`: two calls are a window, and a file removed inside
 * it (the 14-day prune, an `rm`) made the second throw from a timer with nothing above it.
 *
 * ⚠ The CLI's `--follow` starts at the END of the file (it has already printed the day) and
 * this starts at its HEAD, because a page that opens with nothing on it is not a log viewer.
 * That is the `from` parameter, not a second reader.
 *
 * The first step therefore reads the whole day into memory once, which is what
 * `GET /api/logs/bundle` already does for the same file; the cap bounds what is handed on,
 * not what is read.
 *
 * @group Logging
 */
export function openLogTail(options: {
  readonly logsDir: string
  readonly filter: EnsoLogFilter
  /** Defaults to `LOG_TAIL_MAX_RECORDS`. */
  readonly maxRecords?: number
  /**
   * Resume here instead of the day's head — the offset a previous frame carried, and the day
   * that offset is a position in. The first step compares that day to the file it resolves
   * and drops the offset on a mismatch: the route validated the day against one `now()`, this
   * picks the file with another, and a midnight in between is the head of a day skipped.
   */
  readonly from?: { readonly offset: number; readonly day: string }
  /** The clock the day's filename is computed from; a test moves it across midnight. */
  readonly now?: () => Date
}): EnsoLogTail {
  const maxRecords = options.maxRecords ?? LOG_TAIL_MAX_RECORDS
  const now = options.now ?? ((): Date => new Date())
  let filename = ''
  let descriptor: number | undefined
  let inode: number | undefined
  let offset = 0
  let decoder = logChunkDecoder()
  const close = (): void => {
    if (descriptor !== undefined) closeSync(descriptor)
    descriptor = undefined
    inode = undefined
  }
  /** Back to the head of whatever file is there next: descriptor, offset and carry all dropped. */
  const restart = (): void => {
    close()
    offset = 0
    decoder = logChunkDecoder()
  }
  const step = (): EnsoLogTailStep => {
    const today = ensoLogFilename(now())
    if (today !== filename) {
      if (filename === '') {
        // The first call: the caller's `from` is honoured only for the file it names.
        const day = today.slice('enso-'.length, -'.jsonl'.length)
        if (options.from !== undefined && options.from.day === day) offset = options.from.offset
      } else restart() // a rotation starts the new day at its head
      filename = today
    }
    const day = filename.slice('enso-'.length, -'.jsonl'.length)
    const file = join(options.logsDir, filename)
    const stat = statSync(file, { throwIfNoEntry: false })
    if (stat === undefined) {
      // No process has written today yet, or the file was removed under us. Either way the
      // next step re-opens from the head — with an empty carry, so a partial line read just
      // before the removal is not prepended to the new file's first record.
      restart()
      return { type: 'backlog', day, offset: 0, lines: [], matched: 0, malformed: 0 }
    }
    // Truncated in place, or replaced by a different file under the same name: the offset
    // names a byte the descriptor cannot read, or the descriptor is the old inode.
    if (stat.size < offset || (inode !== undefined && inode !== stat.ino)) restart()
    const startedAt = offset
    let text = ''
    if (stat.size > offset) {
      if (descriptor === undefined) {
        descriptor = openSync(file, 'r')
        inode = fstatSync(descriptor).ino
      }
      const chunk = Buffer.alloc(stat.size - offset)
      // `stat` then `read` are two calls: a file truncated between them answers fewer bytes
      // than the size said, without an error. Advance by what was READ, never by what was
      // promised, and decode only that.
      const read = readSync(descriptor, chunk, 0, chunk.length, offset)
      offset += read
      text = decoder.decode(chunk.subarray(0, read))
    }
    const found = selectRecords(text, options.filter)
    return {
      type: startedAt === 0 ? 'backlog' : 'records',
      day,
      // The byte a reconnect resumes from: after the last COMPLETE line, not after the last
      // read. The carry is this tail's own state and a new tail does not have it.
      offset: offset - decoder.carried(),
      lines: found.lines.slice(-maxRecords),
      matched: found.matched,
      malformed: found.malformed,
    }
  }
  return { step, close }
}

/** The records in a run of complete lines that answer the filter, and how many lines were not records. */
function selectRecords(
  text: string,
  filter: EnsoLogFilter,
): { readonly lines: EnsoLogLine[]; readonly matched: number; readonly malformed: number } {
  const lines: EnsoLogLine[] = []
  let matched = 0
  let malformed = 0
  for (const raw of text.split('\n')) {
    if (raw.length === 0) continue
    const parsed = parseEnsoLogLine(raw)
    if (typeof parsed === 'string') {
      malformed += 1
      continue
    }
    if (!logLineMatches(filter, parsed)) continue
    matched += 1
    lines.push(parsed)
  }
  return { lines, matched, malformed }
}
