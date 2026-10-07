import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { gitChildEnvironment } from '@enso/core/git'
import type { ArenaCheckedGap, ArenaGapClass } from './findings.ts'
import { momentOf, readRunFindings } from './report.ts'
import { readArenaScoreInput, scoreArenaRun } from './score.ts'
import { scanRunForSecrets, withEarlierHits } from './secret-scan.ts'

/**
 * Publishing a reviewed run to the corpus (#677): every run so far lived on one machine, and only
 * the product issues its review filed were shared. `arena publish <run>` commits the run's documents
 * and the screenshots they cite to a private corpus repository, opens one issue there for the run —
 * its scenario, models, build, verdict, and each finding with its screenshots shown — labelled so the
 * corpus can be filtered, and comments on each product issue a finding maps to, linking back.
 *
 * ⚠ NOTHING LEAVES THE MACHINE UNTIL THE RUN IS CHECKED. Refused, with every reason at once: a run
 * not reviewed (no `findings.json`, or one that does not read); a finding whose evidence does not
 * resolve; a defect that names no product issue; a report older than its findings; and any secret
 * the scan finds — a fresh scan, plus every hit an earlier scan recorded (never downgraded, as the
 * manifest's). A screenshot cannot be scanned: what the corpus holds is what the run showed.
 */

/** Where runs are published unless `--corpus` names another. */
export const DEFAULT_ARENA_CORPUS = 'dopamine911/enso-dogfood-corpus'

/** The run's documents a publication carries; `review.md` only when the run has one. */
const RUN_DOCUMENTS = ['report.md', 'findings.json', 'score.md', 'manifest.json'] as const
const OPTIONAL_DOCUMENTS = ['review.md'] as const

/** The screenshots a finding shows inline, at most. */
const SHOTS_PER_FINDING = 3

/** A label of the corpus: what a run is filtered by (#677 acceptance: scenario, model, verdict, finding class). */
export interface ArenaLabel {
  readonly name: string
  readonly color: string
  readonly description: string
}

/** A product issue a finding maps to, and the findings that map to it. */
export interface ArenaBacklink {
  /** `owner/repo#number`. */
  readonly issue: string
  readonly findings: readonly string[]
}

export interface ArenaPublication {
  readonly runId: string
  /** The run's files to commit, relative to the run directory. */
  readonly files: readonly string[]
  readonly title: string
  readonly labels: readonly ArenaLabel[]
  readonly backlinks: readonly ArenaBacklink[]
  /** The run issue's body, its images and links pinned to the commit that holds the files. */
  readonly issueBody: (at: { readonly corpus: string; readonly commit: string }) => string
}

export type ArenaPublishPlan =
  | { readonly kind: 'refused'; readonly reasons: readonly string[] }
  | { readonly kind: 'ready'; readonly publication: ArenaPublication }

/**
 * The product issues a finding's `issue` names — `#12`, `owner/repo#12`, or an issue or pull URL —
 * each as `owner/repo#12`. A bare `#12` is the product repository's; without one it names nothing.
 */
export function productIssuesIn(reference: string, productRepo: string | undefined): string[] {
  const named = [
    ...reference.matchAll(
      /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/(\d+)|([\w.-]+\/[\w.-]+)?#(\d+)/g,
    ),
  ].flatMap((match) => {
    const repo = match[1] ?? match[3] ?? productRepo
    const number = match[2] ?? match[4]
    return repo === undefined || number === undefined ? [] : [`${repo}#${number}`]
  })
  return [...new Set(named)]
}

/** The run's documents and every screenshot they or the findings cite — the run directory's own files only. */
function publishedFiles(runDirectory: string, shotsByFinding: readonly (readonly string[])[]): string[] {
  const documents = [
    ...RUN_DOCUMENTS,
    ...OPTIONAL_DOCUMENTS.filter((document) => existsSync(join(runDirectory, document))),
  ]
  const cited = documents
    .filter((document) => document.endsWith('.md'))
    .flatMap((document) => [
      ...readFileSync(join(runDirectory, document), 'utf8').matchAll(/\]\((screenshots\/[^)\s]+)\)/g),
    ])
    .flatMap((match) => (match[1] === undefined ? [] : [match[1]]))
  const shots = [...new Set([...cited, ...shotsByFinding.flat()])].filter((path) => {
    const absolute = resolve(runDirectory, path)
    return !relative(runDirectory, absolute).startsWith('..') && existsSync(absolute) && statSync(absolute).isFile()
  })
  return [...documents, ...shots.toSorted()]
}

