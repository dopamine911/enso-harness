import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { incidentPolicyOf } from '@enso/core'
import {
  ensoAgentDir,
  ensoProjectsDir,
  projectConfigApprovalsPath,
  projectConfigPath,
  projectIdOfCwd,
  projectTreesDir,
} from '@enso/core/paths'
import { approveProjectTier, reviewProjectConfig } from '@enso/core/project-config'
import type { ProjectTrustRuntime, ProjectTrustUpdate } from '../project-trust.ts'
import {
  type SessionConfigContext,
  type SessionEnsoConfig,
  sessionEnsoConfig,
  sessionIncidentPolicy,
  userJudgeConfig,
} from '../session-config.ts'

/**
 * #421: the session's config — the user's, and over it a trusted project's `.enso/config.json`, as
 * the operator approved it (#753). Each case is a real ENSO_HOME and a real project directory.
 * Faked: the UI, which records the question and the notices a person would see, and pi's trust
 * store and settings (#509), which an extension injects — `harness/core` may not import pi (#145).
 * The fake records which agent dir it was opened on; pi's real classes through the real wiring are
 * `extensions/__tests__/project-trust.test.ts`'s.
 */

interface Fixture {
  readonly home: string
  readonly cwd: string
  readonly asked: string[]
  readonly notices: string[]
  /** pi's store, faked: the saved decision per directory, as the session left it. */
  readonly saved: Map<string, boolean>
  /** The agent dirs pi's store and settings were opened on. */
  readonly agentDirs: string[]
  /** `hostTrust`: the web host owns trust (#502) and pi's answer is this; absent, the terminal. */
  context(answer?: string, hasUI?: boolean, hostTrust?: boolean): SessionConfigContext
}

/** pi's store and settings, in memory: exact-directory decisions, and one `defaultProjectTrust`. */
function fakeProjectTrust(
  saved: Map<string, boolean>,
  agentDirs: string[],
  defaultProjectTrust: 'ask' | 'always' | 'never',
): ProjectTrustRuntime {
  return {
    ProjectTrustStore: class {
      constructor(agentDir: string) {
        agentDirs.push(agentDir)
      }
      get(directory: string): boolean | null {
        return saved.get(directory) ?? null
      }
      setMany(updates: ProjectTrustUpdate[]): void {
        for (const { path, decision } of updates) {
          if (decision === null) saved.delete(path)
          else saved.set(path, decision)
        }
      }
    },
    SettingsManager: {
      create: (_cwd, agentDir) => {
        agentDirs.push(agentDir)
        return { getDefaultProjectTrust: () => defaultProjectTrust }
      },
    },
  }
}

/** Where `cwd`'s project keeps its approvals under `home` (#753): the checkout's, for a tree too. */
const approvalsOf = (home: string, cwd: string): string =>
  projectConfigApprovalsPath(ensoProjectsDir(home), projectIdOfCwd(ensoProjectsDir(home), cwd))

/** Approve the project's shared file as the page would: its hash as the review answers it. */
function approveShared(home: string, cwd: string): void {
  const approvals = approvalsOf(home, cwd)
  const shared = reviewProjectConfig(cwd, approvals).find((tier) => tier.tier === 'shared')
  approveProjectTier(cwd, approvals, { tier: 'shared', sha256: shared?.current ?? null })
}

function fixture(
  options: {
    user?: object
    project?: object
    /** Whether the project's file is approved as written; it is, unless said (#753). */
    approved?: boolean
    defaultProjectTrust?: 'ask' | 'always' | 'never'
  } = {},
): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'enso-session-config-'))
  const home = join(root, 'home', '.enso')
  const cwd = join(root, 'project')
  mkdirSync(ensoAgentDir(home), { recursive: true })
  mkdirSync(cwd, { recursive: true })
  if (options.user !== undefined) writeFileSync(join(home, 'config.json'), JSON.stringify(options.user))
  if (options.project !== undefined) {
    mkdirSync(join(cwd, '.enso'))
    writeFileSync(projectConfigPath(cwd), JSON.stringify(options.project))
    if (options.approved !== false) approveShared(home, cwd)
  }
  const asked: string[] = []
  const notices: string[] = []
  const saved = new Map<string, boolean>()
  const agentDirs: string[] = []
  const projectTrust = fakeProjectTrust(saved, agentDirs, options.defaultProjectTrust ?? 'ask')
  return {
    home,
    cwd,
    asked,
    notices,
    saved,
    agentDirs,
    context: (answer?: string, hasUI = true, hostTrust?: boolean) => ({
      home,
      cwd,
      hasUI,
      isProjectTrusted: () => hostTrust === true,
      hostOwnsTrust: hostTrust !== undefined,
      projectTrust,
      ui: {
        select: (title: string) => {
          asked.push(title)
          return Promise.resolve(answer)
        },
        notify: (message: string) => {
          notices.push(message)
        },
      },
    }),
  }
}

