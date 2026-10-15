import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * The anchor for #125 item 3 / #103 invariant 2 (switching threads leaks no state): every
 * store that holds a THREAD's state is created inside `createThreadStores` (thread-stores.ts),
 * so a second thread on the page gets its own. A store created at module level is shared by
 * every thread on the page — the bug class the mounted two-threads test observes
 * (thread-pane.test.tsx) and this test refuses at the source, by name.
 *
 * The module-level stores are PAGE state by design and are listed here with their reason.
 * Adding another means adding it here, with its reason — not making the check looser.
 */

const webSource = join(import.meta.dir, '..')

/** `path:name` of every store created at column zero — a module-level singleton. */
const PAGE_SCOPED_BY_DESIGN: readonly string[] = [
  // The rail's list of the page's threads: one list per page, owned by the registry.
  'thread-stores.ts:threadList',
  // The server's stored-threads listing (the rail's earlier threads): one per page, refreshed on settle.
  'page-listings.ts:storedThreads',
  // The server's projects (#395): the rail's sections, one list per page, fetched on load.
  'page-listings.ts:projectList',
  // The user's models section (#904): favorites, roles, presets — one per page, read on load and saved whole.
  'models-settings.ts:modelsSettings',
  // The page's log ring and shipper (#132): configured once by main.tsx, read by the drawer.
  'thread-stores.ts:browserLogging',
  // The page's clock (#278): one interval, every relative age on the page subscribed to it.
  'page-clock.ts:pageClock',
  // Whether the page may be out of date (#919): one banner per page, whichever thread or pane fell behind.
  'page-health.ts:fault',
]

const MODULE_LEVEL_STORE = /^(?:export )?const (\w+)(?::[^=]+)? = create\w*(?:Store|Lines)\w*(?:<[^\n]*?>)?\(/gm

function moduleLevelStores(): string[] {
  const found: string[] = []
  for (const dirEntry of readdirSync(webSource, { withFileTypes: true, recursive: true })) {
    if (!dirEntry.isFile()) continue
    if (!(dirEntry.name.endsWith('.ts') || dirEntry.name.endsWith('.tsx'))) continue
    const absolutePath = join(dirEntry.parentPath, dirEntry.name)
    const sourceRelative = relative(webSource, absolutePath)
    if (sourceRelative.startsWith('__tests__') || sourceRelative.includes('/__tests__/')) continue
    if (sourceRelative.startsWith('components/')) continue
    const source = readFileSync(absolutePath, 'utf8')
    for (const match of source.matchAll(MODULE_LEVEL_STORE)) found.push(`${sourceRelative}:${match[1]}`)
  }
  return found.toSorted()
}

test('⚠ every module-level store is page state, named here with its reason — thread state is created per thread', () => {
  expect(moduleLevelStores()).toEqual([...PAGE_SCOPED_BY_DESIGN].toSorted())
})
