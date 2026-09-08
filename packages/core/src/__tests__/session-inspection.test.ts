import { expect, test } from "bun:test";
import {
	describeSessionEntry,
	describeThreadEvent,
	isZenThreadId,
	threadEventColumns,
	type ZenThreadEvent,
} from "../session-inspection.ts";

// The row formats are shared by the `?debug` drawer and `zen-session.mjs` (PR #100 review: one
// definition, after the #86 pair had drifted). What a human reads off either surface is pinned here.

test("a branch entry row: time, type, custom type, message role, and picc's mode when the entry is one", () => {
	expect(
		describeSessionEntry({
			type: "custom",
			customType: "modes",
			timestamp: "2026-09-08T12:34:56.000Z",
			data: { mode: "plan" },
		}),
	).toBe("12:34:56 custom:modes mode=plan");
	expect(
		describeSessionEntry({ type: "message", timestamp: "2026-09-08T12:34:56.000Z", message: { role: "user" } }),
	).toBe("12:34:56 message user");
	// Missing fields read as absent, never as "undefined"; a non-object is shown as itself.
	expect(describeSessionEntry({ type: "model_change" })).toBe("model_change");
	expect(describeSessionEntry({})).toBe("?");
	expect(describeSessionEntry(42)).toBe("42");
});

// The id names a FILE (#95): what a filesystem could read is out; what the browser mints is in.
test("a thread id is a UUID or the like — never a path, never a flag, never unbounded", () => {
	expect(isZenThreadId(crypto.randomUUID())).toBe(true);
	expect(isZenThreadId("stored-1")).toBe(true);
	expect(isZenThreadId("a".repeat(64))).toBe(true);
	expect(isZenThreadId("a".repeat(65))).toBe(false);
	expect(isZenThreadId("")).toBe(false);
	expect(isZenThreadId("../../evil")).toBe(false);
	expect(isZenThreadId("with space")).toBe(false);
	expect(isZenThreadId("a.b")).toBe(false);
	expect(isZenThreadId("-flag")).toBe(false);
	expect(isZenThreadId(42)).toBe(false);
});

function threadEvent(overrides: Partial<ZenThreadEvent>): ZenThreadEvent {
	return {
		sequence: 1,
		type: "entry_appended",
		provenance: "live",
		at: "2026-09-08T12:34:56.000Z",
		count: 1,
		...overrides,
	};
}

// The provenance IS the finding — a `held` or `dropped` row is what an ordering bug looks like — so
// every row must show it, and a coalesced row its count, or the tail hides what it was built to show.
test("an event row names its provenance, its coalesced count, and the inner name when there is one", () => {
	expect(describeThreadEvent(threadEvent({ provenance: "held", count: 3, name: "modes" }))).toBe(
		"12:34:56 held ×3 entry_appended modes",
	);
	expect(describeThreadEvent(threadEvent({ type: "RUN_STARTED", provenance: "sent" }))).toBe(
		"12:34:56 sent RUN_STARTED",
	);
	// The columns are what a table lays out: the count rides with the provenance, the name with the type.
	expect(threadEventColumns(threadEvent({ provenance: "held", count: 3, name: "modes" }))).toEqual({
		when: "12:34:56",
		provenance: "held ×3",
		subject: "entry_appended modes",
	});
});
