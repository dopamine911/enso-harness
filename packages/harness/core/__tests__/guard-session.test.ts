import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
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

function fakeRuntime(
  toolNames: () => readonly string[] = () => EVERY_POLICY_TOOL,
  versionRefusal: () => string | undefined = () => undefined,
): FakeRuntime {
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
    versionRefusal,
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

test('⚠ the floor reads the runtime version first: its refusal refuses every call, and so does a version it cannot read (#953)', () => {
  const unpinned = startedSession(fakeRuntime(undefined, () => 'durable 9.9.9 is not one the guard was pinned against'))
  expect(call(unpinned, 'read', { path: 'a' })).toMatchObject({
    kind: 'refused',
    reason: 'All tool calls are blocked: durable 9.9.9 is not one the guard was pinned against',
  })
  // Before the tool-list leg: a runtime that is both unpinned and lacking a tool names the version.
  const both = startedSession(
    fakeRuntime(
      () => ['read'],
      () => 'unpinned',
    ),
  )
  expect(call(both, 'read', { path: 'a' })).toMatchObject({ reason: 'All tool calls are blocked: unpinned' })
  const unreadable = startedSession(
    fakeRuntime(undefined, () => {
      throw new Error('no version')
    }),
  )
  expect(call(unreadable, 'read', { path: 'a' })).toMatchObject({
    kind: 'refused',
    reason: expect.stringContaining("could not read durable's version: Error: no version"),
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
  cwd = WORKSPACE,
): EnsoGuardRefusal | undefined | 'unanswered' {
  let answered: EnsoGuardRefusal | undefined | 'unanswered' = 'unanswered'
  const answer = (refusal: EnsoGuardRefusal | undefined): void => {
    answered = refusal
  }
  runtime.announce(ENSO_GUARD_CHECK_CHANNEL, { toolName, input, cwd, answer })
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
  expect(unread).toEqual({
    rule: 'read-before-write',
    cause: expect.stringContaining('has not read it'),
    reason: expect.stringContaining('has not read it'),
  })
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

/** A project with its own settings tier (#754): `<project>/.enso/` exists, as every configured project's does. */
function projectWithSettings(): string {
  const project = mkdtempSync(join(tmpdir(), 'enso-guard-project-'))
  mkdirSync(join(project, '.enso'))
  return project
}

/**
 * What "Try a command" answers for one tool call in `cwd`, then what the call itself gets, in a fresh
 * session each: both are `decide`'s (#881), so every assertion below holds for both.
 */
function checkThenCall(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
): { check: EnsoGuardRefusal | undefined | 'unanswered'; call: GuardCallOutcome } {
  const runtime = fakeRuntime()
  const session = startedSession(runtime)
  const check = checked(runtime, toolName, input, cwd)
  const outcome = session.toolCall({ toolCallId: 'c1', toolName, input, cwd, signal: undefined, model: undefined })
  return { check, call: outcome }
}

function expectAllowed(toolName: string, input: Record<string, unknown>, cwd: string): void {
  const { check, call: outcome } = checkThenCall(toolName, input, cwd)
  expect(check).toBeUndefined()
  expect(outcome).toEqual({ kind: 'allowed' })
}

function expectSecretRead(toolName: string, input: Record<string, unknown>, cwd: string, naming: string): void {
  const { check, call: outcome } = checkThenCall(toolName, input, cwd)
  expect(check).toEqual({
    rule: 'secret-read',
    cause: expect.stringContaining(naming),
    reason: expect.stringContaining(naming),
  })
  if (typeof check !== 'object') throw new Error('expected a refusal')
  expect(outcome).toMatchObject({ kind: 'refused', reason: check.reason })
}

test('⚠ read of a file that does not exist yet passes in a project holding .enso/: read opens one file and searches nothing (#886)', () => {
  const project = projectWithSettings()
  for (const path of ['not-yet.txt', 'sub/not-yet.txt', join(project, 'docs', 'new', 'x.md')]) {
    expectAllowed('read', { path }, project)
  }
})

test('⚠ grep over a project holding .enso/ is still refused for it, and grep over a path that does not exist searches nothing (#886, #160 §4)', () => {
  const project = projectWithSettings()
  expectSecretRead('grep', { pattern: 'x', path: project }, project, `${join(project, '.enso')} is beneath it`)
  expectSecretRead('grep', { pattern: 'x', path: '.' }, project, `${join(project, '.enso')} is beneath it`)
  expectAllowed('grep', { pattern: 'x', path: 'sub/not-yet' }, project)
})

test('⚠ a file that does not exist yet is still refused at a credential location: ~/.ssh/not-yet, and through a symlink into a .ssh (#886)', () => {
  const project = projectWithSettings()
  expectSecretRead('read', { path: '~/.ssh/not-yet' }, project, 'credential pattern')
  const credentials = join(mkdtempSync(join(tmpdir(), 'enso-guard-home-')), '.ssh')
  mkdirSync(credentials)
  symlinkSync(credentials, join(project, 'keys'), 'dir')
  for (const toolName of ['read', 'grep']) {
    expectSecretRead(toolName, { pattern: 'x', path: 'keys/not-yet' }, project, 'credential pattern')
  }
})
