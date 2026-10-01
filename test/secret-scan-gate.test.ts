import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { REPOSITORY_ROOT } from './gate-support.ts'

/**
 * The range `.github/workflows/secret-scan.yml` hands gitleaks is the coverage of the only
 * gate that stops a committed secret, so it is asserted here rather than read (#209).
 *
 * A secret's remedy is rotation — rewriting history does not un-leak it — which is why that
 * workflow's own header opens on the asymmetry. The range is one string in one shell line,
 * and the two ways to get it wrong are invisible in review:
 *
 *   1. `--no-merges` (what this repository shipped) skips merge commits. A merge's conflict
 *      resolution is content that exists in NEITHER parent, so a secret written while
 *      resolving `Merge branch 'main' into …` on a pull-request branch lands on `main`
 *      unscanned. This repository merges rather than squashes, so those commits do land.
 *   2. `--first-parent` looks like the fix and is a regression: it limits TRAVERSAL, dropping
 *      every commit reached through a second parent, so a secret committed on a side branch
 *      and then removed while resolving the merge is walked by neither the commit nor the
 *      merge diff. `--diff-merges=first-parent` changes only what a merge DISPLAYS.
 *
 * Both cases run the real `git log -p -U0` that gitleaks itself runs (confirmed against
 * gitleaks 8.18.4 under `GIT_TRACE=1`) over a fixture repository, with the flags read out of
 * the workflow. gitleaks is not installed here; what is asserted is the CONTENT the scanner
 * is handed, which is the half a flag can silently lose.
 *
 * ⚠ The scan's rules, its allowlist and the base/head SHAs the event supplies are outside
 * this: a red line here means the range stopped covering merge commits.
 */

const WORKFLOW = '.github/workflows/secret-scan.yml'

/** The `--log-opts` flags the workflow passes, with its `${BASE_SHA}..${HEAD_SHA}` range removed. */
function walkFlagsOfWorkflow(): string[] {
  const workflow = readFileSync(join(REPOSITORY_ROOT, WORKFLOW), 'utf8')
  const logOpts = /--log-opts="([^"]*)"/.exec(workflow)?.[1]
  if (logOpts === undefined) throw new Error(`${WORKFLOW}: no --log-opts to read the walked range from`)
  expect(logOpts).toContain('${BASE_SHA}..${HEAD_SHA}')
  return logOpts.split(/\s+/).filter((flag) => flag.startsWith('-'))
}

/** Absolute, so the child needs no `PATH` and the environment below can be empty of everything else. */
const GIT = Bun.which('git') ?? 'git'

/**
 * One git command against the fixture, with an environment of its own.
 *
 * ⚠ EVERY ambient git variable has to go, not just the config ones. This suite runs inside
 * `bun run check`, which runs inside the pre-commit hook, where `GIT_DIR`, `GIT_WORK_TREE` and
 * `GIT_INDEX_FILE` all point at the COMMIT BEING MADE — a `git add` in a fixture then stages a
 * fixture file into the real commit, and the commit fails with `invalid object … for
 * 'config.txt'`. Observed exactly that before this environment was passed. `--git-dir` on the
 * command line does not save it: there is no flag for the index. So the child gets a fixed
 * environment — the binary is absolute, so it needs no `PATH` — and the identity, hooks,
 * template and signing settings are named rather than inherited.
 */
function git(root: string, ...args: string[]): string {
  const run = Bun.spawnSync([GIT, ...args], {
    cwd: root,
    env: {
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_AUTHOR_NAME: 'secret scan fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'secret scan fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    },
  })
  return `${run.stdout.toString()}${run.stderr.toString()}`
}

/**
 * A repository shaped like a pull-request branch that merged another branch, and the marker
 * each history holds. `resolution` decides where the marker is: written while resolving the
 * conflict (in neither parent), or committed on the side branch and dropped by the
 * resolution (in the second parent only).
 */
function fixtureRange(resolution: 'writes-the-marker' | 'drops-the-marker'): { root: string; range: string } {
  const root = mkdtempSync(join(tmpdir(), 'enso-secret-scan-'))
  const marker = MARKER
  git(root, 'init', '-q', '-b', 'main', '.')
  writeFileSync(join(root, 'config.txt'), 'shared = 1\n')
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'base')
  const base = git(root, 'rev-parse', 'HEAD').trim()

  git(root, 'switch', '-qc', 'side')
  writeFileSync(join(root, 'config.txt'), resolution === 'drops-the-marker' ? `key = ${marker}\n` : 'shared = 2\n')
  git(root, 'commit', '-qam', 'the side branch edits config')
  git(root, 'switch', '-q', 'main')
  git(root, 'switch', '-qc', 'feature')
  writeFileSync(join(root, 'config.txt'), 'shared = 3\n')
  git(root, 'commit', '-qam', 'the branch edits config')
  git(root, 'merge', 'side') // conflicts on purpose: a resolution is a commit of its own
  writeFileSync(join(root, 'config.txt'), resolution === 'writes-the-marker' ? `key = ${marker}\n` : 'shared = 4\n')
  git(root, 'add', 'config.txt')
  git(root, 'commit', '-qm', "Merge branch 'side' into feature")
  fixtureRoots.push(root)
  return { root, range: `${base}..${git(root, 'rev-parse', 'HEAD').trim()}` }
}

/** Every fixture repository this file made, removed together: each one is a real `git init`. */
const fixtureRoots: string[] = []
afterAll(() => {
  for (const root of fixtureRoots) rmSync(root, { recursive: true, force: true })
})