/** Why the run cannot be published yet; none when it can. */
function refusalsOf(
  runDirectory: string,
  gaps: readonly ArenaCheckedGap[],
  {
    productRepo,
    secretValues,
    manifest,
  }: {
    readonly productRepo: string | undefined
    readonly secretValues: readonly string[]
    /** The manifest already read, whose earlier scan's hits stand (PR #723 review: not read twice). */
    readonly manifest: unknown
  },
): string[] {
  const missing = RUN_DOCUMENTS.filter((document) => !existsSync(join(runDirectory, document)))
  const reportStale =
    !missing.includes('report.md') &&
    statSync(join(runDirectory, 'report.md')).mtimeMs < statSync(join(runDirectory, 'findings.json')).mtimeMs
  const scan = withEarlierHits(scanRunForSecrets(runDirectory, secretValues), manifest, runDirectory)
  return [
    ...missing.map((document) => `no ${document} in the run (\`bun run arena report\` and \`arena score\` write them)`),
    ...(reportStale ? ['report.md is older than findings.json: run `bun run arena report <run>` again'] : []),
    ...gaps.flatMap((gap) =>
      gap.verified ? [] : [`finding "${gap.title}": evidence does not resolve — ${gap.unresolved.join('; ')}`],
    ),
    ...gaps.flatMap((gap) =>
      gap.classification === 'defect' && productIssuesIn(gap.issue ?? '', productRepo).length === 0
        ? [`finding "${gap.title}" is a defect that names no product issue`]
        : [],
    ),
    ...[...new Set(scan.hits.map((hit) => hit.path))].map((path) => `the secret scan found a secret in ${path}`),
  ]
}

/** The screenshots a finding shows: the ones it cites, else the nearest to each second it cites. */
function shotsOf(runDirectory: string, gap: ArenaCheckedGap, shots: Parameters<typeof momentOf>[1]): string[] {
  const cited = gap.evidence.flatMap((citation) => (citation.screenshot === undefined ? [] : [citation.screenshot]))
  const nearest = gap.evidence.flatMap((citation) =>
    citation.elapsedMs === undefined ? [] : [momentOf(runDirectory, shots, citation.elapsedMs).screenshot ?? ''],
  )
  return [...new Set(cited.length > 0 ? cited : nearest)].filter((path) => path !== '').slice(0, SHOTS_PER_FINDING)
}

const FINDING_COLORS: Readonly<Record<ArenaGapClass, string>> = {
  defect: 'd93f0b',
  undiscoverable: 'fbca04',
  'agent-mistake': 'bfdadc',
  'not-needed': 'ededed',
}

/** A label name GitHub takes: at most 50 characters. */
const labelName = (prefix: string, value: string): string => `${prefix}:${value}`.slice(0, 50)

function labelsOf(
  run: { readonly scenario: string; readonly agent: string; readonly perception: string; readonly verdict: string },
  classes: ReadonlySet<ArenaGapClass>,
): ArenaLabel[] {
  return [
    { name: labelName('scenario', run.scenario), color: '1d76db', description: 'the scenario the run played' },
    { name: labelName('model', run.agent), color: '5319e7', description: 'the agent model that drove Enso' },
    {
      name: labelName('perception', run.perception),
      color: 'c5def5',
      description: 'how the agent perceived the page (#680)',
    },
    {
      name: labelName('verdict', run.verdict),
      color: run.verdict === 'pass' ? '0e8a16' : 'b60205',
      description: 'the run score’s verdict',
    },
    ...[...classes].map((gapClass) => ({
      name: labelName('finding', gapClass),
      color: FINDING_COLORS[gapClass],
      description: `the run has a ${gapClass} finding`,
    })),
  ]
}

/** A path of the run, as a URL of the corpus at `commit`; `raw` for an image the issue shows. */
function corpusUrl(
  at: { readonly corpus: string; readonly commit: string },
  runId: string,
  path: string,
  raw = false,
): string {
  const encoded = path.split('/').map(encodeURIComponent).join('/')
  return `https://github.com/${at.corpus}/blob/${at.commit}/runs/${encodeURIComponent(runId)}/${encoded}${raw ? '?raw=true' : ''}`
}

/**
 * A finding's words, each bare `#123` written as the product repository's: in the corpus a bare
 * reference would link to the corpus's own issues — its run issues.
 */
