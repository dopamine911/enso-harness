import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { createSessionReadTracker } from "../read-tracker.ts";

const root = mkdtempSync(join(tmpdir(), "zen-read-tracker-"));

test("a recorded path is known; an unrecorded one is not", () => {
	const tracker = createSessionReadTracker();
	const filePath = join(root, "known.ts");
	writeFileSync(filePath, "content");
	tracker.recordKnownPath(filePath);
	expect(tracker.isKnownPath(filePath)).toBe(true);
	expect(tracker.isKnownPath(join(root, "never-seen.ts"))).toBe(false);
});

// ⚠ Identity is the REALPATH: a read through a symlink and a write through the direct
// path (or the reverse) must count as the same file, or the precondition is spoofable
// by spelling.
test("a symlink spelling and the direct spelling are the same identity", () => {
	const tracker = createSessionReadTracker();
	const realFile = join(root, "real-target.ts");
	writeFileSync(realFile, "content");
	const link = join(root, "alias.ts");
	symlinkSync(realFile, link);
	tracker.recordKnownPath(link);
	expect(tracker.isKnownPath(realFile)).toBe(true);
	expect(tracker.isKnownPath(link)).toBe(true);
});

test("reset forgets everything", () => {
	const tracker = createSessionReadTracker();
	const filePath = join(root, "forgotten.ts");
	writeFileSync(filePath, "content");
	tracker.recordKnownPath(filePath);
	tracker.reset();
	expect(tracker.isKnownPath(filePath)).toBe(false);
});
