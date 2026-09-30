import { createHash, randomUUID } from 'node:crypto'
import {
  constants,
  copyFileSync,
  readFileSync,
  renameSync,
  rmSync,
  type Stats,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import type { EnsoPermissionPolicyRead, EnsoPermissionPolicyRefusal } from '@enso/core'
import { realpathOrSelf } from '@enso/core/paths'
import {
  ENSO_DEFAULT_PERMISSION_POLICY,
  permissionEngineConfigPath,
  withCatchAllFirst,
} from '@enso/core/permission-rules'
import { policyProblems } from './permission-policy.ts'

/**
 * What a write expects on disk: the server's `WriteCondition` (#443), stated here because the host
 * imports only core. `absent` — no file; `matches` — the version read; `present` — whatever is there.
 */
type WriteCondition =
  | { readonly kind: 'absent' }
  | { readonly kind: 'matches'; readonly etag: string }
  | { readonly kind: 'present' }

/**
 * The user's permission policy on disk, as Settings reads and writes it (#474):
 * `ENSO_HOME/permissions.json`, which the engine reads through a link from its own config path.
 *
 * ⚠ EVERY WRITE IS ATOMIC, AND EVERY WRITE IS ONE THE ENGINE ACCEPTS. The engine re-reads the file
 * when its modification time changes, at the next permission check of every running session. A
 * file caught half-written — or one its schema rejects — is read as an EMPTY policy: every call
 * asks and every deny is gone. So a save is validated first (`host/permission-policy.ts`), then
 * written to a temporary file beside it and renamed over it: the engine sees the old file or the
 * new one, never neither. The link survives: it names the path, and a rename keeps the path.
 *
 * ⚠ A SAVE SAYS WHAT IT EXPECTS ON DISK, as a prompt write does: the file the page read (its
 * `ETag`), or `*`. The file is the user's too — they may edit it by hand while the page is open —
 * and an edit made there is never overwritten unseen.
 *
 * In the host, beside the engine's schema, because the write is shaped by what the engine does:
 * it reloads on the modification time alone (`writeAtomically`), and its real-engine tests must
 * share `agent-host.test.ts`'s process-wide agent dir.
 */

/** A strong entity tag for the file's bytes, quoted as HTTP writes one (the prompt library's). */
function etagOf(bytes: Uint8Array): string {
  return `"${createHash('sha256').update(bytes).digest('hex')}"`
}

function errorCode(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined
}

/** The file's bytes, or `undefined` when there is none. */
function bytesOf(path: string): Buffer | undefined {
  try {
    return readFileSync(path)
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return undefined
    throw error
  }
}

/** Where the engine writes its review log: beside its config, under `logs/`. */
function reviewLogDirectoryOf(agentDir: string): string {
  return join(dirname(permissionEngineConfigPath(agentDir)), 'logs')
}

/**
 * The policy as a page reads it — or why the file cannot be read, since the engine reads that
 * file as an empty policy and the page must say so, not show an empty list.
 */
export function readPermissionPolicy(policyPath: string, agentDir: string): EnsoPermissionPolicyRead {
  const common = {
    path: policyPath,
    reviewLogDirectory: reviewLogDirectoryOf(agentDir),
    ensoDefault: ENSO_DEFAULT_PERMISSION_POLICY as unknown as Record<string, unknown>,
  }
  const bytes = bytesOf(policyPath)
  if (bytes === undefined) {
    return { kind: 'unreadable', ...common, reason: 'the file is missing: the next launch seeds Enso’s policy' }
  }
  const etag = etagOf(bytes)
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch (error: unknown) {
    return { kind: 'unreadable', ...common, etag, reason: error instanceof Error ? error.message : String(error) }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { kind: 'unreadable', ...common, etag, reason: 'the file is not a JSON object' }
  }
  return { kind: 'ok', ...common, etag, file: parsed as Record<string, unknown> }
}

/** Why the file on disk is not what `condition` expects, or `undefined` when it is. */
function conflictOf(policyPath: string, condition: WriteCondition): string | undefined {
  const bytes = bytesOf(policyPath)
  if (condition.kind === 'absent') return bytes === undefined ? undefined : `${policyPath} already exists`
  if (bytes === undefined) return `${policyPath} is no longer there: it was deleted since it was opened`
  if (condition.kind === 'matches' && etagOf(bytes) !== condition.etag) {
    return `${policyPath} changed on disk since it was opened — reload to see the version there now`
  }
  return undefined
}

function statOrUndefined(path: string): Stats | undefined {
  try {
    return statSync(path)
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Write `text` to the file behind `policyPath` in one step: a temporary file beside it, renamed over it.
 *
 * ⚠ THE MODIFICATION TIME MUST MOVE. The engine reloads a policy only when the file's `mtimeMs`
 * differs from the one it last read (`config/policy-loader.ts`), and Linux stamps it from a coarse
 * clock — one tick is milliseconds. A write landing in the same tick as the last one (a reset just
 * after a hand edit) kept the OLD policy in force, silently. Found by this file's reset test.
 */
function writeAtomically(policyPath: string, text: string): void {
  const target = realpathOrSelf(policyPath)
  const previous = statOrUndefined(target)
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(temporary, text, { flag: 'wx' })
  try {
    renameSync(temporary, target)
  } catch (error: unknown) {
    rmSync(temporary, { force: true })
    throw error
  }
  if (previous === undefined) return
  const written = statSync(target)
  if (written.mtimeMs > previous.mtimeMs) return
  utimesSync(target, written.atime, (previous.mtimeMs + 1) / 1000)
}

/** @group Permission policy */
export type PermissionPolicyWrite =
  | { readonly kind: 'written'; readonly read: EnsoPermissionPolicyRead }
  | { readonly kind: 'conflict'; readonly reason: string }
  | { readonly kind: 'refused'; readonly refusal: EnsoPermissionPolicyRefusal }

/**
 * Write the whole file a page sent, under `condition`: with Enso's `**` put first where a mode
 * needs it (the same normalisation a launch gives a hand-edited file, #499), validated against the
 * engine's schema, atomically. A refusal writes nothing.
 */
export function writePermissionPolicy(
  policyPath: string,
  agentDir: string,
  file: Readonly<Record<string, unknown>>,
  condition: WriteCondition,
): PermissionPolicyWrite {
  const conflict = conflictOf(policyPath, condition)
  if (conflict !== undefined) return { kind: 'conflict', reason: conflict }
  const permission = file.permission
  const normalized =
    typeof permission === 'object' && permission !== null && !Array.isArray(permission)
      ? { ...file, permission: withCatchAllFirst(permission as Record<string, unknown>).permission }
      : file
  const problems = policyProblems(normalized)
  if (problems.length > 0) {
    const reason = `the engine would not run this policy as written (${problems.length} problem${problems.length === 1 ? '' : 's'}); nothing was saved`
    return { kind: 'refused', refusal: { reason, problems } }
  }
  writeAtomically(policyPath, `${JSON.stringify(normalized, null, 2)}\n`)
  return { kind: 'written', read: readPermissionPolicy(policyPath, agentDir) }
}

/**
 * Copy `path` to the first free backup name (`.bak`, then `.bak.1` …) and return it. A copy, not a
 * move: the file stays in place until the reset's atomic write replaces it, so the engine never
 * finds it missing.
 */
function copyAside(path: string): string {
  for (let attempt = 0; ; attempt += 1) {
    const backup = attempt === 0 ? `${path}.bak` : `${path}.bak.${attempt}`
    try {
      copyFileSync(path, backup, constants.COPYFILE_EXCL)
      return backup
    } catch (error: unknown) {
      if (errorCode(error) !== 'EEXIST') throw error
    }
  }
}

/** @group Permission policy */
export type PermissionPolicyReset =
  | { readonly kind: 'reset'; readonly backup?: string; readonly read: EnsoPermissionPolicyRead }
  | { readonly kind: 'conflict'; readonly reason: string }

/**
 * Put Enso's default policy in force, the current file kept beside it first (never overwritten).
 * Under `If-None-Match: *` — no file there — there is nothing to keep.
 */
export function resetPermissionPolicy(
  policyPath: string,
  agentDir: string,
  condition: WriteCondition,
): PermissionPolicyReset {
  const conflict = conflictOf(policyPath, condition)
  if (conflict !== undefined) return { kind: 'conflict', reason: conflict }
  const backup = condition.kind === 'absent' ? undefined : copyAside(realpathOrSelf(policyPath))
  writeAtomically(policyPath, `${JSON.stringify(ENSO_DEFAULT_PERMISSION_POLICY, null, 2)}\n`)
  const read = readPermissionPolicy(policyPath, agentDir)
  return backup === undefined ? { kind: 'reset', read } : { kind: 'reset', backup, read }
}
