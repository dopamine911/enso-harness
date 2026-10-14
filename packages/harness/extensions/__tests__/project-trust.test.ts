import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ProjectTrustStore, SettingsManager } from '@earendil-works/pi-coding-agent'
import {
  ensoAgentDir,
  ensoConfigPath,
  ensoProjectsDir,
  projectConfigApprovalsPath,
  projectConfigPath,
  projectIdOfCwd,
} from '@enso/core/paths'
import { approveProjectTier, reviewProjectConfig } from '@enso/core/project-config'
import { sessionConfigEnvironment, sessionEnsoConfig } from '../../core/index.ts'
import { type ProjectTrustOption, projectTrustOptions } from '../../core/project-trust.ts'

/**
 * #509: the terminal's trust question for a project's `.enso/config.json` reads and writes pi's OWN
 * store (`ProjectTrustStore`) and default (`SettingsManager#getDefaultProjectTrust`), handed in by
 * the extensions through `sessionConfigEnvironment` — the wiring they use, with pi's real classes,
 * a real ENSO_HOME and project. Only the UI is a stand-in.
 *
 * ⚠ The one copy left is `projectTrustOptions`: pi's `getProjectTrustOptions` is not on its package
 * index, so it is reached by file path (`import.meta.resolve`: pi's export map declares an `import`
 * condition only) and the copy is held to it.
 */
interface RuntimeTrustOptions {
  getProjectTrustOptions(cwd: string, options?: { includeSessionOnly?: boolean }): unknown
}
const piEntryPoint = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))
// Dynamic by necessity: the module is not on pi's export map, so it is reached by file path.
const pi = (await import(join(dirname(piEntryPoint), 'core', 'trust-manager.js'))) as RuntimeTrustOptions

const PROJECT = { webFetch: { allowedHosts: ['docs.project.example'] } }

/** Approve the project's shared file as the page would (#753): its hash as the review answers it. */
function approveShared(home: string, cwd: string): void {
  const approvals = projectConfigApprovalsPath(ensoProjectsDir(home), projectIdOfCwd(ensoProjectsDir(home), cwd))
  const shared = reviewProjectConfig(cwd, approvals).find((tier) => tier.tier === 'shared')
  approveProjectTier(cwd, approvals, { tier: 'shared', sha256: shared?.current ?? null })
}

/** A real ENSO_HOME and a project with its own `.enso/config.json`, approved, under `root/parent/project`. */
function fixture(): { home: string; parent: string; cwd: string } {
  const root = mkdtempSync(join(tmpdir(), 'enso-pi-trust-'))
  const home = join(root, 'home', '.enso')
  const parent = join(root, 'parent')
  const cwd = join(parent, 'project')
  mkdirSync(ensoAgentDir(home), { recursive: true })
  mkdirSync(join(cwd, '.enso'), { recursive: true })
  writeFileSync(projectConfigPath(cwd), JSON.stringify(PROJECT))
  approveShared(home, cwd)
  return { home, parent, cwd }
}

/** Resolve as the extensions do, answering the question (if asked) with `answer`. */
async function resolve(home: string, cwd: string, answer?: string): Promise<{ hosts: unknown; asked: number }> {
  let asked = 0
  const resolved = await sessionEnsoConfig(
    {},
    {
      cwd,
      hasUI: true,
      isProjectTrusted: () => false,
      ui: {
        select: () => {
          asked += 1
          return Promise.resolve(answer)
        },
        notify: () => undefined,
      },
      ...sessionConfigEnvironment({ ENSO_HOME: home }, { ProjectTrustStore, SettingsManager }),
    },
  )
  const hosts = resolved.result.kind === 'ok' ? resolved.result.config.webFetch?.allowedHosts : resolved.result.reason
  return { hosts, asked }
}

test("⚠ an answer saved in the terminal is in pi's store, and pi's saved decision is read back unasked (#509)", async () => {
  const { home, parent, cwd } = fixture()
  const store = new ProjectTrustStore(ensoAgentDir(home))
  expect(await resolve(home, cwd, `Trust parent folder (${parent})`)).toEqual({
    hosts: ['docs.project.example'],
    asked: 1,
  })
  expect(store.get(cwd)).toBe(true)
  expect(store.getEntry(cwd)?.path).toBe(parent)
  // pi refuses the project itself: the next session reads that, and asks nothing.
  store.set(cwd, false)
  expect(await resolve(home, cwd, 'Trust')).toEqual({ hosts: undefined, asked: 0 })
})

test("pi's defaultProjectTrust in the agent dir's settings decides an undecided project unasked (#509)", async () => {
  const { home, cwd } = fixture()
  writeFileSync(join(ensoAgentDir(home), 'settings.json'), JSON.stringify({ defaultProjectTrust: 'always' }))
  expect(await resolve(home, cwd, 'Do not trust')).toEqual({ hosts: ['docs.project.example'], asked: 0 })
})

test("⚠ a trusted project's config can't set the Claude Code version Enso claims or loosen the incident policy: the user's stand, and the person is told (#925, #466, #753)", async () => {
  const { home, cwd } = fixture()
  writeFileSync(join(ensoAgentDir(home), 'settings.json'), JSON.stringify({ defaultProjectTrust: 'always' }))
  writeFileSync(
    ensoConfigPath(home),
    JSON.stringify({ claudeCode: { version: '2.1.284' }, security: { incidents: { halt: true } } }),
  )
  writeFileSync(
    projectConfigPath(cwd),
    JSON.stringify({ ...PROJECT, claudeCode: { version: '9.9.9' }, security: { incidents: { halt: false } } }),
  )
  approveShared(home, cwd)
  const notices: string[] = []
  const resolved = await sessionEnsoConfig(
    {},
    {
      cwd,
      hasUI: true,
      isProjectTrusted: () => false,
      ui: { select: () => Promise.resolve(undefined), notify: (message: string) => notices.push(message) },
      ...sessionConfigEnvironment({ ENSO_HOME: home }, { ProjectTrustStore, SettingsManager }),
    },
  )
  if (resolved.result.kind !== 'ok') throw new Error(resolved.result.reason)
  // The project's own settings still apply: it was trusted.
  expect(resolved.result.config.webFetch?.allowedHosts).toEqual(['docs.project.example'])
  expect(resolved.result.config.claudeCode).toEqual({ version: '2.1.284' })
  expect(resolved.result.config.security).toEqual({ incidents: { halt: true } })
  expect(notices).toEqual([
    `Enso: ${projectConfigPath(cwd)} sets claudeCode, which only ${ensoConfigPath(home)} may set — ignored.`,
    `Enso: ${projectConfigPath(cwd)} sets security.incidents.halt looser than ${ensoConfigPath(home)} does — ignored: a project may only tighten it.`,
  ])
})

test("the answers offered are pi's, in pi's order and wording, with the this-session-only variants", () => {
  const { cwd } = fixture()
  expect(projectTrustOptions(cwd)).toEqual(
    pi.getProjectTrustOptions(cwd, { includeSessionOnly: true }) as ProjectTrustOption[],
  )
})
