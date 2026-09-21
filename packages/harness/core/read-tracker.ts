import { existsSync, statSync } from 'node:fs'
import { realpathOfNearestExisting } from './paths.ts'

/**
 * Session-scoped record of files whose content this session has seen (#10), and of the
 * on-disk state they had when it saw them (#11).
 *
 * `write` replaces a whole file knowing nothing of what it destroys — pi's own description:
 * "overwrites if it does [exist]". `edit` is accidentally safe against a *blind* edit (its
 * exact-match fails), so `write` is the one mutating tool with no knowledge precondition
 * (#10). Neither tool notices that a file CHANGED UNDERNEATH the session (#11): nothing in
 * pi checks mtime or content between the read the model saw and the mutation it issues.
 * The recorded incident this closes is a concurrent agent in the same checkout restoring a
 * tracked-but-unstaged file from the index — the work vanished with no error anywhere.
 *
 * So each recorded file carries a STAMP — `{mtimeMs, size}` from `statSync` at the moment
 * of observation — and {@link SessionReadTracker.classifyPath} reports one of three states:
 *
 *   "unknown"  never observed this session (#10 blocks `write` to an existing unknown file)
 *   "fresh"    observed, and the current stat still matches the stamp
 *   "stale"    observed, but mtimeMs or size moved — something else touched the file
 *              (#11 blocks `write` AND `edit`, with a message naming the cause)
 *
 * ⚠ Known gap, accepted: a same-size rewrite landing in the same millisecond escapes
 * mtime+size. The incident class this exists for (`git checkout --` restores, another
 * agent's writes) always moves mtime; closing the residue would mean hashing the full
 * file on every stamp and every check. ⚠ A second small window: the stamp is taken at
 * `tool_result` time, marginally after the tool's own filesystem access — an external
 * write landing inside that gap is stamped as if the session saw it. Both are the cost
 * of stat-based detection, stated rather than hidden.
 *
 * Identity is the realpath (via {@link realpathOfNearestExisting}), so a read through a
 * symlink or a `../` spelling and a write through the direct path count as the same file.
 * If the file cannot be statted at record time (deleted between the tool's execution and
 * its result), NOTHING is recorded — an unstamped entry could never be classified later.
 *
 * ⚠ The state must be SESSION-scoped, never process-scoped — a closure that outlives the
 * session permits writes on stale knowledge. Two mechanisms keep it session-scoped: pi
 * tears the extension runtime down on session replacement (re-instantiating this closure),
 * and the guard also calls {@link SessionReadTracker.reset} on every `session_start`
 * (which additionally fires for "reload" and "resume", where the runtime survives but the
 * conversation context does not carry the old reads).
 */

/** What the session knew of a file when it last observed it. */
/**
 * What "the file the session saw" is compared by. Mirrors pi's own `getFileRevision`
 * (`dist/utils/paths.js`: `dev:ino:size:mtimeNs:ctimeNs`) minus `dev`, because a realpath
 * already pins the device. ⚠ mtime and size alone were spoofable (#53 S3): a same-size
 * rewrite with `utimes` pinning the mtime back read as fresh. ctime cannot be set from
 * userland, and a replace-by-rename changes the inode.
 */
interface ObservedFileStamp {
  /** Nanoseconds, as pi reads them (`statSync(path, { bigint: true })`) — no float rounding. */
  mtimeNs: bigint
  ctimeNs: bigint
  ino: bigint
  size: bigint
}

function stampsMatch(current: ObservedFileStamp, recorded: ObservedFileStamp): boolean {
  return (
    current.mtimeNs === recorded.mtimeNs &&
    current.ctimeNs === recorded.ctimeNs &&
    current.ino === recorded.ino &&
    current.size === recorded.size
  )
}

/** @group Guard predicates */
export type KnownPathState = 'unknown' | 'fresh' | 'stale'

/** @group Guard predicates */
export interface SessionReadTracker {
  /**
   * Record that the session has seen this file's content (a successful read or write),
   * stamping the file's current stat. A file that cannot be statted records nothing.
   */
  recordKnownPath(absolutePath: string): void
  /**
   * Re-stamp a file that is ALREADY known — for the session's own successful `edit`,
   * which moves mtime and size without conferring whole-file knowledge (#10's decision).
   * Knowledge and stamp currency are separate concerns: an edit proves the session knew
   * one fragment, so an unknown file stays unknown, but a KNOWN file's stamp must follow
   * the session's own mutation or the next mutation classifies the session's own work as
   * "changed underneath us" (found live: read → edit → edit refused the second edit).
   */
  refreshStampIfKnown(absolutePath: string): void
  /** How the file this path resolves to relates to what the session last saw of it. */
  classifyPath(absolutePath: string): KnownPathState
  /** Forget everything — called on session_start. */
  reset(): void
}

/** @group Guard predicates */
export function createSessionReadTracker(): SessionReadTracker {
  const stampsByRealpath = new Map<string, ObservedFileStamp>()

  function statStampOf(realpath: string): ObservedFileStamp | undefined {
    try {
      const stats = statSync(realpath, { bigint: true })
      return { mtimeNs: stats.mtimeNs, ctimeNs: stats.ctimeNs, ino: stats.ino, size: stats.size }
    } catch {
      return undefined
    }
  }

  return {
    recordKnownPath(absolutePath: string): void {
      // ⚠ Only a path that EXISTS may be recorded: for a missing file,
      // realpathOfNearestExisting degrades to the nearest existing ANCESTOR, and
      // stamping that directory poisons the map — a directory's mtime moves on any
      // entry creation, so the stamp would later classify unrelated paths under it
      // as "stale" and block ordinary file creation. Found by the record-nothing test.
      if (!existsSync(absolutePath)) return
      const realpath = realpathOfNearestExisting(absolutePath)
      const stamp = statStampOf(realpath)
      if (stamp === undefined) return
      stampsByRealpath.set(realpath, stamp)
    },
    refreshStampIfKnown(absolutePath: string): void {
      const realpath = realpathOfNearestExisting(absolutePath)
      if (!stampsByRealpath.has(realpath)) return
      const stamp = statStampOf(realpath)
      if (stamp === undefined) return
      stampsByRealpath.set(realpath, stamp)
    },
    classifyPath(absolutePath: string): KnownPathState {
      const realpath = realpathOfNearestExisting(absolutePath)
      const recorded = stampsByRealpath.get(realpath)
      if (recorded === undefined) return 'unknown'
      const current = statStampOf(realpath)
      // ⓘ A recorded file DELETED underneath us never reaches this line: its realpath
      // degrades to the nearest existing ancestor above, misses the map, and returns
      // "unknown" — so a write to the now-absent path takes the ordinary creation
      // route. This branch is the narrow remainder (a stat race, a permission flip):
      // the disk no longer matches what the session saw, so fail toward stale.
      if (current === undefined) return 'stale'
      return stampsMatch(current, recorded) ? 'fresh' : 'stale'
    },
    reset(): void {
      stampsByRealpath.clear()
    },
  }
}
