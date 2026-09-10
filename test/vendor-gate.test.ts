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
 * It reads WORDS, not substrings (PR #150 review): the line is split on non-alphanumerics and
 * on `camelCase`, so `readPiccPersistedMode`, `PICC_PERMISSION_MODES` and `.cc-safety-net` all
 * count as the same mention. The two narrower matchers tried before each let a live site
 * through — `\b` missed the `_` form, a both-sides lookaround missed the camelCase one — and
 * a boundary that cannot see a dependency is not a boundary. `pickle` and `piccolo` are not
 * picc: a word is the unit.
 *
 * What it still cannot catch, said up front: it is a line scan, not a type checker.
 * `ZenThreadInspection.entries: unknown[]` carries pi's persistence format with no import and
 * no vendor name in it (goals L2). That needs a transcript type of ours; a third test —
 * vendor-prefixed identifiers outside the host, the naming gate's trick — keeps it fixed once
 * it is. A vendor name assembled at runtime (`"pi" + "cc"`) is out of reach by construction.
 *
 * `COMMENT_LINE` reads one line at a time, so a block comment whose continuation lines do not
 * lead with `*` is scanned as code (PR #150 review). That direction is the safe one: the gate
 * FAILS on prose rather than passing a dependency, and the fix is to write the comment in the
 * house style the whole repo already uses. A skip that tracked block state could hide a real
 * import inside an unterminated comment; this cannot.
 */

const repositoryRoot = join(import.meta.dir, "..");
const SEARCHED_ROOTS = ["packages/core/src", "packages/web/src", "packages/harness"] as const;
/** Where the vendor may be named. Removing one of these is a design conversation. */
const VENDOR_ROOTS = ["packages/web/src/host", "packages/harness/extensions"] as const;
const SKIPPED_DIRECTORIES = ["node_modules", "dist", "dist-types", "coverage", "__tests__"] as const;
const SOURCE_EXTENSION = /\.tsx?$/;
/** A line that is only a comment: `//`, a block opener, or a block's `*`-led body. */
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;
/**
 * pi and its libraries, by package scope — in ANY string that names it, not only a
 * `from "…"` clause (PR #150 review): `import("@earendil-works/…")` and
 * `import.meta.resolve("@earendil-works/…")` are the same dependency by another spelling.
 */
const VENDOR_IMPORT = /["']@earendil-works\//;
/**
 * The words a line is made of, with `camelCase` split: `readPiccPersistedMode` is
 * `read | picc | persisted | mode`, `PICC_PERMISSION_MODES` is `picc | permission | modes`,
 * `.cc-safety-net` is `cc | safety | net`. Matching WORDS rather than substrings is what
 * catches a vendor name embedded mid-identifier — a lookaround requiring a non-alphanumeric
 * on both sides never fires inside `readPiccPersistedMode` (PR #150 review found it live).
 */
function wordsOf(line: string): string[] {
	const words: string[] = [];
	for (const token of line.match(/[A-Za-z0-9]+/g) ?? []) {
		words.push(...(token.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z0-9]+|[0-9]+/g) ?? []).map((word) => word.toLowerCase()));
	}
	return words;
}

/** One word is the whole name. */
const VENDOR_WORD = "picc";
/** …and the ones spelled in several words, however they are joined (`cc-safety-net`, `ccSafetyNet`). */
const VENDOR_WORD_SEQUENCES = [
	["cc", "safety", "net"],
	["pi", "multi", "account"],
] as const;

function namesVendor(line: string): boolean {
	const words = wordsOf(line);
	if (words.includes(VENDOR_WORD)) return true;
	return VENDOR_WORD_SEQUENCES.some((sequence) =>
		words.some((_word, start) => sequence.every((part, offset) => words[start + offset] === part)),
	);
}

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
	// The dropdown reads the persisted mode through `readPiccPersistedMode` and says whose
	// default a fresh thread starts in. The call leaves with L3; the sentence stops being true
	// the same day.
	"packages/web/src/permission-mode.tsx",
	// The status line's second reader of the same persisted entry (`readPiccPersistedMode`) —
	// found by the widened matcher, not by the first one (PR #150 review). Leaves with L3.
	"packages/web/src/mode-lines.ts",
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

function offendersMatching(names: (line: string) => boolean, allowed: readonly string[]): string[] {
	const offenders: string[] = [];
	for (const root of SEARCHED_ROOTS) {
		for (const path of sourceFiles(join(repositoryRoot, root))) {
			const repositoryRelative = path.slice(repositoryRoot.length + 1);
			if (VENDOR_ROOTS.some((vendorRoot) => repositoryRelative.startsWith(`${vendorRoot}/`))) continue;
			if (allowed.includes(repositoryRelative)) continue;
			for (const [lineIndex, line] of readFileSync(path, "utf8").split("\n").entries()) {
				// Code, not prose: a comment may name picc to say why a guard exists.
				if (COMMENT_LINE.test(line)) continue;
				if (names(line)) offenders.push(`${repositoryRelative}:${lineIndex + 1}`);
			}
		}
	}
	return offenders;
}

test("⚠ @earendil-works/* is named only by the host and the pi extensions (#145)", () => {
	expect(offendersMatching((line) => VENDOR_IMPORT.test(line), VENDOR_IMPORT_ALLOWED)).toEqual([]);
});

test("⚠ a vendor extension is named in code only there — the allowlist is the leak inventory (#145)", () => {
	expect(offendersMatching(namesVendor, VENDOR_NAMED_ALLOWED)).toEqual([]);
});

// The gate can only be a ratchet if its matcher sees what a reader would call a mention. The
// first two rows are the ones a `\b` boundary and a both-sides lookaround each missed.
test("the matcher reads words, not substrings: a vendor name counts wherever it is spelled", () => {
	for (const line of [
		"import { readPiccPersistedMode } from '@zen/core';", // camelCase — missed by lookarounds
		"export const PICC_PERMISSION_MODES = [] as const;", // `_` bounded — missed by \b
		'const dirs = [".cc-safety-net"];',
		"const config = ccSafetyNetConfig;",
		"await loadPiMultiAccount();",
		"a fresh thread starts in picc's default",
	]) {
		expect(namesVendor(line)).toBe(true);
	}
	// Words that merely share a prefix are not the vendor.
	for (const line of ["const piccolo = 1;", "import { pick } from './x.ts';", "const netSafetyCc = 2;"]) {
		expect(namesVendor(line)).toBe(false);
	}
});
