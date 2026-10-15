#!/usr/bin/env bun

/**
 * The PR review, run on this machine instead of on GitHub's runners (#981), configured by the
 * workflow that runs it on GitHub (`.github/workflows/claude-pr-review.yml`, read by
 * `workflow-config.ts`), so the two reviews are one review.
 *
 *   bun run review <pull request number> [--dry-run]
 *
 * One run, in the workflow's order:
 *   1. RESOLVE: the pull request's head, base, draft and bot status (`gh pr view`), and the head
 *      this reviewer last reviewed, from the status comment's `head=` line. A draft, a bot's pull
 *      request, or a head already reviewed: nothing runs.
 *   2. PREPARE: a fresh worktree at the head; `bun install` and the comment list, with no
 *      credentials in reach (see `runWithoutCredentials`); THEN its `.claude/` and `.mcp.json`
 *      replaced with the base branch's (a pull request must not supply the reviewer's settings,
 *      hooks or MCP servers, as `claude-code-action` restores `.claude/` from the base for the same
 *      reason). ⚠ After, not before: the install's scripts and the comment list are the pull
 *      request's code, and could rewrite those files after an earlier restore (#989's review).
 *   3. REVIEW: docker-agent's `claude-code` harness, in the worktree, with the workflow's prompt.
 *      The workflow's tool grant is enforced by `tool-grant-hook.ts` (the harness cannot pass one).
 *   4. PUBLISH: the reviewer posts its own comment, as the prompt says. This script then upserts
 *      the workflow's status comment, with the head it reviewed.
 *
 * `--dry-run` runs all of it, but the reviewer's `gh pr comment` is captured to a file instead of
 * posted, and the status comment is not touched.
 *
 * The configuration (prompt, grant, comment-list command) is read from the BASE branch's copy of
 * the workflow, at the base commit `gh pr view` reports (`baseRefOid`), which is the copy GitHub
 * would run, never the pull request's.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { findRepoRoot } from '../../packages/core/src/paths.ts'
import { readReviewAppConfig, reviewAppIdentity } from './app-token.ts'
import { RUNS_DIRECTORY } from './review-paths.ts'
import type { ToolGrant } from './tool-grant-hook.ts'
import { type PromptValues, fillPrompt, REVIEW_WORKFLOW_PATH, readReviewWorkflow } from './workflow-config.ts'

/**
 * The workflow's status comment marker. Each poster keeps its own comment under it (`statusCommentsOf`):
 * the Actions step only the one `github-actions[bot]` wrote, this reviewer only the one its login wrote.
 */
export const STATUS_MARKER = '<!-- claude-run-status: pr-review -->'
/** The second hidden line this reviewer adds: the head it reviewed, so a head is reviewed once. */
const REVIEWED_HEAD_LINE = /<!-- local-review head=([0-9a-f]{40})/
/** Where the credential-less steps keep bun's package cache, so an install is not cold every run. */
const SHARED_BUN_CACHE = join(RUNS_DIRECTORY, 'bun-cache')
/** The directory the prompt and `.claude/pr-review.md` look in for the comment list and the push's diff. */
const REVIEW_CONTEXT_DIRECTORY = '.review-context'
/** The files the comment-list step writes; the workflow's command writes the list at the tree root. */
const COMMENT_LIST_FILE = 'touched-comments.md'
const NEW_COMMITS_DIFF_FILE = 'new-commits.diff'
/** Paths a pull request must not supply to its own reviewer: replaced with the base branch's. */
const BASE_OWNED_PATHS = ['.claude', '.mcp.json'] as const
/** What the reviewer is told when its post is captured on a real run: the runner posts it next. */
const CAPTURE_REPLY =
  'Recorded: the review comment will be posted to the pull request by the runner. The review is complete; stop here.'
/** The docker-agent configuration each run writes into its folder. */
const REVIEWER_CONFIGURATION_FILE = 'reviewer.yaml'
/**
 * ⚠ The local reviewer's model and effort are PINNED HERE, in the runner's own code (#981). Unpinned, the
 * harness's `claude` falls back to the owner's Claude Code settings (measured: Opus 5.5 1M at `xhigh`).
 * They are not read from the workflow: the review reads the workflow at each pull request's own base
 * commit, so a pin there reached no pull request opened before it (measured after #1000: every open
 * pull request's `reviewer.yaml` named no model).
 */