function qualifiedReferences(text: string, productRepo: string | undefined): string {
  return productRepo === undefined ? text : text.replaceAll(/(^|[^\w/#])#(\d+)\b/g, `$1${productRepo}#$2`)
}

function findingSection(
  gap: ArenaCheckedGap,
  position: number,
  shots: readonly string[],
  links: {
    readonly issues: readonly string[]
    readonly productRepo: string | undefined
    readonly url: (path: string, raw?: boolean) => string
  },
): string[] {
  const say = (text: string): string => qualifiedReferences(text, links.productRepo)
  const mapped = links.issues.length === 0 ? '' : ` → ${links.issues.join(', ')}`
  const optional = (label: string, value: string | undefined): string[] =>
    value === undefined ? [] : [`**${label}:** ${say(value)}`, '']
  const citations = gap.evidence.map((citation) =>
    [
      ...(citation.elapsedMs === undefined ? [] : [`${Math.round(citation.elapsedMs / 1000)} s`]),
      ...(citation.screenshot === undefined ? [] : [`[${citation.screenshot}](${links.url(citation.screenshot)})`]),
      ...(citation.threadId === undefined ? [] : [`thread \`${citation.threadId.slice(0, 8)}\``]),
    ].join(' · '),
  )
  return [
    `### ${position}. ${say(gap.title)}`,
    '',
    `\`${gap.classification}\`${mapped}`,
    '',
    `**Reproduction:** ${say(gap.reproduction)}`,
    '',
    `**Impact:** ${say(gap.impact)}`,
    '',
    `**Observed:** ${say(gap.observed)}`,
    '',
    ...optional('Inferred', gap.inferred),
    ...optional('Workaround', gap.workaround),
    `**Evidence:** ${citations.join('; ') || 'none'}`,
    '',
    ...shots.map((shot) => `![${gap.title} — ${shot}](${links.url(shot, true)})`),
    '',
  ]
}

/** What a reviewed run publishes (#677), or every reason it is refused. Reads the run; touches nothing else. */
export function planArenaPublication(
  runDirectory: string,
  options: { readonly productRepo: string | undefined; readonly secretValues: readonly string[] },
): ArenaPublishPlan {
  if (!existsSync(join(runDirectory, 'manifest.json'))) {
    return { kind: 'refused', reasons: ['no manifest.json: `bun run arena manifest <run>` folds one'] }
  }
  const input = readArenaScoreInput(runDirectory)
  const findings = readRunFindings(runDirectory, input.manifest)
  if (findings.status === 'absent') {
    return { kind: 'refused', reasons: ['the run is not reviewed: no findings.json (`bun run arena brief --review`)'] }
  }
  if (findings.status === 'invalid') return { kind: 'refused', reasons: [`findings.json: ${findings.reason}`] }
  const refusals = refusalsOf(runDirectory, findings.gaps, {
    productRepo: options.productRepo,
    secretValues: options.secretValues,
    manifest: input.manifest,
  })
  if (refusals.length > 0) return { kind: 'refused', reasons: refusals }

  const score = scoreArenaRun(input)
  const shotsByFinding = findings.gaps.map((gap) => shotsOf(runDirectory, gap, input.manifest.screenshots))
  const issuesByFinding = findings.gaps.map((gap) => productIssuesIn(gap.issue ?? '', options.productRepo))
  const agent = score.agent ?? 'manual'
  const run = { scenario: score.scenario, agent, perception: score.perception, verdict: score.verdict }
  const issues = [...new Set(issuesByFinding.flat())]
  const build = input.manifest.ensoBuild
  return {
    kind: 'ready',
    publication: {
      runId: score.runId,
      files: publishedFiles(runDirectory, shotsByFinding),
      title: `${score.scenario} · ${agent} · ${score.verdict} — ${score.runId}`,
      labels: labelsOf(run, new Set(findings.gaps.map((gap) => gap.classification))),
      backlinks: issues.map((issue) => ({
        issue,
        findings: findings.gaps
          .filter((_gap, index) => issuesByFinding[index]?.includes(issue))
          .map((gap) => gap.title),
      })),
      issueBody: (at) => {
        const url = (path: string, raw = false): string => corpusUrl(at, score.runId, path, raw)
        const documents = [...RUN_DOCUMENTS, ...OPTIONAL_DOCUMENTS].filter((document) =>
          existsSync(join(runDirectory, document)),
        )
        return [
          `**Run** \`${score.runId}\` · scenario \`${score.scenario}\` · **${score.verdict}**${score.metrics.minutes === undefined ? '' : ` · ${score.metrics.minutes} minutes`}`,
          '',
          `**Agent** \`${agent}\` (perception: ${score.perception}) · **Enso’s model** ${score.metrics.modelUse.enso.map((model) => `\`${model}\``).join(', ') || 'none recorded'}`,
          '',
          `**Build** ${build === undefined ? 'not recorded' : `\`${build.commit.slice(0, 7)}\`${build.dirty ? ' (with uncommitted changes)' : ''}`}`,
          '',
          `**Documents:** ${documents.map((document) => `[${document}](${url(document)})`).join(' · ')}`,
          '',
          `## Findings (${findings.gaps.length})`,
          '',
          ...(findings.gaps.length === 0 ? ['The review recorded no gaps.', ''] : []),
          ...findings.gaps.flatMap((gap, index) =>
            findingSection(gap, index + 1, shotsByFinding[index] ?? [], {
              issues: issuesByFinding[index] ?? [],
              productRepo: options.productRepo,
              url,
            }),
          ),
          qualifiedReferences(
            'Published by `bun run arena publish` (#677). Product issues stay in their repository; this issue is the run’s evidence.',
            options.productRepo,
          ),
        ].join('\n')
      },
    },
  }
}

// ── Publishing it ───────────────────────────────────────────────────────────────────────────────

/** Runs a command and answers its stdout; throws, with its stderr, when it fails. */
export type ArenaCommand = (
  command: string,
  args: readonly string[],
  options?: { readonly cwd?: string; readonly input?: string },
) => string

export const runArenaCommand: ArenaCommand = (command, args, options = {}) => {
  const ran = spawnSync(command, [...args], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.input === undefined ? {} : { input: options.input }),
    // ⚠ Without a hook's GIT_DIR and its kin: run under one, `git -C <corpus>` would act on the
    // repository running the hook (#624's fixture did, staging this checkout as deleted).
    env: gitChildEnvironment(),
    encoding: 'utf8',
  })
  if (ran.status !== 0) {
    // A command that never started (not on PATH) says why in `error`, with nothing on stderr.
    const said = ran.stderr.trim() === '' ? (ran.error?.message ?? `exit ${String(ran.status)}`) : ran.stderr.trim()
    throw new Error(`${command} ${args.slice(0, 2).join(' ')} failed: ${said}`)
  }
  return ran.stdout
}

