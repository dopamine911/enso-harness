import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync } from "node:fs";
import { getTimeRotatingFileSink } from "@logtape/file";
import {
	configure,
	dispose,
	getConsoleSink,
	getJsonLinesFormatter,
	type LogLevel,
	type LogRecord,
	type Sink,
	withFilter,
} from "@logtape/logtape";
import { getPrettyFormatter } from "@logtape/pretty";
import { redactByField } from "@logtape/redaction";
import { ZEN_LOG_ROOT, ZEN_REDACT_FIELDS } from "@zen/core";

/**
 * A process's sink (#132 item 2): ONE log for the harness — `.zen/logs/zen-YYYY-MM-DD.jsonl`,
 * every process appending to the same day's file, every record redacted by field name
 * before it is written, and — for a terminal — a pretty console sink beside it at its own
 * level.
 *
 * Called by a LAUNCHER (`dev.ts`, `dev-web.ts`), never by `startZenServer`: a library
 * configures nothing, so a test that starts the server sees no output it did not ask for,
 * and a test that wants the records installs `@logtape/testing`'s recorder in its own
 * `configure`.
 *
 * ⚠ One file, several processes — so the file is named by DATE, never rotated by size. The
 * sink opens with `O_APPEND` and (below) writes each record in one `writeSync`, which is
 * safe for any number of writers: every line lands whole at the end. A size-rotated file is
 * not: rotation RENAMES the file under the other process, whose descriptor then points at
 * the rotated copy and keeps writing there. Date-named files are never renamed; each
 * process computes the same name for the same day. `process` is on every record so the
 * writer is still known. Old days are deleted by age.
 *
 * ⚠ Blocking and UNBUFFERED, on purpose — measured, not assumed (the first live receipt).
 * LogTape's blocking file sink has no flush timer: `flushInterval` belongs to the
 * non-blocking sink alone, and the buffered blocking sink flushes only when the NEXT record
 * arrives or on dispose. A record over 200 bytes — every one of ours with properties — sat
 * in the buffer until something else was logged; the web launcher's file stayed empty for
 * minutes after its banner. For a debugging log that is the wrong property exactly when it
 * matters: the last record before a hang is the one you need, and it would be the one not
 * on disk. So `bufferSize: 0` — each record is one `writeSync` + `flushSync` when the call
 * returns. Our volume is tens of records per run, not thousands; the syscall pair is the
 * price of the file being the record.
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
	/** Which launcher this is — `server`, `web` — on every record it writes, since the file is shared. */
	readonly process: string;
	/** Lowest level that also reaches the terminal; omit for the file alone. */
	readonly console?: LogLevel;
}

/** `zen-2026-09-09.jsonl`: the harness's one log for that day. */
export function zenLogFilename(date: Date): string {
	return `zen-${date.toISOString().slice(0, 10)}.jsonl`;
}

const ZEN_LOG_FILENAME = /^zen-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const KEEP_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Configure the process; resolves to the disposer that flushes and closes the file. */
export async function configureProcessLogging(options: ProcessLoggingOptions): Promise<() => Promise<void>> {
	mkdirSync(options.logsDir, { recursive: true });
	const fileSink = getTimeRotatingFileSink({
		directory: options.logsDir,
		interval: "daily",
		filename: zenLogFilename,
		parseFilename: (filename: string): Date | null => {
			const day = ZEN_LOG_FILENAME.exec(filename)?.[1];
			return day === undefined ? null : new Date(`${day}T00:00:00Z`);
		},
		maxAgeMs: KEEP_DAYS * DAY_MS,
		// The template as the message and the values as properties — an event name a bundle
		// can filter on, not a sentence with the values rendered into it.
		formatter: getJsonLinesFormatter({ message: "template" }),
		bufferSize: 0,
	});
	// The writer, on every record, since the file is shared. First so a record's own
	// `process` property, should one ever carry it, wins.
	const stamped: Sink = (record: LogRecord) =>
		fileSink({ ...record, properties: { process: options.process, ...record.properties } });
	// ⚠ Redaction wraps EVERY output, not the file alone. The terminal renders properties too
	// (the pretty formatter, `properties: true`), and a secret-shaped value on stdout is the
	// same leak with a different reader — the #134 review caught the console sink bare.
	// Each sink is wrapped on its own so LogTape's per-sink error containment still holds.
	const sinks: Record<string, Sink> = { file: redactByField(stamped, [...ZEN_REDACT_FIELDS]) };
	const zenSinks = ["file"];
	const metaSinks: string[] = [];
	if (options.console !== undefined) {
		const pretty = getConsoleSink({
			formatter: getPrettyFormatter({ timestamp: "time", properties: true, categoryWidth: 24 }),
		});
		sinks.console = redactByField(withFilter(pretty, options.console), [...ZEN_REDACT_FIELDS]);
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
