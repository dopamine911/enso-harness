import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bundleRecordsText, ZEN_REDACTED, type ZenLogLine } from '@zen/core'
import { parseZenLogLine, zenLogFilename } from '@zen/core/log-process'
import { createEventTail } from '../../host/event-tail.ts'
import {
  BUNDLE_MAX_RECORDS,
  type BundleRouteOutcome,
  createAboutRoute,
  createBundleRoute,
  describeCheckout,
} from '../bundle-route.ts'
import type { ThreadView } from '../thread-registry.ts'
import { createFakeHostedThread } from './fake-hosted-thread.ts'

/** A live thread as the registry would list it — the inspection is what the bundle carries. */
function liveThread(threadId: string): ThreadView {
  const { hosted } = createFakeHostedThread({
    runtime: () => ({ permissionModeState: () => ({ mode: 'plan', available: ['default', 'plan'] }) }),
    inspect: { sessionId: `session-${threadId}`, cwd: '/work', sessionDir: '/sessions', commands: ['plan'] },
  })
  return {
    threadId,
    hosted,
    busy: false,
    generation: 1,
    lastActivityAt: Date.parse('2026-09-10T01:00:00Z'),
    sent: createEventTail(),
  }
}

const line = (threadId: string, message: string, extra: Record<string, unknown> = {}): ZenLogLine => ({
  '@timestamp': '2026-09-10T01:00:00.000Z',
  level: 'INFO',
  logger: 'zen.server.events',
  message,
  properties: { process: 'server', sequence: 1, threadId, ...extra },
})

const DAY = new Date('2026-09-10T12:00:00')

const bodyOf = (outcome: BundleRouteOutcome): string => {
  if (outcome.status !== 200) throw new Error(outcome.reason)
  return outcome.body
}

function logsDirWith(lines: readonly (ZenLogLine | string)[]): string {
  const logsDir = mkdtempSync(join(tmpdir(), 'zen-bundle-'))
  writeFileSync(
    join(logsDir, zenLogFilename(DAY)),
    `${lines.map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry))).join('\n')}\n`,
  )
  return logsDir
}

test("the bundle is today's records for the thread, its live inspection, and the versions — readable back through the same parser", () => {
  const logsDir = logsDirWith([
    line('t1', 'run {generation} acquired', { generation: 1 }),
    line('t2', 'run {generation} acquired', { generation: 1 }),
    line('t1', 'prompt refused', { tavilyApiKey: ZEN_REDACTED }),
  ])
  const route = createBundleRoute({
    threads: { list: () => [liveThread('t1'), liveThread('t2')] },
    logsDir,
    runtimeVersion: '1.2.3',
    now: () => DAY,
  })
  const outcome = route(new URLSearchParams('thread=t1'))
  if (outcome.status !== 200) throw new Error(outcome.reason)
  const { filename, body } = outcome

  expect(filename).toBe('zen-bundle-2026-09-10-t1.md')
  const records = bundleRecordsText(body)
    .split('\n')
    .map((raw) => parseZenLogLine(raw))
  expect(records.map((record) => (typeof record === 'string' ? record : record.properties?.threadId))).toEqual([
    't1',
    't1',
  ])
  expect(body).toContain('### thread t1')
  expect(body).not.toContain('### thread t2')
  expect(body).toContain('- `tavilyApiKey` × 1')
  // The version is the HOST's (#145): the route is handed a string and prints that one.
  expect(body).toContain('- pi: `1.2.3`')
  expect(body).toContain("selection: thread t1 from today's file (zen-2026-09-10.jsonl")
})

test('[WARN] no thread: every record and every live thread; the cap keeps the NEWEST and the heading says so', () => {
  const many: ZenLogLine[] = []
  for (let sequence = 0; sequence < BUNDLE_MAX_RECORDS + 3; sequence += 1) {
    many.push(line('t1', 'record {sequence}', { sequence }))
  }
  const route = createBundleRoute({
    threads: { list: () => [liveThread('t1')] },
    logsDir: logsDirWith(many),
    runtimeVersion: '1.2.3',
    now: () => DAY,
  })
  const outcome = route(new URLSearchParams())
  if (outcome.status !== 200) throw new Error(outcome.reason)
  const { filename, body } = outcome

  expect(filename).toBe('zen-bundle-2026-09-10.md')
  expect(body).toContain(`## log — the last ${BUNDLE_MAX_RECORDS} of ${BUNDLE_MAX_RECORDS + 3} records`)
  const records = bundleRecordsText(body).split('\n')
  expect(records).toHaveLength(BUNDLE_MAX_RECORDS)
  // The oldest three fell off the front, not the back.
  expect(records[0]).toContain('"sequence":3')
})

