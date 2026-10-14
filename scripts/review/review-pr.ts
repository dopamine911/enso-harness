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
import type { ToolGrant } from './tool-grant-hook.ts'
import { type PromptValues, fillPrompt, REVIEW_WORKFLOW_PATH, readReviewWorkflow } from './workflow-config.ts'

/** The workflow's status comment marker: the same comment is upserted here, so both reviewers share it. */
export const STATUS_MARKER = '<!-- claude-run-status: pr-review -->'
/** The second hidden line this reviewer adds: the head it reviewed, so a head is reviewed once. */
const REVIEWED_HEAD_LINE = /<!-- local-review head=([0-9a-f]{40})/
/** Where runs keep their worktrees, logs and captured comments. */
const RUNS_DIRECTORY = join(homedir(), '.cache', 'enso-review')
/** Where the credential-less steps keep bun's package cache, so an install is not cold every run. */
const SHARED_BUN_CACHE = join(RUNS_DIRECTORY, 'bun-cache')
/** The directory the prompt and `.claude/pr-review.md` look in for the comment list and the push's diff. */
const REVIEW_CONTEXT_DIRECTORY = '.review-context'
/** How the workflow's review comment begins (its template's heading), which is how a post is found. */
const REVIEW_COMMENT_HEADING = '## Code Review'
/** The files the comment-list step writes; the workflow's command writes the list at the tree root. */
const COMMENT_LIST_FILE = 'touched-comments.md'
const NEW_COMMITS_DIFF_FILE = 'new-commits.diff'
/** Paths a pull request must not supply to its own reviewer: replaced with the base branch's. */
const BASE_OWNED_PATHS = ['.claude', '.mcp.json'] as const
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
 * The status comment's body after a run: the workflow's marker first, so both reviewers upsert one
 * comment. `posted` is whether a review comment is ON THE PULL REQUEST (`reviewCommentsSince`), not
 * docker-agent's exit code: on #989's first run docker-agent exited 1 (`bufio.Scanner: token too
 * long`, its reader of Claude Code's output) AFTER the review was posted, and an exit-code status
 * said "failed, no verdict" under a posted verdict. Nor the hook's "allowed": a hook runs BEFORE
 * `gh`, so an allowed post that then failed would record a head nobody reviewed (#989's review).
 */
export function statusCommentBody(run: {
  readonly posted: boolean
  readonly headSha: string
  readonly scope: string
  readonly agentExitCode: number
}): string {
  const short = run.headSha.slice(0, SHORT_SHA_LENGTH)
  if (!run.posted) {
    // A run that posted nothing records no head, so the next run tries the same head again.
    return `${STATUS_MARKER}\n❌ **Claude PR review failed** locally on \`${short}\`: no review comment was posted (docker-agent exited ${run.agentExitCode}). See the run log on the reviewing machine.`
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
  readonly created_at: string
  /** The login that wrote it. */
  readonly author: string
}

/**
 * The review comments `author` posted at or after `since` (ISO time): those that begin with the
 * template's heading. ⚠ By author too: the Actions reviewer, or anyone, posting a `## Code Review`
 * during a run would otherwise count as this run's post (#989's review).
 */
export function reviewCommentsSince(comments: readonly IssueComment[], since: string, author: string): IssueComment[] {
  return comments.filter(
    (comment) =>
      comment.author === author &&
      comment.created_at >= since &&
      comment.body.trimStart().startsWith(REVIEW_COMMENT_HEADING),
  )
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

/** The docker-agent configuration for one review: Claude Code on the user's login, nothing else. */
function agentConfiguration(): string {
  return [
    'agents:',
    '  root:',
    `    description: PR reviewer configured from ${REVIEW_WORKFLOW_PATH} (#981)`,
    '    harness:',
    '      type: claude-code',
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

function readPullRequest(number: number): PullRequestState {
  const fields = 'number,headRefOid,baseRefName,baseRefOid,isDraft,author'
  return JSON.parse(run(['gh', 'pr', 'view', String(number), '--json', fields])) as PullRequestState
}

function repositoryName(): string {
  return run(['gh', 'repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']).trim()
}

/**
 * Every comment on the pull request, one per line. ⚠ `--paginate` runs `--jq` on EACH page, so a
 * filter that builds one array prints one array per page, which is not one JSON document past 30
 * comments (#989's review); a filter that prints one object per comment is.
 */
function pullRequestComments(repository: string, number: number): IssueComment[] {
  const filter = '.[] | {id, body, created_at, author: .user.login}'
  return run(['gh', 'api', `repos/${repository}/issues/${number}/comments`, '--paginate', '--jq', filter])
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as IssueComment)
}

/** The status comment, when there is one. */
function findStatusComment(repository: string, number: number): IssueComment | undefined {
  return pullRequestComments(repository, number).find((comment) => comment.body.startsWith(STATUS_MARKER))
}

function upsertStatusComment(repository: string, number: number, body: string): void {
  const existing = findStatusComment(repository, number)
  if (existing === undefined) {
    run(['gh', 'api', '-X', 'POST', `repos/${repository}/issues/${number}/comments`, '-f', `body=${body}`])
    return
  }
  run(['gh', 'api', '-X', 'PATCH', `repos/${repository}/issues/comments/${existing.id}`, '-f', `body=${body}`])
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
function runReviewer(tree: string, runDirectory: string, prompt: string): number {
  const configuration = join(runDirectory, 'reviewer.yaml')
  writeFileSync(configuration, agentConfiguration())
  const log = Bun.file(join(runDirectory, 'review.log'))
  const reviewer = Bun.spawnSync(['docker', 'agent', 'run', configuration, '--exec', '--working-dir', tree, prompt], {
    stdout: log,
    stderr: log,
  })
  return reviewer.exitCode
}

interface ReviewOptions {
  readonly number: number
  readonly dryRun: boolean
}

/** Whether this machine's `gh` login posted a review comment after `since`: asked of GitHub, not inferred. */
function reviewWasPosted(repository: string, number: number, since: string): boolean {
  const login = run(['gh', 'api', 'user', '--jq', '.login']).trim()
  return reviewCommentsSince(pullRequestComments(repository, number), since, login).length > 0
}

interface ReviewRun {
  readonly options: ReviewOptions
  readonly pullRequest: PullRequestState
  readonly repository: string
  readonly plan: Extract<ReviewPlan, { kind: 'review' }>
  readonly runDirectory: string
  readonly tree: string
}

/** Everything after the worktree exists: context, settings, the reviewer, the status. */
function reviewInWorktree(review: ReviewRun): string {
  const { options, pullRequest, repository, plan, runDirectory, tree } = review
  const startedAt = new Date().toISOString()
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
    ...(options.dryRun ? { captureCommentTo: capture } : {}),
  })
  const values: PromptValues = {
    repository,
    pullRequestNumber: options.number,
    scope: plan.scope,
    headSha: pullRequest.headRefOid,
  }
  const agentExitCode = runReviewer(tree, runDirectory, fillPrompt(config.promptTemplate, values))
  const posted = options.dryRun ? existsSync(capture) : reviewWasPosted(repository, options.number, startedAt)
  if (!options.dryRun) {
    const body = statusCommentBody({ posted, headSha: pullRequest.headRefOid, scope: plan.scope, agentExitCode })
    upsertStatusComment(repository, options.number, body)
  }
  const where = options.dryRun ? `captured to ${capture}` : 'posted to the pull request'
  const outcome = posted ? `reviewed (${plan.scope}); comment ${where}` : 'FAILED: no review comment was posted'
  const listNote = listProblem === undefined ? '' : `; ${listProblem}`
  return `#${options.number}: ${outcome}; docker-agent exited ${agentExitCode}${listNote}; log ${join(runDirectory, 'review.log')}`
}

/** One review of one pull request, start to finish. Returns what happened, for the terminal. */
function reviewPullRequest(options: ReviewOptions): string {
  const pullRequest = readPullRequest(options.number)
  const repository = repositoryName()
  const status = findStatusComment(repository, options.number)
  const plan = planReview(
    pullRequest,
    lastReviewedHeadOf(status?.body),
    (sha) =>
      Bun.spawnSync(['git', 'merge-base', '--is-ancestor', sha, pullRequest.headRefOid], { cwd: REPOSITORY_ROOT })
        .exitCode === 0,
  )
  if (plan.kind === 'skip') return `#${options.number}: skipped — ${plan.reason}`
  const runDirectory = join(
    RUNS_DIRECTORY,
    `pr-${options.number}-${pullRequest.headRefOid.slice(0, SHORT_SHA_LENGTH)}-${Date.now()}`,
  )
  mkdirSync(runDirectory, { recursive: true })
  const tree = join(runDirectory, 'tree')
  addWorktree(pullRequest, tree)
  try {
    return reviewInWorktree({ options, pullRequest, repository, plan, runDirectory, tree })
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
  process.stdout.write(`${reviewPullRequest(parseReviewArguments(process.argv.slice(2)))}\n`)
}
