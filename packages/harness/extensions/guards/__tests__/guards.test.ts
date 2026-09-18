import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createCodingTools, createPowerShellTool, createReadOnlyTools } from '@earendil-works/pi-coding-agent'
import type { LogRecorder } from '@logtape/testing/recorder'
import { recordZenLogs, releaseZenLogs } from '@zen/core/log-recorder'
import { createGuards, GUARD_POLICY_TOOL_NAMES, type GuardDependencies } from '../index.ts'

/** What a guard handler answers: a block verdict, or nothing when the call passes. */
type GuardVerdict = { block?: boolean; reason?: string } | undefined

type Handler = (event: unknown, extensionContext: unknown) => GuardVerdict

/** ONE guard instance's captured handlers — the #10 sequences need state across calls. */
interface GuardRuntime {
  toolCall: Handler
  toolResult: Handler
  sessionStart: Handler
}

/** pi's shipped tool set, as `getAllTools` returns it (probed live 2026-09-04). */
/**
 * Hand-copied from pi, and PINNED against pi's real tool factories by the test at the end
 * of this file (#53 S2): a tool pi adds or renames fails there, instead of this list quietly
 * describing a pi that no longer exists.
 */
const PI_SHIPPED_TOOL_NAMES = ['read', 'bash', 'powershell', 'edit', 'write', 'grep', 'find', 'ls']

/**
 * Analyzer default for THESE tests: allow everything. ⚠ Deliberately not the real
 * cc-safety-net — `checkCommand` reads the MACHINE's local policy per call, so guard
 * tests touching it would vary with developer config (the "verify against the original"
 * trap: CI and this machine agree today by accident of both having no config). The
 * contract test is the one place the real library runs, with that pinning stated.
 */
const ALLOW_ALL_ANALYZER: GuardDependencies['analyzeBashCommand'] = () => ({ kind: 'allow' })

/**
 * Minimal stand-in for pi's ExtensionAPI — captures every registered handler.
 * `getAllTools` defaults to pi's real shipped set so session_start's policy check (#4)
 * passes; the mismatch tests inject their own list, or a throwing implementation.
 */
function loadGuardRuntime(
  getAllTools: () => { name: string }[] = () => PI_SHIPPED_TOOL_NAMES.map((name) => ({ name })),
  analyzeBashCommand: GuardDependencies['analyzeBashCommand'] = ALLOW_ALL_ANALYZER,
): GuardRuntime {
  const handlers = new Map<string, Handler>()
  const guards = createGuards({ analyzeBashCommand })
  guards({ on: (e: string, h: Handler) => handlers.set(e, h), getAllTools } as never)
  const toolCall = handlers.get('tool_call')
  const toolResult = handlers.get('tool_result')
  const sessionStart = handlers.get('session_start')
  if (!(toolCall && toolResult && sessionStart)) {
    throw new Error('guards did not register tool_call + tool_result + session_start')
  }
  return { toolCall, toolResult, sessionStart }
}

/** The original single-handler loader — per-call tests that need no cross-call state. */
function loadGuard(): Handler {
  return loadGuardRuntime().toolCall
}

const cwd = mkdtempSync(join(tmpdir(), 'zen-guard-live-'))
const call = (toolName: string, input: Record<string, unknown>): GuardVerdict =>
  loadGuard()({ type: 'tool_call', toolCallId: 't', toolName, input }, { cwd })

/** Every verdict is a record (#132): the recorder is the file. */
let logs: LogRecorder
beforeAll(async () => {
  logs = await recordZenLogs()
})
beforeEach(() => logs.clear())
afterAll(releaseZenLogs)

test('⚠ every verdict is a record: a denial at warn with the tool, the path and the reason; an allow at debug — never silent (#132)', () => {
  expect(call('write', { path: '/etc/passwd' })?.block).toBe(true)
  logs.assertLogged({
    level: 'warning',
    category: ['zen', 'extension', 'guards'],
    rawMessage: '{toolName} denied: {reason}',
    properties: (properties: Readonly<Record<string, unknown>>) =>
      properties.toolCallId === 't' &&
      properties.toolName === 'write' &&
      properties.path === '/etc/passwd' &&
      String(properties.reason).includes('blocked'),
  })
  logs.clear()
  expect(call('write', { path: 'src/a.ts' })).toBeUndefined()
  logs.assertLogged({
    level: 'debug',
    rawMessage: '{toolName} allowed',
    properties: { toolCallId: 't', toolName: 'write', path: 'src/a.ts' },
  })
  logs.assertNotLogged({ level: 'warning' })
})

