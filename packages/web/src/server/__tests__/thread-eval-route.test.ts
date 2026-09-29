import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ENSO_LOG_EVENTS,
  ENSO_OPERATOR_DENIAL_ENTRY,
  type EnsoLogLine,
  EnsoSessionEval,
  type EnsoTranscriptEntry,
} from '@enso/core'
import { ensoLogFilename } from '@enso/core/log-process'
import { Check } from 'typebox/value'
import { createThreadEvalRoute } from '../thread-eval-route.ts'
import type { ThreadView } from '../thread-registry.ts'
import { createFakeAgentHost, createFakeHostedThread } from './fake-hosted-thread.ts'

/**
 * #441: one thread's eval — the branch from pi, the log's queued admissions and aborts from the
 * day files the branch spans. Driven with the fake host and day files under a temporary directory.
 */

const THREAD = 'thread-eval-1'
const EARLIER = new Date(2026, 8, 19, 12)
const FIRST_DAY = new Date(2026, 8, 21, 10)
const TODAY = new Date(2026, 8, 22, 15)

function at(day: Date, seconds: number): string {
  const moment = new Date(day)
  moment.setSeconds(moment.getSeconds() + seconds)
  return moment.toISOString()
}

const TRANSCRIPT: EnsoTranscriptEntry[] = [
  { kind: 'message', id: 'u1', at: at(FIRST_DAY, 0), role: 'user', parts: [{ type: 'text', text: 'check the tests' }] },
  {
    kind: 'message',
    id: 'a1',
    at: at(FIRST_DAY, 5),
    role: 'assistant',
    parts: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'bash', args: { command: 'bun test' } }],
  },
  {
    kind: 'tool-result',
    id: 'r1',
    at: at(FIRST_DAY, 9),
    toolCallId: 'c1',
    toolName: 'bash',
    text: 'ok',
    isError: false,
  },
  {
    kind: 'custom',
    id: 'd1',
    at: at(TODAY, 1),
    customType: ENSO_OPERATOR_DENIAL_ENTRY,
    data: { dialogId: 'q', option: 'No', title: 'Run command' },
  },
  { kind: 'message', id: 'u2', at: at(TODAY, 2), role: 'user', parts: [{ type: 'text', text: "no, that's wrong" }] },
]

function serverLine(stamp: string, message: string, properties: Record<string, unknown>): EnsoLogLine {
  return {
    '@timestamp': stamp,
    level: 'INFO',
    message,
    logger: 'enso.server.http',
    properties: { process: 'server', threadId: THREAD, ...properties },
  }
}

function writeDay(logsDir: string, day: Date, lines: readonly EnsoLogLine[]): void {
  writeFileSync(join(logsDir, ensoLogFilename(day)), `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)
}

function logsDirForTheThread(): string {
  const logsDir = mkdtempSync(join(tmpdir(), 'enso-thread-eval-'))
  // Before the branch began: not this branch's, not read.
  writeDay(logsDir, EARLIER, [serverLine(at(EARLIER, 0), ENSO_LOG_EVENTS.runAborted, { generation: 1, restored: 0 })])
  writeDay(logsDir, FIRST_DAY, [
    serverLine(at(FIRST_DAY, 0), ENSO_LOG_EVENTS.promptAdmitted, {
      messageId: 'm1',
      generation: 1,
      admission: 'opened',
    }),
    serverLine(at(FIRST_DAY, 3), ENSO_LOG_EVENTS.promptAdmitted, {
      messageId: 'm2',
      generation: 1,
      admission: 'queued',
    }),
    // Another thread's lines are filtered out by id.
    {
      ...serverLine(at(FIRST_DAY, 4), ENSO_LOG_EVENTS.runAborted, { generation: 1, restored: 0 }),
      properties: { threadId: 'other', generation: 1 },
    },
  ])
  writeDay(logsDir, TODAY, [serverLine(at(TODAY, 0), ENSO_LOG_EVENTS.runAborted, { generation: 2, restored: 1 })])
  return logsDir
}

const noLiveThread = { peek: (): ThreadView | undefined => undefined }

test("a stored thread's eval joins the branch's events with the log's queued admissions and aborts, from the days its branch spans", async () => {
  const route = createThreadEvalRoute({
    threads: noLiveThread,
    host: createFakeAgentHost(() => Promise.reject(new Error('looking must not build')), {
      [THREAD]: { transcript: TRANSCRIPT, modified: TODAY, firstMessage: 'check the tests' },
    }),
    logsDir: logsDirForTheThread(),
    now: () => TODAY,
  })
  const evaluated = await route(THREAD)
  expect(evaluated).toBeDefined()
  expect(Check(EnsoSessionEval, evaluated)).toBe(true)
  expect(evaluated?.live).toBe(false)
  expect(evaluated?.logDays).toEqual(['2026-09-21', '2026-09-22'])
  expect(evaluated?.events.map((event) => event.kind)).toEqual([
    'human',
    'prompt-queued',
    'gate',
    'interrupt',
    'tool-denied',
    'human-correction',
  ])
  expect(evaluated?.scorecard).toMatchObject({
    humanMessages: 2,
    queuedMessages: 1,
    interrupts: 1,
    corrections: 1,
    operatorDenials: 1,
    refusalsTotal: 1,
    gateRuns: 1,
    gatePassed: 1,
  })
})

test('a live thread is answered from its session; with no day file its log-side counts are unknown; a thread held nowhere is no answer', async () => {
  const live = createFakeHostedThread({ inspect: { entries: TRANSCRIPT } })
  const route = createThreadEvalRoute({
    threads: {
      peek: (threadId: string) => (threadId === THREAD ? ({ hosted: live.hosted } as ThreadView) : undefined),
    },
    host: createFakeAgentHost(() => Promise.reject(new Error('looking must not build')), {}),
    logsDir: mkdtempSync(join(tmpdir(), 'enso-thread-eval-empty-')),
    now: () => TODAY,
  })
  const evaluated = await route(THREAD)
  expect(evaluated?.live).toBe(true)
  expect(evaluated?.scorecard.humanMessages).toBe(2)
  expect(evaluated?.scorecard.queuedMessages).toBeNull()
  expect(evaluated?.scorecard.interrupts).toBeNull()
  expect(evaluated?.logDays).toEqual([])
  expect(await route('nowhere')).toBeUndefined()
})
