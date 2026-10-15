import { createHash } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { type Static, Type } from 'typebox'
import { Compile } from 'typebox/compile'
import { type EnsoConfig, parseEnsoConfig } from './config.ts'
import { projectConfigPath, projectLocalConfigPath, readTextIfPresent, replaceFileText } from './paths.ts'
import type {
  EnsoConfigTier,
  EnsoProjectConfigApproval,
  EnsoProjectSettingsUpdate,
  EnsoProjectThreadSettings,
  EnsoProjectTier,
  EnsoProjectTierApprovalState,
  EnsoProjectTierFile,
  EnsoProjectTierPending,
  EnsoProjectTierReview,
} from './project-settings.ts'
import { unifiedPatch } from './text-patch.ts'

/**
 * A project's own config tiers (#754) — its `threads` settings read by tier, written by the project
 * page — and what protects them (#753): the contents the operator APPROVED. Node-only: it reads and
 * writes the project's `.enso/` and the approvals in `ENSO_HOME` (`project-settings.ts` holds the
 * shapes and the tier rules).
 *
 * ⚠ WHAT APPLIES IS THE APPROVED VERSION, NEVER THE FILE AS IT IS. The agent works in the project, so
 * `.enso/config.json` and `.enso/config.local.json` are files it can reach — by a shell command the
 * guard cannot read (an interpreter one-liner, a computed path), by a commit merged later, or in a
 * thread's tree, whose copy its next session reads. Like direnv's `allow`, each tier's approved text
 * is kept with its SHA-256 (`projectConfigApprovalsPath`): a file that matches applies; one that has
 * changed, or gone, leaves the approved version applying until the operator approves the change on
 * the project page; one never approved applies nothing. Whoever made the change, it waits for that.
 *
 * ⚠ READ FRESH, EVERY TIME: nothing here caches, so an approval applies to the next tree made. And the
 * tree settings are the PROJECT's files — the checkout's path — never a thread's tree.
 *
 * ⚠ READ AS UNTRUSTED INPUT (#873), approved or not: a tier file is read only when it is a regular
 * file of at most 64 KiB in the directory's own `.enso/`. A link (the file, or `.enso/` itself, even
 * with no file behind it) is named and never followed, on read or write, since it could point at a
 * file an agent may not read, which the page would then show, or one a write would land in; a FIFO
 * would hold the server. Such a file can be neither shown, written nor approved.
 */

/** The largest tier file Enso reads; a project's config is a few hundred bytes. */
const MAX_TIER_BYTES = 64 * 1024

/** One tier file as read now: not there, its text and hash, or why it was not read. */
type TierText =
  | { readonly kind: 'absent' }
  | { readonly kind: 'present'; readonly text: string; readonly sha256: string }
  | { readonly kind: 'unreadable'; readonly reason: string }

/** One tier's approval, as the approvals file holds it: the text approved and its SHA-256. */
const ApprovedTier = Type.Object(
  { sha256: Type.String({ pattern: '^[0-9a-f]{64}$' }), text: Type.String() },
  { additionalProperties: false },
)
type ApprovedTier = Static<typeof ApprovedTier>

/** The approvals file: each of the project's own tiers the operator approved. */
const ConfigApprovals = Type.Object(
  { shared: Type.Optional(ApprovedTier), local: Type.Optional(ApprovedTier) },
  { additionalProperties: false },
)
type ConfigApprovals = Static<typeof ConfigApprovals>

const approvalsValidator = Compile(ConfigApprovals)

/** One tier against its approval: where it stands, and the text that applies — none, when nothing does. */
interface TierStanding {
  /** `undefined`: no file and no approval — the tier sets nothing. */
  readonly state: EnsoProjectTierApprovalState | undefined
  readonly applied: string | undefined
}

/** A file of the project's own tiers whose APPROVED text no longer reads (a newer Enso's key): resolved as if absent. */
interface UnreadableTier {
  readonly tier: EnsoProjectTier
  readonly path: string
  readonly reason: string
}

/**
 * The project's resolved `threads` settings, each tier whose approved text did not read, and each that awaits approval.
 *
 * @group Project settings
 */
