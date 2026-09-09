import { getLogger, type Logger, withContext } from "@logtape/logtape";
import { type Static, Type } from "typebox";

/**
 * The harness's log record (#132): one shape for every process, so a bundle a user hands
 * us reads the same whichever layer wrote the line.
 *
 * LogTape is the substrate (the #132 assessment): a category tree, one sink per process
 * into one shared file, a record that keeps its values structured. What is OURS is here —
 * the layers, the properties every record carries when it can, and the one way to get a
 * logger. Nothing outside this file and the per-process configurators
 * (`web/server/logging.ts` and kin) imports `@logtape/*` directly;
 * `test/logging-gate.test.ts` holds that line.
 *
 * ⚠ Messages are EVENTS, not sentences with values baked in: `"prompt {messageId}
 * rejected: {reason}"` with `{ threadId, messageId, reason }`, never
 * `` `prompt ${messageId} rejected` ``. The placeholders render for a terminal; the
 * properties stay first-class for the file, so a bundle can be filtered by `threadId`
 * rather than grepped for it. A literal brace in a message IS a placeholder to LogTape —
 * do not put one there by accident.
 *
 * ⚠ "No configure, no logs." A logger from here is silent until its process calls a
 * configurator. That is the contract we want — a test that mounts a module never sees
 * output it did not ask for — and it is also a trap: a process that forgets to configure
 * logs nothing and says nothing. Every launcher configures first; the live receipt proves
 * the file exists.
 */

/** The process a record came from. `extension` is our code inside pi's process. */
export type ZenLogLayer = "server" | "host" | "extension" | "browser";

/**
 * What every record carries when it knows it. These are the identities the wire already
 * has (`ZenObservation`, #112) — a line that names them can be joined to the transcript,
 * the event tail (#97), and the other layers' lines about the same moment.
 */
export interface ZenLogProperties {
	readonly threadId?: string;
	/** The acquisition the record belongs to (`zen.run`, #109). */
	readonly generation?: number;
	/** The observation's sequence on the follow, where the record is about one (#112). */
	readonly seq?: number;
	readonly toolCallId?: string;
	readonly [key: string]: unknown;
}

/** The typed surface. Four levels — `trace` and `fatal` are not vocabulary here. */
export interface ZenLogger {
	debug(message: string, properties?: ZenLogProperties): void;
	info(message: string, properties?: ZenLogProperties): void;
	warn(message: string, properties?: ZenLogProperties): void;
	error(message: string, properties?: ZenLogProperties): void;
	/** A logger whose every record carries `properties` — bind `threadId` once per handler. */
	with(properties: ZenLogProperties): ZenLogger;
}

/** The root category. A configurator routes `["zen"]` and every layer inherits. */
export const ZEN_LOG_ROOT = "zen";

function wrap(logger: Logger): ZenLogger {
	return {
		debug(message: string, properties?: ZenLogProperties): void {
			logger.debug(message, properties);
		},
		info(message: string, properties?: ZenLogProperties): void {
			logger.info(message, properties);
		},
		warn(message: string, properties?: ZenLogProperties): void {
			logger.warn(message, properties);
		},
		error(message: string, properties?: ZenLogProperties): void {
			logger.error(message, properties);
		},
		with(properties: ZenLogProperties): ZenLogger {
			return wrap(logger.with(properties));
		},
	};
}

/**
 * The one way to get a logger: `zenLogger("server", "follow")` is the category
 * `["zen", "server", "follow"]`, a child of the layer, a grandchild of the root. Module
 * level, once per file.
 */
export function zenLogger(layer: ZenLogLayer, ...subcategory: readonly string[]): ZenLogger {
	return wrap(getLogger([ZEN_LOG_ROOT, layer, ...subcategory]));
}

/**
 * Every record emitted inside `callback` — by any logger, in any module it calls, across
 * its awaits — carries `properties` (LogTape's implicit context over `AsyncLocalStorage`).
 * Set once where the identity is known and nowhere else: a route handler binds
 * `{ threadId }`, the prompt route adds `{ generation }` after the acquire. ⚠ Only when the
 * process's configurator installed a `contextLocalStorage`; without one the properties are
 * silently absent — the browser has no `AsyncLocalStorage` and binds them explicitly.
 */
export function withZenLogContext<T>(properties: ZenLogProperties, callback: () => T): T {
	return withContext(properties, callback);
}

/**
 * Property NAMES whose values never reach a sink (#132 item 4). Redaction is at write —
 * the file on disk is already clean, which is the property a user-shareable artifact
 * needs. The canonical record this harness never rewrites is pi's session log, not this
 * file; this file is the export.
 *
 * The shape mirrors `secrets.ts`'s boundary (`*_API_KEY`, `*_TOKEN`, `*_SECRET`,
 * `*_PASSWORD`) case-insensitively for camelCase property names, plus `credential` — the
 * word the guard's own refusals use for the files it protects (`secretPathFragments`), so a
 * property carrying one is dropped by the same rule. ⚠ `token` is deliberate:
 * usage counts are named `input`/`output` here, and a property literally called `tokens`
 * is dropped by design — better a missing count than a leaked key. Not LogTape's
 * `DEFAULT_REDACT_FIELDS`: that list eats `key`, `auth`, and `email` too, which would drop
 * `threadKey`-shaped names and `author` from records that carry nothing secret.
 */
export const ZEN_REDACT_FIELDS: readonly RegExp[] = [/api[-_]?key/i, /secret/i, /password/i, /token/i, /credential/i];

/**
 * One line of the JSONL file, as LogTape's `jsonLinesFormatter` writes it — pinned here
 * so the bundle reader (#132 item 5) validates what it reads and a formatter change goes
 * red instead of silently reshaping the file. `logger` is the category joined by `.`;
 * `level` is upper-cased on disk and `warning` is written `WARN` (measured, LogTape 2.3.4).
 */
export const ZenLogLine = Type.Object(
	{
		"@timestamp": Type.String(),
		level: Type.Union([
			Type.Literal("TRACE"),
			Type.Literal("DEBUG"),
			Type.Literal("INFO"),
			Type.Literal("WARN"),
			Type.Literal("ERROR"),
			Type.Literal("FATAL"),
		]),
		message: Type.Optional(Type.String()),
		logger: Type.String(),
		properties: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	},
	{ additionalProperties: false },
);
export type ZenLogLine = Static<typeof ZenLogLine>;
