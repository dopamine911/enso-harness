import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { filesUnder } from '../scripts/source-tree.ts'
import { REPOSITORY_ROOT } from './gate-support.ts'

/**
 * `scripts/` is TypeScript, with nothing left to except (#269, #308).
 *
 * The split was a coin flip: six programs there were `.mjs` and nine `.ts`, one
 * `scripts/tsconfig.json` covered both with `allowJs`, and both halves were started the same
 * way — so a new script had no rule to land on. #269 wrote the rule in `README.md` →
 * *Repo layout* and named the six as historical; #308 moved them and dropped `allowJs`, so
 * the exception list is gone and the MECHANISM is what makes a seventh impossible rather
 * than this gate: a `.mjs` under `scripts/` is outside `scripts/tsconfig.json`'s `include`
 * and is not type-checked at all.
 *
 * ⚠ Enforcement, not a unit test — the shape of `fallow-config.test.ts`, pointed at a
 * sentence instead of a manifest. A rule written in a README is a wish; these hold it to the
 * disk (a `.mjs` fails, and prose that still names one fails with it) and to the reason it
 * was written for (a script invoked by something other than bun would expire it).
 *
 * What it does not check: the shebang of a file nobody invokes through `package.json`, and a
 * `node scripts/…` spelled inside a workflow or a hook rather than in a script entry.
 */

const README = readFileSync(join(REPOSITORY_ROOT, 'README.md'), 'utf8')
const LAYOUT_SECTION = README.split(/^## /m).find((section) => section.startsWith('Repo layout')) ?? ''

/** Every manifest in the workspace, root and packages: a script entry anywhere is an invocation. */
function scriptEntries(): [string, string][] {
  const manifests = [
    'package.json',
    'packages/core/package.json',
    'packages/web/package.json',
    'packages/harness/package.json',
  ]
  const entries: [string, string][] = []
  for (const manifest of manifests) {
    const parsed = JSON.parse(readFileSync(join(REPOSITORY_ROOT, manifest), 'utf8')) as {
      scripts?: Record<string, string>
    }
    for (const [name, command] of Object.entries(parsed.scripts ?? {})) entries.push([`${manifest} ${name}`, command])
  }
  return entries
}

test('⚠ every file under scripts/ is TypeScript, and the README claims no exception (#269, #308)', () => {
  const notTypeScript = filesUnder(join(REPOSITORY_ROOT, 'scripts'), {
    keep: (file: string): boolean => !file.endsWith('.ts'),
  }).map((path) => basename(path))
  // Named, not counted: the offender IS the file to move.
  expect(notTypeScript).toEqual([])
  // The other direction, and it is how the rule rots rather than breaks: prose naming an
  // exception the tree no longer has. #269's list was correct until #308 emptied it.
  expect([...LAYOUT_SECTION.matchAll(/`([\w.-]+\.mjs)`/g)].map((match) => match[1])).toEqual([])
  // The rule has no reason to exist over an empty directory.
  expect(filesUnder(join(REPOSITORY_ROOT, 'scripts')).length).toBeGreaterThan(5)
})

/**
 * ⚠ The rule's REASON, not its letter: `.ts` is free because bun runs these. A script entry
 * that reached for another runtime would make the rule arbitrary again, and it would be this
 * line that said so rather than a reader noticing.
 */
test('⚠ every package.json script that runs a file under scripts/ runs it with bun (#269)', () => {
  // ⚠ Every workspace manifest, not the root alone (PR #315 review): a `scripts/`-referencing
  // entry added to a package's own manifest would otherwise expire the rule where nothing looks.
  const invocations = scriptEntries().filter(([, command]) => command.includes('scripts/'))
  expect(invocations.filter(([, command]) => !command.startsWith('bun scripts/'))).toEqual([])
  // The rule has no reason to exist if nothing is invoked this way.
  expect(invocations.length).toBeGreaterThan(0)
})
