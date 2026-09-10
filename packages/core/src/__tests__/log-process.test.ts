import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reset } from "@logtape/logtape";
import { Check } from "typebox/value";
import { withZenLogContext, ZEN_REDACTED, ZEN_REDACTED_VALUE, ZenLogLine, zenLogger } from "../log.ts";
import { redactionManifest } from "../log-bundle.ts";
import {
	configureProcessLogging,
	effectiveFileLevel,
	logRecordOf,
	parseZenLogLevels,
	ZenLogLevelError,
	zenLogFilename,
	zenLogLineRenderer,
} from "../log-process.ts";

/**
 * The file a user hands us (#132), end to end through the real configurator: what a line
 * looks like, what never reaches it, what every line under a route carries — and the knob.
 */

afterEach(reset);

const linesOf = (file: string): string[] =>
	readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line.length > 0);

test("⚠ the JSONL file: every line validates ZenLogLine; a secret-shaped field is gone and its VALUE appears nowhere; the route's threadId is on a record that never named it", async () => {
	const logsDir = mkdtempSync(join(tmpdir(), "zen-logs-"));
	const dispose = await configureProcessLogging({ logsDir, process: "server" });
	const log = zenLogger("server", "probe");
	const file = join(logsDir, zenLogFilename(new Date()));
	// The first record is the configuration itself.
	expect(linesOf(file)).toHaveLength(1);

	withZenLogContext({ threadId: "t-ctx" }, () => {
		// A module deep under the route logs with no threadId of its own …
		log.info("something under the route happened: {detail}", {
			toolCallId: "c1",
			tokens: 4653,
			detail: "x".repeat(300), // over the sink's 200-byte immediate-write path on purpose
		});
	});
	// ⚠ On disk when the call returns — no second record, no dispose. The buffered blocking
	// sink held a long record until the NEXT one arrived (the first live receipt: an empty
	// file minutes after its banner); the last record before a hang is the one that matters.
	expect(linesOf(file)).toHaveLength(2);

	// … and one outside it carries a secret-shaped name whose value must never land.
	log.warn("a refusal named the key", { threadId: "t-plain", tavilyApiKey: "tvly-MUST-NOT-LAND", reason: "denied" });
	await dispose();

	const lines = linesOf(file);
	expect(lines).toHaveLength(3);
	expect(lines.join("\n")).not.toContain("MUST-NOT-LAND");

	const parsed = lines.map((line) => JSON.parse(line) as unknown);
	for (const record of parsed) expect(Check(ZenLogLine, record)).toBe(true);
	const [configured, underRoute, refusal] = parsed as ZenLogLine[];
	expect(configured?.properties).toMatchObject({ process: "server", sequence: 1, file: "info", console: "off" });
	// Who wrote this file, and since when (#144): a shared file makes "the processes" mean
	// "who has written today", and liveness is then inferable from the last write.
	expect(configured?.properties?.pid).toBe(process.pid);
	const startedAt = new Date(String(configured?.properties?.startedAt));
	expect(Number.isNaN(startedAt.getTime())).toBe(false);
	expect(startedAt.getTime()).toBeLessThanOrEqual(Date.now());
	expect(startedAt.getTime()).toBeGreaterThan(Date.now() - 60 * 60 * 1000);

	// Implicit context: the route's threadId is on the record; its own properties stay. The
	// message is the TEMPLATE — the event, not its values — so a bundle can filter on it.
	expect(underRoute?.logger).toBe("zen.server.probe");
	expect(underRoute?.level).toBe("INFO");
	expect(underRoute?.message).toBe("something under the route happened: {detail}");
	expect(underRoute?.properties).toMatchObject({ process: "server", sequence: 2, threadId: "t-ctx", toolCallId: "c1" });
	// `tokens` is on ZEN_REDACT_FIELDS by design (token) — a marker, and the test says so.
	expect(underRoute?.properties?.tokens).toBe(ZEN_REDACTED);

	// Redaction at write: the field is a MARKER — the reader knows it was there — and its value is gone.
	expect(refusal?.level).toBe("WARN");
	expect(refusal?.properties).toEqual({
		process: "server",
		sequence: 3,
		threadId: "t-plain",
		tavilyApiKey: ZEN_REDACTED,
		reason: "denied",
	});
	expect(refusal?.message).toBe("a refusal named the key");
});

test("⚠ the terminal is redacted too: a secret-shaped property never reaches console output (#134 review)", async () => {
	// The pretty formatter renders properties; a bare console sink would print the value.
	const printed: string[] = [];
	const spy = spyOn(console, "info").mockImplementation((...parts: unknown[]) => {
		printed.push(parts.map(String).join(" "));
	});
	try {
		const logsDir = mkdtempSync(join(tmpdir(), "zen-logs-"));
		const dispose = await configureProcessLogging({
			logsDir,
			process: "server",
			levels: { file: "info", console: "info", overrides: [] },
		});
		zenLogger("server", "probe").info("a refusal named the key: {reason}", {
			tavilyApiKey: "tvly-MUST-NOT-PRINT",
			reason: "denied",
		});
		await dispose();
	} finally {
		spy.mockRestore();
	}
	expect(printed.length).toBeGreaterThan(0);
	expect(printed.join("\n")).toContain("denied");
	expect(printed.join("\n")).not.toContain("MUST-NOT-PRINT");
});