test('registers a tool_call handler', () => expect(typeof loadGuard()).toBe('function'))
test('write inside the workspace passes', () => expect(call('write', { path: 'src/a.ts' })).toBeUndefined())
test('write outside the workspace is blocked', () => {
  const r = call('write', { path: '/etc/passwd' })
  expect(r?.block).toBe(true)
  expect(r?.reason).toContain('outside the workspace')
})
test('write into .git is blocked', () => expect(call('write', { path: '.git/config' })?.block).toBe(true))
// #54/#59: zen.config.json carries web_fetch's committed host allowlist — the guard is the
// only layer keeping the agent from editing the policy that gates it (same shape as
// .cc-safety-net).
test('write and edit to zen.config.json are blocked', () => {
  expect(call('write', { path: 'zen.config.json' })?.block).toBe(true)
  expect(call('edit', { path: 'zen.config.json' })?.block).toBe(true)
})
// ⚠ STATED RESIDUAL, pinned (#54/#59): a bash REDIRECT into the config is allowed — the
// write/edit denial above and cc-safety-net both miss it. Accepted because the extension
// reads the file ONCE at load (an in-session edit is inert for this session) and the edit
// then sits in `git status` where a human sees it. If this goes red, a layer started
// denying it — update this record, don't re-open the gap.
test('recorded residual: a bash redirect into zen.config.json passes the guard', () => {
  expect(
    call('bash', { command: 'echo \'{"webFetch":{"allowedHosts":["evil.example"]}}\' > zen.config.json' }),
  ).toBeUndefined()
})
test('read of .env is blocked', () => {
  const r = call('read', { path: '.env' })
  expect(r?.block).toBe(true)
  expect(r?.reason).toContain('credential')
})
test('read of ordinary source passes', () => expect(call('read', { path: 'src/i.ts' })).toBeUndefined())
test('bash without timeout is PATCHED not blocked', () => {
  const input: Record<string, unknown> = { command: 'sleep 999' }
  expect(loadGuard()({ type: 'tool_call', toolCallId: 't', toolName: 'bash', input }, { cwd })).toBeUndefined()
  expect(input.timeout).toBe(120)
})
test('an explicit bash timeout is preserved', () => {
  const input: Record<string, unknown> = { command: 'x', timeout: 5 }
  loadGuard()({ type: 'tool_call', toolCallId: 't', toolName: 'bash', input }, { cwd })
  expect(input.timeout).toBe(5)
})
test('a tool with no path argument is ignored', () => expect(call('grep', { pattern: 'f' })).toBeUndefined())

// --- #8: the reader set is an exclusion, so every path-bearing tool is gated.
// pi ships read/grep/find/ls with a `path`; an inclusion list naming only `read`
// left `grep` over a credential directory returning the secret line.
for (const readingTool of ['read', 'grep', 'find', 'ls']) {
  test(`${readingTool} of a credential path is blocked`, () => {
    const result = call(readingTool, { path: '.env' })
    expect(result?.block).toBe(true)
    expect(result?.reason).toContain('credential')
  })
  test(`${readingTool} of ordinary source passes`, () => {
    expect(call(readingTool, { path: 'src/ordinary.ts' })).toBeUndefined()
  })
}

// A tool pi does not ship today must still be gated — that is what "exclusion" buys,
// and it is the case an inclusion list can never cover.
test('an unknown path-bearing tool is gated as a reader', () => {
  const result = call('someFutureSearchTool', { path: '.aws/credentials' })
  expect(result?.block).toBe(true)
  expect(result?.reason).toContain('credential')
})

// The reason names the tool, so a denial is attributable without reading the guard.
test('the denial names the tool that was refused', () => {
  expect(call('grep', { path: '.ssh/id_rsa' })?.reason).toContain('grep')
})

// ⚠ Writes must be claimed BEFORE the reader fallthrough: write/edit also carry a
// `path`, so a dispatch that checked readers first would give them the weaker check
// and silently drop workspace confinement.
test('write outside the workspace is still confined, not treated as a read', () => {
  const result = call('write', { path: '/etc/passwd' })
  expect(result?.block).toBe(true)
  expect(result?.reason).toContain('outside the workspace')
})

// ── #21: persistence vectors are denied on the write path, allowed on the read path ──────
test('write to .mcp.json inside the workspace is blocked', () => {
  const r = call('write', { path: '.mcp.json' })
  expect(r?.block).toBe(true)
  expect(r?.reason).toContain('persistence')
})
test('edit of a .vscode task inside the workspace is blocked', () => {
  const r = call('edit', { path: '.vscode/tasks.json' })
  expect(r?.block).toBe(true)
  expect(r?.reason).toContain('persistence')
})
test('READING a persistence path is not blocked — the danger is installation', () =>
  expect(call('read', { path: '.mcp.json' })).toBeUndefined())

// ── #10: write requires knowledge of the file it replaces ─────────────────────────────────
// These share ONE runtime instance across calls, deliberately — the read-set is state, and
// a suite that rebuilds the instance per call can never see stale or leaking state.

/** A fresh workspace with one pre-existing file the session has NOT read. */
function readPreconditionFixture(): { runtime: GuardRuntime; cwd: string; existingFile: string } {
  const workspace = mkdtempSync(join(tmpdir(), 'zen-guard-10-'))
  writeFileSync(join(workspace, 'existing.ts'), 'content the session has never seen')
  return { runtime: loadGuardRuntime(), cwd: workspace, existingFile: 'existing.ts' }
}

const toolCallEvent = (toolName: string, path: string) =>
  ({ type: 'tool_call', toolCallId: 't', toolName, input: { path } }) as const
const toolResultEvent = (toolName: string, path: string, isError: boolean) =>
  ({ type: 'tool_result', toolCallId: 't', toolName, input: { path }, content: [], isError }) as const

test('write to an EXISTING file the session has not read is blocked, naming file and remedy', () => {
  const { runtime, cwd, existingFile } = readPreconditionFixture()
  const result = runtime.toolCall(toolCallEvent('write', existingFile), { cwd })
  expect(result?.block).toBe(true)
  expect(result?.reason).toContain(existingFile)
  expect(result?.reason).toContain('Read')
})

