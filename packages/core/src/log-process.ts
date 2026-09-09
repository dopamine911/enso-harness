import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync } from "node:fs";
import { getTimeRotatingFileSink } from "@logtape/file";
import {
	compareLogLevel,
	configure,
	dispose,
	getConfig,
	getConsoleSink,
	getJsonLinesFormatter,
	getLogger,
	isLogLevel,
	type LogLevel,
	type LogRecord,
	type Sink,
	withFilter,
} from "@logtape/logtape";
import { getPrettyFormatter } from "@logtape/pretty";
import { redactByField } from "@logtape/redaction";
import { ZEN_LOG_ROOT, ZEN_REDACT_FIELDS } from "./log.ts";

/**
 * A process's sink (#132 item 2): ONE log for the harness — `.zen/logs/zen-YYYY-MM-DD.jsonl`,
 * every process appending to the same day's file, every record redacted by field name
 * before it is written, and — for a terminal — a pretty console sink beside it at its own
 * level. And THE KNOB: `ZEN_LOG_LEVEL` picks the tier the file holds, per subsystem if
 * wanted; `ZEN_LOG_CONSOLE` the terminal's.
 *
 * Called by a LAUNCHER (`dev.ts`, `dev-web.ts`, the harness extension when pi is a child),
 * never by `startZenServer`: a library configures nothing, so a test that starts the server
 * sees no output it did not ask for, and a test that wants the records installs
 * `@logtape/testing`'s recorder in its own `configure`.
 *
 * ⚠ Imported as `@zen/core/log-process`, NEVER from the barrel. `@logtape/file` builds its
 * sinks at module evaluation (`createFileSinks()` on `node:fs`), so it is not tree-shaken
 * the way `paths.ts`'s unused `node:fs` is — exported from `index.ts` it took the page down
 * (`ReferenceError: import_node_fs4 is not defined`, the slice-2 receipt). The barrel stays
 * browser-safe; this module is for processes with a filesystem.
 *
 * ⚠ One file, several processes — so the file is named by DATE, never rotated by size. The
 * sink opens with `O_APPEND` and (below) writes each record in one `writeSync`, which is
 * safe for any number of writers: every line lands whole at the end (measured: two
 * processes, 400 records each, 800 lines, none torn). A size-rotated file is not: rotation
 * RENAMES the file under the other process, whose descriptor then points at the rotated
 * copy and keeps writing there. Date-named files are never renamed; each process computes
 * the same name for the same day. `process` is on every record so the writer is still
 * known, and `sequence` — a per-process count — orders two of one process's records inside
 * one millisecond. Old days are deleted by age.
 *
 * ⚠ Blocking and UNBUFFERED, on purpose — measured, not assumed (the first live receipt).
 * LogTape's blocking file sink has no flush timer: `flushInterval` belongs to the
 * non-blocking sink alone, and the buffered blocking sink flushes only when the NEXT record
 * arrives or on dispose. A record over 200 bytes — every one of ours with properties — sat
 * in the buffer until something else was logged; the web launcher's file stayed empty for
 * minutes after its banner. For a debugging log that is the wrong property exactly when it
 * matters: the last record before a hang is the one you need, and it would be the one not
 * on disk. So `bufferSize: 0` — each record is one `writeSync` + `flushSync` when the call
 * returns. Our volume is tens of records per run at `info`, hundreds at `trace`; the
 * syscall pair is the price of the file being the record.
 *
 * Why not `nonBlocking`: its failures are reported on the meta logger too (2.3.4, contrary
 * to its doc), but a background flush can lose the tail on a crash, and a synchronous
 * `writeSync` that throws is caught by LogTape and reported on `["logtape", "meta"]` at
 * `fatal`, bypassing the sink that failed — routed to the console here, so a full disk is
 * seen, not silent.
 */

/** A per-category override: `zen.host.events=trace` turns one subtree up without the rest. */
export interface ZenLogOverride {
	readonly category: readonly string[];
	readonly level: LogLevel;
}

export interface ZenLogLevels {
	/** The file's lowest level for everything under `zen` not named by an override. */
	readonly file: LogLevel;
	/** The terminal's; undefined for no console sink. Global — overrides are for the file. */
	readonly console: LogLevel | undefined;
	readonly overrides: readonly ZenLogOverride[];
}

/** The tier every process starts in: the spine, and what went wrong. */
export const DEFAULT_FILE_LEVEL: LogLevel = "info";

/** A knob value that is not a level. Thrown at startup, naming the value — never a silent default. */
export class ZenLogLevelError extends Error {
	constructor(variable: string, value: string) {
		super(
			`${variable}=${JSON.stringify(value)} is not a log level. Use one of trace, debug, info, warning, error, fatal; ` +
				`per-category overrides as \`info,zen.host.events=trace\`.`,
		);
		this.name = "ZenLogLevelError";
	}
}

/**
 * The knobs, from the environment a launcher was started with:
 *   ZEN_LOG_LEVEL="info"                              — the file's tier (default `info`)
 *   ZEN_LOG_LEVEL="info,zen.host.events=trace"        — plus one subtree turned up
 *   ZEN_LOG_CONSOLE="warning"                          — the terminal's (the launcher's default otherwise)
 * `warn` is accepted for `warning`, since that is what `ZenLogger` calls it.
 */
