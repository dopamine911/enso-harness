import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  type ArenaCommand,
  type ArenaPublication,
  planArenaPublication,
  productIssuesIn,
  publishArenaRun,
  runArenaCommand,
} from '../publish.ts'
import { writeArenaReport } from '../report.ts'
import { writeArenaScore } from '../score.ts'
import { gitIn } from './fixture-git.ts'
import { OPTIONS, recordedRun, THREAD } from './recorded-run.ts'

/**
 * Publishing a reviewed run to the corpus (#677): what goes — the run's documents, the screenshots
 * they cite, one issue showing each finding and the product issue it maps to — and that nothing
 * goes while the run is unreviewed, unresolved, unmapped, stale or holds a secret.
 */

const SECRET = 'sk-ant-oat01-arena-test-secret'
const PRODUCT = 'owner/product'

const defect = {
  title: 'the Stats view reads a thread that never ran',
  classification: 'defect',
  reproduction: 'open Stats on a fresh thread',
  impact: 'console errors',
  observed: 'three 404s',
  inferred: 'the view reads unconditionally; #620 gated only the git readout',
  issue: '#659',
  evidence: [{ screenshot: 'screenshots/10.png' }, { threadId: THREAD }],
}
const undiscoverable = {
  title: 'Preview is not where the agent looked',
  classification: 'undiscoverable',
  reproduction: 'look for the game',
  impact: 'one minute lost',
  observed: 'it opened the tree view first',
  evidence: [{ elapsedMs: 41_000 }],
}

/** A recorded run, reviewed: its findings, then its score and report, written in that order. */
function reviewedRun(gaps: readonly object[]): string {
  const run = recordedRun()
  writeFileSync(join(run, 'findings.json'), JSON.stringify({ gaps }))
  writeArenaScore(run)
  writeArenaReport(run, { ...OPTIONS, runTests: false })
  return run
}

function ready(run: string): ArenaPublication {
  const plan = planArenaPublication(run, { productRepo: PRODUCT, secretValues: [SECRET] })
  if (plan.kind !== 'ready') throw new Error(`refused: ${plan.reasons.join('; ')}`)
  return plan.publication
}

