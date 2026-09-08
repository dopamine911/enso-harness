import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The naming gate's exemption for externally-fixed KEYS (#82, PR #83 review).
 *
 * ⚠ `is_external_contract_key` in `.biome/naming.grit` replaced two per-line suppressions,
 * so it is now load-bearing in a way the old comments were not: it is the only thing keeping
 * `v` (TanStack's interruptBinding stamp) and `dir` (Bun.serve's static-route option bag)
 * spellable. The failure mode to defend against is someone "simplifying" it into
 * `is_allowlisted`, which exempts EVERY tier — `const dir = …` would silently become legal
 * across the codebase and nothing would say so. The repo has no grit harness, so the gate's
 * behaviour is asserted by running Biome itself.
 */

const repositoryRoot = join(import.meta.dir, "..");
const biomeBinary = join(repositoryRoot, "node_modules", ".bin", "biome");

/**
 * Lints one fixture through the REPO's config and returns the report.
 *
 * ⚠ The fixture lives outside the repo tree on purpose. A temp file written under
 * `packages/` would be visible to the other source-walking tests (the coverage manifest, the
 * duplicate-shape gate) while it existed, and bun runs test files concurrently — that is a
 * flake waiting to happen. `--config-path` gives an out-of-tree file the repo's rules, and
 * the plugin override's `**` include still matches it.
 */
function lintFixture(source: string): string {
	const directory = mkdtempSync(join(tmpdir(), "zen-naming-gate-"));
	try {
		const fixture = join(directory, "fixture.ts");
		writeFileSync(fixture, source);
		const linted = Bun.spawnSync([biomeBinary, "check", `--config-path=${repositoryRoot}`, fixture]);
		return `${linted.stdout.toString()}${linted.stderr.toString()}`;
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

test("⚠ the externally-fixed names are exempt as KEYS but still refused as BINDINGS", () => {
	const report = lintFixture(
		['export const stamp = { v: 1, dir: "static" };', "export const v = 1;", 'export const dir = "static";', ""].join(
			"\n",
		),
	);
	// Line 1 — the wire/API shapes we owe their spelling to. Neither key may be flagged.
	expect(report).not.toContain("Single-character property key");
	expect(report).not.toContain("Abbreviated property key");
	// Lines 2 and 3 — our own identifiers. The exemption must NOT have reached them.
	expect(report).toContain("Single-character name");
	expect(report).toContain("Abbreviated name");
});

// ── the exemption's blast radius, pinned ──────────────────────────────────────
// The suppressions this replaced were scoped to one line each; a predicate keyed on the NAME
// is broader, so the call sites are pinned here instead. A third `{ dir: … }` in first-party
// code is a design question — whether we really owe that spelling to something external —
// and it should surface as a failing gate, not pass silently.
//
// Only property keys can slip through: `v` and `dir` as BINDINGS are still refused by the
// tiers asserted above, so they cannot legally exist as identifiers to be mistaken for keys.

const EXEMPTED_KEY_SITES = [
	// TanStack's `tanstack:interruptBinding` stamp — {v, kind, interruptId, …}.
	"packages/web/src/server/session.ts",
	// Bun.serve's static directory-route option bag.
	"packages/web/src/server/dev-web.ts",
] as const;
const SCANNED_ROOTS = ["packages", "scripts"] as const;
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "dist-types", "coverage"]);
const SOURCE_EXTENSION = /\.(?:tsx?|mjs|cjs)$/;
/** `v:` / `dir:` as a property key — not preceded by a word character or a dot. */
const EXEMPTED_KEY = /(?:^|[^A-Za-z0-9_$.])(?:v|dir)\s*:/;

function sourceFiles(directory: string): string[] {
	const found: string[] = [];
	for (const dirent of readdirSync(directory, { withFileTypes: true })) {
		if (SKIPPED_DIRECTORIES.has(dirent.name)) continue;
		const path = join(directory, dirent.name);
		if (dirent.isDirectory()) found.push(...sourceFiles(path));
		else if (SOURCE_EXTENSION.test(dirent.name)) found.push(path);
	}
	return found;
}

test("⚠ only the two documented sites rely on the key exemption", () => {
	const sites: string[] = [];
	for (const root of SCANNED_ROOTS) {
		for (const path of sourceFiles(join(repositoryRoot, root))) {
			const repositoryRelative = path.slice(repositoryRoot.length + 1);
			// Tests are excluded from the plugin entirely, so their fixtures rely on nothing.
			if (repositoryRelative.includes(".test.")) continue;
			for (const [lineIndex, line] of readFileSync(path, "utf8").split("\n").entries()) {
				if (EXEMPTED_KEY.test(line)) sites.push(`${repositoryRelative}:${lineIndex + 1}`);
			}
		}
	}
	// Named with line numbers — a count cannot say which file to open.
	expect(sites.map((site) => site.split(":")[0])).toEqual([...EXEMPTED_KEY_SITES]);
});
