import { expect, test } from "bun:test";
import {
	describeRunContext,
	latestRunContext,
	readZenRunContext,
	runContextChanged,
	ZEN_RUN_CONTEXT_CUSTOM_TYPE,
	type ZenRunContext,
} from "../run-context.ts";

/**
 * The conditions a run happened under (#126), as they cross pi's log. Read defensively and
 * walked last-wins, for the same reason picc's mode is: `/fork`, `/tree` and `/branch` move
 * the leaf, and a branch's conditions are the newest record ON THAT BRANCH.
 */

function record(overrides: Partial<ZenRunContext> = {}): ZenRunContext {
	return {
		version: 1,
		at: "2026-09-10T12:00:00.000Z",
		revision: { commit: "a".repeat(40), branch: "main", dirty: false },
		context: { paths: ["AGENTS.md"], digest: "d1" },
		skills: [],
		harness: { configDigest: "c1" },
		...overrides,
	};
}

const entry = (data: unknown, customType = ZEN_RUN_CONTEXT_CUSTOM_TYPE): unknown => ({
	type: "custom",
	customType,
	timestamp: "2026-09-10T12:00:00.000Z",
	data,
});

test("an entry that is not ours, is malformed, or is a version this reader does not know, reads as nothing", () => {
	expect(readZenRunContext(entry(record(), "modes"))).toBeUndefined();
	expect(readZenRunContext(entry({ ...record(), version: 2 }))).toBeUndefined();
	expect(readZenRunContext(entry({ version: 1, at: "now" }))).toBeUndefined();
	expect(readZenRunContext(entry(null))).toBeUndefined();
	expect(readZenRunContext(undefined)).toBeUndefined();
	// …and the real thing reads back whole.
	expect(readZenRunContext(entry(record()))).toEqual(record());
});

test("⚠ the LAST record on the branch wins — a fork moves the leaf, so the newest entry is the branch's own", () => {
	const older = record({ at: "2026-09-10T10:00:00.000Z", revision: { commit: "b".repeat(40) } });
	const newer = record({ at: "2026-09-10T11:00:00.000Z", revision: { commit: "c".repeat(40) } });
	const branch = [entry(older), { type: "message" }, entry(newer), { type: "message" }];
	expect(latestRunContext(branch)?.revision.commit).toBe("c".repeat(40));
	// A branch with none — an older thread, or one that has not run — says so rather than guessing.
	expect(latestRunContext([{ type: "message" }, entry({ bad: true })])).toBeUndefined();
	expect(latestRunContext([])).toBeUndefined();
});

test("⚠ the append rule is CONDITIONS changed, not time passed — a long thread under one setup holds one entry", () => {
	const first = record();
	expect(runContextChanged(undefined, first)).toBe(true);
	// A later run, everything the same but the clock: nothing to say.
	expect(runContextChanged(first, record({ at: "2026-09-10T23:59:00.000Z" }))).toBe(false);
	// Each recorded condition on its own is a change worth an entry.
	expect(runContextChanged(first, record({ revision: { commit: "e".repeat(40), branch: "main", dirty: false } }))).toBe(
		true,
	);
	expect(runContextChanged(first, record({ revision: { commit: "a".repeat(40), branch: "main", dirty: true } }))).toBe(
		true,
	);
	expect(runContextChanged(first, record({ context: { paths: ["AGENTS.md"], digest: "d2" } }))).toBe(true);
	expect(runContextChanged(first, record({ skills: ["fallow"] }))).toBe(true);
	expect(runContextChanged(first, record({ harness: { configDigest: "c2" } }))).toBe(true);
});

test("the one-line description names the tree, the context and the skills, and says when dirtiness is unknown", () => {
	expect(describeRunContext(record())).toBe("aaaaaaaaaaaa (main) · 1 context file d1 · 0 skills");
	expect(describeRunContext(record({ revision: { commit: "b".repeat(40), branch: "main", dirty: true } }))).toContain(
		"dirty",
	);
	// git could not be consulted: said, not guessed as clean.
	expect(describeRunContext(record({ revision: { commit: "b".repeat(40), branch: "main" } }))).toContain(
		"dirtiness unknown",
	);
	expect(describeRunContext(record({ revision: { commit: "unknown (no .git)" } }))).toContain("no checkout");
});
