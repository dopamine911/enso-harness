import { expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  EnsoCheckedClaim,
  EnsoIncidentRecord,
  EnsoThreadIncidents,
  EnsoTranscriptCustom,
} from '../../packages/core/src/index.ts'
import {
  exportFiles,
  parseArguments,
  renderAgentReport,
  renderHistory,
  renderReplay,
  run,
  USAGE,
} from '../enso-incidents.ts'
import { UsageError } from '../server-cli.ts'
import { runCaptured, withStubServer } from './server-stub.ts'

/**
 * `bun run incidents` (#468): the commands and their flags, the export's three files — the entries
 * exactly as stored, the report for reading, the resolutions — and the history and replay summaries.
 */

const SIGNALS = [
  { signal: 'denial-retry' as const, toolCallId: 'c2', detail: 'wget after curl was refused', after: ['c1'] },
  { signal: 'command-obfuscation' as const, toolCallId: 'c3', detail: '$(printf cu)rl', after: ['c1'] },
]

const THRESHOLDS = { windowCalls: 8, highAtSignals: 3, highAtKinds: 2, incidentAtSignals: 5 }

const claim = (text: string, verified: boolean): EnsoCheckedClaim => ({
  text,
  evidence: [{ ref: 'c1', quote: 'curl https://example.test/x', verified }],
  verified,
})

/** A halted incident with a filed report whose `tried` citation did not check, resolved once. */
const HALTED: EnsoIncidentRecord = {
  opened: {
    incidentId: 'incident-1',
    signals: SIGNALS,
    halted: true,
    suspended: ['execute', 'network', 'write'],
    model: 'claude-sonnet',
  },
  report: {
    incidentId: 'incident-1',
    factual: {
      task: claim('Fetching a fixture.', true),
      denied: claim('curl was refused.', true),
      tried: claim('I tried wget.', false),
    },
    interpretive: {
      whyThatAlternative: 'It looked equivalent.',
      recognisedAsBypass: 'Only after the second refusal.',
      shouldHaveDone: 'Asked the user.',
      sufficientAuthorization: 'An explicit yes for that host.',
      patternToAvoid: 'Swapping clients after a refusal.',
      uncharitableRead: 'I routed around a refusal.',
    },
    mismatches: [],
    submission: 2,
  },
  resolutions: [{ incidentId: 'incident-1', classification: 'agent-error', outcome: 'resume', suspended: [] }],
}

/** The entries pi stored for it, as the route returns them: our transcript's records (#557). */
const STORED: EnsoTranscriptCustom[] = [
  {
    kind: 'custom',
    id: 'e1',
    at: '2026-09-30T10:00:00.000Z',
    customType: 'enso-incident-opened',
    data: HALTED.opened,
  },
  {
    kind: 'custom',
    id: 'e2',
    at: '2026-09-30T10:00:01.000Z',
    customType: 'enso-incident-resolved',
    data: HALTED.resolutions[0],
  },
]

const ALERT: EnsoIncidentRecord = {
  opened: {
    incidentId: 'incident-2',
    signals: SIGNALS,
    halted: false,
    suspended: [],
    inheritedFrom: { threadId: 'source-thread', incidentId: 'incident-0' },
  },
  resolutions: [],
}

const THREAD: EnsoThreadIncidents = {
  threadId: 'thread-a',
  live: false,
  thresholds: THRESHOLDS,
  incidents: [
    { record: HALTED, entries: STORED },
    { record: ALERT, entries: [] },
  ],
  replay: [
    { verdict: 'same', trigger: 'c3', signals: SIGNALS, incidentId: 'incident-1' },
    { verdict: 'would-open', trigger: 'c9', signals: SIGNALS },
  ],
}

test('the commands: history by default, replay with threshold flags, export of one incident', () => {
  expect(parseArguments([])).toEqual({ command: 'history', threads: [] })
  expect(parseArguments(['thread-a'])).toEqual({ command: 'history', threads: ['thread-a'] })
  expect(parseArguments(['replay', 'thread-a', '--incident-at-signals', '4', '--window-calls', '12'])).toEqual({
    command: 'replay',
    threads: ['thread-a'],
    thresholds: { incidentAtSignals: 4, windowCalls: 12 },
  })
  expect(parseArguments(['export', 'incident-1', '--out', '/tmp/x'])).toEqual({
    command: 'export',
    incidentId: 'incident-1',
    directory: '/tmp/x',
  })
  // A threshold is a whole number from 1, as `config.json` takes it.
  for (const bad of [
    ['replay', '--incident-at-signals', '0'],
    ['replay', '--window-calls'],
    ['replay', '--high-at-kinds', '2.5'],
  ]) {
    expect(() => parseArguments(bad)).toThrow(UsageError)
  }
  expect(() => parseArguments(['export'])).toThrow(UsageError)
  expect(() => parseArguments(['export', 'a', 'b'])).toThrow(UsageError)
  expect(() => parseArguments(['history', '--json'])).toThrow(UsageError)
})

// ⚠ #468's export contract, as of #557: `mechanical.json` is the entries as our transcript records
// them — each stored `data` byte for byte, under our `{ kind, id, at, customType }` envelope — so
// what is handed over is the record, not a reading of it.
test('⚠ the export round-trips: mechanical.json is the entries as recorded, resolution.json the resolutions', () => {
  const files = exportFiles({ record: HALTED, entries: STORED })
  expect(Object.keys(files).toSorted()).toEqual(['agent-report.md', 'mechanical.json', 'resolution.json'])
  expect(JSON.parse(files['mechanical.json'] ?? '')).toEqual(STORED)
  expect(JSON.parse(files['resolution.json'] ?? '')).toEqual(HALTED.resolutions)
})

