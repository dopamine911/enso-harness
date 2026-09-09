import { AsyncLocalStorage } from "node:async_hooks";
import { configure, type LogRecord, reset } from "@logtape/logtape";
import { createLogRecorder, type LogRecorder } from "@logtape/testing/recorder";
import { ZEN_LOG_ROOT } from "@zen/core";

/**
 * The extension tests' sink (#132): every `zen` record into memory, so an audit line or a
 * guard's verdict is asserted as the record it is, not as a line on stderr. `reset: true`
 * because every test file runs in one bun process.
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

export const releaseZenLogs: () => Promise<void> = reset;

/** The audit records an extension wrote — `audit: …` under `zen.extension.<name>`. */
export function auditRecords(recorder: LogRecorder, extension: string): readonly LogRecord[] {
	return recorder.filter({ category: [ZEN_LOG_ROOT, "extension", extension], rawMessage: /^audit:/ });
}
