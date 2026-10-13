import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, sep as pathSeparator, resolve } from 'node:path'
import {
  ENSO_PERSISTENCE_WRITE_BASENAMES,
  ENSO_PERSISTENCE_WRITE_DIRECTORIES,
  PERSISTENCE_WRITE_BASENAMES,
  PERSISTENCE_WRITE_DIRECTORIES,
  PROC_ENVIRON_PATH,
} from '@enso/core'
import { containsPathFragment, fileUrlToPath, isFileUrl, textLooksLikeSecretPath } from '@enso/core/paths'

/**
 * The full directory-segment deny set: the shared persistence corpus plus the enso additions
 * (pi's own persistence surfaces — see the constants' comments in @enso/core guard.ts).
 */
const ALL_PERSISTENCE_WRITE_BASENAMES: readonly string[] = [
  ...PERSISTENCE_WRITE_BASENAMES,
  ...ENSO_PERSISTENCE_WRITE_BASENAMES,
]
const ALL_PERSISTENCE_WRITE_DIRECTORIES: readonly string[] = [
  ...PERSISTENCE_WRITE_DIRECTORIES,
  ...ENSO_PERSISTENCE_WRITE_DIRECTORIES,
]

/**
 * The unicode space characters pi collapses to a plain space before resolving a path
 * (NBSP, the U+2000 block, narrow NBSP, medium mathematical space, ideographic space).
 * Same set as pi's `UNICODE_SPACES` — see the attribution on `normalizeLikePi`.
 */
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g

const AT_PREFIX = '@'
const TILDE = '~'
const TILDE_DIRECTORY_PREFIX = '~/'
const WINDOWS_PLATFORM = 'win32'

/**
 * Convert a Git Bash / MSYS / Cygwin / WSL drive path (`/c/x`, `/mnt/c/x`, `/cygdrive/c/x`)
 * to the native Windows form pi would resolve.
 *
 * Only reached on win32 — kept so the agreement with pi (see `normalizeLikePi`) holds on
 * every platform, not just the ones this harness is run on today.
 *
 * Exported for the tests ONLY: the function is pure, so its agreement with pi's exported
 * `normalizeWindowsShellPath` is pinned on Linux by a corpus of its own — the CALL above
 * it is the only part that stays unexercised until the suite runs on Windows.
 *
 * @group Guard predicates
 */
export function normalizeWindowsShellPath(filePath: string): string {
  if (!filePath.startsWith('/') || filePath.startsWith('//') || filePath.includes('\\')) return filePath
  const match = filePath.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i)
  if (match === null) return filePath
  const driveLetter = match[1]
  if (driveLetter === undefined) return filePath
  const remainder = match[2]
  const suffix = remainder === undefined ? '' : remainder.replaceAll('/', '\\')
  return `${driveLetter.toUpperCase()}:\\${suffix}`
}

/**
 * Normalise a path string EXACTLY as pi's tools do before they resolve it.
 *
 * Replicated from pi-coding-agent 0.87.1 `dist/utils/paths.js` `normalizePath` (unchanged at 1.1.0)
 * (github.com/earendil-works/pi, MIT) — the function every path-bearing pi tool (`read`,
 * `write`, `edit`, `grep`, `find`, `ls`) resolves through via `resolveToCwd`. It is not on
 * the package's export map, so it is copied rather than imported; the corpus test in
 * `__tests__/paths.test.ts` reaches the real one and pins agreement.
 *
 * The two options are pi's and are PER CALL: `resolveToCwd` passes both as `true` for the
 * tool's path argument, while the base directory goes through pi's defaults (both off) —
 * a cwd containing a unicode space is left as-is by pi, and the corpus test proves the
 * guard must leave it too.
 *
 * ⚠ WHY THIS EXISTS (#53 S1.1): the guard used to do plain `resolve(cwd, path)`, so
 * `@/etc/passwd`, `~/evil.sh` and `file:///etc/cron.d/x` were each judged as a path INSIDE
 * the workspace while pi wrote `/etc/passwd`, `$HOME/evil.sh` and `/etc/cron.d/x`. The
 * guard must judge the path pi will actually touch, so it must normalise the same way.
 *
 * ⚠ The ORDER of the steps is pi's and it matters for compound inputs: `@~/x` is `~/x`
 * after the strip and then `$HOME/x`; `@file:///x` decodes only because the `@` went first.
 */
