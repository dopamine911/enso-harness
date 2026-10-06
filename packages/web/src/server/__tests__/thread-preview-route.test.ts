import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EnsoThreadPages } from '@enso/core'
import { createThreadPagesRoute } from '../thread-preview-route.ts'

/** The listing over a stored thread whose tree is `tree`, served. */
const listingOf = (tree: string): Promise<EnsoThreadPages | undefined> =>
  createThreadPagesRoute({
    threads: { peek: () => undefined },
    host: { storedThreadDirectory: () => Promise.resolve(tree) },
    servesDirectory: () => true,
  })('t1')

test('the listing names pages two levels deep, never inside .git or node_modules, shallowest first (#619)', async () => {
  const tree = mkdtempSync(join(tmpdir(), 'enso-pages-'))
  for (const directory of ['game/levels', 'node_modules/dep', '.git'])
    mkdirSync(join(tree, directory), { recursive: true })
  for (const page of [
    'index.html',
    'game/play.htm',
    'game/levels/one.html',
    'node_modules/dep/x.html',
    '.git/y.html',
  ]) {
    writeFileSync(join(tree, page), '<p>page</p>')
  }
  writeFileSync(join(tree, 'game.js'), '')
  expect(await listingOf(tree)).toEqual({
    threadId: 't1',
    path: tree,
    pages: ['index.html', 'game/play.htm'],
    truncated: false,
  })
})

test('a tree with more pages than the listing holds says it was cut', async () => {
  const tree = mkdtempSync(join(tmpdir(), 'enso-pages-many-'))
  for (let page = 0; page < 51; page += 1) writeFileSync(join(tree, `page-${String(page).padStart(2, '0')}.html`), '')
  const listing = await listingOf(tree)
  expect([listing?.pages.length, listing?.truncated]).toEqual([50, true])
})

test('a thread with no served directory has no listing', async () => {
  const listing = await createThreadPagesRoute({
    threads: { peek: () => undefined },
    host: { storedThreadDirectory: () => Promise.resolve('/not/served') },
    servesDirectory: () => false,
  })('t1')
  expect(listing).toBeUndefined()
})