const REVIEWER_MODEL = 'claude-sonnet-5-5'
const REVIEWER_EFFORT = 'medium'
/** A short SHA, as the workflow's comments print one. */
const SHORT_SHA_LENGTH = 7
/** The system directories the credential-less steps need beside bun's own: git, sh, coreutils. */
const SYSTEM_PATH = '/usr/local/bin:/usr/bin:/bin'
const REPOSITORY_ROOT = findRepoRoot(import.meta.url)
const HOOK_SCRIPT = join(REPOSITORY_ROOT, 'scripts', 'review', 'tool-grant-hook.ts')

/** What `gh pr view` answers, as much of it as a run reads. */
export interface PullRequestState {
  readonly number: number
  readonly headRefOid: string
  readonly baseRefName: string
  readonly baseRefOid: string
  readonly isDraft: boolean
  readonly author: { readonly login: string; readonly is_bot?: boolean }
}

/** Why a run did not review, or what it reviewed. */
export type ReviewPlan =
  | { readonly kind: 'skip'; readonly reason: string }
  | { readonly kind: 'review'; readonly scope: 'full' | 'new-commits'; readonly from: string }

/**
 * Whether to review, and how much — the workflow's job `if:` (no drafts, no bots) and its scope
 * step (`new-commits` when the previous head is still an ancestor of HEAD, else `full` from the
 * base), with "previous head" meaning the head this reviewer last reviewed.
 */
export function planReview(
  pullRequest: PullRequestState,
  lastReviewedHead: string | undefined,
  isAncestorOfHead: (sha: string) => boolean,
): ReviewPlan {
  if (pullRequest.isDraft) return { kind: 'skip', reason: 'a draft pull request' }
  if (pullRequest.author.is_bot === true)
    return { kind: 'skip', reason: `a bot's pull request (${pullRequest.author.login})` }
  if (lastReviewedHead === pullRequest.headRefOid) {
    return { kind: 'skip', reason: `head ${pullRequest.headRefOid.slice(0, SHORT_SHA_LENGTH)} is already reviewed` }
  }
  if (lastReviewedHead !== undefined && isAncestorOfHead(lastReviewedHead)) {
    return { kind: 'review', scope: 'new-commits', from: lastReviewedHead }
  }
  return { kind: 'review', scope: 'full', from: pullRequest.baseRefOid }
}

/** The head the status comment says this reviewer last reviewed, if any. */
export function lastReviewedHeadOf(statusCommentBody: string | undefined): string | undefined {
  return statusCommentBody === undefined ? undefined : REVIEWED_HEAD_LINE.exec(statusCommentBody)?.[1]
}

/**
 * The status comments on a pull request, as a run needs them: `own`, the one `login` wrote, which it
 * updates (so it never rewrites the Actions step's comment, or the owner's from before the App); and
 * the last reviewed head, from its own first, else from a status comment by one of `trustedAuthors`
 * (the repository's owner, whose login posted before the App), so a change of poster does not forget
 * what was reviewed. ⚠ ONLY those: a `head=` line in anyone else's comment would make the reviewer
 * skip a head nobody reviewed (#989's review).
 */
export function statusCommentsOf(
  comments: readonly IssueComment[],
  login: string,
  trustedAuthors: readonly string[] = [],
): { readonly own: IssueComment | undefined; readonly lastReviewedHead: string | undefined } {
  const statuses = comments.filter((comment) => comment.body.startsWith(STATUS_MARKER))
  const own = statuses.find((comment) => comment.author === login)
  const recorded = statuses
    .filter((comment) => trustedAuthors.includes(comment.author))
    .map((comment) => lastReviewedHeadOf(comment.body))
    .find((head) => head !== undefined)
  return { own, lastReviewedHead: lastReviewedHeadOf(own?.body) ?? recorded }
}

/**
 * The status comment's body after a run: the workflow's marker first, so both reviewers upsert one
 * comment. `posted` is whether the RUNNER's post of the captured review succeeded (`postCapturedReview`),
 * not docker-agent's exit code: on #989's first run docker-agent exited 1 (`bufio.Scanner: token too
 * long`, its reader of Claude Code's output) AFTER the review was posted, and an exit-code status
 * said "failed, no verdict" under a posted verdict.
 *
 * ⚠ A FAILED run keeps the head reviewed BEFORE it (`previouslyReviewedHead`), not the one it failed
 * at: that one was not reviewed, so the next run tries it again, and with `new-commits` scope from the
 * last real review. Dropping the line made a retry after a ❌ review the whole pull request (#993's review).
 */
