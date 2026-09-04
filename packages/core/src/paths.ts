import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The workspace path helpers (#59) — THE one place that walks the filesystem for roots.
 *
 * Before this module, seven call sites each computed the repo root by counting `..`
 * segments off their own `import.meta.url` — a shape that breaks silently when a file
 * moves (dev.ts carried `4×".."`). An anchor test (`no-duplicate-paths.test.ts`) now
 * refuses an eighth copy: `fileURLToPath` and inline `.zen` path assembly outside this
 * module fail the suite by name.
 *
 * ⚠ REALPATH FIRST, then walk — load-bearing, observed live (PR #58 receipts): bun does
 * NOT realpath `import.meta.url` through the `.zen/print-harness/` symlink mirror, so a
 * walk from the un-resolved module path starts inside the mirror. The mirror's entries
 * are symlinks back into the real tree, so resolving first lands the walk in the real
 * checkout; walking first would search the wrong ancestry.
 *
 * ⚠ These helpers run under node/bun only (node:fs). They are barrel-exported and the
 * browser bundle tolerates that because nothing browser-side imports them — probed
 * 2026-09-04: `bun build index.html --target=browser` tree-shakes the module out.
 */

/** Thrown when no ancestor of the start path is a workspace root. */
export class RepoRootNotFoundError extends Error {
	constructor(startPath: string) {
		super(
			`no ancestor of "${startPath}" is a workspace root (a directory whose package.json ` +
				`carries a "workspaces" field) — is this file inside the zen-harness checkout?`,
		);
		this.name = "RepoRootNotFoundError";
	}
}

/** `realpathSync`, or the input unchanged when the path (or a segment of it) does not exist. */
export function realpathOrSelf(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/**
 * True when `directory` is the workspace root: its `package.json` parses and carries a
 * `workspaces` field. ⚠ A malformed `package.json` on the walk (a test fixture, a
 * scratch dir) means "not the root, keep walking" — never a throw.
 */
function isWorkspaceRoot(directory: string): boolean {
	const manifestPath = join(directory, "package.json");
	if (!existsSync(manifestPath)) return false;
	try {
		const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
		return typeof manifest === "object" && manifest !== null && "workspaces" in manifest;
	} catch {
		return false;
	}
}

/**
 * The repository root: the nearest ancestor whose `package.json` declares `workspaces`.
 *
 * Accepts a filesystem path OR a `file://` URL, so callers pass `import.meta.url`
 * directly and never touch `fileURLToPath` themselves (the anchor test enforces that).
 * The start path is realpath-resolved BEFORE walking — see the module header for why.
 *
 * ⚠ This finds the root of the checkout the given FILE lives in — for a module inside
 * this repo that is always the zen-harness checkout, never the session cwd. That
 * distinction is what `config.ts` relies on; do not "fix" this to consult `process.cwd()`.
 */
export function findRepoRoot(startPathOrFileUrl: string): string {
	const startPath = startPathOrFileUrl.startsWith("file://") ? fileURLToPath(startPathOrFileUrl) : startPathOrFileUrl;
	let current = realpathOrSelf(startPath);
	for (;;) {
		if (isWorkspaceRoot(current)) return current;
		const parent = dirname(current);
		if (parent === current) throw new RepoRootNotFoundError(startPath);
		current = parent;
	}
}

/** The `.zen` runtime dir names, assembled here and nowhere else (the anchor enforces it). */
const ZEN_RUNTIME_DIRECTORY = ".zen";

/** pi's scratch agent dir — settings, extensions, auth. Shared by the TUI launcher and the web server. */
export function zenAgentDir(repoRoot: string): string {
	return join(repoRoot, ZEN_RUNTIME_DIRECTORY, "pi-agent");
}

/** Where the print variant of the harness package is materialized (#20). */
export function printHarnessDir(repoRoot: string): string {
	return join(repoRoot, ZEN_RUNTIME_DIRECTORY, "print-harness");
}

/** The harness package — the directory `zen.mjs` hands to pi's `-e`. */
export function harnessPackageDir(repoRoot: string): string {
	return join(repoRoot, "packages", "harness");
}

/** The web package — the cwd both dev surfaces run in. */
export function webPackageDir(repoRoot: string): string {
	return join(repoRoot, "packages", "web");
}
