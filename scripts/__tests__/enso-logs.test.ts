import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { browserSection, buildLogBundle, type EnsoLogLine } from '../../packages/core/src/index.ts'
import { ensoLogFilename } from '../../packages/core/src/log-process.ts'
import { type LogsIo, matches, parseArguments, run, USAGE, UsageError } from '../enso-logs.ts'

/**
 * The reader's own logic (#132, `bun run logs`): the flags, and what a line must be to print.
 */

test('flags: defaults, every flag, and the local-day --date', () => {
  const defaults = parseArguments([])
  expect(defaults).toMatchObject({
    follow: false,
    json: false,
    color: false,
    level: 2,
    thread: undefined,
    process: undefined,
    sinceMs: undefined,
  })

  const all = parseArguments([
    '--follow',
    '--json',
    '--color',
    '--level',
    'debug',
    '--thread',
    '6923e6',
    '--process',
    'pi',
    '--since',
    '10m',
  ])
  expect(all).toMatchObject({
    follow: true,
    json: true,
    color: true,
    level: 1,
    thread: '6923e6',
    process: 'pi',
    sinceMs: 600_000,
  })

  expect(parseArguments(['-f', '--level', 'WARN'])).toMatchObject({ follow: true, level: 3 })
  expect(parseArguments(['--since', '30s']).sinceMs).toBe(30_000)
  expect(parseArguments(['--since', '2h']).sinceMs).toBe(7_200_000)
  expect(parseArguments(['--since', '1d']).sinceMs).toBe(86_400_000)
  expect(parseArguments(['--file', 'enso-bundle.md']).file).toBe('enso-bundle.md')

  // The file is named by the local day, so the date is read as local noon — never a day off at a zone boundary.
  const dated = parseArguments(['--date', '2026-09-08']).date
  expect([dated.getFullYear(), dated.getMonth() + 1, dated.getDate()]).toEqual([2026, 9, 8])
})

test('a flag the reader cannot take is a UsageError naming the problem, never a silent default', () => {
  expect(() => parseArguments(['--level', 'loud'])).toThrow(UsageError)
  expect(() => parseArguments(['--since', 'soon'])).toThrow(/30s, 10m, 2h, 1d/)
  expect(() => parseArguments(['--date', 'yesterday'])).toThrow(/YYYY-MM-DD/)
  expect(() => parseArguments(['--thread'])).toThrow(/needs a value/)
  expect(() => parseArguments(['--verbose'])).toThrow(/unknown flag --verbose/)
  expect(() => parseArguments(['--file', 'b.md', '--follow'])).toThrow(/cannot be followed/)
})

const line = (overrides: Partial<EnsoLogLine> = {}): EnsoLogLine => ({
  '@timestamp': '2026-09-09T23:41:26.174Z',
  level: 'WARN',
  message: '{toolName} denied: {reason}',
  logger: 'enso.extension.guards',
  properties: { process: 'server', threadId: '6923e620-856a-4132-a9c8-1a2ff7d271f9', toolName: 'write' },
  ...overrides,
})

test('a line prints when it clears the level, is after --since, and matches the thread prefix and process', () => {
  const at = Date.parse('2026-09-09T23:41:26.174Z')
  expect(matches(parseArguments([]), line(), 0)).toBe(true)
  // Level is a floor: WARN clears info; DEBUG does not; --level trace admits everything.
  expect(matches(parseArguments([]), line({ level: 'DEBUG' }), 0)).toBe(false)
  expect(matches(parseArguments(['--level', 'trace']), line({ level: 'TRACE' }), 0)).toBe(true)
  // --since is a cutoff on the record's own time.
  expect(matches(parseArguments([]), line(), at + 1)).toBe(false)
  expect(matches(parseArguments([]), line(), at)).toBe(true)
  // Thread by prefix; process exactly.
  expect(matches(parseArguments(['--thread', '6923e6']), line(), 0)).toBe(true)
  expect(matches(parseArguments(['--thread', '6923e620-856a']), line(), 0)).toBe(true)
  expect(matches(parseArguments(['--thread', 'other']), line(), 0)).toBe(false)
  expect(matches(parseArguments(['--process', 'server']), line(), 0)).toBe(true)
  expect(matches(parseArguments(['--process', 'pi']), line(), 0)).toBe(false)
  // A record with no thread never matches a thread filter, and always matches none.
  expect(matches(parseArguments(['--thread', '6923']), line({ properties: { process: 'server' } }), 0)).toBe(false)
  const { properties: _dropped, ...withoutProperties } = line()
  expect(matches(parseArguments([]), withoutProperties, 0)).toBe(true)
})

// ── The command over its io: what reaches stdout and stderr, and the exit code ──

const ANSI = '\u001B['