export function statusCommentBody(run: {
  readonly posted: boolean
  readonly headSha: string
  readonly scope: string
  readonly agentExitCode: number
  readonly previouslyReviewedHead?: string | undefined
}): string {
  const short = run.headSha.slice(0, SHORT_SHA_LENGTH)
  if (!run.posted) {
    const kept =
      run.previouslyReviewedHead === undefined
        ? ''
        : `<!-- local-review head=${run.previouslyReviewedHead} scope=kept -->\n`
    return `${STATUS_MARKER}\n${kept}❌ **Claude PR review failed** locally on \`${short}\`: no review comment was posted (docker-agent exited ${run.agentExitCode}). See the run log on the reviewing machine.`
  }
  const exitNote =
    run.agentExitCode === 0
      ? ''
      : ` docker-agent exited ${run.agentExitCode} after the review was posted; see the run log.`
  return `${STATUS_MARKER}\n<!-- local-review head=${run.headSha} scope=${run.scope} -->\n✅ **Claude PR review** ran locally on \`${short}\` (${run.scope}), with docker-agent, configured from \`${REVIEW_WORKFLOW_PATH}\`.${exitNote}`
}

/** A pull request comment, as much of one as a run reads. */
export interface IssueComment {
  readonly id: number
  readonly body: string
  /** The login that wrote it. */
  readonly author: string
}

/**
 * Claude Code's own folder for a session started in `directory`: where it saves a tool result too
 * large to return inline, which the reviewer then `Read`s. Claude Code names it by the directory with
 * every character that is not a letter or digit replaced by `-` (seen on #989:
 * `…/enso-review/pr-989-…/tree` → `-home-daniel--cache-enso-review-pr-989-…-tree`).
 */
export function claudeSessionFolder(directory: string, home: string = homedir()): string {
  return join(home, '.claude', 'projects', directory.replace(/[^A-Za-z0-9]/g, '-'))
}

/** The docker-agent configuration for one review: Claude Code on the user's login, at `REVIEWER_MODEL` and `REVIEWER_EFFORT`. */
export function agentConfiguration(): string {
  return [
    'agents:',
    '  root:',
    `    description: PR reviewer configured from ${REVIEW_WORKFLOW_PATH} (#981)`,
    '    harness:',
    '      type: claude-code',
    // docker-agent passes these to `claude` as `--model` / `--effort` (measured: its argv, logged).
    `      model: ${REVIEWER_MODEL}`,
    `      effort: ${REVIEWER_EFFORT}`,
    '',
  ].join('\n')
}

/** The settings file the review worktree gets: the grant hook on every tool call. */
export function reviewSettings(grantPath: string): string {
  const command = `bun ${HOOK_SCRIPT} ${grantPath}`
  return `${JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command }] }] } }, null, 2)}\n`
}

function run(command: readonly string[], options: { cwd?: string; env?: Record<string, string> } = {}): string {
  const result = Bun.spawnSync([...command], { ...options, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) {
    throw new Error(`${command.join(' ')} exited ${result.exitCode}: ${result.stderr.toString().trim()}`)
  }
  return result.stdout.toString()
}

/**
 * Who a run reads and posts as: the review App's bot when this machine has its config
 * (`app-token.ts`), else the owner's own `gh` login. Each environment is the whole environment `gh`
 * runs with (`undefined`: this process's own). `readEnvironment` is the model's: read-only.
 * `postEnvironment` is the runner's alone, for the review it captured and the status comment.
 */
interface Poster {
  readonly login: string
  readonly readEnvironment: Record<string, string> | undefined
  readonly postEnvironment: Record<string, string> | undefined
}

function runGh(command: readonly string[], environment: Record<string, string> | undefined): string {
  return run(command, environment === undefined ? {} : { env: environment })
}

function readPullRequest(number: number, poster: Poster): PullRequestState {
  const fields = 'number,headRefOid,baseRefName,baseRefOid,isDraft,author'
  return JSON.parse(
    runGh(['gh', 'pr', 'view', String(number), '--json', fields], poster.readEnvironment),
  ) as PullRequestState
}

function repositoryName(): string {
  return run(['gh', 'repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']).trim()
}

/**
 * Every comment on the pull request, one per line. ⚠ `--paginate` runs `--jq` on EACH page, so a
 * filter that builds one array prints one array per page, which is not one JSON document past 30
 * comments (#989's review); a filter that prints one object per comment is.
 */
function pullRequestComments(repository: string, number: number, poster: Poster): IssueComment[] {
  const filter = '.[] | {id, body, author: .user.login}'
  return runGh(
    ['gh', 'api', `repos/${repository}/issues/${number}/comments`, '--paginate', '--jq', filter],
    poster.readEnvironment,
  )
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as IssueComment)
}

