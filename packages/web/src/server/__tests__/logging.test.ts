import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withZenLogContext, ZenLogLine, zenLogger } from "@zen/core";
import { Check } from "typebox/value";
import { releaseZenLogs } from "../../__tests__/log-recorder.ts";
import { configureProcessLogging } from "../logging.ts";

/**
 * The file a user hands us (#132), end to end through the real configurator: what a line
 * looks like, what never reaches it, and what every line under a route carries.
 */

afterEach(releaseZenLogs);

test("⚠ the JSONL file: every line validates ZenLogLine; a secret-shaped field is gone and its VALUE appears nowhere; the route's threadId is on a record that never named it", async () => {
	const logsDir = mkdtempSync(join(tmpdir(), "zen-logs-"));
	const dispose = await configureProcessLogging({ logsDir, file: "server.jsonl" });
	const log = zenLogger("server", "probe");

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
	// web.jsonl minutes after its banner); the last record before a hang is the one that matters.
	const file = join(logsDir, "server.jsonl");
	expect(
		readFileSync(file, "utf8")
			.split("\n")
			.filter((line) => line.length > 0),
	).toHaveLength(1);

	// … and one outside it carries a secret-shaped name whose value must never land.
	log.warn("a refusal named the key", { threadId: "t-plain", tavilyApiKey: "tvly-MUST-NOT-LAND", reason: "denied" });
	await dispose();

	const lines = readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line.length > 0);
	expect(lines).toHaveLength(2);
	const text = lines.join("\n");
	expect(text).not.toContain("MUST-NOT-LAND");

	const parsed = lines.map((line) => JSON.parse(line) as unknown);
	for (const record of parsed) expect(Check(ZenLogLine, record)).toBe(true);
	const [underRoute, refusal] = parsed as ZenLogLine[];

	// Implicit context: the route's threadId is on the record; its own properties stay. The
	// message is the TEMPLATE — the event, not its values — so a bundle can filter on it.
	expect(underRoute?.logger).toBe("zen.server.probe");
	expect(underRoute?.level).toBe("INFO");
	expect(underRoute?.message).toBe("something under the route happened: {detail}");
	expect(underRoute?.properties).toMatchObject({ threadId: "t-ctx", toolCallId: "c1" });
	// `tokens` is on ZEN_REDACT_FIELDS by design (token) — dropped, and the test says so.
	expect(underRoute?.properties).not.toHaveProperty("tokens");

	// Redaction at write: the field is absent; the rest of the record is intact.
	expect(refusal?.level).toBe("WARN");
	expect(refusal?.properties).toEqual({ threadId: "t-plain", reason: "denied" });
	expect(refusal?.message).toBe("a refusal named the key");
});

test("a second configure in the same process is refused — one configurator per process, or it is a bug", async () => {
	const logsDir = mkdtempSync(join(tmpdir(), "zen-logs-"));
	await configureProcessLogging({ logsDir, file: "server.jsonl" });
	await expect(configureProcessLogging({ logsDir, file: "web.jsonl" })).rejects.toThrow();
});
