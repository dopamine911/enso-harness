import { expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * THE COVERAGE DENOMINATOR (#slop-factory port). Bun measures coverage only over files a
 * test IMPORTED — there is no `coverage.include` — so an untested module is ABSENT from
 * the table rather than counted at 0%, and the floor in bunfig.toml passes over a shrinking
 * denominator. Measured in slop-factory on bun 1.3.14: an orphan module left the total at
 * 100%. This test closes that gap by importing EVERY library source file, which puts each
 * one in the denominator; a new file joins automatically via readdir, so nothing rots.
 *
 * ⚠ The cost, stated: importing a module runs its top-level code. Every library module
 * here is import-clean (chat-screen.tsx guards its one `window` read for exactly this
 * reason). The files that are NOT import-clean are the named ENTRY_POINTS below — modules
 * whose body IS the program — and the VENDORED components, which share biome.json's
 * exclusion boundary: upstream's code, kept diffable, not held to our coverage.
 *
 * ⚠ Each entry-point exception is asserted to EXIST, so a renamed entry fails here instead
 * of silently widening the exclusion into a dead pattern.
 */

const REPOSITORY_ROOT = resolve(import.meta.dir, "..");

/** Library roots whose every source file must enter the coverage denominator. */
const LIBRARY_SOURCE_ROOTS = [
	"packages/core/src",
	"packages/harness/core",
	"packages/harness/extensions",
	"packages/web/src",
] as const;

/**
 * Modules whose top-level code IS the program — mounting the DOM app, starting the dev
 * servers. Their logic is exercised by live receipts, not unit coverage, and each is kept
 * THIN so the exclusion stays small (main.tsx's header carries that contract).
 */
const ENTRY_POINT_EXCEPTIONS = [
	"packages/web/src/main.tsx",
	"packages/web/src/server/dev.ts",
	"packages/web/src/server/dev-web.ts",
] as const;

/** Vendored code — biome.json's exclusion boundary, applied to coverage for the same reason. */
const VENDORED_DIRECTORIES = ["packages/web/src/components"] as const;

function isSourceFile(fileName: string): boolean {
	if (fileName.endsWith(".test.ts") || fileName.endsWith(".test.tsx")) return false;
	return fileName.endsWith(".ts") || fileName.endsWith(".tsx");
}

function collectLibrarySources(rootDirectory: string): string[] {
	const collected: string[] = [];
	for (const dirEntry of readdirSync(rootDirectory, { withFileTypes: true, recursive: true })) {
		if (!(dirEntry.isFile() && isSourceFile(dirEntry.name))) continue;
		const absolutePath = join(dirEntry.parentPath, dirEntry.name);
		const repositoryRelative = relative(REPOSITORY_ROOT, absolutePath);
		if (repositoryRelative.includes("__tests__")) continue;
		if (VENDORED_DIRECTORIES.some((vendored) => repositoryRelative.startsWith(vendored))) continue;
		if (ENTRY_POINT_EXCEPTIONS.some((entry) => repositoryRelative === entry)) continue;
		collected.push(absolutePath);
	}
	return collected;
}

test("every named entry-point exception still exists — a rename must not widen the exclusion", () => {
	for (const entryPoint of ENTRY_POINT_EXCEPTIONS) {
		expect(existsSync(join(REPOSITORY_ROOT, entryPoint))).toBe(true);
	}
});

test("every library source file is importable and enters the coverage denominator", async () => {
	const sources = LIBRARY_SOURCE_ROOTS.flatMap((root) => collectLibrarySources(join(REPOSITORY_ROOT, root)));
	// A denominator of zero would mean the roots are wrong, not that coverage is perfect.
	expect(sources.length).toBeGreaterThan(20);
	for (const sourcePath of sources) {
		// Import failures name the file — an import-unclean module must either become
		// clean or be promoted to a named entry-point exception with its reason.
		await import(sourcePath);
	}
});

// ⚠ The floor itself is code that nothing else references at build time: assert it is
// present, wired into the gate, and at least the intended level — so weakening or
// unplugging it is a red test rather than a quiet edit. (It lives in a SCRIPT rather than
// bunfig's coverageThreshold because bun 1.4 enforces that key PER FILE — measured
// 2026-09-04, docs disagree — see scripts/check-coverage.ts.)
const INTENDED_LINE_FLOOR = 0.71;
const INTENDED_FUNCTION_FLOOR = 0.82;

test("the total coverage floor is wired into the gate at the intended level", async () => {
	const { TOTAL_LINE_COVERAGE_FLOOR, TOTAL_FUNCTION_COVERAGE_FLOOR } = await import(
		join(REPOSITORY_ROOT, "scripts", "check-coverage.ts")
	);
	expect(TOTAL_LINE_COVERAGE_FLOOR).toBeGreaterThanOrEqual(INTENDED_LINE_FLOOR);
	expect(TOTAL_FUNCTION_COVERAGE_FLOOR).toBeGreaterThanOrEqual(INTENDED_FUNCTION_FLOOR);
	// The script only bites while the gate runs it — assert the wiring, not just the value.
	const gate = await Bun.file(join(REPOSITORY_ROOT, "scripts", "gate.ts")).text();
	expect(gate).toContain('script: "coverage:check"');
	const bunfig = await Bun.file(join(REPOSITORY_ROOT, "bunfig.toml")).text();
	expect(bunfig).toMatch(/^coverage = true$/m);
});