function upsertStatusComment(repository: string, number: number, body: string, poster: Poster): void {
  const own = statusCommentsOf(pullRequestComments(repository, number, poster), poster.login).own
  if (own === undefined) {
    runGh(
      ['gh', 'api', '-X', 'POST', `repos/${repository}/issues/${number}/comments`, '-f', `body=${body}`],
      poster.postEnvironment,
    )
    return
  }
  runGh(
    ['gh', 'api', '-X', 'PATCH', `repos/${repository}/issues/comments/${own.id}`, '-f', `body=${body}`],
    poster.postEnvironment,
  )
}

/**
 * A step that runs the pull request's code (`bun install`'s scripts, the comment-list script),
 * with no credentials in reach by their usual paths: a scratch `HOME` (so `~/.config/gh` and
 * `~/.claude` are not where `gh` and `claude` look), and an environment built from nothing rather
 * than copied, so no token in this process's environment is passed on. The workflow gets the same
 * separation from its credential-less `touched-comments` job.
 *
 * ⚠ NOT A SANDBOX. The step runs as this user and could read an absolute path; docker-agent's
 * `--sandbox` (or a container) is the stronger version. This reviewer only reviews the owner's
 * own pull requests (#981, "Not in scope").
 */
function runWithoutCredentials(command: string, tree: string, scratchHome: string, from: string): void {
  const bunDirectory = dirname(Bun.which('bun') ?? 'bun')
  mkdirSync(scratchHome, { recursive: true })
  run(['bash', '-c', command], {
    cwd: tree,
    env: {
      PATH: `${bunDirectory}:${SYSTEM_PATH}`,
      HOME: scratchHome,
      BUN_INSTALL_CACHE_DIR: SHARED_BUN_CACHE,
      FROM: from,
    },
  })
}

function addWorktree(pullRequest: PullRequestState, tree: string): void {
  run(['git', 'fetch', '--quiet', 'origin', `pull/${pullRequest.number}/head`, pullRequest.baseRefName], {
    cwd: REPOSITORY_ROOT,
  })
  run(['git', 'worktree', 'add', '--quiet', '--detach', tree, pullRequest.headRefOid], { cwd: REPOSITORY_ROOT })
}

/** The reviewer's settings, hooks and MCP servers from the base branch, never the pull request's. */
function restoreBaseOwnedPaths(tree: string, baseSha: string): void {
  for (const path of BASE_OWNED_PATHS) {
    rmSync(join(tree, path), { recursive: true, force: true })
    const onBase = Bun.spawnSync(['git', 'cat-file', '-e', `${baseSha}:${path}`], { cwd: tree })
    if (onBase.exitCode === 0) run(['git', 'checkout', baseSha, '--', path], { cwd: tree })
  }
}

/** Builds `.review-context/`; answers why the comment list could not be built, when its command failed. */
function buildReviewContext(
  tree: string,
  plan: Extract<ReviewPlan, { kind: 'review' }>,
  listCommand: string,
  scratchHome: string,
): string | undefined {
  const contextDirectory = join(tree, REVIEW_CONTEXT_DIRECTORY)
  mkdirSync(contextDirectory, { recursive: true })
  if (plan.scope === 'new-commits') {
    writeFileSync(
      join(contextDirectory, NEW_COMMITS_DIFF_FILE),
      run(['git', 'diff', '--no-color', plan.from, 'HEAD'], { cwd: tree }),
    )
  }
  // The workflow's rule: "A failed list does not stop the review; it only loses that check." The
  // prompt then finds no list and says so in Testing.
  try {
    runWithoutCredentials('bun install --frozen-lockfile', tree, scratchHome, plan.from)
    runWithoutCredentials(listCommand, tree, scratchHome, plan.from)
  } catch (error: unknown) {
    return `the comment list was not built: ${String(error)}`
  }
  const list = join(tree, COMMENT_LIST_FILE)
  if (existsSync(list)) run(['mv', list, join(contextDirectory, COMMENT_LIST_FILE)])
  return undefined
}

