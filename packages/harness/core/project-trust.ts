import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { realpathOrSelf } from '@enso/core/paths'
import lockfile from 'proper-lockfile'
import { resolvePathLikePi } from './paths.ts'

/**
 * pi's project-trust store, replicated (#421): the file, the lookup, the write and the lock.
 *
 * A project's own `.enso/config.json` is read only once the project is trusted, and the decision
 * is pi's — the SAME `trust.json` in the agent dir that gates a project's `.pi/` — so one answer
 * covers both and a decision made in either place holds in the other. pi exports none of this
 * (`ProjectTrustStore`, `getProjectTrustOptions`, the lock are internal to
 * `dist/core/trust-manager.js`), so it is copied from pi-coding-agent 0.87.1 (MIT; re-read at 0.99.2,
 * whose one change, `mcp.json` among the trust-requiring resources, is in a list not copied here), and
 * `__tests__/project-trust.test.ts` reaches the real module to hold the copy to it.
 *
 * ⚠ The LOCK is the part that must not drift: a session writing `.pi/` trust and Enso writing
 * `.enso/` trust at the same moment would otherwise each read the file, change one key, and
 * write it back without the other's. Same library (`proper-lockfile`, pi's own dependency and
 * version), same lock file (`trust.json.lock` beside the store), same retries.
 */

const TRUST_FILENAME = 'trust.json'
const LOCK_ATTEMPTS = 10
const LOCK_RETRY_DELAY_MS = 20

/**
 * One saved answer: `true` trusted, `false` not, `null` removes the entry.
 *
 * @group Project trust
 */
export interface ProjectTrustUpdate {
  readonly path: string
  readonly decision: boolean | null
}

/**
 * One answer to the trust question, as pi offers it.
 *
 * @group Project trust
 */
export interface ProjectTrustOption {
  readonly label: string
  readonly trusted: boolean
  /** What saving this answer writes; empty for a this-session-only answer. */
  readonly updates: readonly ProjectTrustUpdate[]
  /** Where the decision lands, when one is saved. */
  readonly savedPath?: string
}

/** The key pi stores a directory's decision under: its resolved, canonical path. */
function trustKey(directory: string): string {
  return realpathOrSelf(resolvePathLikePi(directory))
}

/**
 * The answers pi offers for `directory` — Trust, Trust parent folder (when there is a parent), and
 * Do not trust, each with a this-session-only variant — in pi's order and wording, since the
 * decision is written to pi's store and read back by pi.
 *
 * @group Project trust
 */
export function projectTrustOptions(directory: string): ProjectTrustOption[] {
  const path = trustKey(directory)
  const parent = dirname(path)
  return [
    { label: 'Trust', trusted: true, updates: [{ path, decision: true }], savedPath: path },
    ...(parent === path
      ? []
      : [
          {
            label: `Trust parent folder (${parent})`,
            trusted: true,
            updates: [
              { path: parent, decision: true },
              { path, decision: null },
            ],
            savedPath: parent,
          },
        ]),
    { label: 'Trust (this session only)', trusted: true, updates: [] },
    { label: 'Do not trust', trusted: false, updates: [{ path, decision: false }], savedPath: path },
    { label: 'Do not trust (this session only)', trusted: false, updates: [] },
  ]
}

/**
 * pi's `trust.json` in `agentDir`.
 *
 * @group Project trust
 */
export interface ProjectTrustStore {
  /** The decision for `directory` or its nearest ancestor that has one; `null` when none does. */
  get(directory: string): boolean | null
  /** Apply updates under pi's lock, as one read-modify-write. */
  setMany(updates: readonly ProjectTrustUpdate[]): void
}

/** @group Project trust */
export function createProjectTrustStore(agentDir: string): ProjectTrustStore {
  const trustPath = join(agentDir, TRUST_FILENAME)
  return {
    get(directory: string): boolean | null {
      return withTrustFileLock(trustPath, () => nearestDecision(readTrustFile(trustPath), trustKey(directory)))
    },
    setMany(updates: readonly ProjectTrustUpdate[]): void {
      withTrustFileLock(trustPath, () => {
        const data = readTrustFile(trustPath)
        for (const { path, decision } of updates) {
          const key = trustKey(path)
          if (decision === null) delete data[key]
          else data[key] = decision
        }
        writeTrustFile(trustPath, data)
      })
    },
  }
}

function nearestDecision(data: Record<string, boolean | null>, key: string): boolean | null {
  for (let directory = key; ; directory = dirname(directory)) {
    const decision = data[directory]
    if (decision === true || decision === false) return decision
    if (dirname(directory) === directory) return null
  }
}

function readTrustFile(path: string): Record<string, boolean | null> {
  if (!existsSync(path)) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
  } catch (error: unknown) {
    throw new Error(`Failed to read trust store ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid trust store ${path}: expected an object`)
  }
  const data: Record<string, boolean | null> = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (value !== true && value !== false && value !== null) {
      throw new Error(`Invalid trust store ${path}: value for ${JSON.stringify(key)} must be true, false, or null`)
    }
    data[key] = value
  }
  return data
}

function writeTrustFile(path: string, data: Record<string, boolean | null>): void {
  const sorted: Record<string, boolean | null> = {}
  for (const key of Object.keys(data).sort()) sorted[key] = data[key] ?? null
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(sorted, null, 2)}\n`, 'utf8')
}

function withTrustFileLock<T>(path: string, work: () => T): T {
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true })
  let release: (() => void) | undefined
  for (let attempt = 1; release === undefined; attempt += 1) {
    try {
      release = lockfile.lockSync(directory, { realpath: false, lockfilePath: `${path}.lock` })
    } catch (error: unknown) {
      if ((error as { code?: string }).code !== 'ELOCKED' || attempt === LOCK_ATTEMPTS) throw error
      // Synchronous, as pi's is: the store's callers are not async.
      const until = Date.now() + LOCK_RETRY_DELAY_MS
      while (Date.now() < until) {
        // wait
      }
    }
  }
  try {
    return work()
  } finally {
    release()
  }
}

/**
 * What to do for a directory with no saved decision: pi's `defaultProjectTrust` (`ask` / `always` /
 * `never`, default `ask`), which pi reads from the AGENT dir's `settings.json` only — a project
 * cannot set it for itself. Read the same way here, so one setting governs `.pi/` and `.enso/`.
 * An unreadable or unknown value is `ask`: the answer that asks rather than decides.
 *
 * @group Project trust
 */
export function defaultProjectTrust(agentDir: string): 'ask' | 'always' | 'never' {
  try {
    const settings: unknown = JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8'))
    const value =
      typeof settings === 'object' && settings !== null ? Reflect.get(settings, 'defaultProjectTrust') : undefined
    return value === 'always' || value === 'never' ? value : 'ask'
  } catch {
    return 'ask'
  }
}