export interface ProjectThreadSettingsRead {
  readonly threads: EnsoProjectThreadSettings
  /** Skipped: the resolution FAILS CLOSED to the tiers below, and the caller says so. */
  readonly unreadable: readonly UnreadableTier[]
  /** Not the version approved: the approved one applied, or nothing did (#753). */
  readonly pending: readonly EnsoProjectTierPending[]
}

type ThreadsSection = NonNullable<EnsoConfig['threads']>

/** One tier's `threads`, highest first; `undefined` when the tier sets none. */
interface TierLayer {
  readonly tier: EnsoConfigTier
  readonly threads: ThreadsSection | undefined
}

/**
 * Resolve a new tree's settings for `project` (a canonical path): local > shared > user > Enso's
 * default (`worktree`, no setup, nothing to copy), each key's whole value from one tier — a list
 * in a higher tier REPLACES a lower one's. The user tier's mode is its `threads.projects` entry for
 * the project, else its `threads.tree`; `canonical` turns a key as the user wrote it (`~/code/app`,
 * a trailing slash, a symlink) into the canonical path `project` is: matched as
 * written, such a key silently fell through to the default.
 *
 * ⚠ THE PROJECT'S OWN TIERS ARE READ ONLY WHEN `trusted` (pi's trust for the project's path), AND
 * ONLY AS APPROVED (#753, `approvals`: the project's approvals file): an untrusted checkout's config
 * cannot move its threads out of their trees, nor run a command, and a trusted one's runs only what
 * the operator approved. ⚠ ON BY DEFAULT (#551 decision 1): each tree adds a worktree registration
 * and an `enso/<thread-id>` branch to the user's repository until its thread is deleted (#571).
 *
 * @group Project settings
 */
export function readProjectThreadSettings(request: {
  readonly project: string
  readonly user: EnsoConfig
  readonly canonical: (key: string) => string
  readonly trusted: boolean
  readonly approvals: string
}): ProjectThreadSettingsRead {
  const own: ApprovedTiers = request.trusted
    ? approvedTierLayers(request.project, request.approvals)
    : { layers: [], unreadable: [], pending: [] }
  const userThreads = request.user.threads
  const ownMode = Object.entries(userThreads?.projects ?? {}).find(
    ([key]) => request.canonical(key) === request.project,
  )?.[1]
  // The user's own entry for this project beats their `threads.tree`.
  const layers: TierLayer[] = [
    ...own.layers,
    { tier: 'user', threads: ownMode === undefined ? userThreads : { ...userThreads, tree: ownMode } },
  ]
  return {
    threads: {
      tree: highest(layers, 'tree') ?? { value: 'worktree', tier: 'default' },
      setup: highest(layers, 'setup') ?? { value: [], tier: 'default' },
      copy: highest(layers, 'copy') ?? { value: [], tier: 'default' },
    },
    unreadable: own.unreadable,
    pending: own.pending,
  }
}

/** The project's own tiers as approved (#753), local first: each one's `threads`, each whose approved text does not read, each not the version approved. */
interface ApprovedTiers {
  readonly layers: readonly TierLayer[]
  readonly unreadable: readonly UnreadableTier[]
  readonly pending: readonly EnsoProjectTierPending[]
}

function approvedTierLayers(project: string, approvalsPath: string): ApprovedTiers {
  const layers: TierLayer[] = []
  const unreadable: UnreadableTier[] = []
  const pending: EnsoProjectTierPending[] = []
  const approvals = readConfigApprovals(approvalsPath)
  for (const tier of ['local', 'shared'] as const) {
    const path = projectTierPath(project, tier)
    const { state, applied } = tierStanding(readTierText(project, path), approvals[tier])
    if (state !== undefined && state !== 'approved') pending.push({ tier, path, state })
    if (applied === undefined) continue
    const read = parseEnsoConfig(applied)
    if (read.kind === 'unreadable') unreadable.push({ tier, path, reason: read.reason })
    else layers.push({ tier, threads: read.config.threads })
  }
  return { layers, unreadable, pending }
}