const CORPUS_README = `# Enso Dogfood Arena — the corpus

Every reviewed Dogfood Arena run, published by \`bun run arena publish <run directory>\` (zen-harness-foundation #677).

- **\`runs/<run id>/\`** holds the run's report, review, findings, score and manifest, and the screenshots they cite.
  The full trace and the uncited screenshots stay with the run.
- **One issue per run**: its scenario, models, build and verdict, and each finding with its screenshots, linked to the
  product issue it maps to. Product defects stay in their repository, each linking back here.
- **Labels** filter the corpus: \`scenario:\`, \`model:\` (the agent), \`perception:\`, \`verdict:\`, and \`finding:\` for
  each class of finding a run has (defect, undiscoverable, agent-mistake, not-needed).
`

/** True when `ref` names a commit in the checkout. */
function hasRef(run: ArenaCommand, checkout: string, ref: string): boolean {
  try {
    run('git', ['-C', checkout, 'rev-parse', '--verify', '--quiet', ref])
    return true
  } catch {
    return false
  }
}

/**
 * The corpus checkout, cloned once and fast-forwarded to the corpus's `main`. Fetched and merged,
 * not pulled: a publish cut short before its first push leaves a `main` with no upstream, where
 * `pull` fails (PR #723 review). A local commit not yet pushed is kept, and pushed by `commitRun`; a
 * corpus that moved past it is refused by the fast-forward, never overwritten.
 */
function syncCheckout(run: ArenaCommand, corpus: string, checkout: string): void {
  if (!existsSync(join(checkout, '.git'))) {
    mkdirSync(dirname(checkout), { recursive: true })
    // Over HTTPS, signed in by gh's credential helper as this checkout's own origin is — not `gh
    // repo clone`, which follows gh's git protocol: over SSH, a machine's key may be another
    // account's, with no access to a private corpus (found publishing the first run).
    run('git', ['clone', '--quiet', `https://github.com/${corpus}.git`, checkout])
  }
  run('git', ['-C', checkout, 'fetch', '--quiet', 'origin'])
  const born = hasRef(run, checkout, 'HEAD')
  if (hasRef(run, checkout, 'refs/remotes/origin/main')) {
    if (born) run('git', ['-C', checkout, 'merge', '--ff-only', '--quiet', 'origin/main'])
    else run('git', ['-C', checkout, 'checkout', '--quiet', '-B', 'main', 'origin/main'])
  } else if (!born) run('git', ['-C', checkout, 'symbolic-ref', 'HEAD', 'refs/heads/main'])
}

