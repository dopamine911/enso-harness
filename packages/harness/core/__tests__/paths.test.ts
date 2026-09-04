import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { DEFAULT_GUARD_POLICY } from "@zen/core";
import { isInsideAnyRoot, isPersistenceWriteTarget, looksLikeSecret, resolveAgainstCwd } from "../paths.ts";

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

// ── #21: write-persistence vectors ────────────────────────────────────────────────────────

test("every shell-init basename is a persistence write target", () => {
	for (const name of [".bashrc", ".bash_profile", ".zshrc", ".zprofile", ".profile"]) {
		expect(isPersistenceWriteTarget(`/home/u/${name}`)).toBe(true);
	}
});

test("git config files are persistence write targets, wherever they live", () => {
	expect(isPersistenceWriteTarget("/home/u/.gitconfig")).toBe(true);
	expect(isPersistenceWriteTarget(join(root, ".gitmodules"))).toBe(true);
});

test("agent and tool config files are persistence write targets", () => {
	expect(isPersistenceWriteTarget("/home/u/.claude.json")).toBe(true);
	expect(isPersistenceWriteTarget(join(root, ".mcp.json"))).toBe(true);
	expect(isPersistenceWriteTarget(join(root, ".ripgreprc"))).toBe(true);
});

test("anything inside a dangerous directory is a persistence write target", () => {
	expect(isPersistenceWriteTarget(join(root, ".vscode", "tasks.json"))).toBe(true);
	expect(isPersistenceWriteTarget(join(root, ".idea", "workspace.xml"))).toBe(true);
	expect(isPersistenceWriteTarget(join(root, ".claude", "settings.json"))).toBe(true);
	expect(isPersistenceWriteTarget(join(root, ".git", "hooks", "pre-commit"))).toBe(true);
});

test("matching is case-insensitive, for case-folding filesystems", () => {
	expect(isPersistenceWriteTarget("/home/u/.BASHRC")).toBe(true);
	expect(isPersistenceWriteTarget(join(root, ".VSCode", "tasks.json"))).toBe(true);
});

// ⚠ Basename-ANCHORED, never fragment matching — the false-positive class the issue names.
test("a name merely containing a dangerous name is NOT caught", () => {
	expect(isPersistenceWriteTarget(join(root, ".profile-notes", "x.ts"))).toBe(false);
	expect(isPersistenceWriteTarget(join(root, "my.bashrc"))).toBe(false);
	expect(isPersistenceWriteTarget(join(root, "vscode-notes", "a.md"))).toBe(false);
	expect(isPersistenceWriteTarget(join(root, "src", "app.ts"))).toBe(false);
});

test("⚠ a symlink with an innocent name pointing at a shell-init file is caught", () => {
	// The write target EXISTS as a symlink; realpath reveals the true basename.
	const dotfiles = mkdtempSync(join(tmpdir(), "zen-dotfiles-"));
	writeFileSync(join(dotfiles, ".bashrc"), "# rc");
	const link = join(root, "innocent-notes.txt");
	symlinkSync(join(dotfiles, ".bashrc"), link);
	expect(isPersistenceWriteTarget(link)).toBe(true);
});

test("⚠ a NEW file through a symlinked directory that is really a dangerous dir is caught", () => {
	const agentConfigDir = mkdtempSync(join(tmpdir(), "zen-agent-"));
	const realClaude = join(agentConfigDir, ".claude");
	mkdirSync(realClaude);
	const link = join(root, "innocent-dir");
	symlinkSync(realClaude, link, "dir");
	// settings.json does not exist yet — the nearest existing ancestor is the symlink.
	expect(isPersistenceWriteTarget(join(link, "settings.json"))).toBe(true);
});
