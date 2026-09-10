import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { reset } from "@logtape/logtape";
import { zenLogger } from "@zen/core";
import { isLoggingConfigured, zenLogFilename } from "@zen/core/log-process";
import { recordZenLogs, releaseZenLogs } from "../../__tests__/log-recorder.ts";
import { createLoggingExtension } from "../index.ts";

/**
 * The extension's two branches (#132): pi as a CHILD configures its own sink; pi IN-PROCESS
 * leaves the server's alone. `ZEN_LOGS_DIR` keeps the child's file out of the checkout.
 */

/** A pi whose only surface is `on`, recording what the extension registered. */
type Handler = (event: unknown) => unknown;
function fakePi(): { pi: ExtensionAPI; handlers: Map<string, Handler> } {
	const handlers = new Map<string, Handler>();
	const pi = {
		on: (event: string, handler: Handler): Map<string, Handler> => handlers.set(event, handler),
	} as unknown as ExtensionAPI;
	return { pi, handlers };
}

afterEach(reset);

test("⚠ pi as a child: nothing has configured, so the extension does — its own record lands as process pi, and session_shutdown flushes", async () => {
	await reset();
	expect(isLoggingConfigured()).toBe(false);
	const logsDir = mkdtempSync(join(tmpdir(), "zen-ext-logs-"));
	const { pi, handlers } = fakePi();
	await createLoggingExtension({ ZEN_LOGS_DIR: logsDir, ZEN_LOG_LEVEL: "debug" })(pi);
	expect(isLoggingConfigured()).toBe(true);
	const shutdown = handlers.get("session_shutdown");
	if (shutdown === undefined) throw new Error("the extension registered no session_shutdown handler");
	await shutdown({ type: "session_shutdown", reason: "quit" });
	const lines = readFileSync(join(logsDir, zenLogFilename(new Date())), "utf8")
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as { message?: string; properties?: Record<string, unknown> });
	expect(lines.map((line) => line.properties?.process)).toEqual(["pi", "pi"]);
	expect(lines[1]?.message).toBe("configured by the extension: pi is a child process");
});

test("pi in-process: the server configured first, so the extension registers nothing and replaces nothing", async () => {
	const logs = await recordZenLogs();
	const { pi, handlers } = fakePi();
	await createLoggingExtension({ ZEN_LOGS_DIR: mkdtempSync(join(tmpdir(), "zen-ext-unused-")) })(pi);
	expect(handlers.size).toBe(0);
	// Still the server's sink: a record goes to the recorder, not to a file of the extension's.
	zenLogger("extension", "probe").info("still the server's");
	logs.assertLogged({ message: "still the server's" });
	await releaseZenLogs();
});
