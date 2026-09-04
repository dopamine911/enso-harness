import { realpathOfNearestExisting } from "./paths.ts";

/**
 * Session-scoped record of files whose content this session has seen (#10).
 *
 * `write` replaces a whole file knowing nothing of what it destroys — pi's own description:
 * "overwrites if it does [exist]". `edit` is accidentally safe (a blind edit fails its
 * exact-match), so `write` is the one mutating tool with no knowledge precondition. This
 * tracker supplies that precondition's state: the guard blocks a `write` to an EXISTING
 * file unless the session has read it (or authored it — see the guard's knowledge set).
 *
 * Identity is the realpath (via {@link realpathOfNearestExisting}), so a read through a
 * symlink or a `../` spelling and a write through the direct path count as the same file.
 * Both record and check happen on paths that exist at the time (a read succeeded; a write
 * targets an existing file), so the realpath is fully resolved in both directions.
 *
 * ⚠ The state must be SESSION-scoped, never process-scoped — a closure that outlives the
 * session permits writes on stale knowledge. Two mechanisms keep it session-scoped: pi
 * tears the extension runtime down on session replacement (re-instantiating this closure),
 * and the guard also calls {@link SessionReadTracker.reset} on every `session_start`
 * (which additionally fires for "reload" and "resume", where the runtime survives but the
 * conversation context does not carry the old reads).
 */
export interface SessionReadTracker {
	/** Record that the session has seen this file's content (a successful read or write). */
	recordKnownPath(absolutePath: string): void;
	/** True when the session has seen the content of the file this path resolves to. */
	isKnownPath(absolutePath: string): boolean;
	/** Forget everything — called on session_start. */
	reset(): void;
}

export function createSessionReadTracker(): SessionReadTracker {
	const knownRealpaths = new Set<string>();
	return {
		recordKnownPath(absolutePath: string): void {
			knownRealpaths.add(realpathOfNearestExisting(absolutePath));
		},
		isKnownPath(absolutePath: string): boolean {
			return knownRealpaths.has(realpathOfNearestExisting(absolutePath));
		},
		reset(): void {
			knownRealpaths.clear();
		},
	};
}