test('write to a path that does not exist is unaffected — creation is the common case', () => {
  const { runtime, cwd } = readPreconditionFixture()
  expect(runtime.toolCall(toolCallEvent('write', 'brand-new.ts'), { cwd })).toBeUndefined()
})

test('a successful read permits a later write of the same file, on the same instance', () => {
  const { runtime, cwd, existingFile } = readPreconditionFixture()
  runtime.toolResult(toolResultEvent('read', existingFile, false), { cwd })
  expect(runtime.toolCall(toolCallEvent('write', existingFile), { cwd })).toBeUndefined()
})

// ⚠ isError gates recording: a FAILED read saw nothing.
test('a failed read confers no knowledge', () => {
  const { runtime, cwd, existingFile } = readPreconditionFixture()
  runtime.toolResult(toolResultEvent('read', existingFile, true), { cwd })
  expect(runtime.toolCall(toolCallEvent('write', existingFile), { cwd })?.block).toBe(true)
})

// Identity is resolved, not spelled: read via a `sub/../` spelling, write via the plain one.
test('a read via a dotted spelling permits a write via the plain spelling', () => {
  const { runtime, cwd, existingFile } = readPreconditionFixture()
  runtime.toolResult(toolResultEvent('read', `sub/../${existingFile}`, false), { cwd })
  expect(runtime.toolCall(toolCallEvent('write', existingFile), { cwd })).toBeUndefined()
})

// The deliberate widening: the session's own successful write authored every byte.
test("the session's own write confers knowledge — create-then-revise never self-blocks", () => {
  const { runtime, cwd } = readPreconditionFixture()
  expect(runtime.toolCall(toolCallEvent('write', 'created.ts'), { cwd })).toBeUndefined()
  // The tool executes between the call and the result — by tool_result time the file exists.
  writeFileSync(join(cwd, 'created.ts'), 'v1')
  runtime.toolResult(toolResultEvent('write', 'created.ts', false), { cwd })
  expect(runtime.toolCall(toolCallEvent('write', 'created.ts'), { cwd })).toBeUndefined()
})

// ⚠ edit is NOT knowledge-conferring: a successful edit proved one matched fragment
// (liftable from grep output), not the whole file a follow-up `write` would claim.
test('a successful edit does NOT permit a whole-file write', () => {
  const { runtime, cwd, existingFile } = readPreconditionFixture()
  runtime.toolResult(toolResultEvent('edit', existingFile, false), { cwd })
  expect(runtime.toolCall(toolCallEvent('write', existingFile), { cwd })?.block).toBe(true)
})

// edit itself stays un-gated by this rule — its exact-match already fails a blind edit.
test('edit of an unread existing file is not gated by the read precondition', () => {
  const { runtime, cwd, existingFile } = readPreconditionFixture()
  expect(runtime.toolCall(toolCallEvent('edit', existingFile), { cwd })).toBeUndefined()
})

// ⚠ The session-scope proof, both halves on one instance: knowledge persists across calls
// within a session, and session_start clears it (reload/resume keep the runtime alive).
test('session_start resets the read-set on a live instance', () => {
  const { runtime, cwd, existingFile } = readPreconditionFixture()
  runtime.toolResult(toolResultEvent('read', existingFile, false), { cwd })
  expect(runtime.toolCall(toolCallEvent('write', existingFile), { cwd })).toBeUndefined()
  runtime.sessionStart({ type: 'session_start', reason: 'resume' }, { cwd })
  expect(runtime.toolCall(toolCallEvent('write', existingFile), { cwd })?.block).toBe(true)
})

// ── #11: a file changed underneath the session is refused, loudly and distinctly ─────────

/** Move a file's mtime one full second forward — unambiguous at any stat resolution. */
function touchForward(filePath: string): void {
  const later = new Date(Date.now() + 1000)
  utimesSync(filePath, later, later)
}

test('write to a file that changed after the session read it is blocked as CHANGED', () => {
  const { runtime, cwd, existingFile } = readPreconditionFixture()
  runtime.toolResult(toolResultEvent('read', existingFile, false), { cwd })
  touchForward(join(cwd, existingFile))
  const result = runtime.toolCall(toolCallEvent('write', existingFile), { cwd })
  expect(result?.block).toBe(true)
  expect(result?.reason).toContain('CHANGED')
  expect(result?.reason).toContain(existingFile)
  // ⚠ The acceptance asks for DISTINCT causes: this is not #10's never-read message.
  expect(result?.reason).not.toContain('has not read')
})

// ⚠ The asymmetry with #10: edit passes on an UNKNOWN file (above) but is refused on a
// STALE one — an exact-match can survive an external change and clobber around it.
test('edit of a file that changed after the session read it is blocked too', () => {
  const { runtime, cwd, existingFile } = readPreconditionFixture()
  runtime.toolResult(toolResultEvent('read', existingFile, false), { cwd })
  touchForward(join(cwd, existingFile))
  const result = runtime.toolCall(toolCallEvent('edit', existingFile), { cwd })
  expect(result?.block).toBe(true)
  expect(result?.reason).toContain('CHANGED')
})

