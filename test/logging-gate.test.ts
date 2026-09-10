import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Every record goes through the one logger (#132), and the substrate stays behind it.
 *
 * ⚠ Enforcement, not a unit test — the same shape as `no-lint-suppressions.test.ts`. Two
 * lines, both ratchets:
 *
 *   1. No production `console.*` in a migrated root. A `console.error` is a record with no
 *      level, no thread, no file, and no test that can hear it — exactly what the server's
 *      `onProblem` seams were until this gate. Tests are outside it; the browser (#132
 *      slice 3) and the vendored ai-elements components are inside it, and clean.
 *   2. `@logtape/*` is imported only where the schema lives (`core/src/log.ts`) and where a
 *      process configures its sink (`core/src/log-process.ts`, `web/src/browser-logging.ts`).
 *      Everything else goes through `zenLogger`, so the record
 *      shape is ours to hold and the substrate is ours to swap (one maintainer — the #132
 *      assessment's named risk).
 *
 * `MIGRATED_ROOTS` covers every layer now (the browser landed with slice 3). Removing a root
 * is a design conversation.
 */

const repositoryRoot = join(import.meta.dir, "..");
const MIGRATED_ROOTS = ["packages/core/src", "packages/web/src", "packages/harness"] as const;
const SKIPPED_DIRECTORIES = ["node_modules", "dist", "dist-types", "coverage", "__tests__"] as const;
const SOURCE_EXTENSION = /\.tsx?$/;
/** A line that is only a comment: `//`, a block opener, or a block's `*`-led body. */
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;
/** The console is a sink LogTape owns; nothing here writes to it by hand. */
const CONSOLE_CALL = /\bconsole\.(?:log|error|warn|info|debug|trace)\s*\(/;
/** Where the substrate may be named. */
const LOGTAPE_IMPORT = /from\s+["']@logtape\//;
const LOGTAPE_ALLOWED = [
	"packages/core/src/log.ts",
	"packages/core/src/log-process.ts",
	"packages/web/src/browser-logging.ts",
] as const;

function sourceFiles(directory: string): string[] {
	const found: string[] = [];
	for (const dirent of readdirSync(directory, { withFileTypes: true })) {
		if ((SKIPPED_DIRECTORIES as readonly string[]).includes(dirent.name)) continue;
		const path = join(directory, dirent.name);
		if (dirent.isDirectory()) found.push(...sourceFiles(path));
		else if (SOURCE_EXTENSION.test(dirent.name)) found.push(path);
	}
	return found;
}

function offendersMatching(pattern: RegExp, allowed: readonly string[]): string[] {
	const offenders: string[] = [];
	for (const root of MIGRATED_ROOTS) {
		for (const path of sourceFiles(join(repositoryRoot, root))) {
			const repositoryRelative = path.slice(repositoryRoot.length + 1);
			if (allowed.includes(repositoryRelative)) continue;
			const lines = readFileSync(path, "utf8").split("\n");
			for (const [lineIndex, line] of lines.entries()) {
				// Code, not prose: a comment may quote `console.log` as the thing a guard denies.
				if (COMMENT_LINE.test(line)) continue;
				if (pattern.test(line)) offenders.push(`${repositoryRelative}:${lineIndex + 1}`);
			}
		}
	}
	return offenders;
}

test("⚠ no production console.* in a migrated root — every record goes through zenLogger (#132)", () => {
	expect(offendersMatching(CONSOLE_CALL, [])).toEqual([]);
});

test("⚠ @logtape/* is imported only by the schema and the configurators (#132)", () => {
	expect(offendersMatching(LOGTAPE_IMPORT, LOGTAPE_ALLOWED)).toEqual([]);
});