const USER = { webFetch: { allowedHosts: ['docs.user.example'] } }
const PROJECT = { webFetch: { allowedHosts: ['docs.project.example'] } }
const hostsOf = (resolved: SessionEnsoConfig): unknown =>
  resolved.result.kind === 'ok' ? resolved.result.config.webFetch?.allowedHosts : resolved.result.reason

// #502: in the web the host asks (before a run) and applies the answer to pi, then reloads the
// session. The config must follow pi's answer — never a second question — and a session trusted
// after it started must read the project's config the untrusted resolution skipped.
test("⚠ under the web host the project config follows pi's trust: never asked, and read once trusted (#502)", async () => {
  const f = fixture({ user: USER, project: PROJECT })
  const session = {}
  expect(hostsOf(await sessionEnsoConfig(session, f.context('Trust', true, false)))).toEqual(['docs.user.example'])
  expect(hostsOf(await sessionEnsoConfig(session, f.context('Trust', true, true)))).toEqual([
    'docs.user.example',
    'docs.project.example',
  ])
  expect(f.asked).toEqual([])
})

test('no project config: the user config alone, and nothing is asked', async () => {
  const f = fixture({ user: USER })
  const resolved = await sessionEnsoConfig({}, f.context('Trust'))
  expect(hostsOf(resolved)).toEqual(['docs.user.example'])
  expect(f.asked).toEqual([])
})

test('no config file anywhere: the defaults, read from no file (#435)', async () => {
  const resolved = await sessionEnsoConfig({}, fixture().context())
  expect(resolved.result).toEqual({ kind: 'ok', config: {} })
  expect(resolved.sources).toEqual([])
})

test("⚠ a trusted project's config merges over the user's: its hosts ADD to the user's (#421)", async () => {
  const f = fixture({ user: USER, project: PROJECT })
  f.saved.set(f.cwd, true)
  const resolved = await sessionEnsoConfig({}, f.context())
  expect(hostsOf(resolved)).toEqual(['docs.user.example', 'docs.project.example'])
  expect(resolved.path).toBe(projectConfigPath(f.cwd))
  expect(resolved.sources).toEqual([join(f.home, 'config.json'), projectConfigPath(f.cwd)])
  expect(f.asked).toEqual([])
})

test("⚠ an untrusted project's config is NOT read, and the session is told so (#421)", async () => {
  const f = fixture({ user: USER, project: PROJECT })
  f.saved.set(f.cwd, false)
  const resolved = await sessionEnsoConfig({}, f.context())
  expect(hostsOf(resolved)).toEqual(['docs.user.example'])
  expect(f.notices.join()).toContain('not trusted')
  // The files the resolution READ (#435): the project's exists but was not read, so it is not one.
  expect(resolved.sources).toEqual([join(f.home, 'config.json')])
})

test('⚠ no saved decision: pi\'s question is asked, and "Trust" is saved where pi reads it', async () => {
  const f = fixture({ user: USER, project: PROJECT })
  const resolved = await sessionEnsoConfig({}, f.context('Trust'))
  expect(f.asked).toHaveLength(1)
  expect(f.asked[0]).toContain(f.cwd)
  expect(hostsOf(resolved)).toEqual(['docs.user.example', 'docs.project.example'])
  expect(f.saved.get(f.cwd)).toBe(true)
  // Where pi reads it: the store opened on Enso's agent dir, the one pi's sessions use.
  expect(new Set(f.agentDirs)).toEqual(new Set([ensoAgentDir(f.home)]))
})

test('a this-session-only answer trusts this session and saves nothing', async () => {
  const f = fixture({ user: USER, project: PROJECT })
  const resolved = await sessionEnsoConfig({}, f.context('Trust (this session only)'))
  expect(hostsOf(resolved)).toEqual(['docs.user.example', 'docs.project.example'])
  expect(f.saved.size).toBe(0)
})

test("⚠ with no UI to ask on, an undecided project is untrusted (pi's rule), and said", async () => {
  const f = fixture({ user: USER, project: PROJECT })
  const resolved = await sessionEnsoConfig({}, f.context('Trust', false))
  expect(f.asked).toEqual([])
  expect(hostsOf(resolved)).toEqual(['docs.user.example'])
  expect(f.notices.join()).toContain('not trusted')
})