test('re-reading the changed file clears the staleness and the write passes', () => {
  const { runtime, cwd, existingFile } = readPreconditionFixture()
  runtime.toolResult(toolResultEvent('read', existingFile, false), { cwd })
  touchForward(join(cwd, existingFile))
  expect(runtime.toolCall(toolCallEvent('write', existingFile), { cwd })?.block).toBe(true)
  runtime.toolResult(toolResultEvent('read', existingFile, false), { cwd })
  expect(runtime.toolCall(toolCallEvent('write', existingFile), { cwd })).toBeUndefined()
})

// ⚠ THE RECORDED INCIDENT, replayed with real git: a tracked-but-unstaged mutation
// restored from the index (`git checkout -- <file>`) destroys the unstaged work with no
// error anywhere — untracked files fail loudly, and that asymmetry is the trap. The two
// contents are the SAME LENGTH deliberately, so only the mtime leg of the stamp can catch
// the restore — this test is what pins that git's restore actually moves mtime.
/**
 * The fixture's git, hermetic: not the caller's environment, and not the caller's config.
 *
 * ⚠ This suite runs INSIDE a git hook — `.githooks/pre-commit` runs the gate — and git exports
 * an absolute `GIT_INDEX_FILE` to a hook. A git spawned here with the inherited environment
 * therefore writes THIS repository's index instead of the temp repo's: `git add work.ts` below
 * staged a fixture file into a real commit of this project, and every `--amend` re-staged it
 * (PR #287). Everything these commands need is on the command line or in the temp repo, so the
 * child is given an environment rather than inheriting one, and a developer's global gitconfig
 * (`core.hooksPath`, `init.defaultBranch`) cannot reach the fixture either.
 *
 * The env therefore carries no `PATH`, and the binary is ABSOLUTE for exactly that reason (PR
 * #287 review). A bare `git` under this env was not portable, it was lucky: with no `PATH` in
 * the child environment, `execvp` falls back to the system default path, so it resolved only
 * because git is `/usr/bin/git`. Measured for a binary that is on the caller's `PATH` and
 * nowhere else — a git under `~/.local/bin`, a nix profile, Homebrew — both Bun's `spawnSync`
 * and `child_process.spawn` raise ENOENT. `Bun.which` does that lookup ONCE, against the real
 * environment, and an absolute path then needs no lookup in any runtime.
 */
const FIXTURE_GIT_ENV: Record<string, string> = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
/** Absolute, resolved once; empty when git is not installed, and then nothing spawns. */
const GIT_BINARY: string = Bun.which('git') ?? ''
const isGitAvailable = GIT_BINARY !== ''
test.skipIf(!isGitAvailable)('the incident shape: staged, mutated, restored from index — the write is refused', () => {
  const repo = mkdtempSync(join(tmpdir(), 'zen-guard-incident-'))
  const runGit = (...args: string[]): void => {
    const result = Bun.spawnSync([GIT_BINARY, ...args], { cwd: repo, env: FIXTURE_GIT_ENV })
    if (result.exitCode !== 0) {
      throw new Error(`git ${args[0]} failed: ${result.stderr.toString()}`)
    }
  }
  runGit('init', '-q')
  runGit('config', 'user.email', 'test@example.invalid')
  runGit('config', 'user.name', 'guard-test')
  const filePath = join(repo, 'work.ts')
  writeFileSync(filePath, 'version-one\n')
  runGit('add', 'work.ts')
  // The session's work: a tracked-but-unstaged mutation, same byte length.
  writeFileSync(filePath, 'version-two\n')
  // ⚠ Backdate the mutation two seconds: in the real incident the observation and the
  // restore are separated by wall-clock time, and compressing them into one test tick
  // put both inside the SAME mtimeMs — the restore classified fresh and this test
  // failed. That was the documented same-size-same-millisecond gap manifesting, not a
  // broken guard; backdating restores the realistic separation deterministically.
  const twoSecondsAgo = new Date(Date.now() - 2000)
  utimesSync(filePath, twoSecondsAgo, twoSecondsAgo)
  const runtime = loadGuardRuntime()
  runtime.toolResult(toolResultEvent('read', 'work.ts', false), { cwd: repo })
  const observed = statSync(filePath)
  // The concurrent agent's restore.
  runGit('checkout', '--', 'work.ts')
  const restored = statSync(filePath)
  // Assert the CAUSE before the effect: the restore moved mtime while size is equal,
  // so a pass below is attributable to the mtime leg, not to a size difference.
  expect(restored.size).toBe(observed.size)
  expect(restored.mtimeMs).not.toBe(observed.mtimeMs)
  const result = runtime.toolCall(toolCallEvent('write', 'work.ts'), { cwd: repo })
  expect(result?.block).toBe(true)
  expect(result?.reason).toContain('CHANGED')
})