test('⚠ a reviewed run publishes its documents and the screenshots they cite, and one issue that shows each finding at the commit (#677)', () => {
  const run = reviewedRun([defect, undiscoverable])
  const publication = ready(run)

  expect(publication.files.slice(0, 4)).toEqual(['report.md', 'findings.json', 'score.md', 'manifest.json'])
  // A finding's cited screenshot, and the one nearest a second it cites (41 s → 40 s); never the trace.
  expect(publication.files).toContain('screenshots/10.png')
  expect(publication.files).toContain('screenshots/40.png')
  expect(publication.files.some((file) => file.startsWith('trace') || file === 'timeline.jsonl')).toBe(false)
  expect(publication.files.every((file) => existsSync(join(run, file)))).toBe(true)

  // The fixture's verdict is its score's: its polling fails it.
  expect(publication.title).toBe('snake · manual · fail — snake-r')
  expect(publication.labels.map((label) => label.name)).toEqual([
    'scenario:snake',
    'model:manual',
    'perception:tree',
    'verdict:fail',
    'finding:defect',
    'finding:undiscoverable',
  ])
  expect(publication.backlinks).toEqual([{ issue: `${PRODUCT}#659`, findings: [defect.title] }])

  const body = publication.issueBody({ corpus: 'me/corpus', commit: 'abc123' })
  const image = (shot: string): string => `(https://github.com/me/corpus/blob/abc123/runs/snake-r/${shot}?raw=true)`
  expect(body).toContain(image('screenshots/10.png'))
  expect(body).toContain(image('screenshots/40.png'))
  expect(body).toContain(`\`defect\` → ${PRODUCT}#659`)
  // A bare reference is the product repository's: in the corpus it would link to a run issue.
  expect(body).toContain(`the view reads unconditionally; ${PRODUCT}#620 gated only the git readout`)
  expect(body).not.toMatch(/[^\w/]#620/)
})

test('⚠ a run is refused, with every reason at once, until it is reviewed, resolved, mapped, current and clean (#677)', () => {
  const unreviewed = recordedRun()
  writeArenaScore(unreviewed)
  writeArenaReport(unreviewed, { ...OPTIONS, runTests: false })
  expect(planArenaPublication(unreviewed, { productRepo: PRODUCT, secretValues: [] })).toMatchObject({
    kind: 'refused',
    reasons: [expect.stringContaining('not reviewed')],
  })

  const unmapped = { ...defect, issue: undefined }
  const unresolved = { ...undiscoverable, evidence: [{ screenshot: 'screenshots/99.png' }] }
  const run = reviewedRun([unmapped, unresolved])
  // The review was rewritten after the report, and the project holds a token the run had.
  const earlier = new Date(Date.now() - 60_000)
  utimesSync(join(run, 'report.md'), earlier, earlier)
  writeFileSync(join(run, 'project', 'notes.txt'), `token: ${SECRET}\n`)

  const plan = planArenaPublication(run, { productRepo: PRODUCT, secretValues: [SECRET] })
  if (plan.kind !== 'refused') throw new Error('published a run that should have been refused')
  expect(plan.reasons).toEqual([
    'report.md is older than findings.json: run `bun run arena report <run>` again',
    `finding "${unresolved.title}": evidence does not resolve — evidence 1: no screenshot screenshots/99.png in the run`,
    `finding "${unmapped.title}" is a defect that names no product issue`,
    'the secret scan found a secret in project/notes.txt',
  ])
  // Where the secret is, never the secret.
  expect(plan.reasons.join('\n')).not.toContain(SECRET)
})

test('the product issues a finding names: a bare number is the product repository’s, a URL or owner/repo its own (#677)', () => {
  expect(
    productIssuesIn(
      '#659, other/repo#3 and https://github.com/third/one/issues/12 (again: #659, https://github.com/third/one/pull/13)',
      PRODUCT,
    ),
  ).toEqual([`${PRODUCT}#659`, 'other/repo#3', 'third/one#12', 'third/one#13'])
  // With no product repository, a bare number names nothing that could be linked.
  expect(productIssuesIn('#659', undefined)).toEqual([])
})

/** What git answers in `directory`: git by absolute path, nothing inherited — as `gitIn` runs it. */
function gitOut(directory: string, ...args: string[]): string {
  const git = Bun.which('git') ?? 'git'
  return spawnSync(git, ['-C', directory, ...args], { encoding: 'utf8', env: { PATH: dirname(git) } }).stdout.trim()
}

/** The corpus as git holds it: a bare repository as `origin`, and a checkout of it; `seeded` when it has a commit. */
function corpusCheckout(seeded: boolean): { readonly origin: string; readonly checkout: string } {
  const origin = mkdtempSync(join(tmpdir(), 'arena-corpus-origin-'))
  gitIn(origin, 'init', '--quiet', '--bare', '--initial-branch=main')
  if (seeded) {
    const seed = mkdtempSync(join(tmpdir(), 'arena-corpus-seed-'))
    gitIn(seed, 'init', '--quiet', '--initial-branch=main')
    writeFileSync(join(seed, 'README.md'), '# corpus\n')
    gitIn(seed, 'add', '.')
    gitIn(seed, 'commit', '--quiet', '-m', 'the corpus')
    gitIn(seed, 'push', '--quiet', origin, 'main')
  }
  const checkout = join(mkdtempSync(join(tmpdir(), 'arena-corpus-')), 'corpus')
  gitIn(tmpdir(), 'clone', '--quiet', origin, checkout)
  // The publish's own commits run as the operator's git does; this checkout's identity is its own.
  for (const [key, value] of [
    ['user.name', 't'],
    ['user.email', 't@t'],
    ['commit.gpgsign', 'false'],
  ] as const) {
    gitIn(checkout, 'config', key, value)
  }
  return { origin, checkout }
}

/** Real git; `gh` answered as GitHub would, the issue bodies kept; the first push lost, as a network blip loses it. */
function corpusRunner(): { readonly run: ArenaCommand; readonly issues: string[] } {
  const issues: string[] = []
  let pushes = 0
  const run: ArenaCommand = (command, args, options) => {
    if (command === 'gh') {
      if (args[1] === 'list') return '[]'
      if (args[1] === 'create' && args[0] === 'issue') {
        issues.push(options?.input ?? '')
        return 'https://github.com/me/corpus/issues/1\n'
      }
      return ''
    }
    if (args.includes('push') && pushes++ === 0) throw new Error('git push failed: the network went away')
    return runArenaCommand(command, args, options)
  }
  return { run, issues }
}

// ⚠ PR #723 review: the push sat behind "anything to commit?", so a publish cut short between its
// commit and its push found a clean tree when run again, skipped the push, and opened an issue whose
// images were a commit only this machine held. On an empty corpus the re-run's `pull` failed outright.
test.each([
  ['a corpus with commits', true],
  ['an empty corpus', false],
])(
  '⚠ a publish cut short between its commit and its push pushes when run again, before its issue is opened — %s (#677)',
  (_corpus, seeded) => {
    const run = reviewedRun([defect])
    const publication = ready(run)
    const { origin, checkout } = corpusCheckout(seeded)
    const corpus = corpusRunner()
    const options = { corpus: 'me/corpus', checkout, run: corpus.run }

    expect(() => publishArenaRun(run, publication, options)).toThrow('the network went away')
    expect(corpus.issues).toEqual([])

    const outcome = publishArenaRun(run, publication, options)
    if (outcome.kind !== 'published') throw new Error(`refused: ${outcome.reasons.join('; ')}`)
    // The commit the issue shows is the corpus's, and holds the run.
    expect(gitOut(origin, 'cat-file', '-t', outcome.commit)).toBe('commit')
    expect(gitOut(origin, 'ls-tree', '-r', '--name-only', outcome.commit)).toContain('runs/snake-r/report.md')
    expect(corpus.issues).toHaveLength(1)
    expect(corpus.issues[0]).toContain(`/blob/${outcome.commit}/runs/snake-r/`)
  },
)
