import { AsyncLocalStorage } from "node:async_hooks";
import { configure, reset } from "@logtape/logtape";
import { createLogRecorder, type LogRecorder } from "@logtape/testing/recorder";
import { ZEN_LOG_ROOT } from "@zen/core";

/**
 * The test's sink (#132): every `zen` record, at every level, into memory — assert on the
 * event and its properties, the way a bundle reader would. Replaces the `problems: unknown[]`
 * arrays the `onProblem` seams fed: a module logs through `zenLogger` at module level, so
 * there is nothing to inject, and this is how a test hears it.
 *
 * `reset: true` because every test file runs in one bun process: the second file's
 * `configure` replaces the first's, whose recorder is finished with by then. The meta logger
 * is routed nowhere so LogTape's own notes never leak into a test's output.
 */
export async function recordZenLogs(): Promise<LogRecorder> {
	const recorder = createLogRecorder();
	await configure({
		reset: true,
		sinks: { recorder: recorder.sink },
		loggers: [
			{ category: [ZEN_LOG_ROOT], lowestLevel: "trace", sinks: ["recorder"] },
			{ category: ["logtape", "meta"], sinks: [] },
		],
		contextLocalStorage: new AsyncLocalStorage(),
	});
	return recorder;
}

/** Back to "no configuration, no logs" for whatever runs next in the process. */
export const releaseZenLogs: () => Promise<void> = reset;
