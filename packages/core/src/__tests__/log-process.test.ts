import { afterEach, expect, spyOn, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { reset } from '@logtape/logtape'
import { Check } from 'typebox/value'
import { redactionManifest } from '../log-bundle.ts'
import {
  configureProcessLogging,
  EnsoLogLevelError,
  effectiveFileLevel,
  ensoLogFilename,
  ensoLogLineRenderer,
  logRecordOf,
  parseEnsoLogLevels,
  reportHomeMigration,
  reportSessionMigration,
  retiredEnvironmentNames,
} from '../log-process.ts'
import { ENSO_LOG_EVENTS } from '../log-stats.ts'
import {
  ENSO_LOG_ROOT,
  ENSO_REDACTED,
  ENSO_REDACTED_VALUE,
  EnsoLogLine,
  ensoLogger,
  withEnsoLogContext,
} from '../log.ts'
import { ensoSecretsPath } from '../paths.ts'
import { isProcessMarkerAlive, processMarkersDir, reconcileProcessMarkers } from '../process-marker.ts'
import { knownSecretValuesTracking, readSecret } from '../secrets.ts'
import { recordEnsoLogs } from './log-recorder.ts'

/**
 * The file a user hands us (#132), end to end through the real configurator: what a line
 * looks like, what never reaches it, what every line under a route carries — and the knob.
 */

afterEach(reset)

const linesOf = (file: string): string[] =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)

test("⚠ the JSONL file: every line validates EnsoLogLine; a secret-shaped field is gone and its VALUE appears nowhere; the route's threadId is on a record that never named it", async () => {
  const logsDir = mkdtempSync(join(tmpdir(), 'enso-logs-'))
  const dispose = await configureProcessLogging({ logsDir, process: 'server' })
  const log = ensoLogger('server', 'probe')
  const file = join(logsDir, ensoLogFilename(new Date()))
  // The first record is the configuration itself.
  expect(linesOf(file)).toHaveLength(1)

  withEnsoLogContext({ threadId: 't-ctx' }, () => {
    // A module deep under the route logs with no threadId of its own …
    log.info('something under the route happened: {detail}', {
      toolCallId: 'c1',
      tokens: 4653,
      detail: 'x'.repeat(300), // over the sink's 200-byte immediate-write path on purpose
    })
  })
  // ⚠ On disk when the call returns — no second record, no dispose. The buffered blocking
  // sink held a long record until the NEXT one arrived (the first live receipt: an empty
  // file minutes after its banner); the last record before a hang is the one that matters.
  expect(linesOf(file)).toHaveLength(2)

  // … and one outside it carries a secret-shaped name whose value must never land.
  log.warn('a refusal named the key', { threadId: 't-plain', tavilyApiKey: 'tvly-MUST-NOT-LAND', reason: 'denied' })
  await dispose()

  const lines = linesOf(file)
  expect(lines).toHaveLength(3)
  expect(lines.join('\n')).not.toContain('MUST-NOT-LAND')

  const parsed = lines.map((line) => JSON.parse(line) as unknown)
  for (const record of parsed) expect(Check(EnsoLogLine, record)).toBe(true)
  const [configured, underRoute, refusal] = parsed as EnsoLogLine[]
  expect(configured?.properties).toMatchObject({ process: 'server', sequence: 1, file: 'info', console: 'off' })
  // Who wrote this file, and since when (#144): a shared file makes "the processes" mean
  // "who has written today", and liveness is then inferable from the last write.
  expect(configured?.properties?.pid).toBe(process.pid)
  const startedAt = new Date(String(configured?.properties?.startedAt))
  expect(Number.isNaN(startedAt.getTime())).toBe(false)
  expect(startedAt.getTime()).toBeLessThanOrEqual(Date.now())
  expect(startedAt.getTime()).toBeGreaterThan(Date.now() - 60 * 60 * 1000)

  // Implicit context: the route's threadId is on the record; its own properties stay. The
  // message is the TEMPLATE — the event, not its values — so a bundle can filter on it.
  expect(underRoute?.logger).toBe('enso.server.probe')
  expect(underRoute?.level).toBe('INFO')
  expect(underRoute?.message).toBe('something under the route happened: {detail}')
  expect(underRoute?.properties).toMatchObject({ process: 'server', sequence: 2, threadId: 't-ctx', toolCallId: 'c1' })
  // `tokens` is on ENSO_REDACT_FIELDS by design (token) — a marker, and the test says so.
  expect(underRoute?.properties?.tokens).toBe(ENSO_REDACTED)

  // Redaction at write: the field is a MARKER — the reader knows it was there — and its value is gone.
  expect(refusal?.level).toBe('WARN')
  expect(refusal?.properties).toEqual({
    process: 'server',
    sequence: 3,
    threadId: 't-plain',
    tavilyApiKey: ENSO_REDACTED,
    reason: 'denied',
  })
  expect(refusal?.message).toBe('a refusal named the key')
})