// ── the sensor for FIXTURE_GIT_ENV above ──────────────────────────────────────────────────
// The hermetic environment is load-bearing and invisible: with the caller's environment
// inherited, the fixture's `git add`/`git checkout` ran against the REPOSITORY BEING
// COMMITTED — a stray `work.ts` in real commits, an author rewritten, `core.bare` flipped on
// a config every worktree shares, and `checkout --` silently reverting tracked content,
// which is the leg that destroys work rather than dirtying a tree.
//
// ⚠ It cannot be pinned in-process: arming the hazard means a poisoned GIT_* in the
// environment this suite runs in, and `noProcessEnv` scopes environment reads to the #89
// inventory, which a test fixture has no business joining. So the suite is re-run in a CHILD
// given exactly that environment — the real fixture, the real spawn, the real hazard — and
// the victim repository is asserted untouched afterwards. That is a behavioural sensor, not
// an assertion on a literal: delete `env: FIXTURE_GIT_ENV` from the spawn above and this
// goes red, naming the leg that leaked.
test.skipIf(!isGitAvailable)(
  '⚠ the incident fixture cannot reach the repository that runs it (GIT_DIR, GIT_INDEX_FILE)',
  () => {
    const victim = mkdtempSync(join(tmpdir(), 'zen-guard-victim-'))
    const hermetic: Record<string, string> = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
    const victimGit = (...args: string[]): string => {
      const result = Bun.spawnSync(['git', ...args], { cwd: victim, env: hermetic })
      return result.stdout.toString().trim()
    }
    victimGit('init', '-q')
    victimGit('config', '--local', 'user.email', 'victim@example.invalid')
    victimGit('config', '--local', 'user.name', 'victim')
    const tracked = join(victim, 'work.ts')
    writeFileSync(tracked, 'victim-committed\n')
    victimGit('add', 'work.ts')
    victimGit('commit', '-q', '-m', 'victim')
    // An unstaged mutation on top: the shape that has something to lose to `checkout --`.
    writeFileSync(tracked, 'victim-unstaged\n')

    // The child is handed what a git hook hands its children, and nothing else it does not need.
    const child = Bun.spawnSync([process.execPath, 'test', import.meta.path, '-t', 'the incident shape'], {
      cwd: dirname(import.meta.path),
      env: {
        ...hermetic,
        PATH: dirname(Bun.which('git') ?? '/usr/bin/git'),
        GIT_DIR: join(victim, '.git'),
        GIT_INDEX_FILE: join(victim, '.git', 'index'),
        GIT_WORK_TREE: victim,
      },
    })
    // The fixture still passes under the hazard — the point is that it passes HARMLESSLY.
    expect(child.stderr.toString()).toContain('1 pass')
    // The destructive leg first: the victim's unstaged work survived `checkout --`.
    expect(readFileSync(tracked, 'utf8')).toBe('victim-unstaged\n')
    // Then the noisy ones: no fixture author written over the victim's, and nothing staged.
    expect(victimGit('config', '--local', '--get', 'user.name')).toBe('victim')
    expect(victimGit('diff', '--cached', '--name-only')).toBe('')
    expect(victimGit('config', '--local', '--get', 'core.bare')).toBe('false')
  },
)

// ⚠ The session's OWN successful edit must not make the file stale to itself: an edit
// moves mtime/size, confers no whole-file knowledge (#10), but must refresh the stamp of
// an already-known file — read → edit → edit refused the second edit before this, live,
// blaming an external actor for the session's own work.
test("the session's own edit refreshes a known file's stamp — read → edit → edit passes", () => {
  const { runtime, cwd, existingFile } = readPreconditionFixture()
  runtime.toolResult(toolResultEvent('read', existingFile, false), { cwd })
  // The edit tool's own successful mutation: content changes, then its result arrives.
  writeFileSync(join(cwd, existingFile), "content after the session's first edit")
  touchForward(join(cwd, existingFile))
  runtime.toolResult(toolResultEvent('edit', existingFile, false), { cwd })
  expect(runtime.toolCall(toolCallEvent('edit', existingFile), { cwd })).toBeUndefined()
  expect(runtime.toolCall(toolCallEvent('write', existingFile), { cwd })).toBeUndefined()
})

// The refresh is IF-KNOWN only: an edit of a never-read file still confers nothing, so a
// later whole-file write is still gated by #10.
test('an edit result on an UNKNOWN file still confers no knowledge', () => {
  const { runtime, cwd, existingFile } = readPreconditionFixture()
  runtime.toolResult(toolResultEvent('edit', existingFile, false), { cwd })
  expect(runtime.toolCall(toolCallEvent('write', existingFile), { cwd })?.block).toBe(true)
})

// A FAILED edit refreshes nothing: pi reports isError before mutating, so the stamp must
// keep describing the file the session last actually observed.
test('a failed edit result does not refresh the stamp', () => {
  const { runtime, cwd, existingFile } = readPreconditionFixture()
  runtime.toolResult(toolResultEvent('read', existingFile, false), { cwd })
  touchForward(join(cwd, existingFile))
  runtime.toolResult(toolResultEvent('edit', existingFile, true), { cwd })
  expect(runtime.toolCall(toolCallEvent('write', existingFile), { cwd })?.block).toBe(true)
})

// ── #4 gap 2: tool identity is case-insensitive, and the policy is checked live ───────────
// Claude-Code-style vendors register capitalised tool names (picc's own types carry
// `tool: "Bash"`), so two naming conventions are live in one process. Every branch must
// match by canonical name — these are DISAGREEING vectors (event case ≠ policy case), or
// they would assert x === x.

test('a capitalised Write is still confined — case cannot skip the write branch', () => {
  const result = call('Write', { path: '/etc/passwd' })
  expect(result?.block).toBe(true)
  expect(result?.reason).toContain('outside the workspace')
})

