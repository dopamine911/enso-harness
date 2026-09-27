import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import lockfile from 'proper-lockfile'
import {
  createProjectTrustStore,
  type ProjectTrustOption,
  type ProjectTrustUpdate,
  projectTrustOptions,
} from '../project-trust.ts'

/**
 * The replica of pi's project-trust store (#421), held to pi's OWN module. A project's `.enso/` is
 * gated by the same `trust.json` that gates its `.pi/`, so the two implementations must agree on
 * every read, every write and the lock — a disagreement is a project trusted in one and not the
 * other, or a decision one of them silently drops.
 *
 * `import.meta.resolve`, not `require.resolve`: pi's export map declares an `import` condition only.
 */
interface RuntimeTrustStore {
  get(cwd: string): boolean | null
  setMany(updates: readonly ProjectTrustUpdate[]): void
}
interface RuntimeTrustModule {
  ProjectTrustStore: new (agentDir: string) => RuntimeTrustStore
  getProjectTrustOptions(cwd: string, options?: { includeSessionOnly?: boolean }): unknown
}
const piEntryPoint = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))
// Dynamic by necessity: the module is not on pi's export map, so it is reached by file path.
const pi = (await import(join(dirname(piEntryPoint), 'core', 'trust-manager.js'))) as RuntimeTrustModule

/** An agent dir, and a tree of projects: `root/parent/project`, plus a symlink to the project. */
function fixture(): { agentDir: string; parent: string; project: string; linked: string } {
  const root = mkdtempSync(join(tmpdir(), 'enso-trust-'))
  const parent = join(root, 'parent')
  const project = join(parent, 'project')
  mkdirSync(project, { recursive: true })
  const linked = join(root, 'linked')
  symlinkSync(project, linked)
  return { agentDir: join(root, 'agent'), parent, project, linked }
}

test('⚠ a decision either side writes reads the same on the other, by the nearest ancestor that has one', () => {
  const { agentDir, parent, project } = fixture()
  const ours = createProjectTrustStore(agentDir)
  const theirs = new pi.ProjectTrustStore(agentDir)
  expect(ours.get(project)).toBeNull()
  // Ours trusts the parent: pi reads it for the project beneath.
  ours.setMany([{ path: parent, decision: true }])
  expect(theirs.get(project)).toBe(true)
  // pi refuses the project itself: ours reads the nearer decision.
  theirs.setMany([{ path: project, decision: false }])
  expect(ours.get(project)).toBe(false)
  expect(ours.get(parent)).toBe(true)
  // A null removes: back to the parent's answer, on both sides.
  ours.setMany([{ path: project, decision: null }])
  expect(theirs.get(project)).toBe(true)
})

test('⚠ both write the same bytes for the same decisions — one file, sorted, the same format', () => {
  const left = fixture()
  const right = fixture()
  const decisions = (base: typeof left): ProjectTrustUpdate[] => [
    { path: base.project, decision: false },
    { path: base.parent, decision: true },
  ]
  createProjectTrustStore(left.agentDir).setMany(decisions(left))
  new pi.ProjectTrustStore(right.agentDir).setMany(decisions(right))
  const normalized = (file: string, base: typeof left): string =>
    readFileSync(file, 'utf8').replaceAll(dirname(base.parent), '<root>')
  expect(normalized(join(left.agentDir, 'trust.json'), left)).toBe(
    normalized(join(right.agentDir, 'trust.json'), right),
  )
})

test('a symlinked project and its target are one decision, on both sides', () => {
  const { agentDir, project, linked } = fixture()
  createProjectTrustStore(agentDir).setMany([{ path: linked, decision: true }])
  expect(new pi.ProjectTrustStore(agentDir).get(project)).toBe(true)
})

test("the answers offered are pi's, in pi's order and wording, with the this-session-only variants", () => {
  const { project } = fixture()
  expect(projectTrustOptions(project)).toEqual(
    pi.getProjectTrustOptions(project, { includeSessionOnly: true }) as ProjectTrustOption[],
  )
})

// ⚠ THE LOCK. Both must contend for ONE lock, or a `.pi/` decision and an `.enso/` decision
// written together each overwrite the other's. Held from outside, the lock stops pi's write and
// ours alike; released, both proceed.
test('⚠ the lock pi takes is the lock ours takes: held, both writes are refused; released, both proceed', () => {
  const { agentDir, project } = fixture()
  const ours = createProjectTrustStore(agentDir)
  const theirs = new pi.ProjectTrustStore(agentDir)
  ours.setMany([{ path: project, decision: true }])
  const release = lockfile.lockSync(agentDir, { realpath: false, lockfilePath: join(agentDir, 'trust.json.lock') })
  try {
    expect(() => ours.setMany([{ path: project, decision: false }])).toThrow(/lock/i)
    expect(() => theirs.setMany([{ path: project, decision: false }])).toThrow(/lock/i)
  } finally {
    release()
  }
  ours.setMany([{ path: project, decision: false }])
  expect(theirs.get(project)).toBe(false)
})