/**
 * AWS's own canonical example access key: `aws-access-token` in shape, allowlisted by name in
 * `.github/workflows/secret-scan.yml`'s baseline, and reserved by AWS so it can never be real.
 *
 * ⚠ These tests do not run gitleaks — they assert that `git log -p` HANDS it this line — so the
 * marker only has to be distinctive, not detectable. An invented AKIA literal was both, and it
 * tripped this repository's own scan on the commit that introduced it (PR #318). A value the
 * baseline already allows is the same shape without the self-inflicted finding.
 */
const MARKER = 'AKIAIOSFODNN7EXAMPLE'

test('⚠ the secret gate walks a secret written while RESOLVING a merge (#209)', () => {
  const { root, range } = fixtureRange('writes-the-marker')
  const walked = git(root, 'log', '-p', '-U0', ...walkFlagsOfWorkflow(), range)
  // `--no-merges`, which this repository shipped, hands gitleaks a patch without this line.
  expect(walked).toContain(MARKER)
})

test('⚠ the secret gate still walks a secret a merge resolution REMOVED (#209)', () => {
  const { root, range } = fixtureRange('drops-the-marker')
  const walked = git(root, 'log', '-p', '-U0', ...walkFlagsOfWorkflow(), range)
  // `--first-parent` would drop the side commit from the traversal, and the merge's own diff
  // does not carry a line the resolution deleted: the secret would be scanned by nothing.
  expect(walked).toContain(MARKER)
})

/**
 * THE CONFIG THE SCAN ACTUALLY USES, and the one line whose absence is invisible (#209).
 *
 * gitleaks auto-detects `.gitleaks.toml` at the repository root and that file REPLACES the
 * default ruleset, so adding one moves the workflow onto its `if` branch: the baseline it
 * writes for a config-less repository stops being applied. Two failures follow from that, and
 * neither is visible in a diff:
 *
 *   1. A config without `[extend] useDefault = true` disables EVERY built-in rule. The scan
 *      then exits 0 on a repository full of secrets and reads as a clean result — the one
 *      failure mode where a green gate is worse than no gate.
 *   2. A config whose allowlist is narrower than the baseline re-opens the false positives the
 *      baseline exists to settle, and the fix people reach for under a red check is deleting
 *      the rule rather than the pattern.
 *
 * So: the file exists, it extends the defaults, and it allows everything the baseline allowed.
 */
const REPOSITORY_CONFIG = '.gitleaks.toml'

/** The quoted `'''…'''` patterns of a TOML allowlist, in order. */
function allowlistPatterns(toml: string): string[] {
  const block = /regexes\s*=\s*\[([\s\S]*?)\n\s*\]/.exec(toml)?.[1]
  if (block === undefined) throw new Error('no `regexes = [...]` allowlist to read')
  return [...block.matchAll(/'''([\s\S]*?)'''/g)].map((pattern) => pattern[1] ?? '')
}

test('⚠ the repository gitleaks config extends the defaults — without it every rule is off (#209)', () => {
  const config = readFileSync(join(REPOSITORY_ROOT, REPOSITORY_CONFIG), 'utf8')
  // Not a substring check on the words: the assignment, with `useDefault` true and not commented.
  expect(/^\s*\[extend\]\s*\n\s*useDefault\s*=\s*true\s*$/m.test(config)).toBe(true)
})

test('⚠ the repository allowlist keeps every pattern the workflow baseline had (#209)', () => {
  const config = allowlistPatterns(readFileSync(join(REPOSITORY_ROOT, REPOSITORY_CONFIG), 'utf8'))
  // The baseline lives in the workflow's heredoc, and is only applied when no config exists —
  // which is why it is read from there rather than restated here: one source, both branches.
  const workflow = readFileSync(join(REPOSITORY_ROOT, WORKFLOW), 'utf8')
  const baseline = allowlistPatterns(workflow.slice(workflow.indexOf('[extend]')))
  expect(baseline.length).toBeGreaterThan(0)
  expect(config).toEqual(expect.arrayContaining(baseline))
})

/**
 * THE TRIGGER THAT RUNS BEFORE A MERGE (#538). The scan once ran on `merge_group` alone, on the
 * premise that `main` required a merge queue; it did not, this repository has never had a
 * `merge_group` run, and so no pull request was scanned before it merged — secrets were caught
 * only by the push backstop, when they already needed rotating. A test can hold the workflow
 * file; it cannot see the repository setting, which is why `pull_request` is the trigger held.
 */

/** The `on:` block of the workflow, as the lines indented under it. */
function triggerBlockOfWorkflow(): string {
  const workflow = readFileSync(join(REPOSITORY_ROOT, WORKFLOW), 'utf8')
  const block = /^on:\n((?:[ \t]+.*\n|\n)*)/m.exec(workflow)?.[1]
  if (block === undefined) throw new Error(`${WORKFLOW}: no top-level on: block`)
  return block
}

test('⚠ the secret scan runs on every push to a pull request, before any merge (#538)', () => {
  const triggers = triggerBlockOfWorkflow()
  const pullRequest = /^ {2}pull_request:\n((?:[ ]{4}.*\n)*)/m.exec(triggers)?.[1]
  expect(pullRequest).toBeDefined()
  // Not `opened` alone: a push after opening must re-scan, and a draft made ready must be scanned.
  const types =
    /types:\s*\[([^\]]*)\]/
      .exec(pullRequest ?? '')?.[1]
      ?.split(',')
      .map((type) => type.trim()) ?? []
  expect(types).toEqual(expect.arrayContaining(['opened', 'synchronize', 'reopened', 'ready_for_review']))
  // The other two stay: the queue's authoritative check if one is ever enabled, and the backstop on main.
  expect(/^ {2}merge_group:/m.test(triggers)).toBe(true)
  expect(/^ {2}push:\n[ ]{4}branches: \[main\]/m.test(triggers)).toBe(true)
})
