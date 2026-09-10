import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The seam has an owner: only the host and the pi extensions may name the vendor (#145).
 *
 * ⚠ Enforcement, not a unit test — the same shape as `logging-gate.test.ts`. Two lines,
 * both ratchets:
 *
 *   1. `@earendil-works/*` is imported only under `VENDOR_ROOTS`. Everything else — `@zen/core`,
 *      the server, the browser — talks our shapes, so a pi replacement is a rewrite of two
 *      directories rather than of the product (#69 is the pivot this survived once).
 *   2. A vendor extension's name (`picc`, `pi-multi-account`, `cc-safety-net`) appears in code
 *      only there. Prose may name them — a comment says why a guard exists; an identifier or a
 *      string literal is a dependency.
 *
 * The allowlist IS the leak inventory (`.local/refactor/goals.md` §2 has the table): each entry
 * names one site, its reason, and the leak it maps to. Fixing a leak deletes a line; a new
 * dependency site adds one and must say why. Adding a ROOT, or removing one, is a design
 * conversation — the two roots are the boundary this repo is built on.
 *
 * What it cannot catch, said up front: this is regexes over lines. `ZenThreadInspection.entries:
 * unknown[]` carries pi's persistence format with no import and no vendor name in it (goals L2).
 * That needs a transcript type of ours; a third test — vendor-prefixed identifiers outside the
 * host, the naming gate's trick — keeps it fixed once it is.
 */

const repositoryRoot = join(import.meta.dir, "..");
const SEARCHED_ROOTS = ["packages/core/src", "packages/web/src", "packages/harness"] as const;
/** Where the vendor may be named. Removing one of these is a design conversation. */
const VENDOR_ROOTS = ["packages/web/src/host", "packages/harness/extensions"] as const;
const SKIPPED_DIRECTORIES = ["node_modules", "dist", "dist-types", "coverage", "__tests__"] as const;
const SOURCE_EXTENSION = /\.tsx?$/;
/** A line that is only a comment: `//`, a block opener, or a block's `*`-led body. */
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;
/** pi and its libraries, by package scope. */
const VENDOR_IMPORT = /from\s+["']@earendil-works\//;
/**
 * A vendor extension by name. `_`/`-` are boundaries here, not word characters, so
 * `PICC_PERMISSION_MODES` and `.cc-safety-net` both count — a prefix IS the dependency.
 */
const VENDOR_NAMED = /(?<![A-Za-z0-9])(?:picc|pi[-_]multi[-_]account|cc[-_]safety[-_]net)(?![A-Za-z0-9])/i;

/**
 * Measured on `main` @ #149. The bundle's `about` no longer imports pi's `VERSION` — the host
 * exports `AGENT_RUNTIME_VERSION` and the route takes the string — so what is left is the
 * provider seam under `harness/core`, which is a different boundary (a model API, not the
 * agent loop) and is fenced by `web-search`'s five-providers-behind-one-contract shape.
 */
const VENDOR_IMPORT_ALLOWED: readonly string[] = [
	// pi-ai's `Api`/`Model` types and its env-key fallback: the PROVIDER seam, not the loop.
	// Leaves when web-search's provider contract names its own model/credential types.
	"packages/harness/core/web-search/vocabulary.ts",
	"packages/harness/core/web-search/auth.ts",
];

const VENDOR_NAMED_ALLOWED: readonly string[] = [
	// L3 (picc's persistence read in core): the mode's own vocabulary is picc's registered set
	// and its persisted `customType: "modes"` entry. Leaves when the mode concept is ours.
	"packages/core/src/permission-mode.ts",
	// …and its re-export surface: `PICC_*` is part of `@zen/core`'s public names today.
	"packages/core/src/index.ts",
	// The guard's write-allowlist names cc-safety-net's state directory: a path, not an import.
	// Leaves when the harness owns the list of directories an extension may write.
	"packages/core/src/guard.ts",
	// The two server routes that answer `{ mode, available }`: the available set is picc's.
	// Leaves with L3 — the host would hand the server a mode state of ours.
	"packages/web/src/server/index.ts",
	"packages/web/src/server/follow.ts",
	// The dropdown's empty-state sentence says whose default a fresh thread starts in. A UI
	// string, and it stops being true the moment the mode is ours (L3, again).
	"packages/web/src/permission-mode.tsx",
];

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
	for (const root of SEARCHED_ROOTS) {
		for (const path of sourceFiles(join(repositoryRoot, root))) {
			const repositoryRelative = path.slice(repositoryRoot.length + 1);
			if (VENDOR_ROOTS.some((vendorRoot) => repositoryRelative.startsWith(`${vendorRoot}/`))) continue;
			if (allowed.includes(repositoryRelative)) continue;
			for (const [lineIndex, line] of readFileSync(path, "utf8").split("\n").entries()) {
				// Code, not prose: a comment may name picc to say why a guard exists.
				if (COMMENT_LINE.test(line)) continue;
				if (pattern.test(line)) offenders.push(`${repositoryRelative}:${lineIndex + 1}`);
			}
		}
	}
	return offenders;
}

test("⚠ @earendil-works/* is imported only by the host and the pi extensions (#145)", () => {
	expect(offendersMatching(VENDOR_IMPORT, VENDOR_IMPORT_ALLOWED)).toEqual([]);
});

test("⚠ a vendor extension is named in code only there — the allowlist is the leak inventory (#145)", () => {
	expect(offendersMatching(VENDOR_NAMED, VENDOR_NAMED_ALLOWED)).toEqual([]);
});