/** Writes the run's grant, and the worktree settings that load the hook with it. */
function writeGrant(tree: string, runDirectory: string, grant: ToolGrant): void {
  const grantPath = join(runDirectory, 'grant.json')
  writeFileSync(grantPath, JSON.stringify(grant))
  mkdirSync(join(tree, '.claude'), { recursive: true })
  writeFileSync(join(tree, '.claude', 'settings.local.json'), reviewSettings(grantPath))
}

/** Runs the reviewer and answers docker-agent's exit code. Its output goes to `review.log`. */
function runReviewer(tree: string, runDirectory: string, prompt: string, poster: Poster): number {
  const configuration = join(runDirectory, REVIEWER_CONFIGURATION_FILE)
  const log = Bun.file(join(runDirectory, 'review.log'))
  const reviewer = Bun.spawnSync(['docker', 'agent', 'run', configuration, '--exec', '--working-dir', tree, prompt], {
    stdout: log,
    stderr: log,
    ...(poster.readEnvironment === undefined ? {} : { env: poster.readEnvironment }),
  })
  return reviewer.exitCode
}

/** What one run did: a line for the terminal, and whether it failed (no review reached the pull request). */
export interface ReviewResult {
  readonly summary: string
  readonly failed: boolean
  /** The head the run was at, when it got that far: the worker counts failed attempts per head. */
  readonly head: string | undefined
}

export interface ReviewOptions {
  readonly number: number
  readonly dryRun: boolean
}

/**
 * Posts the review the hook captured, with the runner's token: `true` when GitHub took it. The model
 * never posts (`app-token.ts#READ_TOKEN_PERMISSIONS`), so this is the one place a review reaches the
 * pull request, and whether it did is known, not searched for.
 */
function postCapturedReview(repository: string, number: number, capture: string, poster: Poster): boolean {
  if (!existsSync(capture)) return false
  try {
    runGh(
      ['gh', 'api', '-X', 'POST', `repos/${repository}/issues/${number}/comments`, '-F', `body=@${capture}`],
      poster.postEnvironment,
    )
    return true
  } catch {
    return false
  }
}

/**
 * The review App's bot, with two one-hour tokens for this repository only, when this machine has the
 * App's config; else the owner's own login, as before #981's App. ⚠ The model's token goes into the
 * reviewer's environment as `GH_TOKEN`, which `gh` prefers over its stored login; it is read-only,
 * and the model cannot print it: the grant hook refuses any `$` in a command, and `Read` cannot reach
 * `/proc`.
 */
async function reviewPoster(repository: string): Promise<Poster> {
  const config = readReviewAppConfig()
  if (config === undefined) {
    const login = run(['gh', 'api', 'user', '--jq', '.login']).trim()
    return { login, readEnvironment: undefined, postEnvironment: undefined }
  }
  const identity = await reviewAppIdentity(config, repository.split('/')[1] ?? repository)
  return {
    login: identity.login,
    readEnvironment: { ...process.env, GH_TOKEN: identity.readToken },
    postEnvironment: { ...process.env, GH_TOKEN: identity.postToken },
  }
}

interface ReviewRun {
  readonly poster: Poster
  readonly options: ReviewOptions
  readonly pullRequest: PullRequestState
  readonly repository: string
  readonly plan: Extract<ReviewPlan, { kind: 'review' }>
  readonly runDirectory: string
  readonly tree: string
  /** The head this reviewer last reviewed, kept in the status comment when this run fails. */
  readonly lastReviewedHead: string | undefined
}

/** The terminal line for one run: what was posted (or that nothing was), docker-agent's exit, a missing comment list, the log. */
export function runSummary(run: {
  readonly number: number
  readonly posted: boolean
  readonly where: string
  readonly scope: string
  readonly agentExitCode: number
  readonly listProblem: string | undefined
  readonly log: string
}): string {
  const outcome = run.posted ? `reviewed (${run.scope}); comment ${run.where}` : 'FAILED: no review comment was posted'
  const listNote = run.listProblem === undefined ? '' : `; ${run.listProblem}`
  return `#${run.number}: ${outcome}; docker-agent exited ${run.agentExitCode}${listNote}; log ${run.log}`
}