interface Captured {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

async function runCaptured(argv: readonly string[], io: Partial<LogsIo> = {}): Promise<Captured> {
  let stdout = ''
  let stderr = ''
  const code = await run(argv, {
    serverUrl: 'http://127.0.0.1:1',
    logsDir: '/nonexistent-enso-logs',
    onTerminal: false,
    ...io,
    stdout: (text) => {
      stdout += text
    },
    stderr: (text) => {
      stderr += text
    },
  })
  return { code, stdout, stderr }
}

/** A scratch logs directory for one test, removed after it. */
async function withLogsDir(body: (logsDir: string) => Promise<void>): Promise<void> {
  const logsDir = mkdtempSync(join(tmpdir(), 'enso-logs-test-'))
  try {
    await body(logsDir)
  } finally {
    rmSync(logsDir, { recursive: true, force: true })
  }
}

const DAY = '2026-09-08'
const WARN_RAW = JSON.stringify(line())
const DEBUG_RAW = JSON.stringify(line({ level: 'DEBUG', message: 'quiet' }))

test('run: a usage error exits 2 with the problem and the usage on stderr', async () => {
  expect(await runCaptured(['--verbose'])).toEqual({
    code: 2,
    stdout: '',
    stderr: `enso-logs: unknown flag --verbose\n\n${USAGE}\n`,
  })
})

test("run: no file for the day exits 1 naming the day's file and the directory it looked in", async () => {
  await withLogsDir(async (logsDir) => {
    const result = await runCaptured(['--date', DAY], { logsDir })
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain(`no log for enso-${DAY}.jsonl in ${logsDir}`)
  })
})

test("run: the day's file prints its matching records, says which lines are not records, and skips the rest", async () => {
  await withLogsDir(async (logsDir) => {
    const dayFile = join(logsDir, ensoLogFilename(parseArguments(['--date', DAY]).date))
    writeFileSync(dayFile, `${WARN_RAW}\n${DEBUG_RAW}\nnot a record\n`)

    // --json: the matching lines exactly as on disk; the DEBUG record is under the info floor.
    const raw = await runCaptured(['--date', DAY, '--json'], { logsDir })
    expect(raw).toEqual({ code: 0, stdout: `${WARN_RAW}\n(not JSON) not a record\n`, stderr: '' })

    // Rendered: the template's values put back, plain off a terminal, in the file's order.
    const plain = await runCaptured(['--date', DAY], { logsDir })
    expect(plain.stdout).toContain("'write' denied")
    expect(plain.stdout.endsWith('(not JSON) not a record\n')).toBe(true)
    expect(plain.stdout).not.toContain('{toolName}')
    expect(plain.stdout).not.toContain('quiet')
    expect(plain.stdout).not.toContain(ANSI)

    // Colors on a terminal, and through a pipe only when asked.
    expect((await runCaptured(['--date', DAY], { logsDir, onTerminal: true })).stdout).toContain(ANSI)
    expect((await runCaptured(['--date', DAY, '--color'], { logsDir })).stdout).toContain(ANSI)
  })
})

test('run: --since keeps only the records written within that long of now', async () => {
  await withLogsDir(async (logsDir) => {
    const recent = JSON.stringify(line({ '@timestamp': new Date().toISOString(), message: 'recent' }))
    const file = join(logsDir, 'raw.jsonl')
    writeFileSync(file, `${WARN_RAW}\n${recent}\n`)
    const result = await runCaptured(['--file', file, '--since', '1h', '--json'])
    expect(result.stdout).toBe(`${recent}\n`)
  })
})

test("run: --file reads a bundle's fenced records, the server's then the browser's, and none of its prose", async () => {
  await withLogsDir(async (logsDir) => {
    const browserLine = line({ message: 'browser said so', properties: { process: 'web' } })
    const bundle =
      buildLogBundle({
        about: {
          at: '2026-09-09T23:50:00.000Z',
          enso: 'abc',
          pi: '1.0.0',
          bun: '1.4.2',
          os: 'linux',
          selection: 'all',
        },
        threads: [],
        lines: [line(), line({ level: 'DEBUG', message: 'quiet' })],
        matched: 2,
      }) + browserSection([browserLine])
    const bundleFile = join(logsDir, 'enso-bundle.md')
    writeFileSync(bundleFile, bundle)

    const result = await runCaptured(['--file', bundleFile, '--json'])
    expect(result).toEqual({ code: 0, stdout: `${WARN_RAW}\n${JSON.stringify(browserLine)}\n`, stderr: '' })
  })
})

test('run: a --file that does not exist exits 1 naming it', async () => {
  expect(await runCaptured(['--file', '/nonexistent-enso-logs/b.md'])).toEqual({
    code: 1,
    stdout: '',
    stderr: 'enso-logs: no such file /nonexistent-enso-logs/b.md\n',
  })
})

/** A stand-in for the server's bundle route: echoes the query it was asked, or fails with `status`. */
async function withBundleServer(status: number, body: (serverUrl: string) => Promise<void>): Promise<void> {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname !== '/api/logs/bundle') return new Response('no route', { status: 404 })
      return new Response(`# bundle for ${url.searchParams.get('thread') ?? 'every thread'}\n`, { status })
    },
  })
  try {
    await body(server.url.origin)
  } finally {
    await server.stop(true)
  }
}

test("run: bundle prints the server's bundle as it answered, for one thread when --thread names it", async () => {
  await withBundleServer(200, async (serverUrl) => {
    expect(await runCaptured(['bundle'], { serverUrl })).toEqual({
      code: 0,
      stdout: '# bundle for every thread\n',
      stderr: '',
    })
    expect((await runCaptured(['bundle', '--thread', '6923 e6&x'], { serverUrl })).stdout).toBe(
      '# bundle for 6923 e6&x\n',
    )
  })
})

test('run: bundle exits 1 when the server refuses, naming the URL and its answer, or when no server answers', async () => {
  await withBundleServer(500, async (serverUrl) => {
    expect(await runCaptured(['bundle'], { serverUrl })).toEqual({
      code: 1,
      stdout: '',
      stderr: `enso-logs: ${serverUrl}/api/logs/bundle answered 500: # bundle for every thread\n\n`,
    })
  })
  // Port 1 on loopback: nothing listens there, so the connection is refused.
  const unreachable = await runCaptured(['bundle'], { serverUrl: 'http://127.0.0.1:1' })
  expect(unreachable.code).toBe(1)
  expect(unreachable.stderr).toContain('enso-logs: no server at http://127.0.0.1:1')
  expect(unreachable.stderr).toContain('`bun run dev`')
})