export function parseZenLogLevels(
	environment: Readonly<Record<string, string | undefined>>,
	defaults: { readonly console: LogLevel | undefined },
): ZenLogLevels {
	let file: LogLevel = DEFAULT_FILE_LEVEL;
	const overrides: ZenLogOverride[] = [];
	const levelValue = environment.ZEN_LOG_LEVEL;
	if (levelValue !== undefined && levelValue.trim().length > 0) {
		for (const token of levelValue.split(",")) {
			const part = token.trim();
			if (part.length === 0) continue;
			const separator = part.indexOf("=");
			if (separator === -1) {
				file = levelOf("ZEN_LOG_LEVEL", part);
				continue;
			}
			const category = part.slice(0, separator).trim().split(".");
			if (category[0] !== ZEN_LOG_ROOT || category.some((segment) => segment.length === 0)) {
				throw new ZenLogLevelError("ZEN_LOG_LEVEL", part);
			}
			overrides.push({ category, level: levelOf("ZEN_LOG_LEVEL", part.slice(separator + 1)) });
		}
	}
	const consoleValue = environment.ZEN_LOG_CONSOLE;
	const console =
		consoleValue === undefined || consoleValue.trim().length === 0
			? defaults.console
			: levelOf("ZEN_LOG_CONSOLE", consoleValue);
	return { file, console, overrides };
}

function levelOf(variable: string, raw: string): LogLevel {
	const value = raw.trim().toLowerCase();
	const level = value === "warn" ? "warning" : value;
	if (!isLogLevel(level)) throw new ZenLogLevelError(variable, raw);
	return level;
}

/**
 * The level a record's category must reach to be written: the longest override prefix that
 * matches, else the file's level. `["zen","host","events"]` is matched by an override on
 * `zen.host.events`, then `zen.host`, then `zen`.
 */
export function effectiveFileLevel(levels: ZenLogLevels, category: readonly string[]): LogLevel {
	let best: ZenLogOverride | undefined;
	for (const override of levels.overrides) {
		if (override.category.length > category.length) continue;
		if (best !== undefined && override.category.length <= best.category.length) continue;
		if (override.category.every((segment, index) => category[index] === segment)) best = override;
	}
	return best?.level ?? levels.file;
}

/** The lowest of every configured level — what the logger tree must let through for the sinks to choose. */
function lowestOf(levels: ZenLogLevels): LogLevel {
	let lowest: LogLevel = levels.file;
	for (const candidate of [levels.console, ...levels.overrides.map((override) => override.level)]) {
		if (candidate !== undefined && compareLogLevel(candidate, lowest) < 0) lowest = candidate;
	}
	return lowest;
}

export interface ProcessLoggingOptions {
	/** `zenLogsDir(repoRoot)` — created if absent. */
	readonly logsDir: string;
	/** Which launcher this is — `server`, `web`, `pi` — on every record it writes, since the file is shared. */
	readonly process: string;
	/** From `parseZenLogLevels`; the defaults when omitted: file `info`, no console. */
	readonly levels?: ZenLogLevels;
}

/** `zen-2026-09-09.jsonl`: the harness's one log for that day. */
export function zenLogFilename(date: Date): string {
	return `zen-${date.toISOString().slice(0, 10)}.jsonl`;
}

const ZEN_LOG_FILENAME = /^zen-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const KEEP_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

/** True once some configurator has run in this process — pi in-process shares the server's. */
export function isLoggingConfigured(): boolean {
	return getConfig() !== null;
}

/** Configure the process; resolves to the disposer that flushes and closes the file. */
export async function configureProcessLogging(options: ProcessLoggingOptions): Promise<() => Promise<void>> {
	const levels: ZenLogLevels = options.levels ?? { file: DEFAULT_FILE_LEVEL, console: undefined, overrides: [] };
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
	// The writer and its count on every record, since the file is shared. First, so a
	// record's own `process`, should one ever carry it, wins.
	let written = 0;
	const stamped: Sink = (record: LogRecord) => {
		written += 1;
		fileSink({ ...record, properties: { process: options.process, sequence: written, ...record.properties } });
	};
	const file: Sink = withFilter(
		stamped,
		(record: LogRecord) => compareLogLevel(record.level, effectiveFileLevel(levels, record.category)) >= 0,
	);
	// ⚠ Redaction wraps EVERY output, not the file alone. The terminal renders properties too
	// (the pretty formatter, `properties: true`), and a secret-shaped value on stdout is the
	// same leak with a different reader — the #134 review caught the console sink bare.
	// Each sink is wrapped on its own so LogTape's per-sink error containment still holds.
	const sinks: Record<string, Sink> = { file: redactByField(file, [...ZEN_REDACT_FIELDS]) };
	const zenSinks = ["file"];
	const metaSinks: string[] = [];
	if (levels.console !== undefined) {
		const pretty = getConsoleSink({
			formatter: getPrettyFormatter({ timestamp: "time", properties: true, categoryWidth: 24 }),
		});
		sinks.console = redactByField(withFilter(pretty, levels.console), [...ZEN_REDACT_FIELDS]);
		zenSinks.push("console");
		metaSinks.push("console");
	}
	await configure({
		sinks,
		loggers: [
			// The tree lets the lowest configured level through; each sink's filter decides.
			{ category: [ZEN_LOG_ROOT], lowestLevel: lowestOf(levels), sinks: zenSinks },
			// LogTape's own reports — a sink that threw, a misconfiguration. Never to the file
			// that may be the thing failing.
			{ category: ["logtape", "meta"], lowestLevel: "warning", sinks: metaSinks },
		],
		contextLocalStorage: new AsyncLocalStorage(),
	});
	// The first record: what this process will and will not write, so a bundle that lacks
	// the debug lines says why.
	getLogger([ZEN_LOG_ROOT, "log"]).info("logging configured: file {file}, console {console}, overrides {overrides}", {
		file: levels.file,
		console: levels.console ?? "off",
		overrides: levels.overrides.map((override) => `${override.category.join(".")}=${override.level}`),
		logsDir: options.logsDir,
	});
	return dispose;
}
