import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, sep as pathSeparator, resolve } from "node:path";
import {
	fileUrlToPath,
	isFileUrl,
	PERSISTENCE_WRITE_BASENAMES,
	PERSISTENCE_WRITE_DIRECTORIES,
	SECRET_BASENAME_PATTERNS,
	ZEN_PERSISTENCE_WRITE_DIRECTORIES,
} from "@zen/core";

/**
 * The full directory-segment deny set: picc's vendored corpus plus the zen additions
 * (pi's own persistence surfaces — see the constants' comments in @zen/core guard.ts).
 */
const ALL_PERSISTENCE_WRITE_DIRECTORIES: readonly string[] = [
	...PERSISTENCE_WRITE_DIRECTORIES,
	...ZEN_PERSISTENCE_WRITE_DIRECTORIES,
];

/**
 * The unicode space characters pi collapses to a plain space before resolving a path
 * (NBSP, the U+2000 block, narrow NBSP, medium mathematical space, ideographic space).
 * Same set as pi's `UNICODE_SPACES` — see the attribution on {@link normalizeLikePi}.
 */
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

const AT_PREFIX = "@";
const TILDE = "~";
const TILDE_DIRECTORY_PREFIX = "~/";
const WINDOWS_PLATFORM = "win32";

/**
 * Convert a Git Bash / MSYS / Cygwin / WSL drive path (`/c/x`, `/mnt/c/x`, `/cygdrive/c/x`)
 * to the native Windows form pi would resolve. Only reached on win32 — kept so the
 * agreement with pi (see {@link normalizeLikePi}) holds on every platform, not just the
 * ones this harness is run on today.
 *
 * ⚠ NAMED NON-COVERAGE: replicated from pi but UNEXERCISED here — the corpus test runs on
 * Linux, where this branch is never reached, so its agreement with pi is by transcription,
 * not by receipt. The day the suite runs on Windows, the corpus test covers it for free.
 */
function normalizeWindowsShellPath(filePath: string): string {
	if (!filePath.startsWith("/") || filePath.startsWith("//") || filePath.includes("\\")) return filePath;
	const match = filePath.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
	if (match === null) return filePath;
	const driveLetter = match[1];
	if (driveLetter === undefined) return filePath;
	const remainder = match[2];
	const suffix = remainder === undefined ? "" : remainder.replaceAll("/", "\\");
	return `${driveLetter.toUpperCase()}:\\${suffix}`;
}

/**
 * Normalise a path string EXACTLY as pi's tools do before they resolve it.
 *
 * Replicated from pi-coding-agent 0.84.4 `dist/utils/paths.js` `normalizePath`
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
	let normalized = options.normalizeUnicodeSpaces ? input.replace(UNICODE_SPACES, " ") : input;
	if (options.stripAtPrefix && normalized.startsWith(AT_PREFIX)) {
		normalized = normalized.slice(AT_PREFIX.length);
	}
	if (process.platform === WINDOWS_PLATFORM) {
		normalized = normalizeWindowsShellPath(normalized);
	}
	// Only the bare `~` and `~/…` expand — `~user/x` stays literal, exactly as in pi.
	const home = homedir();
	if (normalized === TILDE) return home;
	if (normalized.startsWith(TILDE_DIRECTORY_PREFIX)) {
		return join(home, normalized.slice(TILDE_DIRECTORY_PREFIX.length));
	}
	if (isFileUrl(normalized)) {
		return fileUrlToPath(normalized);
	}
	return normalized;
}

/**
 * Resolve a tool-supplied path against the session cwd, to the SAME absolute path pi's own
 * tool will operate on. Does NOT confine — see {@link isInsideAnyRoot}.
 *
 * Mirrors pi's `resolveToCwd` → `resolvePath`: the candidate is normalised with the tool
 * options (see {@link normalizeLikePi}); the cwd is normalised with pi's DEFAULT options
 * (tilde and `file://` only — pi neither strips `@` from a base directory nor collapses
 * its unicode spaces).
 */
