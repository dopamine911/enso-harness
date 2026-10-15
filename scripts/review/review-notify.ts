#!/usr/bin/env bun

/**
 * Tells the local review worker a pull request has something new to review (#981).
 *
 *   bun run review-notify [<pull request number>]
 *
 * With no number, the pull request of the current branch (`gh pr view`), so a session that just
 * pushed runs it from its worktree with no arguments. It only queues: the worker (`review-worker.ts`)
 * reviews, one at a time, and skips a head it already reviewed. A missed notify loses nothing — the
 * worker's poll finds the push — it only waits for the next poll.
 */

import { enqueueReview } from './review-queue.ts'

function currentBranchPullRequest(): number {
  const answer = Bun.spawnSync(['gh', 'pr', 'view', '--json', 'number', '--jq', '.number'], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (answer.exitCode !== 0) {
    throw new Error(`no pull request for this branch: ${answer.stderr.toString().trim()}`)
  }
  return Number(answer.stdout.toString().trim())
}

/** The pull request number a command line names, or `undefined` for the current branch's. */
export function notifyArgument(argv: readonly string[]): number | undefined {
  const [first] = argv
  if (first === undefined) return undefined
  const number = Number(first)
  if (!Number.isInteger(number) || number <= 0) throw new Error('usage: review-notify [<pull request number>]')
  return number
}

if (import.meta.main) {
  const number = notifyArgument(process.argv.slice(2)) ?? currentBranchPullRequest()
  enqueueReview(number)
  process.stdout.write(`#${number}: queued for the local review worker\n`)
}