test('a capitalised Bash still gets the timeout patch, not the reader fallthrough', () => {
  const input: Record<string, unknown> = { command: 'sleep 999' }
  expect(loadGuard()({ type: 'tool_call', toolCallId: 't', toolName: 'BASH', input }, { cwd })).toBeUndefined()
  expect(input.timeout).toBe(120)
})

test('a capitalised Read result confers knowledge for a later lowercase write', () => {
  const { runtime, cwd: fixtureCwd, existingFile } = readPreconditionFixture()
  runtime.toolResult(toolResultEvent('Read', existingFile, false), { cwd: fixtureCwd })
  expect(runtime.toolCall(toolCallEvent('write', existingFile), { cwd: fixtureCwd })).toBeUndefined()
})

// ── #4 gap 2, half two: a policy naming a tool pi does not register must FAIL CLOSED ──────
// A mismatch is otherwise a silent no-op: the guard loads, never fires, nothing reports it.
// ⚠ Deny-all, never a throw — a throwing session_start handler WEDGES print mode (probed
// 2026-09-04: 120s hang, zero output), which is a hang, not a refusal.

test("a policy tool missing from pi's registry denies every subsequent call, naming it", () => {
  const runtime = loadGuardRuntime(() =>
    PI_SHIPPED_TOOL_NAMES.filter((name) => name !== 'write').map((name) => ({ name })),
  )
  runtime.sessionStart({ type: 'session_start', reason: 'start' }, { cwd })
  const result = runtime.toolCall(toolCallEvent('read', 'src/a.ts'), { cwd })
  expect(result?.block).toBe(true)
  expect(result?.reason).toContain('write')
})

test('registry names are matched canonically — a capitalised registry entry is not a mismatch', () => {
  const runtime = loadGuardRuntime(() => PI_SHIPPED_TOOL_NAMES.map((name) => ({ name: name.toUpperCase() })))
  runtime.sessionStart({ type: 'session_start', reason: 'start' }, { cwd })
  expect(runtime.toolCall(toolCallEvent('read', 'src/a.ts'), { cwd })).toBeUndefined()
})

test("an unreadable tool list fails closed too — 'could not check' is not 'checked, fine'", () => {
  const runtime = loadGuardRuntime(() => {
    throw new Error('registry unavailable')
  })
  // The session_start handler itself must NOT throw (the print-mode wedge).
  expect(() => runtime.sessionStart({ type: 'session_start', reason: 'start' }, { cwd })).not.toThrow()
  const result = runtime.toolCall(toolCallEvent('read', 'src/a.ts'), { cwd })
  expect(result?.block).toBe(true)
  expect(result?.reason).toContain('enumerate')
})

test('a matching registry leaves every call ungated by the mismatch floor', () => {
  const runtime = loadGuardRuntime()
  runtime.sessionStart({ type: 'session_start', reason: 'start' }, { cwd })
  expect(runtime.toolCall(toolCallEvent('read', 'src/a.ts'), { cwd })).toBeUndefined()
})

// ⚠ The pre-session_start window (PR #52 review): pi's ordering — session_start before any
// tool_call — is an assumption, not a contract, and an unchecked floor reading `undefined`
// as "checked, fine" fails OPEN through exactly the window this feature exists to close.
// The lazy leg verifies on the first tool_call instead, so the floor is ordering-independent.
test('a mismatch denies the FIRST tool_call even when session_start never fired', () => {
  const runtime = loadGuardRuntime(() =>
    PI_SHIPPED_TOOL_NAMES.filter((name) => name !== 'write').map((name) => ({ name })),
  )
  // No sessionStart call, deliberately — this is the window under test.
  const result = runtime.toolCall(toolCallEvent('read', 'src/a.ts'), { cwd })
  expect(result?.block).toBe(true)
  expect(result?.reason).toContain('write')
})

test('the lazy check runs once — a healthy registry is not re-enumerated per call', () => {
  let enumerations = 0
  const runtime = loadGuardRuntime(() => {
    enumerations += 1
    return PI_SHIPPED_TOOL_NAMES.map((name) => ({ name }))
  })
  runtime.toolCall(toolCallEvent('read', 'src/a.ts'), { cwd })
  runtime.toolCall(toolCallEvent('read', 'src/b.ts'), { cwd })
  expect(enumerations).toBe(1)
})

// ── #9: bash policy — cc-safety-net as a library, then the network deny, then the patch ───

const toolCallEvent2 = (toolName: string, command: string) =>
  ({ type: 'tool_call', toolCallId: 't', toolName, input: { command } }) as const

// These test OUR WIRING of the analyzer verdict, with injected verdicts — the real
// library's behaviour is pinned by the contract test, and the live receipt pairs the two.
test('an analyzer deny is blocked with its rule identity in the reason', () => {
  const runtime = loadGuardRuntime(undefined, () => ({
    kind: 'deny',
    reason: 'git reset --hard destroys all uncommitted changes permanently.',
    ruleId: 'git.reset-hard',
  }))
  const result = runtime.toolCall(toolCallEvent2('bash', 'git reset --hard HEAD~3'), { cwd })
  expect(result?.block).toBe(true)
  expect(result?.reason).toContain('cc-safety-net')
  expect(result?.reason).toContain('git.reset-hard')
})