/** Commit the run's files under `runs/<id>/` and push; the commit that holds them, new or already there. */
function commitRun(
  run: ArenaCommand,
  runDirectory: string,
  publication: ArenaPublication,
  { checkout, message }: { readonly checkout: string; readonly message: string },
): string {
  const folder = join('runs', publication.runId)
  for (const file of publication.files) {
    mkdirSync(dirname(join(checkout, folder, file)), { recursive: true })
    copyFileSync(join(runDirectory, file), join(checkout, folder, file))
  }
  if (!existsSync(join(checkout, 'README.md'))) writeFileSync(join(checkout, 'README.md'), CORPUS_README)
  run('git', ['-C', checkout, 'add', '--', folder, 'README.md'])
  if (run('git', ['-C', checkout, 'status', '--porcelain', '--', folder, 'README.md']).trim() !== '') {
    run('git', ['-C', checkout, 'commit', '--quiet', '-m', message])
  }
  // ⚠ Pushed every time, not only after a new commit (PR #723 review): a publish cut short between
  // its commit and its push leaves a clean tree, and its re-run must still push — else its issue
  // shows images from a commit only this machine holds. Up to date, the push changes nothing.
  run('git', ['-C', checkout, 'push', '--quiet', '-u', 'origin', 'HEAD:main'])
  return run('git', ['-C', checkout, 'log', '-1', '--format=%H', '--', folder]).trim()
}

/** The run's issue in the corpus, if it was published before: its title ends with the run id. */
function publishedIssue(run: ArenaCommand, corpus: string, runId: string): string | undefined {
  const listed = JSON.parse(
    run('gh', [
      'issue',
      'list',
      '-R',
      corpus,
      '--state',
      'all',
      '--search',
      `${runId} in:title`,
      '--json',
      'title,url',
    ]),
  ) as ReadonlyArray<{ readonly title: string; readonly url: string }>
  return listed.find((issue) => issue.title.endsWith(`— ${runId}`))?.url
}

export type ArenaPublishOutcome =
  | { readonly kind: 'refused'; readonly reasons: readonly string[] }
  | {
      readonly kind: 'published'
      readonly issue: string
      readonly commit: string
      readonly backlinks: readonly string[]
    }

/**
 * Publish a planned run: refused when its issue is already there; else its files committed (or the
 * commit that already holds them — an interrupted publish resumes), the labels made, the issue
 * opened, and each product issue told.
 */
export function publishArenaRun(
  runDirectory: string,
  publication: ArenaPublication,
  options: { readonly corpus: string; readonly checkout: string; readonly run: ArenaCommand },
): ArenaPublishOutcome {
  const { corpus, checkout, run } = options
  const existing = publishedIssue(run, corpus, publication.runId)
  if (existing !== undefined) return { kind: 'refused', reasons: [`already published: ${existing}`] }
  syncCheckout(run, corpus, checkout)
  const commit = commitRun(run, runDirectory, publication, { checkout, message: `run ${publication.title}` })
  for (const label of publication.labels) {
    run('gh', [
      'label',
      'create',
      label.name,
      '--color',
      label.color,
      '--description',
      label.description,
      '--force',
      '-R',
      corpus,
    ])
  }
  const issue = run(
    'gh',
    [
      'issue',
      'create',
      '-R',
      corpus,
      '--title',
      publication.title,
      '--body-file',
      '-',
      '--label',
      publication.labels.map((label) => label.name).join(','),
    ],
    { input: publication.issueBody({ corpus, commit }) },
  ).trim()
  const backlinks = publication.backlinks.map((backlink) => {
    const [repo, number] = backlink.issue.split('#')
    const said = backlink.findings.map((title) => `- ${title}`).join('\n')
    run('gh', ['issue', 'comment', number ?? '', '-R', repo ?? '', '--body-file', '-'], {
      input: `Found by Dogfood Arena run [\`${publication.runId}\`](${issue}):\n\n${said}\n`,
    })
    return backlink.issue
  })
  return { kind: 'published', issue, commit, backlinks }
}
