import { expect, test } from 'bun:test'
import { ENSO_REDACTED, type EnsoLogLine } from '../log.ts'
import { browserSection, buildLogBundle, bundleRecordsText, isLogBundle, redactionManifest } from '../log-bundle.ts'
import { parseEnsoLogLine } from '../log-process.ts'
import type { EnsoThreadInspection } from '../thread-inspection.ts'

const line = (message: string, properties: Record<string, unknown>): EnsoLogLine => ({
  '@timestamp': '2026-09-10T01:00:00.000Z',
  level: 'INFO',
  logger: 'enso.server.events',
  message,
  properties,
})

const about = {
  at: '2026-09-10T01:02:03.000Z',
  enso: 'abc123 (main)',
  pi: '0.84.4',
  bun: '1.4.2',
  os: 'linux 6.12 x64',
  selection: "thread t1 from today's file",
}

const inspection: EnsoThreadInspection = {
  threadId: 't1',
  sessionId: 's1',
  cwd: '/work',
  sessionDir: '/sessions',
  sessionFile: null,
  permissionMode: { mode: 'plan', available: ['default', 'plan'] },
  commands: ['plan', 'mode'],
  busy: false,
  generation: 2,
  lastActivityAt: '2026-09-10T01:01:00.000Z',
  entries: [{ kind: 'custom', id: 'm1', customType: 'modes', at: '2026-09-10T01:00:30.000Z', data: { mode: 'plan' } }],
}

test('the manifest counts redaction MARKERS per field — what the reader is not seeing — and nothing else', () => {
  const lines = [
    line('prompt refused', { threadId: 't1', tavilyApiKey: ENSO_REDACTED, reason: 'denied' }),
    line('usage', { threadId: 't1', tokens: ENSO_REDACTED, tavilyApiKey: ENSO_REDACTED }),
    // A literal value that merely resembles the marker's shape is not a redaction.
    line('plain', { threadId: 't1', note: '[REDACTED-ish]' }),
  ]
  expect(redactionManifest(lines)).toEqual({ tavilyApiKey: 2, tokens: 1 })
  expect(redactionManifest([])).toEqual({})
})

test('a bundle is a log file with prose around it: the records come back out verbatim, in order, through the same parser', () => {
  const server = [line('run {generation} acquired', { threadId: 't1', generation: 1 })]
  const ring = [line('follow opened', { pageSequence: 1, threadId: 't1' })]
  const text = `${buildLogBundle({ about, threads: [inspection], lines: server, matched: 1 })}\n${browserSection(ring)}`

  expect(isLogBundle(text)).toBe(true)
  expect(isLogBundle(JSON.stringify(server[0]))).toBe(false)
  const recovered = bundleRecordsText(text)
    .split('\n')
    .map((raw) => parseEnsoLogLine(raw))
  expect(recovered).toEqual([...server, ...ring])

  // The prose says what a triage reads first.
  expect(text).toContain('- enso: `abc123 (main)`')
  expect(text).toContain('- pi: `0.84.4`')
  expect(text).toContain('### thread t1')
  expect(text).toContain('mode: plan · available: default, plan')
  expect(text).toContain('01:00:30 custom:modes mode=plan')
  expect(text).toContain('## log — 1 records')
  expect(text).toContain('nothing — no record carried a secret-shaped field')
})

test("the cut is visible: capped records say 'the last N of M'; redacted fields are listed with their counts", () => {
  const lines = [line('a', { tavilyApiKey: ENSO_REDACTED }), line('b', {})]
  const text = buildLogBundle({ about, threads: [], lines, matched: 7 })
  expect(text).toContain('## log — the last 2 of 7 records')
  expect(text).toContain('- `tavilyApiKey` × 1')
  expect(text).toContain('none live at the time of the bundle')
})

test('an empty ring says so rather than fencing nothing — and an empty block is not a record', () => {
  const text = browserSection([])
  expect(text).toContain("the page's ring was empty")
  expect(bundleRecordsText(`${buildLogBundle({ about, threads: [], lines: [], matched: 0 })}\n${text}`)).toBe('')
})

// The page's URL names the thread (#142): the line a reader opens to see it live - present in both shapes of the section.
test('the browser section carries the page URL when given one, with records and without', () => {
  const ring = [line('follow opened', { pageSequence: 1 })]
  expect(browserSection(ring, 'http://127.0.0.1:5178/?thread=t1')).toContain(
    '\nPage: http://127.0.0.1:5178/?thread=t1\n',
  )
  expect(browserSection([], 'http://127.0.0.1:5178/?thread=t1')).toContain('\nPage: http://127.0.0.1:5178/?thread=t1\n')
  expect(browserSection([])).not.toContain('Page:')
  // The records still round-trip through the reader with the line in place.
  expect(bundleRecordsText(browserSection(ring, 'http://x/?thread=t1'))).toBe(JSON.stringify(ring[0]))
})