export function resolveAgainstCwd(candidate: string, cwd: string): string {
	const normalizedCandidate = normalizeLikePi(candidate, { stripAtPrefix: true, normalizeUnicodeSpaces: true });
	const normalizedCwd = normalizeLikePi(cwd, { stripAtPrefix: false, normalizeUnicodeSpaces: false });
	return isAbsolute(normalizedCandidate) ? resolve(normalizedCandidate) : resolve(normalizedCwd, normalizedCandidate);
}

/**
 * Realpath of the nearest existing ancestor.
 *
 * ⚠ Load-bearing: a string containment check alone is escapable by a symlink that
 * lives inside the workspace and points outside it. New files have no realpath, so
 * the nearest existing ancestor is the thing to resolve.
 */
export function realpathOfNearestExisting(absolutePath: string): string {
	let current = absolutePath;
	for (;;) {
		if (existsSync(current)) {
			try {
				return realpathSync(current);
			} catch {
				return current;
			}
		}
		const parent = dirname(current);
		if (parent === current) return current;
		current = parent;
	}
}

/** True when `absolutePath` is `root` or lives beneath it. Compares with a trailing separator so `/a/bc` is not inside `/a/b`. */
export function isInsideRoot(absolutePath: string, root: string): boolean {
	const normalizedRoot = resolve(root);
	if (absolutePath === normalizedRoot) return true;
	return absolutePath.startsWith(
		normalizedRoot.endsWith(pathSeparator) ? normalizedRoot : normalizedRoot + pathSeparator,
	);
}

/** True when the path is inside at least one root, checking both the literal path and its realpath. */
export function isInsideAnyRoot(absolutePath: string, roots: readonly string[]): boolean {
	if (roots.length === 0) return false;
	const viaSymlink = realpathOfNearestExisting(absolutePath);
	return roots.some((root) => isInsideRoot(absolutePath, root) && isInsideRoot(viaSymlink, resolve(root)));
}

/**
 * True when the path contains any of the fragments, case-insensitively.
 *
 * ⚠ The path is compared WITH a trailing separator appended (#53 S1.2). Directory-shaped
 * fragments carry a trailing `/` (`/.aws/`, `/.ssh/`, `/.git/`) so that they match as a
 * segment and not as a name prefix — but `resolve()` strips the trailing slash a model
 * supplies, so the directory ITSELF (`/home/u/.aws`) never contained `/.aws/` and passed.
 * `grep pattern=aws_secret_access_key path=~/.aws` went through the reader gate that way.
 * Appending the separator makes the directory match its own fragment; file-shaped fragments
 * (`/.npmrc`, `/.kube/config`) are unaffected because they still occur as a substring.
 */
function containsPathFragment(absolutePath: string, fragments: readonly string[]): boolean {
	const loweredWithTrailingSeparator = absolutePath.toLowerCase() + pathSeparator;
	return fragments.some((fragment) => loweredWithTrailingSeparator.includes(fragment.toLowerCase()));
}

/** True when the path looks like credential material, by directory fragment or by basename. */
export function looksLikeSecret(absolutePath: string, fragments: readonly string[]): boolean {
	if (containsPathFragment(absolutePath, fragments)) return true;
	const name = basename(absolutePath);
	return SECRET_BASENAME_PATTERNS.some((pattern) => pattern.test(name));
}

/** True when the path contains a fragment that is never writable. */
export function isProtectedForWrite(absolutePath: string, fragments: readonly string[]): boolean {
	return containsPathFragment(absolutePath, fragments);
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
 */
export function isPersistenceWriteTarget(absolutePath: string): boolean {
	for (const candidate of [absolutePath, realpathOfNearestExisting(absolutePath)]) {
		const name = basename(candidate).toLowerCase();
		if (PERSISTENCE_WRITE_BASENAMES.some((dangerous) => dangerous === name)) return true;
		const segments = candidate.toLowerCase().split(pathSeparator);
		if (segments.some((segment) => ALL_PERSISTENCE_WRITE_DIRECTORIES.some((dangerous) => dangerous === segment))) {
			return true;
		}
	}
	return false;
}