// ⚠ The analyzer's own contract: "If this function throws, the caller must not execute
// the command" — so a throw is a DENY, never a pass-through.
test('an analyzer THROW is a deny, per its contract', () => {
  const runtime = loadGuardRuntime(undefined, () => {
    throw new Error('policy read failed')
  })
  const result = runtime.toolCall(toolCallEvent2('bash', 'ls -la'), { cwd })
  expect(result?.block).toBe(true)
  expect(result?.reason).toContain('must not run')
})

test('an analyzer deny without a ruleId still blocks, without inventing one', () => {
  const runtime = loadGuardRuntime(undefined, () => ({ kind: 'deny', reason: 'protected path' }))
  const result = runtime.toolCall(toolCallEvent2('bash', 'rm -rf /'), { cwd })
  expect(result?.block).toBe(true)
  expect(result?.reason).not.toContain('(undefined)')
})

test('a network client at command position is blocked, naming the match', () => {
  const result = call('bash', { command: 'curl https://example.com/docs' })
  expect(result?.block).toBe(true)
  expect(result?.reason).toContain('curl')
  expect(result?.reason).toContain('network egress')
  // #54: the deny must point at the sanctioned path, not claim web access is gone —
  // "there is no fetch tool yet" was true when #9 landed and is a stale premise now.
  expect(result?.reason).toContain('web_fetch')
  expect(result?.reason).not.toContain('no fetch tool')
})

// ⚠ ORDER IS THE INVARIANT: deny first, patch last — a denied command must never have had
// its input mutated (a later handler or a retry would see the rewritten input).
test('a DENIED bash command does not receive the timeout patch', () => {
  const input: Record<string, unknown> = { command: 'curl https://x' }
  const result = loadGuard()({ type: 'tool_call', toolCallId: 't', toolName: 'bash', input }, { cwd })
  expect(result?.block).toBe(true)
  expect(input.timeout).toBeUndefined()
})

test('an allowed bash command still gets the timeout patch, after both gates', () => {
  const input: Record<string, unknown> = { command: 'git status' }
  expect(loadGuard()({ type: 'tool_call', toolCallId: 't', toolName: 'bash', input }, { cwd })).toBeUndefined()
  expect(input.timeout).toBe(120)
})

test('powershell egress is blocked by the coarse scan; cc-safety-net does not run on PS', () => {
  // Invoke-WebRequest would be POSIX-misparsed by checkCommand; the coarse scan owns PS.
  const result = call('powershell', { command: 'Invoke-WebRequest -Uri https://x' })
  expect(result?.block).toBe(true)
  expect(result?.reason).toContain('invoke-webrequest')
})

// ── the environment-dump deny (#89) ──────────────────────────────────────────
// Depth behind the quarantine: secrets are already out of the environment, so this is
// what makes a regression there loud. Same order invariant as egress: deny, then patch.

test('⚠ an environment listing is blocked, naming #89 and the match, and gets no timeout patch', () => {
  const input: Record<string, unknown> = { command: 'env' }
  const result = loadGuard()({ type: 'tool_call', toolCallId: 't', toolName: 'bash', input }, { cwd })
  expect(result?.block).toBe(true)
  expect(result?.reason).toContain('environment listing')
  expect(result?.reason).toContain('#89')
  // ⚠ The reason is read by the model and lands in transcripts: it must point at the
  // secrets file, never at the root .env this fix exists to get secrets OUT of (PR #98
  // review — the first version said ".env" and no substring assertion caught it).
  expect(result?.reason).toContain('.zen/secrets.env')
  expect(result?.reason).not.toMatch(/from the gated \.env/)
  expect(input.timeout).toBeUndefined()
})

test('expanding a secret-shaped variable is blocked; env as a wrapper and a plain expansion pass', () => {
  expect(call('bash', { command: 'echo $TAVILY_API_KEY' })?.reason).toContain('TAVILY_API_KEY')
  expect(call('bash', { command: 'cat /proc/self/environ' })?.reason).toContain('environ')
  expect(call('bash', { command: 'env FOO=1 bun test' })).toBeUndefined()
  expect(call('bash', { command: 'echo $HOME' })).toBeUndefined()
})

test('powershell environment access takes the coarse path too', () => {
  expect(call('powershell', { command: 'Get-ChildItem Env:' })?.reason).toContain('environment listing')
  expect(call('powershell', { command: 'Write-Output $env:GH_TOKEN' })?.reason).toContain('GH_TOKEN')
})

test('powershell commands are NEVER analyzed by cc-safety-net — the division, pinned', () => {
  // `git reset --hard` IS valid PS too and dangerous — but the analyzer parses POSIX
  // only, so it never runs on powershell (an analyzer that would deny everything proves
  // it was not consulted). This pins the division so a future "just run it on PS too"
  // change is a conscious one, not a drive-by.
  const runtime = loadGuardRuntime(undefined, () => ({ kind: 'deny', reason: 'should never be consulted' }))
  expect(runtime.toolCall(toolCallEvent2('powershell', 'git reset --hard'), { cwd })).toBeUndefined()
})

test('write/edit into .cc-safety-net is a persistence denial — the door checkCommand leaves open', () => {
  const result = call('write', { path: '.cc-safety-net/rules.json' })
  expect(result?.block).toBe(true)
  expect(result?.reason).toContain('persistence')
})

