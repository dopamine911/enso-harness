import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * The run's state over time, beside the UI's (#584 A7, A8, A12; #608): which build of Enso ran, what
 * the work held at each sample, and which turn of a thread each screenshot shows. #556's deliverable
 * is a manifest "linking UI time, thread, turn, and filesystem state"; the timeline held only the first
 * two.
 */

// ── The build under test (A12) ──────────────────────────────────────────────────────────────────

/**
 * The checkout the run's Enso came from: its commit, whether it had uncommitted work, and a hash of
 * that work. ⚠ `rev-parse HEAD` alone said nothing about a dirty tree, and a run against uncommitted
 * code is not reproducible from its commit; `diffHash` tells two dirty runs from the same commit
 * apart. Undefined when the checkout is no git repository.
 */
export interface ArenaEnsoBuild {
  readonly commit: string
  readonly dirty: boolean
  /** sha256 of the tracked diff against HEAD and the untracked files' names and bytes; present when dirty. */
  readonly diffHash?: string
}

const git = (repoRoot: string, args: readonly string[]): string | undefined => {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return result.status === 0 ? result.stdout : undefined
}

export function ensoBuildOf(repoRoot: string): ArenaEnsoBuild | undefined {
  const commit = git(repoRoot, ['rev-parse', 'HEAD'])?.trim()
  const status = git(repoRoot, ['status', '--porcelain', '--untracked-files=all'])
  if (commit === undefined || status === undefined) return undefined
  if (status.trim().length === 0) return { commit, dirty: false }
  const hash = createHash('sha256').update(git(repoRoot, ['diff', 'HEAD', '--binary']) ?? '')
  const untracked = (git(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z']) ?? '')
    .split('\0')
    .filter(Boolean)
  for (const path of untracked.toSorted()) {
    hash.update(`\0${path}\0`)
    try {
      hash.update(readFileSync(join(repoRoot, path)))
    } catch {
      hash.update('(unreadable)')
    }
  }
  return { commit, dirty: true, diffHash: hash.digest('hex') }
}

// ── The work, sampled (A8) ──────────────────────────────────────────────────────────────────────

/** One workspace at one moment: how much it holds and a fingerprint that changes when any file does. */
export interface ArenaWorkspaceSample {
  /** Relative to the run directory, or absolute for a workspace outside it. */
  readonly path: string
  readonly files: number
  readonly bytes: number
  /** sha256 over each file's path, size and mtime: cheap enough for every 30 s, moved by any write. */
  readonly fingerprint: string
  /** True when the walk stopped at `SAMPLE_MAX_FILES`: the counts are a floor, the fingerprint partial. */
  readonly truncated?: true
}

/** Directories a sample never walks: a repository's own, and installed dependencies. */
const SAMPLE_SKIPPED = new Set(['.git', 'node_modules'])
/** Where a sample stops walking one workspace: a project this size is not the bench's Snake. */
const SAMPLE_MAX_FILES = 5000

/** Each workspace's sample, in the order given; a workspace that is not there is left out. */
export function sampleWorkspaces(runDirectory: string, workspaces: readonly string[]): ArenaWorkspaceSample[] {
  return workspaces.flatMap((workspace) => {
    if (!existsSync(workspace)) return []
    const hash = createHash('sha256')
    let files = 0
    let bytes = 0
    let truncated = false
    const walk = (directory: string): void => {
      let entries
      try {
        entries = readdirSync(directory, { withFileTypes: true }).toSorted((left, right) =>
          left.name < right.name ? -1 : 1,
        )
      } catch {
        return
      }
      for (const directoryEntry of entries) {
        if (truncated) return
        const path = join(directory, directoryEntry.name)
        if (directoryEntry.isDirectory()) {
          if (!SAMPLE_SKIPPED.has(directoryEntry.name)) walk(path)
          continue
        }
        if (!directoryEntry.isFile()) continue
        if (files >= SAMPLE_MAX_FILES) {
          truncated = true
          return
        }
        try {
          const stats = statSync(path)
          files += 1
          bytes += stats.size
          hash.update(`${relative(workspace, path)}\0${stats.size}\0${stats.mtimeMs}\n`)
        } catch {
          // gone between the listing and the stat: not in this sample
        }
      }
    }
    walk(workspace)
    const shown = relative(runDirectory, workspace)
    return [
      {
        path: shown.startsWith('..') ? workspace : shown,
        files,
        bytes,
        fingerprint: hash.digest('hex').slice(0, 16),
        ...(truncated ? { truncated: true as const } : {}),
      },
    ]
  })
}

// ── Screenshot → turn (A7) ──────────────────────────────────────────────────────────────────────

/** One message of a thread's history, as the join reads it: its entry id, role and time. */
export interface ArenaHistoryMessage {
  readonly id: string
  readonly role: string
  readonly atMs: number
}

/** Where in a thread a moment falls: the prompt that opened the turn, and the latest message before it. */
export interface ArenaTurnPlace {
  /** The user message that began the turn: the turn's id. */
  readonly turnId: string
  /** The last message, of either role, at or before the moment. */
  readonly messageId: string
}

/**
 * Each thread's history as the stop collected it (`thread-<id>-history.json`, `GET …/history`):
 * messages with their entry id and `createdAt`. Measured on the 2026-10-05 reference run before this
 * was built: every message carries its own millisecond timestamp, so a screenshot lands on one step.
 */
export function threadHistoriesIn(evidenceDirectory: string): Map<string, ArenaHistoryMessage[]> {
  const histories = new Map<string, ArenaHistoryMessage[]>()
  if (!existsSync(evidenceDirectory)) return histories
  for (const fileName of readdirSync(evidenceDirectory)) {
    const matched = /^thread-(.+)-history\.json$/.exec(fileName)
    if (matched?.[1] === undefined) continue
    const messages = historyMessagesOf(parsedOrUndefined(readFileSync(join(evidenceDirectory, fileName), 'utf8')))
    if (messages.length > 0) histories.set(matched[1], messages)
  }
  return histories
}

function historyMessagesOf(history: unknown): ArenaHistoryMessage[] {
  if (typeof history !== 'object' || history === null || !('messages' in history)) return []
  if (!Array.isArray(history.messages)) return []
  return history.messages
    .flatMap((message: unknown): ArenaHistoryMessage[] => {
      if (typeof message !== 'object' || message === null) return []
      const id = 'id' in message && typeof message.id === 'string' ? message.id : undefined
      const role = 'role' in message && typeof message.role === 'string' ? message.role : undefined
      const created =
        'createdAt' in message && typeof message.createdAt === 'string' ? Date.parse(message.createdAt) : Number.NaN
      return id === undefined || role === undefined || Number.isNaN(created) ? [] : [{ id, role, atMs: created }]
    })
    .toSorted((left, right) => left.atMs - right.atMs)
}

/** The turn a moment in a thread falls in, or undefined before the thread's first prompt. */
export function turnAt(history: readonly ArenaHistoryMessage[], atMs: number): ArenaTurnPlace | undefined {
  const before = history.filter((message) => message.atMs <= atMs)
  const prompt = before.findLast((message) => message.role === 'user')
  const latest = before.at(-1)
  return prompt === undefined || latest === undefined ? undefined : { turnId: prompt.id, messageId: latest.id }
}

function parsedOrUndefined(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