/** The first layer that sets `key`, with its tier. */
function highest<Key extends 'tree' | 'setup' | 'copy'>(
  layers: readonly TierLayer[],
  key: Key,
): { value: NonNullable<ThreadsSection[Key]>; tier: EnsoConfigTier } | undefined {
  for (const layer of layers) {
    const value = layer.threads?.[key]
    if (value !== undefined) return { value, tier: layer.tier }
  }
  return undefined
}

/** The file behind one of the project's own tiers: shared `config.json`, local `config.local.json`. */
function projectTierPath(project: string, tier: EnsoProjectTier): string {
  return tier === 'local' ? projectLocalConfigPath(project) : projectConfigPath(project)
}

const sha256Of = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

/**
 * One tier against its approval (#753): the file that IS the version approved applies; one that
 * differs from it, or could not be read, or is gone, leaves the approved text applying; with no
 * approval, nothing applies.
 */
function tierStanding(current: TierText, approved: ApprovedTier | undefined): TierStanding {
  if (approved === undefined) return { state: current.kind === 'absent' ? undefined : 'unapproved', applied: undefined }
  if (current.kind === 'absent') return { state: 'removed', applied: approved.text }
  if (current.kind === 'present' && current.sha256 === approved.sha256)
    return { state: 'approved', applied: current.text }
  return { state: 'changed', applied: approved.text }
}

/**
 * Where `directory`'s own `tier` file stands against `approvals` (#753), and the text that applies
 * from it: a session's read of the project tier in its cwd — the checkout, or a thread's tree,
 * whose copy is held to the project's approval like the checkout's.
 *
 * @group Project settings
 */
export function projectTierStanding(
  directory: string,
  tier: EnsoProjectTier,
  approvals: string,
): TierStanding & { readonly path: string } {
  const path = projectTierPath(directory, tier)
  return { path, ...tierStanding(readTierText(directory, path), readConfigApprovals(approvals)[tier]) }
}

/**
 * The approvals file's tiers. ⚠ FAILS CLOSED: a file that is not one, and a tier whose text is not
 * the text its hash names (edited by hand), approve nothing — the files show as unapproved, and an
 * approval writes the file afresh.
 */
function readConfigApprovals(path: string): ConfigApprovals {
  let parsed: unknown
  try {
    const text = readTextIfPresent(path)
    if (text === undefined) return {}
    parsed = JSON.parse(text)
  } catch {
    return {}
  }
  if (!approvalsValidator.Check(parsed)) return {}
  const approvals: { -readonly [Tier in EnsoProjectTier]?: ApprovedTier } = {}
  for (const tier of ['local', 'shared'] as const) {
    const record = parsed[tier]
    if (record !== undefined && sha256Of(record.text) === record.sha256) approvals[tier] = record
  }
  return approvals
}

/** Record `tier`'s approval of `text` — `undefined` takes the approval away (a removal approved) — atomically. */
function recordApproval(path: string, tier: EnsoProjectTier, text: string | undefined): void {
  const approvals: { -readonly [Tier in EnsoProjectTier]?: ApprovedTier } = { ...readConfigApprovals(path) }
  if (text === undefined) delete approvals[tier]
  else approvals[tier] = { sha256: sha256Of(text), text }
  mkdirSync(dirname(path), { recursive: true })
  replaceFileText(path, `${JSON.stringify(approvals, null, 2)}\n`)
}

/**
 * Set or clear `threads` keys in one of the project's own files (#754), the project page's write:
 * a key given is set, `null` removes it, a key absent is left; every other key in the file is kept,
 * and a `threads` left empty goes. Written as 2-space JSON with a final newline, `<project>/.enso/`
 * made if needed, and APPROVED as written (#753): the operator wrote it. Writing needs no trust: it
 * is the operator's own action, and reading it back into a resolution does.
 *
 * ⚠ NEVER OVER WHAT IS NOT APPROVED: a file that changed since its approval, or was never approved,
 * is refused (`pending`) — written over, its change would be approved unseen. ⚠ Nor over a file that
 * is unreadable — a link (the file, or `.enso/` itself, whether or not a file is behind it), not JSON,
 * not a config this version reads: the reason comes back, and the operator fixes the file.
 *
 * @group Project settings
 */
