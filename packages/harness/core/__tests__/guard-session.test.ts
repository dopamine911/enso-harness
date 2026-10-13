import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_GUARD_POLICY,
  ENSO_GUARD_CHECK_CHANNEL,
  ENSO_GUARD_DENIAL_ENTRY,
  ENSO_INCIDENT_OPENED_ENTRY,
  ENSO_INCIDENT_REPORT_MISSING_ENTRY,
  ENSO_INCIDENT_RESOLVED_CHANNEL,
  type EnsoGuardRefusal,
  type EnsoIncidentOpened,
  type EnsoTranscriptEntry,
  incidentPolicyOf,
  incidentResolvedOf,
} from '@enso/core'
import { createGuardSession, type GuardCallOutcome, type GuardRuntime, type GuardSession } from '../guard-session.ts'

/**
 * The guard session through its port alone (#861): what a second runtime's glue relies on and the pi
 * suite (`extensions/guards/__tests__`) cannot see, since it drives the session through pi's glue.
 * The verdict paths themselves are that suite's: each is one decision, whichever glue asks.
 */

const WORKSPACE = mkdtempSync(join(tmpdir(), 'enso-guard-session-'))
const EVERY_POLICY_TOOL = ['read', 'write', 'edit', 'bash', 'powershell']

interface FakeRuntime extends GuardRuntime {
  readonly appended: { customType: string; data: unknown }[]
  announce(channel: string, data: unknown): void
}

function fakeRuntime(toolNames: () => readonly string[] = () => EVERY_POLICY_TOOL): FakeRuntime {
  const listeners = new Map<string, ((data: unknown) => void)[]>()
  const appended: { customType: string; data: unknown }[] = []
  const announce = (channel: string, data: unknown): void => {
    for (const listener of listeners.get(channel) ?? []) listener(data)
  }
  return {
    name: 'durable',
    appended,
    announce,
    append: (customType, data) => appended.push({ customType, data }),
    emit: announce,
    on: (channel, handler) => listeners.set(channel, [...(listeners.get(channel) ?? []), handler]),
    toolNames,
  }
}

function startedSession(runtime: GuardRuntime, transcript: readonly EnsoTranscriptEntry[] = []): GuardSession {
  const session = createGuardSession(runtime, {
    analyzeShell: () => undefined,
    harnessRoot: WORKSPACE,
    incidentPolicy: () => incidentPolicyOf({ incidents: { halt: true } }),
    logsDirectory: join(WORKSPACE, 'logs'),
    projectsDirectory: join(WORKSPACE, 'projects'),
    commandJudge: () => undefined,
    judgeSecretValues: () => [],
  })
  session.start({ recordDirectory: () => join(WORKSPACE, 'sessions'), transcript: () => transcript })
  return session
}

function call(session: GuardSession, toolName: string, input: unknown, toolCallId = 'c1'): GuardCallOutcome {
  return session.toolCall({ toolCallId, toolName, input, cwd: WORKSPACE, signal: undefined, model: undefined })
}

test('an allowed shell call gets the default timeout as a patch, and the call it was handed is left as it arrived', () => {
  const input = Object.freeze({ command: 'ls' })
  const patch = { timeout: DEFAULT_GUARD_POLICY.defaultBashTimeoutSeconds }
  expect(call(startedSession(fakeRuntime()), 'bash', input)).toEqual({ kind: 'allowed', patch })
  expect(input).toEqual({ command: 'ls' })
  expect(call(startedSession(fakeRuntime()), 'bash', { command: 'ls', timeout: 5 })).toEqual({ kind: 'allowed' })
})

test('⚠ the floor reads the runtime tool list: a policy tool it lacks refuses every call, and so does a list it cannot read', () => {
  // Durable's `CodingTools` is exactly this list: no `powershell` (#862 settles it).
  const lacking = call(startedSession(fakeRuntime(() => ['read', 'write', 'edit', 'bash'])), 'read', { path: 'a' })
  expect(lacking).toMatchObject({
    kind: 'refused',
    reason: expect.stringContaining('durable does not register: powershell'),
  })
  const unreadable = startedSession(
    fakeRuntime(() => {
      throw new Error('no registry')
    }),
  )
  expect(call(unreadable, 'read', { path: 'a' })).toMatchObject({
    kind: 'refused',
    reason: expect.stringContaining("could not enumerate durable's tools: Error: no registry"),
  })
})

test("a refusal comes back in the runtime's own shape, and its record goes through append", () => {
  const runtime = fakeRuntime()
  const outcome = call(startedSession(runtime), 'write', { path: '.bashrc', content: 'echo hi' }, 'w1')
  expect(outcome).toMatchObject({ kind: 'refused', block: true, reason: expect.stringContaining('persistence path') })
  expect(runtime.appended).toContainEqual({
    customType: ENSO_GUARD_DENIAL_ENTRY,
    data: { toolCallId: 'w1', rule: 'persistence-write' },
  })
})

