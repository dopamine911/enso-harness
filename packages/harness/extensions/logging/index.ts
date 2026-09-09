import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findRepoRoot, zenLogger } from "@zen/core";
import { configureProcessLogging, isLoggingConfigured, logsDirFrom, parseZenLogLevels } from "@zen/core/log-process";

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
export function createLoggingExtension(
	environment: Readonly<Record<string, string | undefined>>,
): (pi: ExtensionAPI) => Promise<void> {
	return async (pi: ExtensionAPI): Promise<void> => {
		if (isLoggingConfigured()) return;
		const disposeLogging = await configureProcessLogging({
			logsDir: logsDirFrom(environment, findRepoRoot(import.meta.url)),
			process: "pi",
			levels: parseZenLogLevels(environment, { console: undefined }),
		});
		zenLogger("extension", "logging").debug("configured by the extension: pi is a child process");
		pi.on("session_shutdown", async (): Promise<void> => {
			await disposeLogging();
		});
	};
}

/** The pi entry point: this process's environment. Tests build one with an environment of their own. */
export default createLoggingExtension(process.env);