export function writeProjectThreadSettings(
  project: string,
  update: EnsoProjectSettingsUpdate,
  approvals: string,
):
  | { kind: 'written' }
  | { kind: 'unreadable'; path: string; reason: string }
  | { kind: 'pending'; path: string; state: EnsoProjectTierPending['state'] } {
  const path = projectTierPath(project, update.tier)
  const current = readTierText(project, path)
  if (current.kind === 'unreadable') return { kind: 'unreadable', path, reason: current.reason }
  const read = parseEnsoConfig(current.kind === 'present' ? current.text : undefined)
  if (read.kind === 'unreadable') return { kind: 'unreadable', path, reason: read.reason }
  const { state } = tierStanding(current, readConfigApprovals(approvals)[update.tier])
  if (state !== undefined && state !== 'approved') return { kind: 'pending', path, state }
  const threads = Object.fromEntries(
    Object.entries({ ...read.config.threads, ...update.threads }).filter(
      ([, value]) => value !== null && value !== undefined,
    ),
  )
  const others = Object.entries(read.config).filter(([key]) => key !== 'threads')
  const next = Object.keys(threads).length === 0 ? Object.fromEntries(others) : { ...read.config, threads }
  const text = `${JSON.stringify(next, null, 2)}\n`
  mkdirSync(dirname(path), { recursive: true })
  // ⚠ Checked again once `.enso/` exists, and the file opened without following a link: the write
  // must land in the project's own `.enso/`, never where a link planted since the read points.
  if (reachedThroughLink(project, path)) return { kind: 'unreadable', path, reason: LINKED }
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW)
  try {
    writeFileSync(descriptor, text)
  } finally {
    closeSync(descriptor)
  }
  recordApproval(approvals, update.tier, text)
  return { kind: 'written' }
}

/**
 * Each of the project's own tiers that has a file or an approval, the local one first, as the
 * project page reviews it (#753): its state, the file's hash now, and the diff from the approved
 * version — none is empty — to the file. Read whatever the trust: it applies nothing.
 *
 * @group Project settings
 */
export function reviewProjectConfig(project: string, approvals: string): EnsoProjectTierReview[] {
  const approved = readConfigApprovals(approvals)
  return (['local', 'shared'] as const).flatMap((tier): EnsoProjectTierReview[] => {
    const path = projectTierPath(project, tier)
    const current = readTierText(project, path)
    const { state } = tierStanding(current, approved[tier])
    if (state === undefined) return []
    const problem = approvalProblem(current)
    const patch =
      current.kind === 'unreadable'
        ? ''
        : unifiedPatch(approved[tier]?.text ?? '', current.kind === 'present' ? current.text : '')
    return [
      {
        tier,
        path,
        state,
        current: current.kind === 'present' ? current.sha256 : null,
        patch,
        ...(problem === undefined ? {} : { problem }),
      },
    ]
  })
}

/** Why the file as it is cannot be approved, or `undefined` when it can (a removal always can). */
function approvalProblem(current: TierText): string | undefined {
  if (current.kind === 'unreadable') return current.reason
  if (current.kind === 'absent') return undefined
  const read = parseEnsoConfig(current.text)
  return read.kind === 'unreadable' ? `is not a config Enso reads: ${read.reason}` : undefined
}

/**
 * What an approval did: approved, or refused with its status — 409, the file changed since it was
 * reviewed; 422, it cannot be approved as it is.
 *
 * @group Project settings
 */
export type ProjectTierApprovalOutcome =
  | { readonly kind: 'approved' }
  | { readonly kind: 'refused'; readonly status: 409 | 422; readonly reason: string }

/**
 * Approve one of the project's own tiers as the page showed it (#753): the file whose hash is
 * `approval.sha256` — its removal when `null` — becomes the version that applies. ⚠ ONLY WHAT WAS
 * SEEN: a file whose hash is not the one named changed after the page read it, and is refused (409);
 * so is one that cannot be approved as it is (422, `approvalProblem`).
 *
 * @group Project settings
 */