test("⚠ a suspension rebuilt from the start's transcript holds until a resolution arrives on the runtime's bus", () => {
  const opened: EnsoIncidentOpened = {
    incidentId: 'i1',
    signals: [],
    halted: true,
    suspended: ['execute', 'network', 'write'],
  }
  const reportMissing = { incidentId: 'i1', reason: 'the report turn ended without a report' }
  const transcript: EnsoTranscriptEntry[] = [
    { kind: 'custom', id: 'e1', customType: ENSO_INCIDENT_OPENED_ENTRY, data: opened },
    { kind: 'custom', id: 'e2', customType: ENSO_INCIDENT_REPORT_MISSING_ENTRY, data: reportMissing },
  ]
  const runtime = fakeRuntime()
  const session = startedSession(runtime, transcript)
  expect(call(session, 'bash', { command: 'ls' })).toMatchObject({ kind: 'refused', terminate: true })
  expect(call(session, 'read', { path: 'a' })).toEqual({ kind: 'allowed' })

  runtime.announce(
    ENSO_INCIDENT_RESOLVED_CHANNEL,
    incidentResolvedOf('i1', { classification: 'false-positive', outcome: 'resume' }),
  )
  expect(call(session, 'bash', { command: 'ls' })).toMatchObject({ kind: 'allowed' })
})

test('a start whose record directory and transcript cannot be read does not throw, and still guards', () => {
  const session = createGuardSession(fakeRuntime(), {
    analyzeShell: () => undefined,
    harnessRoot: WORKSPACE,
    incidentPolicy: () => incidentPolicyOf(undefined),
    logsDirectory: join(WORKSPACE, 'logs'),
    projectsDirectory: join(WORKSPACE, 'projects'),
    commandJudge: () => undefined,
    judgeSecretValues: () => [],
  })
  const unreadable = (): never => {
    throw new Error('gone')
  }
  expect(() => session.start({ recordDirectory: unreadable, transcript: unreadable })).not.toThrow()
  expect(call(session, 'write', { path: '.bashrc', content: 'x' })).toMatchObject({ kind: 'refused' })
})

test("knowledge comes from the runtime's word on a result: a read it calls partial does not license a whole-file write", () => {
  const file = join(WORKSPACE, 'notes.txt')
  writeFileSync(file, 'one\ntwo\n')
  const session = startedSession(fakeRuntime())
  const read = { toolName: 'read', input: { path: file }, isError: false, cwd: WORKSPACE }

  session.toolResult({ ...read, wholeFile: false })
  expect(call(session, 'write', { path: file, content: 'x' })).toMatchObject({
    kind: 'refused',
    reason: expect.stringContaining('read only part of it'),
  })
  session.toolResult({ ...read, wholeFile: true })
  expect(call(session, 'write', { path: file, content: 'x' })).toEqual({ kind: 'allowed' })
})

/** What the session answers a check on the runtime's bus (#881): its refusal, `undefined`, or `'unanswered'`. */
function checked(
  runtime: FakeRuntime,
  toolName: string,
  input: Record<string, unknown>,
): EnsoGuardRefusal | undefined | 'unanswered' {
  let answered: EnsoGuardRefusal | undefined | 'unanswered' = 'unanswered'
  const answer = (refusal: EnsoGuardRefusal | undefined): void => {
    answered = refusal
  }
  runtime.announce(ENSO_GUARD_CHECK_CHANNEL, { toolName, input, cwd: WORKSPACE, answer })
  return answered
}

// @pins guarded-tool-call/check-is-the-call
test("⚠ a check on the runtime's bus answers what the call would now, from the session's state, and records nothing (#881)", () => {
  const file = join(WORKSPACE, 'checked.txt')
  writeFileSync(file, 'one\n')
  const runtime = fakeRuntime()
  const session = startedSession(runtime)

  // A write over a file the session has not read is refused, as its call is; nothing is recorded.
  const unread = checked(runtime, 'write', { path: file })
  expect(unread).toEqual({ rule: 'read-before-write', reason: expect.stringContaining('has not read it') })
  expect(checked(runtime, 'Bash', { command: 'ls' })).toBeUndefined()
  expect(runtime.appended).toEqual([])
  if (typeof unread !== 'object') throw new Error('expected a refusal')
  expect(call(session, 'write', { path: file, content: 'x' })).toMatchObject({ kind: 'refused', reason: unread.reason })

  // The session's state moves the answer: once it has read the whole file, the same check passes.
  session.toolResult({ toolName: 'read', input: { path: file }, isError: false, wholeFile: true, cwd: WORKSPACE })
  expect(checked(runtime, 'write', { path: file })).toBeUndefined()
})

test('a malformed check is not answered and does not throw (#881)', () => {
  const runtime = fakeRuntime()
  startedSession(runtime)
  expect(() => runtime.announce(ENSO_GUARD_CHECK_CHANNEL, { toolName: 'bash', cwd: WORKSPACE })).not.toThrow()
  expect(() => runtime.announce(ENSO_GUARD_CHECK_CHANNEL, 'bash')).not.toThrow()
  expect(runtime.appended).toEqual([])
})
