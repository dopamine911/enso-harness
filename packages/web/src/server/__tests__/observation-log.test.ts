import { afterEach, expect, test } from "bun:test";
import type { LogRecord } from "@logtape/logtape";
import { recordZenLogs, releaseZenLogs } from "../../__tests__/log-recorder.ts";
import { recordObservation } from "../observation-log.ts";
import { noteRunAdmitted } from "../run-timing.ts";

/**
 * The tier an observation lands at, and the one record that is not an observation at all:
 * the run's time to first token (#144). The deltas themselves stay at `debug` — the text
 * is pi's session file, not this one — so this `info` line is the only thing at the spine's
 * tier that dates the first token.
 */

afterEach(releaseZenLogs);

function firstDeltaRecords(records: readonly LogRecord[]): readonly LogRecord[] {
	return records.filter((record) => String(record.rawMessage).includes("first delta"));
}

test("⚠ the first delta of a run is one info record with the latency; the rest stay debug deltas", async () => {
	const logs = await recordZenLogs();
	noteRunAdmitted("obs-t1", 1);
	for (const delta of ["he", "llo"]) {
		recordObservation("obs-t1", 1, 1, { kind: "text-delta", contentIndex: 0, delta });
	}
	const timing = firstDeltaRecords(logs.records);
	expect(timing).toHaveLength(1);
	expect(timing[0]?.level).toBe("info");
	expect(typeof timing[0]?.properties?.firstDeltaMs).toBe("number");
	expect(timing[0]?.properties).toMatchObject({ threadId: "obs-t1", generation: 1 });
	// The compact lines are unchanged: `debug`, a char count, never the text. (`{kind}` is the
	// compact line's own template; the `trace` twin says `{kind} payload` and carries the text.)
	const compact = logs.records.filter((record) => record.rawMessage === "{kind}");
	expect(compact.map((record) => record.level)).toEqual(["debug", "debug"]);
	expect(compact.map((record) => record.properties?.chars)).toEqual([2, 3]);
	expect(JSON.stringify(compact)).not.toContain("hello");
});

test("a run with no delta leaves nothing behind: after it settles, a late delta records no latency", async () => {
	const logs = await recordZenLogs();
	noteRunAdmitted("obs-t2", 4);
	recordObservation("obs-t2", 4, 9, { kind: "settled" });
	recordObservation("obs-t2", 4, 10, { kind: "text-delta", contentIndex: 0, delta: "x" });
	expect(firstDeltaRecords(logs.records)).toHaveLength(0);
});
