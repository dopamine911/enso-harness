import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findRepoRoot, zenLogger, zenLogsDir } from "@zen/core";
import { configureProcessLogging, isLoggingConfigured, parseZenLogLevels } from "@zen/core/log-process";

/**
 * The extension process's logging (#132): FIRST in the harness manifest, so every
 * extension after it — guards, web-fetch, web-search — has a sink for its records.
 *
 * Two ways this code runs, one behaviour each:
 *   - in-process (the web host): the server's launcher configured logging before pi
 *     existed, and `isLoggingConfigured()` says so — this does nothing, and the
 *     extensions' records land in the server's file through the server's configure;
 *   - as a child (`zen.mjs` → pi): nothing has configured, so this configures — the same
 *     day's file as everyone else, `process: "pi"`, NO console sink (stderr is the TUI's).
 *
 * ⚠ Never configure when something already has: LogTape's `configure` throws on a second
 * call by design (one configurator per process, or it is a bug — `log-process.test.ts`),
 * and a `reset: true` here would silently replace the server's sinks with ours.
 *
 * The knobs are the same: `ZEN_LOG_LEVEL` for the file's tier, per-category overrides in
 * it; `ZEN_LOG_CONSOLE` is ignored here on purpose.
 */
export default async function logging(pi: ExtensionAPI): Promise<void> {
	if (isLoggingConfigured()) return;
	const repoRoot = findRepoRoot(import.meta.url);
	const disposeLogging = await configureProcessLogging({
		logsDir: zenLogsDir(repoRoot),
		process: "pi",
		levels: parseZenLogLevels(process.env, { console: undefined }),
	});
	zenLogger("extension", "logging").debug("configured by the extension: pi is a child process");
	pi.on("session_shutdown", async (): Promise<void> => {
		await disposeLogging();
	});
}