function normalizeLikePi(input: string, options: { stripAtPrefix: boolean; normalizeUnicodeSpaces: boolean }): string {
  let normalized = options.normalizeUnicodeSpaces ? input.replace(UNICODE_SPACES, ' ') : input
  if (options.stripAtPrefix && normalized.startsWith(AT_PREFIX)) {
    normalized = normalized.slice(AT_PREFIX.length)
  }
  if (process.platform === WINDOWS_PLATFORM) {
    normalized = normalizeWindowsShellPath(normalized)
  }
  // Only the bare `~` and `~/…` expand — `~user/x` stays literal, exactly as in pi.
  const home = homedir()
  if (normalized === TILDE) return home
  if (normalized.startsWith(TILDE_DIRECTORY_PREFIX)) {
    return join(home, normalized.slice(TILDE_DIRECTORY_PREFIX.length))
  }
  if (isFileUrl(normalized)) {
    return fileUrlToPath(normalized)
  }
  return normalized
}

/**
 * pi's `resolvePath(input, baseDir)` with its DEFAULT options — tilde and `file://` only, no `@`
 * strip, no unicode-space folding. What pi's project-trust store keys by (before its realpath);
 * `resolveAgainstCwd` is the tool-argument variant.
 *
 * @group Guard predicates
 */
export function resolvePathLikePi(input: string, baseDir: string = process.cwd()): string {
  const defaults = { stripAtPrefix: false, normalizeUnicodeSpaces: false }
  const normalized = normalizeLikePi(input, defaults)
  return isAbsolute(normalized) ? resolve(normalized) : resolve(normalizeLikePi(baseDir, defaults), normalized)
}

/**
 * Resolve a tool-supplied path against the session cwd, to the SAME absolute path pi's own
 * tool will operate on. Does NOT confine — see {@link isInsideAnyRoot}.
 *
 * Mirrors pi's `resolveToCwd` → `resolvePath`: the candidate is normalised with the tool
 * options (see `normalizeLikePi`); the cwd is normalised with pi's DEFAULT options
 * (tilde and `file://` only — pi neither strips `@` from a base directory nor collapses
 * its unicode spaces).
 *
 * @group Guard predicates
 */
export function resolveAgainstCwd(candidate: string, cwd: string): string {
  const normalizedCandidate = normalizeLikePi(candidate, { stripAtPrefix: true, normalizeUnicodeSpaces: true })
  const normalizedCwd = normalizeLikePi(cwd, { stripAtPrefix: false, normalizeUnicodeSpaces: false })
  return isAbsolute(normalizedCandidate) ? resolve(normalizedCandidate) : resolve(normalizedCwd, normalizedCandidate)
}

/**
 * Realpath of the nearest existing ancestor.
 *
 * ⚠ Load-bearing: a string containment check alone is escapable by a symlink that
 * lives inside the workspace and points outside it. New files have no realpath, so
 * the nearest existing ancestor is the thing to resolve.
 *
 * @group Guard predicates
 */
export function realpathOfNearestExisting(absolutePath: string): string {
  let current = absolutePath
  for (;;) {
    if (existsSync(current)) {
      try {
        return realpathSync(current)
      } catch {
        return current
      }
    }
    const parent = dirname(current)
    if (parent === current) return current
    current = parent
  }
}

/**
 * True when `absolutePath` is `root` or lives beneath it. Compares with a trailing separator
 * so `/a/bc` is not inside `/a/b`.
 *
 * File-local (#263): `isInsideAnyRoot` below is the only caller and the only shape any guard
 * needs — a single-root check that ignores the symlink pass is the mistake this file exists
 * to prevent, so it is deliberately not reachable from outside.
 */
function isInsideRoot(absolutePath: string, root: string): boolean {
  const normalizedRoot = resolve(root)
  if (absolutePath === normalizedRoot) return true
  return absolutePath.startsWith(
    normalizedRoot.endsWith(pathSeparator) ? normalizedRoot : normalizedRoot + pathSeparator,
  )
}

/**
 * True when the path is inside at least one root, checking both the literal path and its realpath.
 *
 * @group Guard predicates
 */