test('⚠ the terminal is redacted too: a secret-shaped property never reaches console output (#134 review)', async () => {
  // The pretty formatter renders properties; a bare console sink would print the value.
  const printed: string[] = []
  const spy = spyOn(console, 'info').mockImplementation((...parts: unknown[]) => {
    printed.push(parts.map(String).join(' '))
  })
  try {
    const logsDir = mkdtempSync(join(tmpdir(), 'enso-logs-'))
    const dispose = await configureProcessLogging({
      logsDir,
      process: 'server',
      levels: { file: 'info', console: 'info', overrides: [] },
    })
    ensoLogger('server', 'probe').info('a refusal named the key: {reason}', {
      tavilyApiKey: 'tvly-MUST-NOT-PRINT',
      reason: 'denied',
    })
    await dispose()
  } finally {
    spy.mockRestore()
  }
  expect(printed.length).toBeGreaterThan(0)
  expect(printed.join('\n')).toContain('denied')
  expect(printed.join('\n')).not.toContain('MUST-NOT-PRINT')
})

test('⚠ two processes, one file: every line lands whole — the property the dated, unbuffered, O_APPEND design rests on', async () => {
  const logsDir = mkdtempSync(join(tmpdir(), 'enso-logs-'))
  const child = join(logsDir, 'writer.ts')
  writeFileSync(
    child,
    [
      // By path: the script lives in a tmpdir, outside the workspace's module resolution.
      `import { ensoLogger } from ${JSON.stringify(join(import.meta.dir, '..', 'log.ts'))};`,
      `import { configureProcessLogging } from ${JSON.stringify(join(import.meta.dir, '..', 'log-process.ts'))};`,
      `const dispose = await configureProcessLogging({ logsDir: ${JSON.stringify(logsDir)}, process: process.argv[2] });`,
      `const log = ensoLogger("server", "writer");`,
      `for (let i = 0; i < 200; i++) log.info("line {i} from {who}: {pad}", { i, who: process.argv[2], pad: "x".repeat(600) });`,
      `await dispose();`,
    ].join('\n'),
  )
  const spawn = (who: string): Bun.Subprocess<'ignore', 'ignore', 'pipe'> =>
    Bun.spawn(['bun', child, who], { cwd: join(import.meta.dir, '..'), stdout: 'ignore', stderr: 'pipe' })
  const [alpha, bravo] = [spawn('alpha'), spawn('bravo')]
  expect(await Promise.all([alpha.exited, bravo.exited])).toEqual([0, 0])
  // ⚠ `bun test` runs in UTC; the children run in the machine's zone and name the file by
  // their local day (as the launchers do), so read whatever day file they made.
  const written = readdirSync(logsDir).filter((name) => /^enso-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
  expect(written).toHaveLength(1)
  const parsed = linesOf(join(logsDir, written[0] ?? '')).map((line) => JSON.parse(line) as EnsoLogLine)
  expect(parsed.every((record) => Check(EnsoLogLine, record))).toBe(true)
  // 200 records + the configuration record, per process.
  expect(parsed.filter((record) => record.properties?.process === 'alpha')).toHaveLength(201)
  expect(parsed.filter((record) => record.properties?.process === 'bravo')).toHaveLength(201)
})

/**
 * A child that configures logging into `logsDir`, installs the shutdown contract, writes one
 * record, and then does what `argv[2]` says: `wait` (alive on an open stdin until signalled),
 * `throw` (an error outside every handler), `reject` (an unhandled rejection) — each a real
 * process, because the contract IS the exit code a supervisor reads and the handler's last act
 * is `process.exit`. `argv[3]` is the writer's name on its records.
 */
function writeEndingChild(logsDir: string): string {
  const child = join(logsDir, 'ending.ts')
  writeFileSync(
    child,
    [
      `import { ensoLogger } from ${JSON.stringify(join(import.meta.dir, '..', 'log.ts'))};`,
      `import { configureProcessLogging, installLoggingShutdown } from ${JSON.stringify(join(import.meta.dir, '..', 'log-process.ts'))};`,
      `const dispose = await configureProcessLogging({ logsDir: ${JSON.stringify(logsDir)}, process: process.argv[3] ?? 'server' });`,
      // `beforeStop` says so on stdout and holds the flush a moment, so a test can land a SECOND signal mid-stop.
      `installLoggingShutdown(dispose, async () => { process.stdout.write("stopping\\n"); await Bun.sleep(300) });`,
      `ensoLogger("server", "ending").info("the record written before the end by {who}", { who: process.argv[3] ?? process.argv[2] });`,
      `process.stdout.write("ready\\n");`,
      `if (process.argv[2] === 'throw') setTimeout(() => { throw new Error('the handler nobody wrote') }, 0);`,
      `else if (process.argv[2] === 'reject') void Promise.reject(new Error('the promise nobody awaited'));`,
      // Alive until signalled by an open stdin handle, not a timer: nothing here waits on a clock.
      `else process.stdin.resume();`,
    ].join('\n'),
  )
  return child
}

type EndingChild = Bun.Subprocess<'pipe', 'pipe', 'pipe'>

/** Spawn the child and wait for its `ready` — it has configured logging and written its record. */
async function startEndingChild(child: string, mode: string, who: string): Promise<EndingChild> {
  const running = Bun.spawn(['bun', child, mode, who], {
    cwd: join(import.meta.dir, '..'),
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  await stdoutSays(running, 'ready')
  return running
}

async function stdoutSays(running: EndingChild, word: string): Promise<void> {
  for await (const chunk of running.stdout) {
    if (new TextDecoder().decode(chunk).includes(word)) return
  }
}

const dayRecordsOf = (logsDir: string): EnsoLogLine[] => {
  const written = readdirSync(logsDir).find((name) => /^enso-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
  return linesOf(join(logsDir, written ?? '')).map((line) => JSON.parse(line) as EnsoLogLine)
}

test('⚠ a stop signal — even twice, as a supervisor and a parent both send it — leaves ONE `process stopping` record, flushes, and exits 128 + the signal (#267, #385)', async () => {
  // A red line here means a stop either loses the records still in the sink, reports a code
  // the hub cannot tell an orderly stop from a crash by, or leaves no trace of itself (#385).
  // ⚠ The second signal is the realistic case (`timeout` signals the group, `bun run dev`
  // signals its children): a `once` handler would let it kill the process mid-flush.
  const logsDir = mkdtempSync(join(tmpdir(), 'enso-logs-'))
  const child = writeEndingChild(logsDir)
  for (const [signal, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const) {
    const running = await startEndingChild(child, 'wait', signal)
    running.kill(signal)
    await stdoutSays(running, 'stopping')
    running.kill(signal)
    expect(await running.exited).toBe(code)
    const records = dayRecordsOf(logsDir)
    // Flushed, not just registered: the record the child wrote before the signal is in the file.
    expect(records.some((record) => record.properties?.who === signal)).toBe(true)
    const stops = records.filter(
      (record) => record.message === ENSO_LOG_EVENTS.processStopping && record.properties?.process === signal,
    )
    expect(stops).toHaveLength(1)
    expect(stops[0]?.properties?.signal).toBe(signal)
    expect(stops[0]?.level).toBe('INFO')
  }
  // Both ended cleanly: no marker is left for the next start to report.
  expect(readdirSync(processMarkersDir(logsDir))).toEqual([])
})

test('⚠ an error outside every handler, or an unhandled rejection, is one `fatal` record with the stack, and the process exits 1 (#385)', async () => {
  const logsDir = mkdtempSync(join(tmpdir(), 'enso-logs-'))
  const child = writeEndingChild(logsDir)
  for (const [mode, message] of [
    ['throw', 'the handler nobody wrote'],
    ['reject', 'the promise nobody awaited'],
  ] as const) {
    const running = await startEndingChild(child, mode, mode)
    expect(await running.exited).toBe(1)
    const crashes = dayRecordsOf(logsDir).filter(
      (record) => record.message === ENSO_LOG_EVENTS.processCrashed && record.properties?.process === mode,
    )
    expect(crashes).toHaveLength(1)
    expect(crashes[0]?.level).toBe('FATAL')
    expect(crashes[0]?.properties?.error).toBe(message)
    expect(String(crashes[0]?.properties?.stack)).toContain('ending.ts')
  }
  expect(readdirSync(processMarkersDir(logsDir))).toEqual([])
})

test('⚠ after a SIGKILL the next start says the previous process ended without a record, by ITS pid and start; after a clean stop it says nothing (#385)', async () => {
  const logsDir = mkdtempSync(join(tmpdir(), 'enso-logs-'))
  const child = writeEndingChild(logsDir)
  // Killed: nothing in the process could write, so its marker stays behind.
  const killed = await startEndingChild(child, 'wait', 'killed')
  killed.kill('SIGKILL')
  await killed.exited
  expect(readdirSync(processMarkersDir(logsDir))).toEqual([`killed-${killed.pid}.json`])
  const killedStart = dayRecordsOf(logsDir).find(
    (record) => record.message === ENSO_LOG_EVENTS.loggingConfigured && record.properties?.process === 'killed',
  )?.properties?.startedAt

  // The next start reports it — naming the dead process, not itself — and removes the marker.
  const next = await startEndingChild(child, 'wait', 'next')
  next.kill('SIGTERM')
  expect(await next.exited).toBe(143)
  const unclean = dayRecordsOf(logsDir).filter((record) => record.message === ENSO_LOG_EVENTS.processEndedWithoutRecord)
  expect(unclean).toHaveLength(1)
  expect(unclean[0]?.level).toBe('WARN')
  expect(unclean[0]?.properties).toEqual(
    expect.objectContaining({ process: 'next', role: 'killed', pid: killed.pid, startedAt: killedStart }),
  )
  expect(readdirSync(processMarkersDir(logsDir))).toEqual([])

  // A start after a CLEAN stop has nothing to report.
  const after = await startEndingChild(child, 'wait', 'after')
  after.kill('SIGTERM')
  expect(await after.exited).toBe(143)
  expect(
    dayRecordsOf(logsDir).filter((record) => record.message === ENSO_LOG_EVENTS.processEndedWithoutRecord),
  ).toHaveLength(1)
})

test('⚠ a marker whose pid is alive but belongs to another process (pid reuse after a reboot) is dead; a live owner with a matching start is not', () => {
  // This process is the live owner: the kernel's start time for our pid agrees with the one the configurator would write.
  const ownStart = new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString()
  expect(isProcessMarkerAlive({ process: 'test', pid: process.pid, startedAt: ownStart })).toBe(true)
  // Same live pid, a start time from an hour ago: not this process — a pid handed out again.
  const anHourAgo = new Date(Date.now() - 3_600_000).toISOString()
  expect(isProcessMarkerAlive({ process: 'test', pid: process.pid, startedAt: anHourAgo })).toBe(false)
  // A start in the future is no process that ever ran.
  expect(
    isProcessMarkerAlive({ process: 'test', pid: process.pid, startedAt: new Date(Date.now() + 60_000).toISOString() }),
  ).toBe(false)
})

test("⚠ a running writer's staging file is a marker mid-write: never reported, never removed; a dead writer's is removed as unreadable (#906)", async () => {
  const logsDir = mkdtempSync(join(tmpdir(), 'enso-logs-'))
  const markers = processMarkersDir(logsDir)
  mkdirSync(markers)
  // Empty, as `writeFileSync` leaves it the instant before its bytes land. Removing it would fail the writer's rename.
  const live = join(markers, `web-${process.pid}.json.${process.pid}.tmp`)
  writeFileSync(live, '')
  expect(reconcileProcessMarkers(logsDir, -1)).toEqual([])
  expect(readdirSync(markers)).toEqual([`web-${process.pid}.json.${process.pid}.tmp`])

  const ended = Bun.spawn(['true'])
  await ended.exited
  const left = join(markers, `web-${ended.pid}.json.${ended.pid}.tmp`)
  writeFileSync(left, '{"process":"web"')
  expect(reconcileProcessMarkers(logsDir, -1)).toEqual([{ kind: 'unreadable', path: left }])
  expect(readdirSync(markers)).toEqual([`web-${process.pid}.json.${process.pid}.tmp`])
})

test('a second configure in the same process is refused — one configurator per process, or it is a bug', async () => {
  const logsDir = mkdtempSync(join(tmpdir(), 'enso-logs-'))
  await configureProcessLogging({ logsDir, process: 'server' })
  await expect(configureProcessLogging({ logsDir, process: 'web' })).rejects.toThrow()
})

// ── reading the file back ─────────────────────────────────────────────────────────────

test("a line reads back as the record it was: the template's placeholders take their values; one with no value stays literal; WARN is warning", () => {
  const record = logRecordOf({
    '@timestamp': '2026-09-09T23:41:22.799Z',
    level: 'WARN',
    message: '{toolName} denied: {reason} — {absent}',
    logger: 'enso.extension.guards',
    properties: { toolName: 'write', reason: 'outside the root', threadId: 't1' },
  })
  expect(record.category).toEqual(['enso', 'extension', 'guards'])
  expect(record.level).toBe('warning')
  expect(record.timestamp).toBe(Date.parse('2026-09-09T23:41:22.799Z'))
  expect(record.message).toEqual(['', 'write', ' denied: ', 'outside the root', ' — ', '{absent}', ''])
  expect(record.rawMessage).toBe('{toolName} denied: {reason} — {absent}')
  // Rendered by the terminal's formatter: the values in the sentence, no braces left.
  const rendered = ensoLogLineRenderer({ wordWrap: false })({
    '@timestamp': '2026-09-09T23:41:22.799Z',
    level: 'INFO',
    message: 'run {generation} acquired',
    logger: 'enso.server.threads',
    properties: { generation: 1 },
  }).replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '')
  expect(rendered).toContain('run 1 acquired')
  expect(rendered).not.toContain('{generation}')
})

// ── the knob ──────────────────────────────────────────────────────────────────────────

test("ENSO_LOG_LEVEL: a tier, optional per-category overrides; ENSO_LOG_CONSOLE its own; the launcher's console default otherwise", () => {
  expect(parseEnsoLogLevels({}, { console: 'info' })).toEqual({ file: 'info', console: 'info', overrides: [] })
  expect(parseEnsoLogLevels({ ENSO_LOG_LEVEL: 'trace', ENSO_LOG_CONSOLE: 'warn' }, { console: 'info' })).toEqual({
    file: 'trace',
    console: 'warning',
    overrides: [],
  })
  expect(
    parseEnsoLogLevels(
      { ENSO_LOG_LEVEL: 'info, enso.host.events=trace ,enso.extension.guards=debug' },
      { console: undefined },
    ),
  ).toEqual({
    file: 'info',
    console: undefined,
    overrides: [
      { category: ['enso', 'host', 'events'], level: 'trace' },
      { category: ['enso', 'extension', 'guards'], level: 'debug' },
    ],
  })
})

test('⚠ a knob value that is not a level is a startup error naming it — never a silent default', () => {
  expect(() => parseEnsoLogLevels({ ENSO_LOG_LEVEL: 'verbose' }, { console: undefined })).toThrow(EnsoLogLevelError)
  expect(() => parseEnsoLogLevels({ ENSO_LOG_LEVEL: 'info,host.events=trace' }, { console: undefined })).toThrow(
    /host\.events=trace/,
  )
  expect(() => parseEnsoLogLevels({ ENSO_LOG_CONSOLE: 'loud' }, { console: undefined })).toThrow(
    /ENSO_LOG_CONSOLE="loud"/,
  )
})

test("the effective level is the longest matching override, else the file's", () => {
  const levels = parseEnsoLogLevels(
    { ENSO_LOG_LEVEL: 'info,enso.host=debug,enso.host.events=trace' },
    { console: undefined },
  )
  expect(effectiveFileLevel(levels, ['enso', 'server', 'http'])).toBe('info')
  expect(effectiveFileLevel(levels, ['enso', 'host'])).toBe('debug')
  expect(effectiveFileLevel(levels, ['enso', 'host', 'ui'])).toBe('debug')
  expect(effectiveFileLevel(levels, ['enso', 'host', 'events'])).toBe('trace')
  expect(effectiveFileLevel(levels, ['enso', 'host', 'events', 'deep'])).toBe('trace')
})

test("⚠ the file holds the tier the knob picked: at info a debug line is not written; with the subtree turned up, it is — and the console's level is its own", async () => {
  const logsDir = mkdtempSync(join(tmpdir(), 'enso-logs-'))
  const dispose = await configureProcessLogging({
    logsDir,
    process: 'server',
    levels: parseEnsoLogLevels({ ENSO_LOG_LEVEL: 'info,enso.host.events=trace' }, { console: undefined }),
  })
  ensoLogger('server', 'http').debug('not written')
  ensoLogger('server', 'http').info('written')
  ensoLogger('host', 'events').trace('written too, the subtree is up')
  ensoLogger('host', 'ui').debug('not written, a sibling subtree')
  await dispose()
  const messages = linesOf(join(logsDir, ensoLogFilename(new Date()))).map(
    (line) => (JSON.parse(line) as EnsoLogLine).message,
  )
  expect(messages.slice(1)).toEqual(['written', 'written too, the subtree is up'])
})

// #284: the per-observation path built two payloads per token and the default tier threw
// both away. A thunk is the whole point only if the gate runs FIRST — a `wrap` that called
// it and forwarded the object would type-check, pass every other test here, and buy nothing.
test('⚠ a payload thunk is called only for a record the tier admits — and its object is the line', async () => {
  const logsDir = mkdtempSync(join(tmpdir(), 'enso-logs-thunk-'))
  const dispose = await configureProcessLogging({ logsDir, process: 'server' })
  const log = ensoLogger('server', 'probe')
  let built = 0
  const payload = (): { chars: number } => {
    built += 1
    return { chars: 7 }
  }
  log.debug('dropped at the default tier', payload)
  log.trace('dropped too', payload)
  expect(built).toBe(0)
  log.info('admitted, {chars} of them', payload)
  expect(built).toBe(1)
  await dispose()
  const written = linesOf(join(logsDir, ensoLogFilename(new Date()))).map((line) => JSON.parse(line) as EnsoLogLine)
  // One line beyond the configuration record: the dropped pair never reached the file, and
  // the admitted one carries what the thunk returned.
  expect(written.slice(1).map((line) => [line.message, line.properties?.chars])).toEqual([
    ['admitted, {chars} of them', 7],
  ])
})

// #139: the gap #132 accepted. Redaction by field NAME cannot see a secret quoted inside a
// message, inside an innocently-named property, or inside a `trace` payload — and those are
// exactly the shapes a guard's `reason` and a tool's output take.
test('⚠ a known secret VALUE is scrubbed wherever it appears: in the message, in a plainly-named property, inside a trace payload (#139)', async () => {
  const logsDir = mkdtempSync(join(tmpdir(), 'enso-logs-values-'))
  const secret = 'tvly-LIVE-VALUE-MUST-NOT-LAND'
  const dispose = await configureProcessLogging({
    logsDir,
    process: 'server',
    levels: { file: 'trace', console: undefined, overrides: [] },
    secretValues: [secret],
  })
  const log = ensoLogger('server', 'probe')
  // 1. quoted in the message itself — no property to name.
  log.info(`a command was refused: curl -H "x-key: ${secret}" https://example.com`)
  // 2. inside a property whose name is not secret-shaped: a guard's reason, a path.
  log.warn('bash command refused: {reason}', { reason: `the command carried --token ${secret}`, threadId: 't1' })
  // 3. inside a nested payload, which is what `trace` writes.
  log.trace('tool-result payload', { observation: { kind: 'tool-result', text: `KEY=${secret}\n`, isError: false } })
  await dispose()

  const text = readFileSync(join(logsDir, ensoLogFilename(new Date())), 'utf8')
  expect(text).not.toContain('LIVE-VALUE-MUST-NOT-LAND')
  // Present, and counted as a value redaction rather than a field one — the manifest tells a
  // reader that something leaked and was caught, not that a field was shaped right.
  const lines = linesOf(join(logsDir, ensoLogFilename(new Date()))).map((line) => JSON.parse(line) as EnsoLogLine)
  for (const line of lines) expect(Check(EnsoLogLine, line)).toBe(true)
  expect(redactionManifest(lines).values).toBe(3)
  // The rest of each record survives: this is a replacement, not a dropped record.
  expect(text).toContain('https://example.com')
  expect(text).toContain(ENSO_REDACTED_VALUE)
})

test('with no known values the pass does not run — an ordinary record is untouched', async () => {
  const logsDir = mkdtempSync(join(tmpdir(), 'enso-logs-novalues-'))
  const dispose = await configureProcessLogging({ logsDir, process: 'server' })
  ensoLogger('server', 'probe').info('nothing to scrub here')
  await dispose()
  expect(readFileSync(join(logsDir, ensoLogFilename(new Date())), 'utf8')).toContain('nothing to scrub here')
})

// Review of the lint/hardening pass. The value pass rebuilds every object structurally, and
// an Error's `message`/`stack` are own but NON-ENUMERABLE — so `Object.entries` saw `{}` and
// wrote `{}`. The records that carry an Error are exactly the ones someone reads to find out
// why: the guard's analyzer-failure deny, the server's handler failure.
test('⚠ an Error property survives the value pass with its message and stack — and is still scrubbed', async () => {
  const logsDir = mkdtempSync(join(tmpdir(), 'enso-logs-error-'))
  const secret = 'tvly-LIVE-VALUE-IN-AN-ERROR'
  const dispose = await configureProcessLogging({
    logsDir,
    process: 'server',
    secretValues: [secret],
  })
  ensoLogger('server', 'probe').error('handler failed: {error}', {
    error: new Error(`refused while sending ${secret}`),
  })
  await dispose()

  const file = join(logsDir, ensoLogFilename(new Date()))
  const text = readFileSync(file, 'utf8')
  // Every process's first record is `logging configured`; the one under test is the ERROR.
  const records = linesOf(file).map((line) => JSON.parse(line) as EnsoLogLine)
  const record = records.find((candidate) => candidate.level === 'ERROR')
  const properties = record?.properties ?? {}
  if (!('error' in properties)) throw new Error('the record carried no error property at all')
  const error = properties.error
  if (error === null || typeof error !== 'object') throw new Error(`the error was flattened to ${String(error)}`)
  expect('name' in error && error.name).toBe('Error')
  // The reason survives — this is the whole point; it used to be `{}`.
  expect('message' in error && String(error.message)).toContain('refused while sending')
  expect('stack' in error && typeof error.stack).toBe('string')
  // …and the secret quoted inside it does not.
  expect(text).not.toContain('LIVE-VALUE-IN-AN-ERROR')
  expect('message' in error && String(error.message)).toContain(ENSO_REDACTED_VALUE)
})

// PR #153 review, issue 1: a JS alternation takes the FIRST matching branch, not the longest.
// Two live keys from one provider — or a key and its rotation — routinely share a prefix.
test('⚠ a known value that is a prefix of another known value does not truncate the redaction', async () => {
  const logsDir = mkdtempSync(join(tmpdir(), 'enso-logs-prefix-'))
  const dispose = await configureProcessLogging({
    logsDir,
    process: 'server',
    // The shorter one first: the order `knownSecretValues` would have produced from a file.
    secretValues: ['sk-notarealsecret-abc', 'sk-notarealsecret-abcdef99'],
  })
  ensoLogger('server', 'probe').info('leaked: sk-notarealsecret-abcdef99')
  await dispose()
  const text = readFileSync(join(logsDir, ensoLogFilename(new Date())), 'utf8')
  // Before the fix this file held `[REDACTED:value]def99` — the tail of a live key.
  expect(text).not.toContain('def99')
  expect(text).toContain(`leaked: ${ENSO_REDACTED_VALUE}`)
})

// PR #153 review, issue 2: the console sink is wrapped the same way as the file (#134's
// lesson), and now says so under test rather than by inspection.
test('⚠ the terminal gets the value pass too: a known secret never reaches console output', async () => {
  const printed: string[] = []
  const spy = spyOn(console, 'info').mockImplementation((...parts: unknown[]) => {
    printed.push(parts.map(String).join(' '))
  })
  try {
    const dispose = await configureProcessLogging({
      logsDir: mkdtempSync(join(tmpdir(), 'enso-logs-console-')),
      process: 'server',
      levels: { file: 'info', console: 'info', overrides: [] },
      secretValues: ['tvly-notarealsecret-console'],
    })
    // Quoted in the message and in a plainly-named property: neither is a secret-shaped
    // FIELD, so the name pass has nothing to catch and only the value pass can.
    ensoLogger('server', 'probe').info('a command carried tvly-notarealsecret-console', {
      reason: 'the command carried tvly-notarealsecret-console',
    })
    await dispose()
    expect(printed.join('\n')).not.toContain('tvly-notarealsecret-console')
    expect(printed.join('\n')).toContain(ENSO_REDACTED_VALUE)
  } finally {
    spy.mockRestore()
  }
})

// #207: the read path was per call and the redaction path was a boot snapshot. A key added
// or rotated in `.enso/secrets.env` while a launcher runs is immediately live for
// `readSecret` — web-search's own refusal tells the operator to do exactly this — and was
// absent from every sink's alternation for the remaining lifetime of that process.
test('⚠ a key rotated while the process runs is redacted from the next record on, no restart (#207)', async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'enso-rotation-root-'))
  mkdirSync(join(repoRoot, '.enso'))
  const secretsFile = ensoSecretsPath(repoRoot)
  writeFileSync(secretsFile, 'TAVILY_API_KEY=tvly-notarealsecret-BOOT-000\n')
  const logsDir = mkdtempSync(join(tmpdir(), 'enso-logs-rotation-'))
  const dispose = await configureProcessLogging({
    logsDir,
    process: 'server',
    secretValues: knownSecretValuesTracking(repoRoot, {}),
  })
  const log = ensoLogger('server', 'probe')
  log.warn('bash command refused: {reason}', {
    reason: 'the command carried --token tvly-notarealsecret-BOOT-000',
  })
  // The rotation, with the launcher still running.
  writeFileSync(secretsFile, 'TAVILY_API_KEY=tvly-notarealsecret-ROTATED-999\n')
  expect(readSecret(repoRoot, 'TAVILY_API_KEY')).toBe('tvly-notarealsecret-ROTATED-999')
  log.warn('bash command refused: {reason}', {
    reason: 'the command carried --token tvly-notarealsecret-ROTATED-999',
  })
  await dispose()

  const text = readFileSync(join(logsDir, ensoLogFilename(new Date())), 'utf8')
  // Reproduced before the thunk existed: this line held the rotated key verbatim.
  expect(text).not.toContain('ROTATED-999')
  // …and the key the snapshot did know is still redacted: the rebuild replaces the set, it
  // does not shift a window over it.
  expect(text).not.toContain('BOOT-000')
  expect(text.split(ENSO_REDACTED_VALUE)).toHaveLength(3)
})

// #207, same surface: the day file was `0664` while every source it may quote — the secrets
// file itself, through a record carrying a value the redactor did not know yet — is `0600`.
// Every reader is the same user: `bun run logs`, the bundle route in the server, and the
// three writers are all processes the operator started.
//
// ⚠ NOT covered: the LOCAL-MIDNIGHT rollover, where the sink names a new file and the
// writer owns it on the next record. It needs a fake clock inside LogTape's sink; a red line
// here would mean today's file, not tomorrow's.
test('⚠ the day file is created owner-only (#207)', async () => {
  const logsDir = mkdtempSync(join(tmpdir(), 'enso-logs-mode-'))
  const dispose = await configureProcessLogging({ logsDir, process: 'server' })
  await dispose()
  expect(statSync(join(logsDir, ensoLogFilename(new Date()))).mode & 0o777).toBe(0o600)
})

test('a day file an older build left group-readable is tightened when a process configures (#207)', async () => {
  const logsDir = mkdtempSync(join(tmpdir(), 'enso-logs-mode-legacy-'))
  const legacyFile = join(logsDir, ensoLogFilename(new Date()))
  writeFileSync(legacyFile, '')
  chmodSync(legacyFile, 0o664)
  const dispose = await configureProcessLogging({ logsDir, process: 'server' })
  await dispose()
  expect(statSync(legacyFile).mode & 0o777).toBe(0o600)
})

/**
 * ⚠ A RENAMED KNOB THAT NOBODY READS IS SILENT. Every `ZEN_*` variable became `ENSO_*` with the
 * Enso rename; a shell profile still exporting the old spelling would otherwise get the default
 * and no explanation — a session logging at `info` when its author asked for `trace`. The refusal
 * is thrown from the one function every process that configures logging calls.
 */
test('⚠ a variable from before the rename is refused by name, never ignored', () => {
  expect(retiredEnvironmentNames({ ENSO_LOG_LEVEL: 'trace' })).toEqual([])
  // Unset is not stale: an absent variable is absent however it is spelled.
  expect(retiredEnvironmentNames({ ZEN_LOG_LEVEL: undefined })).toEqual([])
  expect(retiredEnvironmentNames({ ZEN_LOG_LEVEL: 'trace', ZEN_LOGS_DIR: '/tmp/x' })).toEqual([
    'ZEN_LOGS_DIR',
    'ZEN_LOG_LEVEL',
  ])
  // The throw names every stale variable AND what to rename it to, so the fix is the message.
  expect(() => parseEnsoLogLevels({ ZEN_LOG_LEVEL: 'trace' }, { console: 'info' })).toThrow(
    /ZEN_LOG_LEVEL.*Rename to ENSO_LOG_LEVEL/s,
  )
  // And a clean environment still parses.
  expect(parseEnsoLogLevels({ ENSO_LOG_LEVEL: 'debug' }, { console: 'info' }).file).toBe('debug')
})

/**
 * What a launch tells the user about its two migrations (#421, #552), on the launcher's own
 * logger: a move is one `info` line with the count, and everything left where it was is its own
 * `warning`, named, because nothing is overwritten and the user decides. A launch that moved
 * nothing says nothing.
 */
test("a launch's `.enso/` move: one info line for what moved, a warning per file kept, and one when ENSO_HOME held it", async () => {
  const logs = await recordEnsoLogs()
  const from = '/work/checkout/.enso'
  const to = '/home/user/custom-enso'
  reportHomeMigration(ensoLogger('server', 'dev'), {
    from,
    to,
    moved: ['secrets.env', 'pi-agent/auth.json'],
    kept: ['config.json', 'pi-agent/settings.json'],
    held: true,
  })
  expect(logs.records.map(({ category, level, properties }) => ({ category, level, properties }))).toEqual([
    { category: [ENSO_LOG_ROOT, 'server', 'dev'], level: 'info', properties: { count: 2, from, to } },
    { category: [ENSO_LOG_ROOT, 'server', 'dev'], level: 'warning', properties: { path: 'config.json', from, to } },
    {
      category: [ENSO_LOG_ROOT, 'server', 'dev'],
      level: 'warning',
      properties: { path: 'pi-agent/settings.json', from, to },
    },
    { category: [ENSO_LOG_ROOT, 'server', 'dev'], level: 'warning', properties: { from, to } },
  ])
  const [moved, kept, , held] = logs.records.map(({ rawMessage }) => String(rawMessage))
  expect(moved).toContain('moved {count} file(s)')
  expect(kept).toContain('nothing is overwritten')
  expect(held).toContain('was not moved: ENSO_HOME is set')
})

test("a launch's session move: what moved, then each kept file, gone directory and headerless file, in that order", async () => {
  const logs = await recordEnsoLogs()
  reportSessionMigration(
    ensoLogger('server', 'web'),
    {
      moved: ['/p/a.jsonl', '/p/b.jsonl', '/p/c.jsonl'],
      kept: ['/legacy/kept.jsonl'],
      orphaned: ['/legacy/--gone--'],
      unreadable: ['/legacy/tail.jsonl'],
    },
    '/home/user/.enso/projects',
  )
  expect(
    logs.records.map(({ level, properties, rawMessage }) => [level, properties, String(rawMessage).split(':')[0]]),
  ).toEqual([
    [
      'info',
      { count: 3, projectsDir: '/home/user/.enso/projects' },
      'moved {count} session file(s) into their project folders under {projectsDir} (#552)',
    ],
    ['warning', { path: '/legacy/kept.jsonl' }, '{path} stays where it was'],
    ['warning', { directory: '/legacy/--gone--' }, '{directory} stays where it was'],
    ['warning', { path: '/legacy/tail.jsonl' }, '{path} stays where it was'],
  ])
  expect(String(logs.records[1]?.rawMessage)).toContain('already holds a file of that name')
  expect(String(logs.records[2]?.rawMessage)).toContain('no longer exists')
  expect(String(logs.records[3]?.rawMessage)).toContain('no session header')
})

test('a launch that moved nothing and kept nothing logs nothing about either migration', async () => {
  const logs = await recordEnsoLogs()
  const log = ensoLogger('server', 'dev')
  reportHomeMigration(log, { from: '/work/checkout/.enso', to: '/home/user/.enso', moved: [], kept: [], held: false })
  reportSessionMigration(log, { moved: [], kept: [], orphaned: [], unreadable: [] }, '/home/user/.enso/projects')
  expect(logs.records).toEqual([])
})