test("⚠ two processes, one file: every line lands whole — the property the dated, unbuffered, O_APPEND design rests on", async () => {
	const logsDir = mkdtempSync(join(tmpdir(), "zen-logs-"));
	const child = join(logsDir, "writer.ts");
	writeFileSync(
		child,
		[
			// By path: the script lives in a tmpdir, outside the workspace's module resolution.
			`import { zenLogger } from ${JSON.stringify(join(import.meta.dir, "..", "log.ts"))};`,
			`import { configureProcessLogging } from ${JSON.stringify(join(import.meta.dir, "..", "log-process.ts"))};`,
			`const dispose = await configureProcessLogging({ logsDir: ${JSON.stringify(logsDir)}, process: process.argv[2] });`,
			`const log = zenLogger("server", "writer");`,
			`for (let i = 0; i < 200; i++) log.info("line {i} from {who}: {pad}", { i, who: process.argv[2], pad: "x".repeat(600) });`,
			`await dispose();`,
		].join("\n"),
	);
	const spawn = (who: string) =>
		Bun.spawn(["bun", child, who], { cwd: join(import.meta.dir, ".."), stdout: "ignore", stderr: "pipe" });
	const [alpha, bravo] = [spawn("alpha"), spawn("bravo")];
	expect(await Promise.all([alpha.exited, bravo.exited])).toEqual([0, 0]);
	// ⚠ `bun test` runs in UTC; the children run in the machine's zone and name the file by
	// their local day (as the launchers do), so read whatever day file they made.
	const written = readdirSync(logsDir).filter((name) => /^zen-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name));
	expect(written).toHaveLength(1);
	const parsed = linesOf(join(logsDir, written[0] ?? "")).map((line) => JSON.parse(line) as ZenLogLine);
	expect(parsed.every((record) => Check(ZenLogLine, record))).toBe(true);
	// 200 records + the configuration record, per process.
	expect(parsed.filter((record) => record.properties?.process === "alpha")).toHaveLength(201);
	expect(parsed.filter((record) => record.properties?.process === "bravo")).toHaveLength(201);
});

test("a second configure in the same process is refused — one configurator per process, or it is a bug", async () => {
	const logsDir = mkdtempSync(join(tmpdir(), "zen-logs-"));
	await configureProcessLogging({ logsDir, process: "server" });
	await expect(configureProcessLogging({ logsDir, process: "web" })).rejects.toThrow();
});

// ── reading the file back ─────────────────────────────────────────────────────────────

test("a line reads back as the record it was: the template's placeholders take their values; one with no value stays literal; WARN is warning", () => {
	const record = logRecordOf({
		"@timestamp": "2026-09-09T23:41:22.799Z",
		level: "WARN",
		message: "{toolName} denied: {reason} — {absent}",
		logger: "zen.extension.guards",
		properties: { toolName: "write", reason: "outside the root", threadId: "t1" },
	});
	expect(record.category).toEqual(["zen", "extension", "guards"]);
	expect(record.level).toBe("warning");
	expect(record.timestamp).toBe(Date.parse("2026-09-09T23:41:22.799Z"));
	expect(record.message).toEqual(["", "write", " denied: ", "outside the root", " — ", "{absent}", ""]);
	expect(record.rawMessage).toBe("{toolName} denied: {reason} — {absent}");
	// Rendered by the terminal's formatter: the values in the sentence, no braces left.
	const rendered = zenLogLineRenderer({ wordWrap: false })({
		"@timestamp": "2026-09-09T23:41:22.799Z",
		level: "INFO",
		message: "run {generation} acquired",
		logger: "zen.server.threads",
		properties: { generation: 1 },
	}).replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");
	expect(rendered).toContain("run 1 acquired");
	expect(rendered).not.toContain("{generation}");
});

// ── the knob ──────────────────────────────────────────────────────────────────────────

test("ZEN_LOG_LEVEL: a tier, optional per-category overrides; ZEN_LOG_CONSOLE its own; the launcher's console default otherwise", () => {
	expect(parseZenLogLevels({}, { console: "info" })).toEqual({ file: "info", console: "info", overrides: [] });
	expect(parseZenLogLevels({ ZEN_LOG_LEVEL: "trace", ZEN_LOG_CONSOLE: "warn" }, { console: "info" })).toEqual({
		file: "trace",
		console: "warning",
		overrides: [],
	});
	expect(
		parseZenLogLevels(
			{ ZEN_LOG_LEVEL: "info, zen.host.events=trace ,zen.extension.guards=debug" },
			{ console: undefined },
		),
	).toEqual({
		file: "info",
		console: undefined,
		overrides: [
			{ category: ["zen", "host", "events"], level: "trace" },
			{ category: ["zen", "extension", "guards"], level: "debug" },
		],
	});
});