/** Everything after the worktree exists: context, settings, the reviewer, the status. */
function reviewInWorktree(review: ReviewRun): ReviewResult {
  const { poster, options, pullRequest, repository, plan, runDirectory, tree } = review
  const config = readReviewWorkflow(
    run(['git', 'show', `${pullRequest.baseRefOid}:${REVIEW_WORKFLOW_PATH}`], { cwd: tree }),
  )
  const listProblem = buildReviewContext(tree, plan, config.listCommand, join(runDirectory, 'home'))
  restoreBaseOwnedPaths(tree, pullRequest.baseRefOid)
  const capture = join(runDirectory, 'review-comment.md')
  writeGrant(tree, runDirectory, {
    allowedTools: config.allowedTools,
    decisionLog: join(runDirectory, 'tool-calls.jsonl'),
    readRoots: [tree, claudeSessionFolder(tree)],
    // The post is always captured: a dry run keeps it, a real run posts it with the runner's token.
    captureCommentTo: capture,
    ...(options.dryRun ? {} : { captureReply: CAPTURE_REPLY }),
  })
  const values: PromptValues = {
    repository,
    pullRequestNumber: options.number,
    scope: plan.scope,
    headSha: pullRequest.headRefOid,
  }
  writeFileSync(join(runDirectory, REVIEWER_CONFIGURATION_FILE), agentConfiguration())
  const agentExitCode = runReviewer(tree, runDirectory, fillPrompt(config.promptTemplate, values), poster)
  const posted = options.dryRun ? existsSync(capture) : postCapturedReview(repository, options.number, capture, poster)
  if (!options.dryRun) {
    const body = statusCommentBody({
      posted,
      headSha: pullRequest.headRefOid,
      scope: plan.scope,
      agentExitCode,
      previouslyReviewedHead: review.lastReviewedHead,
    })
    upsertStatusComment(repository, options.number, body, poster)
  }
  const summary = runSummary({
    number: options.number,
    posted,
    where: options.dryRun ? `captured to ${capture}` : `posted to the pull request as ${poster.login}`,
    scope: plan.scope,
    agentExitCode,
    listProblem,
    log: join(runDirectory, 'review.log'),
  })
  return { summary, failed: !posted, head: pullRequest.headRefOid }
}

/**
 * One review of one pull request, start to finish: a line for the terminal, whether it failed, and the
 * head it was at. The worker retries a failed one (`review-worker.ts#afterReviews`).
 */
export async function reviewPullRequest(options: ReviewOptions): Promise<ReviewResult> {
  const repository = repositoryName()
  const poster = await reviewPoster(repository)
  const pullRequest = readPullRequest(options.number, poster)
  const lastReviewedHead = statusCommentsOf(pullRequestComments(repository, options.number, poster), poster.login, [
    repository.split('/')[0] ?? '',
  ]).lastReviewedHead
  const plan = planReview(
    pullRequest,
    lastReviewedHead,
    (sha) =>
      Bun.spawnSync(['git', 'merge-base', '--is-ancestor', sha, pullRequest.headRefOid], { cwd: REPOSITORY_ROOT })
        .exitCode === 0,
  )
  if (plan.kind === 'skip') {
    return { summary: `#${options.number}: skipped — ${plan.reason}`, failed: false, head: pullRequest.headRefOid }
  }
  const runDirectory = join(
    RUNS_DIRECTORY,
    `pr-${options.number}-${pullRequest.headRefOid.slice(0, SHORT_SHA_LENGTH)}-${Date.now()}`,
  )
  mkdirSync(runDirectory, { recursive: true })
  const tree = join(runDirectory, 'tree')
  addWorktree(pullRequest, tree)
  try {
    return reviewInWorktree({ poster, options, pullRequest, repository, plan, runDirectory, tree, lastReviewedHead })
  } finally {
    run(['git', 'worktree', 'remove', '--force', tree], { cwd: REPOSITORY_ROOT })
  }
}

/** The command line: a pull request number, and `--dry-run`. */
export function parseReviewArguments(argv: readonly string[]): ReviewOptions {
  const number = Number(argv.find((argument) => !argument.startsWith('--')))
  if (!Number.isInteger(number) || number <= 0) throw new Error('usage: review-pr.ts <pull request number> [--dry-run]')
  return { number, dryRun: argv.includes('--dry-run') }
}

if (import.meta.main) {
  const result = await reviewPullRequest(parseReviewArguments(process.argv.slice(2)))
  process.stdout.write(`${result.summary}\n`)
  // A failed review exits 1, so a script or a cron job calling this sees it (#993's review).
  if (result.failed) process.exitCode = 1
}
