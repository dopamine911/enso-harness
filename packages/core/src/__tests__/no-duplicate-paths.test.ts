import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { findRepoRoot } from "../paths.ts";

/**
 * The anti-duplication anchor for path resolution (#59) — Daniel: "this should live in
 * core and prevent duplicate code again."
 *
 * Before paths.ts, seven call sites each walked up from their own `import.meta.url`
 * (one counted `4×".."` and broke on any file move). This anchor refuses an eighth copy
 * the way `no-duplicate-shapes.test.ts` refuses a stray schema: a convention with no
 * check is a convention that has already been broken somewhere nobody has looked.
 *
 * Tests are excluded — a test legitimately builds fixture paths and reads its own
 * location. The rules gate SOURCE, where a duplicate resolver silently drifts.
 */

const repositoryRoot = findRepoRoot(import.meta.url);
const PATHS_MODULE = join("packages", "core", "src", "paths.ts");

/** The scanned surface: every non-test source file the migration covered. */
const SCANNED_ROOTS = [
	"packages/core/src",
	"packages/harness/core",
	"packages/harness/extensions",
	"packages/web/src",
	"scripts",
] as const;

/** Vendored code — biome.jsonc's exclusion boundary, same as the coverage manifest. */
const VENDORED_DIRECTORIES = ["packages/web/src/components"] as const;

function isScannableSource(fileName: string): boolean {
	if (fileName.endsWith(".test.ts") || fileName.endsWith(".test.tsx")) return false;
	return fileName.endsWith(".ts") || fileName.endsWith(".tsx") || fileName.endsWith(".mjs");
}

function collectScannableSources(): string[] {
	const collected: string[] = [];
	for (const scannedRoot of SCANNED_ROOTS) {
		for (const dirEntry of readdirSync(join(repositoryRoot, scannedRoot), {
			withFileTypes: true,
			recursive: true,
		})) {
			if (!(dirEntry.isFile() && isScannableSource(dirEntry.name))) continue;
			const absolutePath = join(dirEntry.parentPath, dirEntry.name);
			const repositoryRelative = relative(repositoryRoot, absolutePath);
			if (repositoryRelative.includes("__tests__")) continue;
			if (repositoryRelative.includes("node_modules")) continue;
			if (repositoryRelative.includes("dist-types")) continue;
			if (VENDORED_DIRECTORIES.some((vendored) => repositoryRelative.startsWith(vendored))) continue;
			collected.push(repositoryRelative);
		}
	}
	return collected;
}

function offendersContaining(needle: string, allowedFiles: readonly string[]): string[] {
	return collectScannableSources()
		.filter((repositoryRelative) => !allowedFiles.includes(repositoryRelative))
		.filter((repositoryRelative) => readFileSync(join(repositoryRoot, repositoryRelative), "utf8").includes(needle))
		.map((repositoryRelative) => `${repositoryRelative} contains ${JSON.stringify(needle)}`);
}

test("⚠ fileURLToPath lives ONLY in core's paths module — pass import.meta.url to findRepoRoot instead", () => {
	// Named, not counted — a count cannot say which file to look at.
	expect(offendersContaining("fileURLToPath(", [PATHS_MODULE])).toEqual([]);
});

test("⚠ no source resolves siblings via import.meta.dir — that is the seven-copies shape returning", () => {
	// Exact property name: `import.meta.main` (check-coverage's entry idiom) must not match.
	expect(offendersContaining("import.meta.dir", [])).toEqual([]);
});

test('⚠ the ".zen" literal is assembled only in paths.ts (plus guard.ts, where it is corpus data)', () => {
	// guard.ts's exception is ZEN_PERSISTENCE_WRITE_DIRECTORIES: there ".zen" is a DENIED
	// DIRECTORY NAME in the write-guard's corpus, not a path being assembled — rewiring the
	// corpus to import from paths.ts would couple the guard's deny-list to the helper for
	// no safety gain (the corpus lists names to REFUSE; paths.ts assembles paths to USE).
	const GUARD_CORPUS_MODULE = join("packages", "core", "src", "guard.ts");
	expect(offendersContaining('".zen"', [PATHS_MODULE, GUARD_CORPUS_MODULE])).toEqual([]);
});
