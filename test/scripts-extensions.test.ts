import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { filesUnder } from '../scripts/source-tree.ts'
import { REPOSITORY_ROOT } from './gate-support.ts'

/**
 * `scripts/` is TypeScript, and the exceptions are named (#269).
 *
 * The split was a coin flip: six programs there are `.mjs` and nine are `.ts`, one
 * `scripts/tsconfig.json` covers both with `allowJs`, and both halves are started the same
 * way — so a new script had no rule to land on. There is one now, in `README.md` →
 * *Repo layout*: bun starts everything under `scripts/` and loads `.ts` directly, so nothing
 * there needs to be JavaScript. The six are historical and #308 moves them.
 *
 * ⚠ Enforcement, not a unit test — the shape of `fallow-config.test.ts`, pointed at a
 * sentence instead of a manifest. A rule written in a README is a wish; these hold it to the
 * disk (a seventh `.mjs` fails, and a moved one has to leave the sentence) and to the reason
 * it was written for (a script invoked by something other than bun would expire it).
 *
 * What it does not check: the shebang of a file nobody invokes through `package.json`, and a
 * `node scripts/…` spelled inside a workflow or a hook rather than in a script entry.
 */

const README = readFileSync(join(REPOSITORY_ROOT, 'README.md'), 'utf8')
const LAYOUT_SECTION = README.split(/^## /m).find((section) => section.startsWith('Repo layout')) ?? ''

const packageJson = JSON.parse(readFileSync(join(REPOSITORY_ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>
}

test('⚠ every non-TypeScript file under scripts/ is one the README names, and every name is still there (#269)', () => {
  const named = [...LAYOUT_SECTION.matchAll(/`([\w.-]+\.mjs)`/g)].map((match) => match[1] ?? '').sort()
  const onDisk = filesUnder(join(REPOSITORY_ROOT, 'scripts'), {
    keep: (file: string): boolean => !file.endsWith('.ts'),
  })
    .map((path) => basename(path))
    .sort()
  expect(onDisk).toEqual(named)
})

/**
 * ⚠ The rule's REASON, not its letter: `.ts` is free because bun runs these. A script entry
 * that reached for another runtime would make the rule arbitrary again, and it would be this
 * line that said so rather than a reader noticing.
 */
test('⚠ every package.json script that runs a file under scripts/ runs it with bun (#269)', () => {
  const invocations = Object.entries(packageJson.scripts).filter(([, command]) => command.includes('scripts/'))
  expect(invocations.filter(([, command]) => !command.startsWith('bun scripts/'))).toEqual([])
  // The rule has no reason to exist if nothing is invoked this way.
  expect(invocations.length).toBeGreaterThan(0)
})