test("pi's defaultProjectTrust decides an undecided project without asking: always, never", async () => {
  const always = fixture({ user: USER, project: PROJECT, defaultProjectTrust: 'always' })
  expect(hostsOf(await sessionEnsoConfig({}, always.context()))).toEqual(['docs.user.example', 'docs.project.example'])
  const never = fixture({ user: USER, project: PROJECT, defaultProjectTrust: 'never' })
  expect(hostsOf(await sessionEnsoConfig({}, never.context('Trust')))).toEqual(['docs.user.example'])
  expect([...always.asked, ...never.asked]).toEqual([])
})

test("⚠ projects.roots is user-only: a trusted project's is ignored, and said", async () => {
  const f = fixture({ user: USER, project: { ...PROJECT, projects: { roots: ['/'] } } })
  const resolved = await sessionEnsoConfig({}, f.context('Trust'))
  expect(resolved.result.kind === 'ok' ? resolved.result.config.projects : 'unreadable').toBeUndefined()
  expect(f.notices.join()).toContain('projects.roots')
})

// #904 decision 1: favorites, hidden providers and roles are the user's, read from the user's file
// alone by the server; a project's `models` would configure nothing, so it is dropped and said.
test("⚠ models is user-only: a trusted project's is ignored, and said (#904)", async () => {
  const f = fixture({ user: USER, project: { ...PROJECT, models: { favorites: ['faux/model'] } } })
  const resolved = await sessionEnsoConfig({}, f.context('Trust'))
  expect(resolved.result.kind === 'ok' ? resolved.result.config.models : 'unreadable').toBeUndefined()
  expect(f.notices.join()).toContain('sets models, which only')
})

// #754: `threads` is a project setting now (its trees' mode, setup and files to copy), resolved by
// tier where a tree is made; a trusted project naming it is no longer told it was ignored.
test("a trusted project's threads is read without a warning (#754)", async () => {
  const f = fixture({ user: USER, project: { ...PROJECT, threads: { tree: 'off' } } })
  const resolved = await sessionEnsoConfig({}, f.context('Trust'))
  expect(resolved.result.kind === 'ok' ? resolved.result.config.threads : 'unreadable').toEqual({ tree: 'off' })
  expect(f.notices.join()).not.toContain('threads')
})

// A file Enso cannot read is never approved (#753); an APPROVED one this Enso cannot read — approved
// by a newer one that knew the key — still fails closed.
test("a trusted project's approved config that does not read fails CLOSED, naming the project's file", async () => {
  const typo = JSON.stringify({ webFetch: { allowedHost: ['typo'] } })
  const f = fixture({ user: USER, project: { webFetch: { allowedHost: ['typo'] } }, approved: false })
  const approvals = approvalsOf(f.home, f.cwd)
  mkdirSync(join(approvals, '..'), { recursive: true })
  const sha256 = createHash('sha256').update(typo).digest('hex')
  writeFileSync(approvals, JSON.stringify({ shared: { sha256, text: typo } }))
  const resolved = await sessionEnsoConfig({}, f.context('Trust'))
  expect(resolved.result.kind).toBe('unreadable')
  expect(resolved.path).toBe(projectConfigPath(f.cwd))
})

// #753's first acceptance item, for a session: an edit made after approval, by any route, is not
// applied — the version approved is — and the thread says so.
test('⚠ a project config changed after its approval is not applied: the approved one is, and the session is told (#753)', async () => {
  const f = fixture({ user: USER, project: PROJECT })
  writeFileSync(projectConfigPath(f.cwd), JSON.stringify({ webFetch: { allowedHosts: ['exfil.example'] } }))
  const resolved = await sessionEnsoConfig({}, f.context('Trust'))
  expect(hostsOf(resolved)).toEqual(['docs.user.example', 'docs.project.example'])
  expect(f.notices).toEqual([
    expect.stringContaining(
      `${projectConfigPath(f.cwd)} has changed since you approved it, so the version you approved is in use`,
    ),
  ])
})

test('⚠ a project config never approved applies nothing, trusted or not, and the session is told (#753)', async () => {
  const f = fixture({ user: USER, project: PROJECT, approved: false })
  const resolved = await sessionEnsoConfig({}, f.context('Trust'))
  expect(hostsOf(resolved)).toEqual(['docs.user.example'])
  expect(f.notices.join()).toContain('has not been approved, so nothing in it applies')
})