export function approveProjectTier(
  project: string,
  approvals: string,
  approval: EnsoProjectConfigApproval,
): ProjectTierApprovalOutcome {
  const path = projectTierPath(project, approval.tier)
  const current = readTierText(project, path)
  const problem = approvalProblem(current)
  if (problem !== undefined)
    return { kind: 'refused', status: 422, reason: `${path} ${problem}; fix it, then approve it` }
  const now = current.kind === 'present' ? current.sha256 : null
  if (now !== approval.sha256) {
    return {
      kind: 'refused',
      status: 409,
      reason: `${path} changed after the page read it; nothing was approved — review it again`,
    }
  }
  recordApproval(approvals, approval.tier, current.kind === 'present' ? current.text : undefined)
  return { kind: 'approved' }
}

/**
 * The project's own tier files that are there, the local one first, each with the setup commands it
 * declares as written (#873): what trusting the project would turn on — once approved (#753) —
 * shown BEFORE it is trusted. Display only: nothing read here is applied or run. A file that does not
 * parse says only that, never the parser's words, which can quote what it read.
 *
 * @group Project settings
 */
export function readProjectTierFiles(project: string): EnsoProjectTierFile[] {
  const files: EnsoProjectTierFile[] = []
  for (const tier of ['local', 'shared'] as const) {
    const path = projectTierPath(project, tier)
    const current = readTierText(project, path)
    if (current.kind === 'absent') continue
    if (current.kind === 'unreadable') {
      files.push({ tier, path, unread: `${current.reason}, so it is not shown here, and nothing in it applies` })
      continue
    }
    const parsed = parseEnsoConfig(current.text)
    if (parsed.kind === 'unreadable') {
      files.push({
        tier,
        path,
        unread: 'is not a config Enso reads (not JSON, or a key it does not know), so nothing in it applies',
      })
      continue
    }
    const setup = parsed.config.threads?.setup
    files.push(setup === undefined ? { tier, path } : { tier, path, setup })
  }
  return files
}

/** `path`, one of `directory`'s own tier files, read as untrusted input (the module header). */
function readTierText(directory: string, path: string): TierText {
  let descriptor: number
  try {
    // O_NOFOLLOW: a link is refused at the open; O_NONBLOCK: a FIFO opens without a writer, and is refused below.
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR')
      return reachedThroughLink(directory, path) ? { kind: 'unreadable', reason: LINKED } : { kind: 'absent' }
    if (code === 'ELOOP') return { kind: 'unreadable', reason: 'is a link' }
    return { kind: 'unreadable', reason: `could not be opened (${code ?? 'error'})` }
  }
  try {
    return readOpenedTier(directory, path, descriptor)
  } catch (error: unknown) {
    return { kind: 'unreadable', reason: `could not be read (${(error as NodeJS.ErrnoException).code ?? 'error'})` }
  } finally {
    closeSync(descriptor)
  }
}

/** Why a tier file whose `.enso/` is not the directory's own is refused (the module header). */
const LINKED = 'is reached through a link'

/**
 * Whether `path`'s `.enso/` is a link — to a directory elsewhere, or dangling — rather than the
 * directory's own. Asked when the file is absent too, since a write would land where the link points.
 */
function reachedThroughLink(directory: string, path: string): boolean {
  const parent = dirname(path)
  try {
    return realpathSync(parent) !== dirname(projectConfigPath(realpathSync(directory)))
  } catch {
    try {
      lstatSync(parent)
      return true // there, but does not resolve: a dangling link
    } catch {
      return false // no `.enso/` at all
    }
  }
}

function readOpenedTier(directory: string, path: string, descriptor: number): TierText {
  if (!fstatSync(descriptor).isFile()) return { kind: 'unreadable', reason: 'is not a regular file' }
  if (reachedThroughLink(directory, path)) return { kind: 'unreadable', reason: LINKED }
  const buffer = Buffer.alloc(MAX_TIER_BYTES + 1)
  const length = readSync(descriptor, buffer, 0, buffer.length, 0)
  if (length > MAX_TIER_BYTES) return { kind: 'unreadable', reason: `is larger than ${MAX_TIER_BYTES / 1024} KiB` }
  const text = buffer.toString('utf8', 0, length)
  return { kind: 'present', text, sha256: sha256Of(text) }
}