// ── #53 S1.1 + S1.2: the guard judges the path pi will ACTUALLY touch ─────────────────────
// pi's tools resolve `path` through `resolveToCwd` (leading `@` stripped, `~` expanded,
// `file://` decoded). A guard resolving with plain `resolve()` saw each of these as a
// non-existent path INSIDE the workspace and permitted it; pi then wrote outside it.
for (const escapingPath of ['@/etc/passwd', '~/evil.sh', 'file:///etc/cron.d/x']) {
  test(`⚠ write to "${escapingPath}" is blocked as outside the workspace`, () => {
    const result = call('write', { path: escapingPath })
    expect(result?.block).toBe(true)
    expect(result?.reason).toContain('outside the workspace')
  })
}

test('⚠ grep over the credential DIRECTORY is blocked — the #8 incident shape, closed', () => {
  const result = call('grep', { path: '~/.aws' })
  expect(result?.block).toBe(true)
  expect(result?.reason).toContain('credential')
})

// The consuming-module spot check: `tool_result` resolves through the same function, so a
// read of `@x` must confer knowledge of `x` for #10 — before the fix it recorded `<cwd>/@/x`
// and the follow-up write was refused as "never read".
test('a read through the @ prefix confers knowledge of the plain path (#10 agrees with pi)', () => {
  const { runtime, cwd, existingFile } = readPreconditionFixture()
  runtime.toolResult(toolResultEvent('read', `@${existingFile}`, false), { cwd })
  expect(runtime.toolCall(toolCallEvent('write', existingFile), { cwd })).toBeUndefined()
})

// ⚠ The list above is a copy of pi's registry. This is the receipt that it still matches:
// the three exported factories (`createCodingTools`, `createReadOnlyTools`,
// `createPowerShellTool`) together build every tool pi 0.84.4 ships (`allToolNames` in
// dist/core/tools/index.js is not on the export map, so the factories are the reachable
// source of truth). A new pi mutator would land in this diff, not fall to the reader gate
// unnoticed — and `GUARD_POLICY_TOOL_NAMES` must name only tools pi actually registers.
test("⚠ PI_SHIPPED_TOOL_NAMES matches the tools pi's factories build, and the guard policy names only real tools", () => {
  const piTools = [...createCodingTools(cwd), ...createReadOnlyTools(cwd), createPowerShellTool(cwd)]
  const realNames = [...new Set(piTools.map((tool) => tool.name))].sort()
  expect(realNames).toEqual([...PI_SHIPPED_TOOL_NAMES].sort())
  for (const policyName of GUARD_POLICY_TOOL_NAMES) expect(realNames).toContain(policyName)
  // And the policy list is EXACTLY the gated set — the audit's mutation (drop `edit`) failed
  // no test, because the session_start check iterates whatever the list happens to hold.
  expect([...GUARD_POLICY_TOOL_NAMES].sort()).toEqual(['bash', 'edit', 'powershell', 'read', 'write'])
})

// ── #53 S3: a tool event with no `input` must not throw out of a must-not-throw handler ──
// pi's contract says `input` is an object, but the handler's own rule (a throwing hook
// wedges print mode; in-process it yields a session with the guard half-set-up) means
// "never throw" has to hold for the shape the contract forbids as well.
test('a tool_call with no input is handled without throwing (write, bash, read)', () => {
  const guard = loadGuard()
  for (const toolName of ['write', 'bash', 'read', 'edit', 'powershell']) {
    expect(() => guard({ type: 'tool_call', toolCallId: 't', toolName }, { cwd })).not.toThrow()
  }
})

test('a tool_result with no input is handled without throwing', () => {
  const runtime = loadGuardRuntime()
  expect(() =>
    runtime.toolResult({ type: 'tool_result', toolCallId: 't', toolName: 'read', isError: false }, { cwd }),
  ).not.toThrow()
})

// ── two deny branches of the HANDLER that no test had reached (#162 exit criteria) ─────────
// The core functions beneath them (`findDeniedNetworkEgress`, `looksLikeSecret`) are pinned in
// their own suites; these pin the WIRING — that the handler turns each verdict into a block
// with the reason a model can act on. Both branches are security-relevant, and a handler that
// dropped either would have left every core test green.

test('⚠ an egress construct the deny cannot see through is REFUSED by the handler, naming the construct and the sanctioned path', () => {
  // A command substitution with quoting inside it: not a denied name, a shape the scanner cannot vouch for (#57).
  const verdict = call('bash', { command: 'x=$(echo "cu"rl); $x http://example.com' })
  expect(verdict?.block).toBe(true)
  expect(verdict?.reason).toContain('cannot vouch')
  expect(verdict?.reason).toContain('command substitution')
  expect(verdict?.reason).toContain('web_fetch')
})

test('⚠ a write to a credential-shaped path inside the workspace is blocked as a credential, not as internals or persistence', () => {
  // Not `.git/` (internals), not a shell rc (persistence): the third refusal, by secret pattern alone.
  const verdict = call('write', { path: 'deploy/.aws/credentials', content: 'aws_access_key_id = x' })
  expect(verdict?.block).toBe(true)
  expect(verdict?.reason).toContain('credential pattern')
  expect(verdict?.reason).not.toContain('protected internals')
  expect(verdict?.reason).not.toContain('persistence')
})