test('a missing file and a malformed line are said in the selection, never silently absent', () => {
  const empty = mkdtempSync(join(tmpdir(), 'zen-bundle-empty-'))
  const route = createBundleRoute({
    threads: { list: () => [] },
    logsDir: empty,
    runtimeVersion: '1.2.3',
    now: () => DAY,
  })
  expect(bodyOf(route(new URLSearchParams()))).toContain('does not exist yet: no process has logged today')

  const torn = createBundleRoute({
    threads: { list: () => [] },
    logsDir: logsDirWith([line('t1', 'ok'), '{not json', JSON.stringify({ level: 'INFO' })]),
    runtimeVersion: '1.2.3',
    now: () => DAY,
  })
  const body = bodyOf(torn(new URLSearchParams()))
  expect(body).toContain('2 line(s) of it were not records and are left out')
  expect(body).toContain('## log — 1 records')
  expect(body).toContain('none live at the time of the bundle')
})

test("[WARN] a thread that is not id-shaped is a 400, never a filename: a quote would end the header's attribute, a CR/LF would throw in the request callback (PR #138 review)", () => {
  const route = createBundleRoute({
    threads: { list: () => [] },
    logsDir: logsDirWith([line('t1', 'ok')]),
    runtimeVersion: '1.2.3',
    now: () => DAY,
  })
  for (const hostile of ['t1"; x="y', 't1\r\nX-Injected: 1', '../etc', ' t1', 't1 x']) {
    expect(route(new URLSearchParams({ thread: hostile }))).toEqual({
      status: 400,
      reason: 'thread must be a thread id or a prefix of one',
    })
  }
  // A prefix of a valid id is a valid id: the one check serves both the filter and the filename.
  expect(route(new URLSearchParams({ thread: '6923e6' }))).toMatchObject({
    status: 200,
    filename: 'zen-bundle-2026-09-10-6923e6.md',
  })
})

test('the checkout is described from .git by hand: a branch ref, a detached head, and no checkout at all', () => {
  const repo = mkdtempSync(join(tmpdir(), 'zen-checkout-'))
  expect(describeCheckout(repo)).toBe('unknown (no .git)')

  mkdirSync(join(repo, '.git', 'refs', 'heads', 'feat'), { recursive: true })
  writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/feat/x\n')
  writeFileSync(join(repo, '.git', 'refs', 'heads', 'feat', 'x'), '0123456789abcdef0123456789abcdef01234567\n')
  expect(describeCheckout(repo)).toBe('0123456789ab (feat/x)')

  // A packed ref (after `git gc`): the loose file is gone, the row in packed-refs remains.
  rmSync(join(repo, '.git', 'refs', 'heads', 'feat', 'x'))
  writeFileSync(
    join(repo, '.git', 'packed-refs'),
    '# pack-refs\nabcdefabcdefabcdefabcdefabcdefabcdefabcd refs/heads/feat/x\n',
  )
  expect(describeCheckout(repo)).toBe('abcdefabcdef (feat/x)')

  writeFileSync(join(repo, '.git', 'HEAD'), 'fedcba9876543210fedcba9876543210fedcba98\n')
  expect(describeCheckout(repo)).toBe('fedcba987654')
})

// #144: one `about` builder for both surfaces. The claim worth pinning is not that the route
// answers — it is that a bundle a user hands over and a dashboard reading `/api/about` cannot
// disagree about which checkout, runtime and machine produced them.
test("⚠ /api/about carries the same about the bundle's header does — one builder, no drift (#144)", () => {
  const deps = { runtimeVersion: '1.2.3', now: (): Date => DAY }
  const about = createAboutRoute(deps)()
  const body = bodyOf(
    createBundleRoute({ threads: { list: () => [] }, logsDir: logsDirWith([line('t1', 'ok')]), ...deps })(
      new URLSearchParams(),
    ),
  )
  expect(about.at).toBe(DAY.toISOString())
  for (const row of [
    `- zen: \`${about.zen}\``,
    `- pi: \`${about.pi}\``,
    `- bun: \`${about.bun}\``,
    `- os: ${about.os}`,
  ]) {
    expect(body).toContain(row)
  }
  // Its own `selection` says what it is: a header with no records behind it.
  expect(about.selection).toContain('no records')
})