test("⚠ a knob value that is not a level is a startup error naming it — never a silent default", () => {
	expect(() => parseZenLogLevels({ ZEN_LOG_LEVEL: "verbose" }, { console: undefined })).toThrow(ZenLogLevelError);
	expect(() => parseZenLogLevels({ ZEN_LOG_LEVEL: "info,host.events=trace" }, { console: undefined })).toThrow(
		/host\.events=trace/,
	);
	expect(() => parseZenLogLevels({ ZEN_LOG_CONSOLE: "loud" }, { console: undefined })).toThrow(
		/ZEN_LOG_CONSOLE="loud"/,
	);
});

test("the effective level is the longest matching override, else the file's", () => {
	const levels = parseZenLogLevels(
		{ ZEN_LOG_LEVEL: "info,zen.host=debug,zen.host.events=trace" },
		{ console: undefined },
	);
	expect(effectiveFileLevel(levels, ["zen", "server", "http"])).toBe("info");
	expect(effectiveFileLevel(levels, ["zen", "host"])).toBe("debug");
	expect(effectiveFileLevel(levels, ["zen", "host", "ui"])).toBe("debug");
	expect(effectiveFileLevel(levels, ["zen", "host", "events"])).toBe("trace");
	expect(effectiveFileLevel(levels, ["zen", "host", "events", "deep"])).toBe("trace");
});

test("⚠ the file holds the tier the knob picked: at info a debug line is not written; with the subtree turned up, it is — and the console's level is its own", async () => {
	const logsDir = mkdtempSync(join(tmpdir(), "zen-logs-"));
	const dispose = await configureProcessLogging({
		logsDir,
		process: "server",
		levels: parseZenLogLevels({ ZEN_LOG_LEVEL: "info,zen.host.events=trace" }, { console: undefined }),
	});
	zenLogger("server", "http").debug("not written");
	zenLogger("server", "http").info("written");
	zenLogger("host", "events").trace("written too, the subtree is up");
	zenLogger("host", "ui").debug("not written, a sibling subtree");
	await dispose();
	const messages = linesOf(join(logsDir, zenLogFilename(new Date()))).map(
		(line) => (JSON.parse(line) as ZenLogLine).message,
	);
	expect(messages.slice(1)).toEqual(["written", "written too, the subtree is up"]);
});

// #139: the gap #132 accepted. Redaction by field NAME cannot see a secret quoted inside a
// message, inside an innocently-named property, or inside a `trace` payload — and those are
// exactly the shapes a guard's `reason` and a tool's output take.
test("⚠ a known secret VALUE is scrubbed wherever it appears: in the message, in a plainly-named property, inside a trace payload (#139)", async () => {
	const logsDir = mkdtempSync(join(tmpdir(), "zen-logs-values-"));
	const secret = "tvly-LIVE-VALUE-MUST-NOT-LAND";
	const dispose = await configureProcessLogging({
		logsDir,
		process: "server",
		levels: { file: "trace", console: undefined, overrides: [] },
		secretValues: [secret],
	});
	const log = zenLogger("server", "probe");
	// 1. quoted in the message itself — no property to name.
	log.info(`a command was refused: curl -H "x-key: ${secret}" https://example.com`);
	// 2. inside a property whose name is not secret-shaped: a guard's reason, a path.
	log.warn("bash command refused: {reason}", { reason: `the command carried --token ${secret}`, threadId: "t1" });
	// 3. inside a nested payload, which is what `trace` writes.
	log.trace("tool-result payload", { observation: { kind: "tool-result", text: `KEY=${secret}\n`, isError: false } });
	await dispose();

	const text = readFileSync(join(logsDir, zenLogFilename(new Date())), "utf8");
	expect(text).not.toContain("LIVE-VALUE-MUST-NOT-LAND");
	// Present, and counted as a value redaction rather than a field one — the manifest tells a
	// reader that something leaked and was caught, not that a field was shaped right.
	const lines = linesOf(join(logsDir, zenLogFilename(new Date()))).map((line) => JSON.parse(line) as ZenLogLine);
	for (const line of lines) expect(Check(ZenLogLine, line)).toBe(true);
	expect(redactionManifest(lines).values).toBe(3);
	// The rest of each record survives: this is a replacement, not a dropped record.
	expect(text).toContain("https://example.com");
	expect(text).toContain(ZEN_REDACTED_VALUE);
});

test("with no known values the pass does not run — an ordinary record is untouched", async () => {
	const logsDir = mkdtempSync(join(tmpdir(), "zen-logs-novalues-"));
	const dispose = await configureProcessLogging({ logsDir, process: "server" });
	zenLogger("server", "probe").info("nothing to scrub here");
	await dispose();
	expect(readFileSync(join(logsDir, zenLogFilename(new Date())), "utf8")).toContain("nothing to scrub here");
});
