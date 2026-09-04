import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import {
	PERSISTENCE_WRITE_BASENAMES,
	PERSISTENCE_WRITE_DIRECTORIES,
	SECRET_BASENAME_PATTERNS,
} from "@zen/core";

/** Resolve a tool-supplied path against the session cwd. Does NOT confine — see {@link isInsideAnyRoot}. */
export function resolveAgainstCwd(candidate: string, cwd: string): string {
	return isAbsolute(candidate) ? resolve(candidate) : resolve(cwd, candidate);
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
	return absolutePath.startsWith(normalizedRoot.endsWith(sep) ? normalizedRoot : normalizedRoot + sep);
}

/** True when the path is inside at least one root, checking both the literal path and its realpath. */
export function isInsideAnyRoot(absolutePath: string, roots: readonly string[]): boolean {
	if (roots.length === 0) return false;
	const viaSymlink = realpathOfNearestExisting(absolutePath);
	return roots.some((root) => isInsideRoot(absolutePath, root) && isInsideRoot(viaSymlink, resolve(root)));
}

/** True when the path looks like credential material, by directory fragment or by basename. */
export function looksLikeSecret(absolutePath: string, fragments: readonly string[]): boolean {
	const lowered = absolutePath.toLowerCase();
	if (fragments.some((fragment) => lowered.includes(fragment.toLowerCase()))) return true;
	const name = basename(absolutePath);
	return SECRET_BASENAME_PATTERNS.some((pattern) => pattern.test(name));
}

/** True when the path contains a fragment that is never writable. */
export function isProtectedForWrite(absolutePath: string, fragments: readonly string[]): boolean {
	const lowered = absolutePath.toLowerCase();
	return fragments.some((fragment) => lowered.includes(fragment.toLowerCase()));
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
		const segments = candidate.toLowerCase().split(sep);
		if (
			segments.some((segment) =>
				PERSISTENCE_WRITE_DIRECTORIES.some((dangerous) => dangerous === segment),
			)
		) {
			return true;
		}
	}
	return false;
}
