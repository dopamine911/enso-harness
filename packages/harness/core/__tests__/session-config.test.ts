import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensoAgentDir, projectConfigPath } from '@enso/core/paths'
import { createProjectTrustStore } from '../project-trust.ts'
import {
  type SessionConfigContext,
  type SessionEnsoConfig,
  sessionEnsoConfig,
  userJudgeConfig,
} from '../session-config.ts'

/**
 * #421: the session's config — the user's, and over it a trusted project's `.enso/config.json`.
 * Each case is a real ENSO_HOME and a real project directory; the UI is the one thing faked, and it
 * records the question and the notices a person would see.
 */

interface Fixture {
  readonly home: string
  readonly cwd: string
  readonly asked: string[]
  readonly notices: string[]
  /** `hostTrust`: the web host owns trust (#502) and pi's answer is this; absent, the terminal. */
  context(answer?: string, hasUI?: boolean, hostTrust?: boolean): SessionConfigContext
}

function fixture(options: { user?: object; project?: object; settings?: object } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'enso-session-config-'))
  const home = join(root, 'home', '.enso')
  const cwd = join(root, 'project')
  mkdirSync(ensoAgentDir(home), { recursive: true })
  mkdirSync(cwd, { recursive: true })
  if (options.user !== undefined) writeFileSync(join(home, 'config.json'), JSON.stringify(options.user))
  if (options.settings !== undefined)
    writeFileSync(join(ensoAgentDir(home), 'settings.json'), JSON.stringify(options.settings))
  if (options.project !== undefined) {
    mkdirSync(join(cwd, '.enso'))
    writeFileSync(projectConfigPath(cwd), JSON.stringify(options.project))
  }
  const asked: string[] = []
  const notices: string[] = []
  return {
    home,
    cwd,
    asked,
    notices,
    context: (answer?: string, hasUI = true, hostTrust?: boolean) => ({
      home,
      cwd,
      hasUI,
      isProjectTrusted: () => hostTrust === true,
      hostOwnsTrust: hostTrust !== undefined,
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
  createProjectTrustStore(ensoAgentDir(f.home)).setMany([{ path: f.cwd, decision: true }])
  const resolved = await sessionEnsoConfig({}, f.context())
  expect(hostsOf(resolved)).toEqual(['docs.user.example', 'docs.project.example'])
  expect(resolved.path).toBe(projectConfigPath(f.cwd))
  expect(resolved.sources).toEqual([join(f.home, 'config.json'), projectConfigPath(f.cwd)])
  expect(f.asked).toEqual([])
})

test("⚠ an untrusted project's config is NOT read, and the session is told so (#421)", async () => {
  const f = fixture({ user: USER, project: PROJECT })
  createProjectTrustStore(ensoAgentDir(f.home)).setMany([{ path: f.cwd, decision: false }])
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
  expect(createProjectTrustStore(ensoAgentDir(f.home)).get(f.cwd)).toBe(true)
})

test('a this-session-only answer trusts this session and saves nothing', async () => {
  const f = fixture({ user: USER, project: PROJECT })
  const resolved = await sessionEnsoConfig({}, f.context('Trust (this session only)'))
  expect(hostsOf(resolved)).toEqual(['docs.user.example', 'docs.project.example'])
  expect(createProjectTrustStore(ensoAgentDir(f.home)).get(f.cwd)).toBeNull()
})

test("⚠ with no UI to ask on, an undecided project is untrusted (pi's rule), and said", async () => {
  const f = fixture({ user: USER, project: PROJECT })
  const resolved = await sessionEnsoConfig({}, f.context('Trust', false))
  expect(f.asked).toEqual([])
  expect(hostsOf(resolved)).toEqual(['docs.user.example'])
  expect(f.notices.join()).toContain('not trusted')
})

test("pi's defaultProjectTrust decides an undecided project without asking: always, never", async () => {
  const always = fixture({ user: USER, project: PROJECT, settings: { defaultProjectTrust: 'always' } })
  expect(hostsOf(await sessionEnsoConfig({}, always.context()))).toEqual(['docs.user.example', 'docs.project.example'])
  const never = fixture({ user: USER, project: PROJECT, settings: { defaultProjectTrust: 'never' } })
  expect(hostsOf(await sessionEnsoConfig({}, never.context('Trust')))).toEqual(['docs.user.example'])
  expect([...always.asked, ...never.asked]).toEqual([])
})

test("⚠ projects.roots is user-only: a trusted project's is ignored, and said", async () => {
  const f = fixture({ user: USER, project: { ...PROJECT, projects: { roots: ['/'] } } })
  const resolved = await sessionEnsoConfig({}, f.context('Trust'))
  expect(resolved.result.kind === 'ok' ? resolved.result.config.projects : 'unreadable').toBeUndefined()
  expect(f.notices.join()).toContain('projects.roots')
})

// #551: whether a thread runs on its own tree is the user's call, made where the server reads the
// user's file; a checkout naming `threads` would otherwise read as if it had taken effect.
test("⚠ threads is user-only: a trusted project's is ignored, and said", async () => {
  const f = fixture({ user: USER, project: { ...PROJECT, threads: { tree: 'off' } } })
  const resolved = await sessionEnsoConfig({}, f.context('Trust'))
  expect(resolved.result.kind === 'ok' ? resolved.result.config.threads : 'unreadable').toBeUndefined()
  expect(f.notices.join()).toContain('threads')
})

test("a trusted project's unreadable config fails CLOSED, naming the project's file", async () => {
  const f = fixture({ user: USER, project: { webFetch: { allowedHost: ['typo'] } } })
  const resolved = await sessionEnsoConfig({}, f.context('Trust'))
  expect(resolved.result.kind).toBe('unreadable')
  expect(resolved.path).toBe(projectConfigPath(f.cwd))
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