// Gap 2 of #753: a thread's tree holds its own copy of the project's file, the one its session
// reads. The copy is held to the PROJECT's approval: an agent editing it changes nothing.
test("⚠ in a thread's tree, the tree's copy is held to its project's approval (#753)", async () => {
  const f = fixture({ user: USER, project: PROJECT })
  const projectsDir = ensoProjectsDir(f.home)
  const tree = join(projectTreesDir(projectsDir, projectIdOfCwd(projectsDir, f.cwd)), 'thread-1')
  mkdirSync(join(tree, '.enso'), { recursive: true })
  writeFileSync(projectConfigPath(tree), JSON.stringify({ webFetch: { allowedHosts: ['exfil.example'] } }))
  f.saved.set(tree, true)
  const resolved = await sessionEnsoConfig({}, { ...f.context(), cwd: tree })
  expect(hostsOf(resolved)).toEqual(['docs.user.example', 'docs.project.example'])
  expect(f.notices.join()).toContain('has changed since you approved it')
})

// #753's fourth acceptance item: a project that loosens a security key is ignored with a notice;
// one that tightens it applies — in the guard, which reads it through `sessionIncidentPolicy`.
test('⚠ a project may only tighten the incident policy: loosening is ignored and said, tightening applies (#753)', async () => {
  const user = { ...USER, security: { incidents: { halt: true, incidentAtSignals: 5 } } }
  const loosening = fixture({
    user,
    project: { ...PROJECT, security: { incidents: { halt: false, incidentAtSignals: 50 }, judge: { backend: 'jev' } } },
  })
  loosening.saved.set(loosening.cwd, true)
  await sessionEnsoConfig({}, loosening.context())
  expect(loosening.notices).toEqual([
    expect.stringContaining('sets security.judge, which only'),
    expect.stringContaining('sets security.incidents.halt looser than'),
    expect.stringContaining('sets security.incidents.incidentAtSignals looser than'),
  ])
  const trusted = { cwd: loosening.cwd, trusted: true }
  expect(sessionIncidentPolicy(loosening.home, trusted).policy).toEqual(
    incidentPolicyOf({ incidents: { halt: true, incidentAtSignals: 5 } }),
  )

  const tightening = fixture({ user: USER, project: { security: { incidents: { halt: true, incidentAtSignals: 2 } } } })
  tightening.saved.set(tightening.cwd, true)
  await sessionEnsoConfig({}, tightening.context())
  expect(tightening.notices).toEqual([])
  const tightened = incidentPolicyOf({ incidents: { halt: true, incidentAtSignals: 2 } })
  expect(sessionIncidentPolicy(tightening.home, { cwd: tightening.cwd, trusted: true }).policy).toEqual(tightened)
  // Untrusted, or before a start names the project: the user's alone.
  expect(sessionIncidentPolicy(tightening.home, { cwd: tightening.cwd, trusted: false }).policy).toEqual(
    incidentPolicyOf(undefined),
  )
  expect(sessionIncidentPolicy(tightening.home, undefined).policy).toEqual(incidentPolicyOf(undefined))
})

test('⚠ one question per session: two tools resolving for the same session share the answer', async () => {
  const f = fixture({ user: USER, project: PROJECT })
  const sessionManager = {}
  const [first, second] = await Promise.all([
    sessionEnsoConfig(sessionManager, f.context('Trust (this session only)')),
    sessionEnsoConfig(sessionManager, f.context('Trust (this session only)')),
  ])
  expect(f.asked).toHaveLength(1)
  expect(second).toBe(first)
})

// ⚠ #469: the judge sends command text off the machine, so only the user switches it on — never a
// project — and a config.json that cannot be read leaves it off, saying why.
test('⚠ the command judge is the user’s alone, off by default, and off when config.json is unreadable (#469)', () => {
  const jev = { security: { judge: { backend: 'jev' } } }
  expect(userJudgeConfig(fixture({ user: jev }).home)).toEqual({ backend: 'jev' })
  expect(userJudgeConfig(fixture().home)).toEqual({ backend: 'off' })
  expect(userJudgeConfig(fixture({ project: jev }).home)).toEqual({ backend: 'off' })
  const unreadable = fixture()
  writeFileSync(join(unreadable.home, 'config.json'), '{ "security": { "judge": ')
  expect(userJudgeConfig(unreadable.home)).toEqual({ backend: 'off', problem: expect.any(String) })
  const unknownBackend = fixture({ user: { security: { judge: { backend: 'openrouter' } } } })
  expect(userJudgeConfig(unknownBackend.home)).toEqual({ backend: 'off', problem: expect.any(String) })
  // `local` (#532) names its router and model; without them it is off, and says why.
  const local = { baseUrl: 'http://127.0.0.1:8080/v1', model: 'qwen' }
  expect(userJudgeConfig(fixture({ user: { security: { judge: { backend: 'local', local } } } }).home)).toEqual({
    backend: 'local',
    local,
  })
  const bare = fixture({ user: { security: { judge: { backend: 'local' } } } })
  expect(userJudgeConfig(bare.home)).toEqual({
    backend: 'off',
    problem: expect.stringContaining('security.judge.local'),
  })
})
