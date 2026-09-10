#!/usr/bin/env bun

/**
 * See the log (#132): the day's file, rendered the way the terminal renders it live.
 *
 *   bun run logs                       today, info and up, every thread
 *   bun run logs --follow              keep printing as records land (tail -f)
 *   bun run logs --level debug         the tier floor: trace | debug | info | warning | error
 *   bun run logs --thread 6923e6       one thread, by id or a prefix of it
 *   bun run logs --process pi          one writer: server | web | pi
 *   bun run logs --since 10m           the last 10 minutes (s, m, h, d)
 *   bun run logs --date 2026-09-08     another day's file
 *   bun run logs --json                the matching lines raw, for jq
 *   bun run logs --color | less -R     colors kept through a pipe
 *   bun run logs --file zen-bundle.md  a bundle someone attached (or any log file), read like today's
 *   bun run logs bundle > b.md         make a bundle from the running server (--thread ID for one thread)
 *
 * ⚠ The file stores each message as its TEMPLATE with the values in `properties`, so a
 * bundle can filter on the event name; raw, a human reads `run {generation} acquired`. This
 * puts the values back — `logRecordOf` — and hands the record to the same pretty formatter
 * the console sink uses, so the file and the terminal read alike.
 */

import { existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { bundleRecordsText, findRepoRoot, isLogBundle, type ZenLogLine } from '../packages/core/src/index.ts'
import {
  logRecordOf,
  logsDirFrom,
  parseZenLogLine,
  zenLogFilename,
  zenLogLineRenderer,
} from '../packages/core/src/log-process.ts'

const LEVEL_RANK: Readonly<Record<string, number>> = {
  trace: 0,
  debug: 1,
  info: 2,
  warning: 3,
  warn: 3,
  error: 4,
  fatal: 5,
}
const SINCE = /^(\d+)(s|m|h|d)$/
/** `--since` units: the suffix at index N is worth `UNIT_MS[N]` milliseconds. */
const UNIT_SUFFIXES = ['s', 'm', 'h', 'd'] as const
const UNIT_MS = [1000, 60_000, 3_600_000, 86_400_000] as const
const FOLLOW_POLL_MS = 250

export interface Query {
  readonly date: Date
  readonly follow: boolean
  readonly json: boolean
  readonly color: boolean
  readonly level: number
  readonly thread: string | undefined
  readonly process: string | undefined
  readonly sinceMs: number | undefined
  /** A file to read instead of the day's: a bundle (`GET /api/logs/bundle`) or a raw log. */
  readonly file: string | undefined
}

export const USAGE =
  'usage: bun run logs [--follow] [--level trace|debug|info|warning|error] [--thread ID] [--process NAME] [--since 10m] [--date YYYY-MM-DD] [--file PATH] [--json] [--color]\n' +
  '       bun run logs bundle [--thread ID] > zen-bundle.md'

/** A flag the parser could not accept — the main prints it with the usage and exits 2. */
export class UsageError extends Error {
  constructor(problem: string) {
    super(problem)
    this.name = 'UsageError'
  }
}

function usage(problem: string): never {
  throw new UsageError(problem)
}

export function parseArguments(argv: readonly string[]): Query {
  let date = new Date()
  let follow = false
  let json = false
  let color = false
  let level = LEVEL_RANK.info ?? 2
  let thread: string | undefined
  let processName: string | undefined
  let sinceMs: number | undefined
  let file: string | undefined
  for (let flagIndex = 0; flagIndex < argv.length; flagIndex += 1) {
    const flag = argv[flagIndex]
    const value = (): string => argv[flagIndex + 1] ?? usage(`${flag} needs a value`)
    switch (flag) {
      case '--follow':
      case '-f':
        follow = true
        break
      case '--json':
        json = true
        break
      case '--color':
        color = true
        break
      case '--level': {
        const wanted = value().toLowerCase()
        level = LEVEL_RANK[wanted] ?? usage(`${wanted} is not a level`)
        flagIndex += 1
        break
      }
      case '--thread':
        thread = value()
        flagIndex += 1
        break
      case '--process':
        processName = value()
        flagIndex += 1
        break
      case '--since': {
        const match = SINCE.exec(value())
        if (match === null) usage(`--since wants a duration like 30s, 10m, 2h, 1d`)
        sinceMs = Number(match[1]) * (UNIT_MS[UNIT_SUFFIXES.indexOf(match[2] as 's' | 'm' | 'h' | 'd')] ?? 60_000)
        flagIndex += 1
        break
      }
      case '--file':
        file = value()
        flagIndex += 1
        break
      case '--date': {
        const parsed = new Date(`${value()}T12:00:00`) // local noon: the file is named by the local day
        if (Number.isNaN(parsed.getTime())) usage(`--date wants YYYY-MM-DD`)
        date = parsed
        flagIndex += 1
        break
      }
      default:
        usage(`unknown flag ${flag}`)
    }
  }
  if (file !== undefined && follow) usage('--file is a finished file; it cannot be followed')
  return { date, follow, json, color, level, thread, process: processName, sinceMs, file }
}

export function matches(query: Query, line: ZenLogLine, notBefore: number): boolean {
  const record = logRecordOf(line)
  if ((LEVEL_RANK[record.level] ?? 0) < query.level) return false
  if (record.timestamp < notBefore) return false
  const properties = line.properties ?? {}
  if (query.thread !== undefined && !String(properties.threadId ?? '').startsWith(query.thread)) return false
  if (query.process !== undefined && properties.process !== query.process) return false
  return true
}

/** Print every matching line in `text`; a line that is not a record is said, not skipped silently. */
function print(query: Query, render: (line: ZenLogLine) => string, text: string, notBefore: number): void {
  for (const raw of text.split('\n')) {
    if (raw.length === 0) continue
    const parsed = parseZenLogLine(raw)
    if (typeof parsed === 'string') {
      process.stdout.write(`(${parsed}) ${raw}\n`)
      continue
    }
    if (!matches(query, parsed, notBefore)) continue
    process.stdout.write(query.json ? `${raw}\n` : render(parsed))
  }
}

/** Poll until the day's file exists — `--follow` started before the first launcher of the day. */
async function untilExists(file: string): Promise<void> {
  if (existsSync(file)) return
  process.stderr.write(`zen-logs: waiting for ${file} …\n`)
  while (!existsSync(file)) await new Promise((resolve) => setTimeout(resolve, FOLLOW_POLL_MS))
}

function follow(query: Query, render: (line: ZenLogLine) => string, file: string): void {
  // Poll from where the first read ended; a partial last line is carried to the next poll.
  let offset = statSync(file).size
  let carry = ''
  const descriptor = openSync(file, 'r')
  setInterval(() => {
    const size = statSync(file).size
    if (size <= offset) return
    const chunk = Buffer.alloc(size - offset)
    readSync(descriptor, chunk, 0, chunk.length, offset)
    offset = size
    const text = carry + chunk.toString('utf8')
    const lastNewline = text.lastIndexOf('\n')
    carry = lastNewline === -1 ? text : text.slice(lastNewline + 1)
    if (lastNewline !== -1) print(query, render, text.slice(0, lastNewline), 0)
  }, FOLLOW_POLL_MS)
}

/**
 * `bundle`: the running server's bundle (`GET /api/logs/bundle`) to stdout — its records,
 * its live threads, the versions. The server is needed for the threads; without one, the
 * file alone is `bun run logs --json`. The browser's ring is NOT here (only a page has it);
 * the drawer's button is the bundle with that appended.
 */
async function bundle(argv: readonly string[]): Promise<void> {
  const query = parseArguments(argv)
  const serverUrl = process.env.ZEN_SERVER_URL ?? 'http://127.0.0.1:5179'
  const url = `${serverUrl}/api/logs/bundle${query.thread === undefined ? '' : `?thread=${encodeURIComponent(query.thread)}`}`
  let response: Response
  try {
    response = await fetch(url)
  } catch (error) {
    process.stderr.write(
      `zen-logs: no server at ${serverUrl} (${error instanceof Error ? error.message : String(error)}) — a bundle needs the running server for its threads; is \`bun run dev\` up? The file alone is \`bun run logs --json\`.\n`,
    )
    process.exit(1)
  }
  if (!response.ok) {
    process.stderr.write(`zen-logs: ${url} answered ${response.status}: ${await response.text()}\n`)
    process.exit(1)
  }
  process.stdout.write(await response.text())
}

async function main(argv: readonly string[]): Promise<void> {
  if (argv[0] === 'bundle') {
    await bundle(argv.slice(1))
    return
  }
  let query: Query
  try {
    query = parseArguments(argv)
  } catch (error) {
    if (!(error instanceof UsageError)) throw error
    process.stderr.write(`zen-logs: ${error.message}\n\n${USAGE}\n`)
    process.exit(2)
  }
  // A terminal gets colors and wraps to its width; a pipe (`| less`, `> file`) gets plain,
  // whole lines. `--color` keeps colors through a pipe (`| less -R`).
  const onTerminal = process.stdout.isTTY === true
  const render = zenLogLineRenderer({ wordWrap: onTerminal, colors: onTerminal || query.color })
  const notBefore = query.sinceMs === undefined ? 0 : Date.now() - query.sinceMs

  if (query.file !== undefined) {
    // A bundle is a log file with prose around it: its fenced records, in order. Anything
    // else is read as a raw log — the same parser says what is not a record.
    if (!existsSync(query.file)) {
      process.stderr.write(`zen-logs: no such file ${query.file}\n`)
      process.exit(1)
    }
    const text = readFileSync(query.file, 'utf8')
    print(query, render, isLogBundle(text) ? bundleRecordsText(text) : text, notBefore)
    return
  }

  const logsDir = logsDirFrom(process.env, findRepoRoot(import.meta.url))
  const file = join(logsDir, zenLogFilename(query.date))
  if (query.follow) await untilExists(file)
  else if (!existsSync(file)) {
    process.stderr.write(
      `zen-logs: no log for ${zenLogFilename(query.date)} in ${logsDir} — has a launcher run today?\n`,
    )
    process.exit(1)
  }
  print(query, render, readFileSync(file, 'utf8'), notBefore)
  if (query.follow) follow(query, render, file)
}

if (import.meta.main) await main(process.argv.slice(2))