export function isInsideAnyRoot(absolutePath: string, roots: readonly string[]): boolean {
  if (roots.length === 0) return false
  const viaSymlink = realpathOfNearestExisting(absolutePath)
  return roots.some((root) => isInsideRoot(absolutePath, root) && isInsideRoot(viaSymlink, resolve(root)))
}

/**
 * A path as the guard judges it (#615): inside the session's OWN thread tree — `ownTree`, a minted
 * `ENSO_HOME/projects/<id>/trees/<thread>` — re-rooted at the tree, so `<tree>/src/a.ts` is judged as
 * `/src/a.ts`, the way the same file in a checkout would be; anywhere else, unchanged.
 *
 * ⚠ Why a tree is not the harness's own directory: it sits under `ENSO_HOME`, and every path there
 * carries the `.enso` the credential fragment (`/.enso/`) and the persistence set (`.enso`) refuse —
 * so a thread could neither write nor read its own work, nor run any shell command, whose every word
 * resolves under its cwd. Other tools keep their worktrees in their own home too (omp `~/.omp/wt`,
 * Codex `~/.codex/worktrees`); the guard was the outlier.
 *
 * ⚠ What stays refused: everything under `ENSO_HOME` outside that ONE tree (secrets, logins, config,
 * logs, snapshots, sessions, other threads' trees), and, inside it, whatever a checkout's own path
 * would be refused for — a project's `.enso/config.json`, `.git/`, a `.env`. Each caller judges the
 * realpath as well as the literal path, so a link in the tree that points out of it is judged where
 * it points. File-local, as `isInsideRoot` is: the predicates below are the only callers, and a check
 * that re-rooted one candidate but not the other would be the mistake this file exists to prevent.
 */
function withinOwnTree(candidate: string, ownTree: string | undefined): string {
  if (ownTree === undefined) return candidate
  for (const root of new Set([resolve(ownTree), realpathOfNearestExisting(resolve(ownTree))])) {
    if (isInsideRoot(candidate, root)) return pathSeparator + relative(root, candidate)
  }
  return candidate
}

/**
 * True when the path looks like credential material, by directory fragment, by basename,
 * or because it is a process's environment.
 *
 * ⚠ Both the literal path AND the realpath of its nearest existing ancestor are judged,
 * for the reason `isPersistenceWriteTarget` and `isInsideAnyRoot` already do it: a symlink
 * inside the workspace named `notes.txt` pointing at `~/.aws/credentials` has an innocent
 * literal path, and pi follows the link. Reading a secret is the precondition for
 * exfiltrating one, so this gate cannot be the one that judges only the name it was given.
 *
 * @group Guard predicates
 */
export function looksLikeSecret(absolutePath: string, fragments: readonly string[], ownTree?: string): boolean {
  for (const literalOrReal of [absolutePath, realpathOfNearestExisting(absolutePath)]) {
    const candidate = withinOwnTree(literalOrReal, ownTree)
    if (textLooksLikeSecretPath(candidate, fragments)) return true
    if (PROC_ENVIRON_PATH.test(candidate)) return true
  }
  return false
}

/** Text bash spells exactly as written: no expansion, quoting, glob or whitespace. */
const PLAIN_PATH_TEXT = /^[\w./@%+,:=-]+$/

/**
 * The text pass's credential question (#777): a word judged by its TEXT, because its value is not
 * knowable or the segmenter declined the command (a heredoc, #545). A plain literal path is asked
 * exactly what {@link looksLikeSecret} asks of a resolved one, so inside the session's own tree it is
 * judged relative to the tree (#615), and through its realpath; any other text is judged whole.
 *
 * ⚠ Only a PLAIN path is: text is a word bash has not resolved, and `<tree>/$X/logins` with
 * `X=../../../..` names the home's logins. An expansion, a glob or a `..` segment keeps the whole
 * text, and with it the `/.enso/` that refuses it.
 *
 * @group Guard predicates
 */
export function wordTextLooksLikeSecret(text: string, fragments: readonly string[], ownTree?: string): boolean {
  const plain = PLAIN_PATH_TEXT.test(text) && !text.split('/').includes('..')
  return plain ? looksLikeSecret(text, fragments, ownTree) : textLooksLikeSecretPath(text, fragments)
}

/**
 * Where a credential fragment is placed to name a location (#160 §4).
 *
 * @group Guard predicates
 */
