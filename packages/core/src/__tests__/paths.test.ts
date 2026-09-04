import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	findRepoRoot,
	harnessPackageDir,
	printHarnessDir,
	RepoRootNotFoundError,
	realpathOrSelf,
	webPackageDir,
	zenAgentDir,
} from "../paths.ts";

/**
 * `findRepoRoot` against tmp fixtures. ⚠ These fixtures double as the cwd-independence
 * proof: `bun test` runs with `process.cwd()` AT the zen-harness checkout — itself a
 * workspace root — so every assertion below that returns a TMP root would fail if the
 * walk consulted the cwd instead of the given file's ancestry.
 */

/** A fixture workspace root: package.json with `workspaces`, plus nested dirs. */
function makeWorkspaceFixture(): string {
	const root = mkdtempSync(join(tmpdir(), "zen-paths-fixture-"));
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", workspaces: ["packages/*"] }));
	mkdirSync(join(root, "packages", "harness", "extensions", "deep"), { recursive: true });
	writeFileSync(join(root, "packages", "harness", "extensions", "deep", "module.ts"), "export {};\n");
	return root;
}

test("finds the nearest ancestor whose package.json declares workspaces", () => {
	const root = makeWorkspaceFixture();
	const deepFile = join(root, "packages", "harness", "extensions", "deep", "module.ts");
	expect(realpathSync(findRepoRoot(deepFile))).toBe(realpathSync(root));
});

test("accepts a file:// URL, so callers can pass import.meta.url directly", () => {
	const root = makeWorkspaceFixture();
	const deepFile = join(root, "packages", "harness", "extensions", "deep", "module.ts");
	expect(realpathSync(findRepoRoot(pathToFileURL(deepFile).href))).toBe(realpathSync(root));
});

// ⚠ THE #59 TRAP, made to discriminate: the print harness (#20) runs extensions through a
// symlink mirror, and bun does NOT realpath import.meta.url through it (observed live,
// PR #58). Here the mirror lives inside a DIFFERENT workspace root, so a walk that skips
// the realpath finds the WRONG root — this test is red without realpath-first, not merely
// green with it (mutation-proven).
test("realpath FIRST: a symlinked mirror inside another workspace root still finds the REAL root", () => {
	const realRoot = makeWorkspaceFixture();
	const otherRoot = mkdtempSync(join(tmpdir(), "zen-paths-other-"));
	writeFileSync(join(otherRoot, "package.json"), JSON.stringify({ name: "other", workspaces: [] }));
	mkdirSync(join(otherRoot, "mirror"));
	symlinkSync(join(realRoot, "packages", "harness", "extensions"), join(otherRoot, "mirror", "extensions"), "dir");

	const throughMirror = join(otherRoot, "mirror", "extensions", "deep", "module.ts");
	expect(realpathSync(findRepoRoot(throughMirror))).toBe(realpathSync(realRoot));
});

test("a malformed package.json on the walk means keep walking, never a throw", () => {
	const root = makeWorkspaceFixture();
	const middle = join(root, "packages", "harness");
	writeFileSync(join(middle, "package.json"), "{ this is not json");
	const deepFile = join(root, "packages", "harness", "extensions", "deep", "module.ts");
	expect(realpathSync(findRepoRoot(deepFile))).toBe(realpathSync(root));
});

test("a package.json WITHOUT a workspaces field is not a root — the walk continues past it", () => {
	const root = makeWorkspaceFixture();
	const middle = join(root, "packages", "harness");
	writeFileSync(join(middle, "package.json"), JSON.stringify({ name: "zen-harness" }));
	const deepFile = join(root, "packages", "harness", "extensions", "deep", "module.ts");
	expect(realpathSync(findRepoRoot(deepFile))).toBe(realpathSync(root));
});

test("no workspace root anywhere above throws a NAMED error carrying the start path", () => {
	const orphanDir = mkdtempSync(join(tmpdir(), "zen-paths-orphan-"));
	const orphanFile = join(orphanDir, "module.ts");
	writeFileSync(orphanFile, "export {};\n");
	expect(() => findRepoRoot(orphanFile)).toThrow(RepoRootNotFoundError);
	expect(() => findRepoRoot(orphanFile)).toThrow(orphanFile);
});

test("realpathOrSelf returns the input unchanged for a path that does not exist", () => {
	expect(realpathOrSelf("/no/such/path/anywhere")).toBe("/no/such/path/anywhere");
});

test("the derived directories assemble from one root", () => {
	expect(zenAgentDir("/repo")).toBe("/repo/.zen/pi-agent");
	expect(printHarnessDir("/repo")).toBe("/repo/.zen/print-harness");
	expect(harnessPackageDir("/repo")).toBe("/repo/packages/harness");
	expect(webPackageDir("/repo")).toBe("/repo/packages/web");
});

test("this checkout's own root is findable from this test file", () => {
	const root = findRepoRoot(import.meta.url);
	expect(root.endsWith("zen-harness")).toBe(true);
});
