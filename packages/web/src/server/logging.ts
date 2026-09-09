import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { getRotatingFileSink } from "@logtape/file";
import {
	configure,
	dispose,
	getConsoleSink,
	getJsonLinesFormatter,
	type LogLevel,
	type Sink,
	withFilter,
} from "@logtape/logtape";
import { redactByField } from "@logtape/redaction";
import { ZEN_LOG_ROOT, ZEN_REDACT_FIELDS } from "@zen/core";

/**
 * A process's one sink (#132 item 2): a size-rotated JSONL file under `.zen/logs`, every
 * record redacted by field name before it is written, and — for a terminal — a console
 * sink beside it at its own level.
 *
 * Called by a LAUNCHER (`dev.ts`, `dev-web.ts`), never by `startZenServer`: a library configures
 * nothing, so a test that starts the server sees no output it did not ask for, and a test
 * that wants the records installs `@logtape/testing`'s recorder in its own `configure`.
 *
 * ⚠ Blocking and UNBUFFERED, on purpose — measured, not assumed (the first live receipt).
 * LogTape's blocking file sink has no flush timer: `flushInterval` belongs to the
 * non-blocking sink alone, and the buffered blocking sink flushes only when the NEXT record
 * arrives or on dispose. A record over 200 bytes — every one of ours with properties — sat
 * in the buffer until something else was logged; `web.jsonl` stayed empty for minutes after
 * its banner. For a debugging log that is the wrong property exactly when it matters: the
 * last record before a hang is the one you need, and it would be the one not on disk. So
 * `bufferSize: 0` — each record is one `writeSync` + `flushSync` when the call returns. Our
 * volume is tens of records per run, not thousands; the syscall pair is the price of the
 * file being the record.
 *
 * Why not `nonBlocking`: its failures are reported on the meta logger too (2.3.4, contrary
 * to its doc), but a background flush can lose the tail on a crash, and a synchronous
 * `writeSync` that throws is caught by LogTape and reported on `["logtape", "meta"]` at
 * `fatal`, bypassing the sink that failed — routed to the console here, so a full disk is
 * seen, not silent.
 */

export interface ProcessLoggingOptions {
	/** `zenLogsDir(repoRoot)` — created if absent. */
	readonly logsDir: string;
	/** This process's file under it — `server.jsonl`, `web.jsonl`; one per process, never shared. */
	readonly file: string;
	/** Lowest level that also reaches the terminal; omit for the file alone. */
	readonly console?: LogLevel;
}

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_FILES = 5;

/** Configure the process; resolves to the disposer that flushes and closes the file. */
export async function configureProcessLogging(options: ProcessLoggingOptions): Promise<() => Promise<void>> {
	mkdirSync(options.logsDir, { recursive: true });
	const file: Sink = redactByField(
		getRotatingFileSink(join(options.logsDir, options.file), {
			// The template as the message and the values as properties — an event name a bundle
			// can filter on, not a sentence with the values rendered into it.
			formatter: getJsonLinesFormatter({ message: "template" }),
			maxSize: MAX_FILE_BYTES,
			maxFiles: MAX_FILES,
			bufferSize: 0,
		}),
		[...ZEN_REDACT_FIELDS],
	);
	const sinks: Record<string, Sink> = { file };
	const zenSinks = ["file"];
	const metaSinks: string[] = [];
	if (options.console !== undefined) {
		sinks.console = withFilter(getConsoleSink(), options.console);
		zenSinks.push("console");
		metaSinks.push("console");
	}
	await configure({
		sinks,
		loggers: [
			{ category: [ZEN_LOG_ROOT], lowestLevel: "debug", sinks: zenSinks },
			// LogTape's own reports — a sink that threw, a misconfiguration. Never to the file
			// that may be the thing failing.
			{ category: ["logtape", "meta"], lowestLevel: "warning", sinks: metaSinks },
		],
		contextLocalStorage: new AsyncLocalStorage(),
	});
	return dispose;
}