export interface CredentialPlaces {
  /** The user's home: a fragment names a location here whether or not it exists yet. */
  readonly home: string
  /**
   * Places a fragment names a location in only once it EXISTS: the session's workspace and the
   * harness's own root, where `.enso/` lives. A search normally starts in them, so a location that
   * is not there must not refuse it — `grep path=.` in every project would be.
   */
  readonly existing: readonly string[]
}

/**
 * The credential location a search starting at this directory would reach beneath it, if any:
 * each fragment placed in one of {@link CredentialPlaces} (`~/.ssh`, `~/.aws`, `<harness>/.enso`,
 * …), and the directory an ancestor of it or the location itself (#160 §4).
 *
 * {@link looksLikeSecret} judges the one path it is given, which is the right question for a tool
 * that reads that path. A recursive search reads everything BENEATH it, so `~/.aws` refused while
 * `~` — and `/` — searched the same files. As {@link looksLikeSecret} does, both the literal
 * directory and its realpath are judged (a workspace symlink to home), against each place and its
 * realpath.
 *
 * ⚠ A path that does not exist searches nothing, so nothing is beneath it (#886). Its nearest
 * existing ancestor is not what is searched: judging that folder refused a not-yet-created file in
 * every project holding `.enso/`. The path itself is still {@link looksLikeSecret}'s to judge,
 * through its symlinked ancestors.
 *
 * ⚠ The harness's `.enso/` is NOT protected by being gitignored: ripgrep honours `.gitignore` only
 * inside a git work tree, and the agent may edit `.gitignore`.
 *
 * ⚠ WHAT THIS DOES NOT SEE, stated: a fragment's location anywhere but those places
 * (`/srv/app/.aws`), and a basename-class file (`.env`, `id_rsa`) beneath the directory — those are
 * found only by walking the tree.
 *
 * @group Guard predicates
 */
export function secretLocationBeneath(
  absolutePath: string,
  fragments: readonly string[],
  places: CredentialPlaces,
): string | undefined {
  if (!existsSync(absolutePath)) return undefined
  const directories = new Set([absolutePath, realpathOfNearestExisting(absolutePath)])
  const reached = (location: string): boolean => [...directories].some((directory) => isInsideRoot(location, directory))
  const locationsIn = (place: string): string[] =>
    [...new Set([place, realpathOfNearestExisting(place)])].flatMap((base) =>
      fragments.map((fragment) => resolve(join(base, fragment))),
    )
  const fromHome = locationsIn(places.home).find(reached)
  if (fromHome !== undefined) return fromHome
  return places.existing.flatMap(locationsIn).find((location) => existsSync(location) && reached(location))
}

/**
 * True when the path contains a fragment that is never writable.
 *
 * @group Guard predicates
 */
export function isProtectedForWrite(absolutePath: string, fragments: readonly string[]): boolean {
  return containsPathFragment(absolutePath, fragments)
}

/**
 * True when writing the path would plant a persistence vector (#21) — a shell-init file,
 * git/agent/editor config, or anything inside such a directory.
 *
 * Two candidates are checked: the literal path, and the realpath of its nearest existing
 * ancestor. The second is what catches symlinks — an existing symlink named `notes.txt`
 * pointing at `~/.bashrc` resolves to the true basename, and a NEW file created through a
 * symlinked directory (`innocent/` → `~/.claude/`) resolves to a path whose segments carry
 * the dangerous directory. (A new file's own basename never changes through a directory
 * symlink, so the literal candidate covers that half.)
 *
 * ⚠ Basenames match EXACTLY (case-insensitive, for case-folding filesystems), never as
 * fragments — `.profile-notes/x.ts` and `my.bashrc` must not be caught.
 *
 * @group Guard predicates
 */
export function isPersistenceWriteTarget(absolutePath: string, ownTree?: string): boolean {
  for (const literalOrReal of [absolutePath, realpathOfNearestExisting(absolutePath)]) {
    const candidate = withinOwnTree(literalOrReal, ownTree)
    const name = basename(candidate).toLowerCase()
    if (ALL_PERSISTENCE_WRITE_BASENAMES.some((dangerous) => dangerous === name)) return true
    const segments = candidate.toLowerCase().split(pathSeparator)
    if (segments.some((segment) => ALL_PERSISTENCE_WRITE_DIRECTORIES.some((dangerous) => dangerous === segment))) {
      return true
    }
  }
  return false
}
