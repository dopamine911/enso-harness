import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { DEFAULT_GUARD_POLICY } from "@zen/core";
import { isInsideAnyRoot, looksLikeSecret, resolveAgainstCwd } from "../paths.ts";

const root = mkdtempSync(join(tmpdir(), "zen-guard-"));
const outside = mkdtempSync(join(tmpdir(), "zen-outside-"));
mkdirSync(join(root, "src"), { recursive: true });
writeFileSync(join(outside, "target.txt"), "x");

test("a relative path inside the workspace is allowed", () => {
	const target = resolveAgainstCwd("src/app.ts", root);
	expect(isInsideAnyRoot(target, [root])).toBe(true);
});

test("an absolute path outside the workspace is refused", () => {
	const target = resolveAgainstCwd(join(outside, "app.ts"), root);
	expect(isInsideAnyRoot(target, [root])).toBe(false);
});

test("a ../ escape is refused", () => {
	const target = resolveAgainstCwd("../../etc/passwd", root);
	expect(isInsideAnyRoot(target, [root])).toBe(false);
});

test("a sibling directory sharing a name prefix is not 'inside'", () => {
	expect(isInsideAnyRoot(`${root}-evil/x.ts`, [root])).toBe(false);
});

test("⚠ a symlink inside the workspace pointing outside it is refused", () => {
	// The case a plain string-containment check lets through.
	const link = join(root, "escape");
	symlinkSync(outside, link, "dir");
	const target = resolveAgainstCwd("escape/target.txt", root);
	expect(target.startsWith(root)).toBe(true); // string check would pass
	expect(isInsideAnyRoot(target, [root])).toBe(false); // realpath check catches it
});

test("credential material is recognised by basename and by directory", () => {
	const f = DEFAULT_GUARD_POLICY.secretPathFragments;
	expect(looksLikeSecret("/home/u/project/.env", f)).toBe(true);
	expect(looksLikeSecret("/home/u/project/.env.production", f)).toBe(true);
	expect(looksLikeSecret("/home/u/.ssh/id_ed25519", f)).toBe(true);
	expect(looksLikeSecret("/home/u/.aws/credentials", f)).toBe(true);
	expect(looksLikeSecret("/home/u/certs/server.pem", f)).toBe(true);
	expect(looksLikeSecret("/home/u/project/src/env.ts", f)).toBe(false);
	expect(looksLikeSecret("/home/u/project/README.md", f)).toBe(false);
});
