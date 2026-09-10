import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleRecordsText, type PiSession, ZEN_REDACTED, type ZenLogLine } from "@zen/core";
import { parseZenLogLine, zenLogFilename } from "@zen/core/log-process";
import type { HostedSession } from "../../host/agent-host.ts";
import { createEventTail } from "../../host/event-tail.ts";
import { BUNDLE_MAX_RECORDS, createBundleRoute, describeCheckout } from "../bundle-route.ts";
import type { ThreadView } from "../thread-registry.ts";

const ignore = (): void => undefined;

/** A live thread as the registry would list it — the inspection is what the bundle carries. */
function liveThread(threadId: string): ThreadView {
	const session: PiSession = {
		prompt: ignore,
		answerDialog: ignore,
		openDialogs: () => [],
		listCommands: () => [],
		permissionModeState: () => ({ mode: "plan", available: ["default", "plan"] }),
		subscribe: () => ignore,
		abort: () => Promise.resolve(),
		clearQueue: () => ({ steering: [], followUp: [] }),
		dispose: ignore,
	};
	const hosted: HostedSession = {
		session,
		loadedExtensionPaths: [],
		inspect: () => ({
			sessionId: `session-${threadId}`,
			cwd: "/work",
			sessionDir: "/sessions",
			sessionFile: null,
			entries: [],
			commands: ["plan"],
		}),
		emittedEvents: () => [],
	};
	return {
		threadId,
		hosted,
		busy: false,
		generation: 1,
		lastActivityAt: Date.parse("2026-09-10T01:00:00Z"),
		sent: createEventTail(),
	};
}

const line = (threadId: string, message: string, extra: Record<string, unknown> = {}): ZenLogLine => ({
	"@timestamp": "2026-09-10T01:00:00.000Z",
	level: "INFO",
	logger: "zen.server.events",
	message,
	properties: { process: "server", sequence: 1, threadId, ...extra },
});

const DAY = new Date("2026-09-10T12:00:00");

function logsDirWith(lines: readonly (ZenLogLine | string)[]): string {
	const logsDir = mkdtempSync(join(tmpdir(), "zen-bundle-"));
	writeFileSync(
		join(logsDir, zenLogFilename(DAY)),
		`${lines.map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry))).join("\n")}\n`,
	);
	return logsDir;
}

test("the bundle is today's records for the thread, its live inspection, and the versions — readable back through the same parser", () => {
	const logsDir = logsDirWith([
		line("t1", "run {generation} acquired", { generation: 1 }),
		line("t2", "run {generation} acquired", { generation: 1 }),
		line("t1", "prompt refused", { tavilyApiKey: ZEN_REDACTED }),
	]);
	const route = createBundleRoute({
		threads: { list: () => [liveThread("t1"), liveThread("t2")] },
		logsDir,
		now: () => DAY,
	});
	const { filename, body } = route(new URLSearchParams("thread=t1"));

	expect(filename).toBe("zen-bundle-2026-09-10-t1.md");
	const records = bundleRecordsText(body)
		.split("\n")
		.map((raw) => parseZenLogLine(raw));
	expect(records.map((record) => (typeof record === "string" ? record : record.properties?.threadId))).toEqual([
		"t1",
		"t1",
	]);
	expect(body).toContain("### thread t1");
	expect(body).not.toContain("### thread t2");
	expect(body).toContain("- `tavilyApiKey` × 1");
	expect(body).toContain("- pi: `");
	expect(body).toContain("selection: thread t1 from today's file (zen-2026-09-10.jsonl");
});

test("[WARN] no thread: every record and every live thread; the cap keeps the NEWEST and the heading says so", () => {
	const many: ZenLogLine[] = [];
	for (let sequence = 0; sequence < BUNDLE_MAX_RECORDS + 3; sequence += 1) {
		many.push(line("t1", "record {sequence}", { sequence }));
	}
	const route = createBundleRoute({
		threads: { list: () => [liveThread("t1")] },
		logsDir: logsDirWith(many),
		now: () => DAY,
	});
	const { filename, body } = route(new URLSearchParams());

	expect(filename).toBe("zen-bundle-2026-09-10.md");
	expect(body).toContain(`## log — the last ${BUNDLE_MAX_RECORDS} of ${BUNDLE_MAX_RECORDS + 3} records`);
	const records = bundleRecordsText(body).split("\n");
	expect(records).toHaveLength(BUNDLE_MAX_RECORDS);
	// The oldest three fell off the front, not the back.
	expect(records[0]).toContain('"sequence":3');
});

test("a missing file and a malformed line are said in the selection, never silently absent", () => {
	const empty = mkdtempSync(join(tmpdir(), "zen-bundle-empty-"));
	const route = createBundleRoute({ threads: { list: () => [] }, logsDir: empty, now: () => DAY });
	expect(route(new URLSearchParams()).body).toContain("does not exist yet: no process has logged today");

	const torn = createBundleRoute({
		threads: { list: () => [] },
		logsDir: logsDirWith([line("t1", "ok"), "{not json", JSON.stringify({ level: "INFO" })]),
		now: () => DAY,
	});
	const body = torn(new URLSearchParams()).body;
	expect(body).toContain("2 line(s) of it were not records and are left out");
	expect(body).toContain("## log — 1 records");
	expect(body).toContain("none live at the time of the bundle");
});

test("the checkout is described from .git by hand: a branch ref, a detached head, and no checkout at all", () => {
	const repo = mkdtempSync(join(tmpdir(), "zen-checkout-"));
	expect(describeCheckout(repo)).toBe("unknown (no .git)");

	mkdirSync(join(repo, ".git", "refs", "heads", "feat"), { recursive: true });
	writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/feat/x\n");
	writeFileSync(join(repo, ".git", "refs", "heads", "feat", "x"), "0123456789abcdef0123456789abcdef01234567\n");
	expect(describeCheckout(repo)).toBe("0123456789ab (feat/x)");

	// A packed ref (after `git gc`): the loose file is gone, the row in packed-refs remains.
	rmSync(join(repo, ".git", "refs", "heads", "feat", "x"));
	writeFileSync(
		join(repo, ".git", "packed-refs"),
		"# pack-refs\nabcdefabcdefabcdefabcdefabcdefabcdefabcd refs/heads/feat/x\n",
	);
	expect(describeCheckout(repo)).toBe("abcdefabcdef (feat/x)");

	writeFileSync(join(repo, ".git", "HEAD"), "fedcba9876543210fedcba9876543210fedcba98\n");
	expect(describeCheckout(repo)).toBe("fedcba987654");
});
