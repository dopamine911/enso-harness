import { mkdtempSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { createSessionReadTracker } from "../read-tracker.ts";

const root = mkdtempSync(join(tmpdir(), "zen-read-tracker-"));

/** Move a file's mtime one full second forward — unambiguous at any stat resolution. */
function touchForward(filePath: string): void {
	const later = new Date(Date.now() + 1000);
	utimesSync(filePath, later, later);
}

test("a recorded path is fresh; an unrecorded one is unknown", () => {
	const tracker = createSessionReadTracker();
	const filePath = join(root, "known.ts");
	writeFileSync(filePath, "content");
	tracker.recordKnownPath(filePath);
	expect(tracker.classifyPath(filePath)).toBe("fresh");
	expect(tracker.classifyPath(join(root, "never-seen.ts"))).toBe("unknown");
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
	expect(tracker.classifyPath(realFile)).toBe("fresh");
	expect(tracker.classifyPath(link)).toBe("fresh");
});

// --- #11: the stamp notices a file changing underneath the session
test("an mtime moved by an external touch classifies as stale", () => {
	const tracker = createSessionReadTracker();
	const filePath = join(root, "touched.ts");
	writeFileSync(filePath, "content");
	tracker.recordKnownPath(filePath);
	touchForward(filePath);
	expect(tracker.classifyPath(filePath)).toBe("stale");
});

test("a size change classifies as stale even when mtime is pinned back", () => {
	const tracker = createSessionReadTracker();
	const filePath = join(root, "resized.ts");
	writeFileSync(filePath, "content");
	tracker.recordKnownPath(filePath);
	// ⚠ The deliberately-hostile shape: append, then force mtime back to hide the write.
	// Size is the second leg of the stamp precisely so this cannot pass as fresh.
	const recordedMtime = statSync(filePath).mtime;
	writeFileSync(filePath, "content plus external growth");
	utimesSync(filePath, recordedMtime, recordedMtime);
	expect(tracker.classifyPath(filePath)).toBe("stale");
});

test("re-recording after an external change makes the path fresh again", () => {
	const tracker = createSessionReadTracker();
	const filePath = join(root, "re-read.ts");
	writeFileSync(filePath, "content");
	tracker.recordKnownPath(filePath);
	touchForward(filePath);
	expect(tracker.classifyPath(filePath)).toBe("stale");
	tracker.recordKnownPath(filePath);
	expect(tracker.classifyPath(filePath)).toBe("fresh");
});

// A path that cannot be statted records NOTHING — an unstamped entry could never be
// classified, so the record must not exist at all.
test("recording a non-existent path records nothing", () => {
	const tracker = createSessionReadTracker();
	const ghost = join(root, "never-created.ts");
	tracker.recordKnownPath(ghost);
	expect(tracker.classifyPath(ghost)).toBe("unknown");
});

test("reset forgets everything", () => {
	const tracker = createSessionReadTracker();
	const filePath = join(root, "forgotten.ts");
	writeFileSync(filePath, "content");
	tracker.recordKnownPath(filePath);
	tracker.reset();
	expect(tracker.classifyPath(filePath)).toBe("unknown");
});