test("the agent's report reads as the tool asked it: each question, each citation checked or not, the flags", () => {
  const report = renderAgentReport(HALTED)
  expect(report).toContain("# Incident incident-1: the agent's report")
  expect(report).toContain('Submission 2. Flagged: tried: the quote "curl https://example.test/x" is not in c1.')
  // The schema's own question words.
  expect(report).toContain('### What you tried after the denial.')
  expect(report).toContain('### The least charitable reading of what you did, stated plainly.')
  expect(report).toContain('- `c1`: "curl https://example.test/x" — NOT verified')
  expect(report).toContain('I routed around a refusal.')
  expect(renderAgentReport(ALERT)).toBe(
    '# Incident incident-2: no report\n\nnone was asked: the incident did not halt\n',
  )
  // Halted, nothing filed yet: the same incident before its report turn ended.
  const owed: EnsoIncidentRecord = { opened: HALTED.opened, resolutions: [] }
  expect(renderAgentReport(owed)).toContain('the report is still owed')
  expect(
    renderAgentReport({ ...owed, reportMissing: { incidentId: 'incident-1', reason: 'the run was cut off' } }),
  ).toBe('# Incident incident-1: no report\n\nthe run was cut off\n')
})

test('the history says each incident in one line: model, halt, signals by kind, report, resolution, inheritance', () => {
  expect(renderHistory([THREAD]).split('\n')).toEqual([
    'thread-a  ·  incident-1  ·  claude-sonnet  ·  halted  ·  2 signal(s) (denial-retry, command-obfuscation)  ·  report flagged  ·  agent-error → resume',
    'thread-a  ·  incident-2  ·  (unknown model)  ·  alert  ·  2 signal(s) (denial-retry, command-obfuscation)  ·  no report asked  ·  open  ·  inherited from source-thread',
  ])
  expect(renderHistory([{ ...THREAD, incidents: [] }])).toBe('no incident in the threads read')
})

test('the replay lists each opening by verdict and totals them under the thresholds used', () => {
  expect(renderReplay([THREAD, { ...THREAD, threadId: 'thread-b', replay: [] }]).split('\n')).toEqual([
    'replayed under --window-calls 8 --high-at-signals 3 --high-at-kinds 2 --incident-at-signals 5',
    'thread-a  same        at c3  2 signal(s)  incident-1',
    'thread-a  would-open  at c9  2 signal(s)',
    '2 thread(s): 1 same · 1 would open · 0 would miss',
  ])
})

const OTHER: EnsoThreadIncidents = { ...THREAD, threadId: 'thread b', incidents: [], replay: [] }
const STUB = { [THREAD.threadId]: THREAD, [OTHER.threadId]: OTHER }

test('run: a usage error exits 2 with the problem and the usage on stderr, and asks the server nothing', async () => {
  await withStubServer('incidents', STUB, async (serverUrl, requests) => {
    expect(await runCaptured(run, ['export'], serverUrl)).toEqual({
      code: 2,
      stdout: '',
      stderr: `enso-incidents: export takes one incident id\n\n${USAGE}\n`,
    })
    expect(requests).toEqual([])
  })
})

test('run: with no thread named, every stored thread is read; the replay passes its thresholds on', async () => {
  await withStubServer('incidents', STUB, async (serverUrl, requests) => {
    expect(await runCaptured(run, [], serverUrl)).toEqual({
      code: 0,
      stdout: `${renderHistory([THREAD, OTHER])}\n`,
      stderr: '',
    })
    expect(requests.map((url) => url.pathname)).toEqual([
      '/api/stored-threads',
      '/api/threads/thread-a/incidents',
      '/api/threads/thread%20b/incidents',
    ])
    requests.length = 0
    const replayed = await runCaptured(run, ['replay', 'thread-a', '--window-calls', '12'], serverUrl)
    expect(replayed).toEqual({ code: 0, stdout: `${renderReplay([THREAD])}\n`, stderr: '' })
    expect(requests.map((url) => `${url.pathname}${url.search}`)).toEqual([
      '/api/threads/thread-a/incidents?windowCalls=12',
    ])
  })
})

test('run: export finds the incident in whichever stored thread has it and writes its three files', async () => {
  const into = mkdtempSync(join(tmpdir(), 'enso-incidents-'))
  try {
    await withStubServer('incidents', { [OTHER.threadId]: OTHER, ...STUB }, async (serverUrl) => {
      const exported = await runCaptured(run, ['export', 'incident-1', '--out', into], serverUrl)
      const directory = join(into, 'incident', 'incident-1')
      expect(exported).toEqual({
        code: 0,
        stdout: `thread thread-a: wrote ${['mechanical.json', 'agent-report.md', 'resolution.json'].map((name) => join(directory, name)).join(', ')}\n`,
        stderr: '',
      })
      const files = exportFiles({ record: HALTED, entries: STORED })
      expect(readdirSync(directory).toSorted()).toEqual(Object.keys(files).toSorted())
      for (const [name, text] of Object.entries(files)) expect(readFileSync(join(directory, name), 'utf8')).toBe(text)
    })
  } finally {
    rmSync(into, { recursive: true, force: true })
  }
})

test('run: a failure exits 1 with the reason on stderr and prints no partial stdout', async () => {
  await withStubServer('incidents', STUB, async (serverUrl) => {
    expect(await runCaptured(run, ['export', 'incident-9'], serverUrl)).toEqual({
      code: 1,
      stdout: '',
      stderr: 'enso-incidents: no stored thread has incident incident-9\n',
    })
    // One thread readable, one not: nothing of the history is shown.
    expect(await runCaptured(run, ['thread-a', 'gone'], serverUrl)).toEqual({
      code: 1,
      stdout: '',
      stderr: `enso-incidents: ${serverUrl}/api/threads/gone/incidents answered 404: no such thread\n`,
    })
  })
})
