import { type ZenBrowserLogBatch, ZenBrowserLogBatch as ZenBrowserLogBatchSchema, zenLogger } from "@zen/core";
import { Check } from "typebox/value";

/**
 * `POST /api/logs` (#132 slice 3): the browser's records, into the one file. Each record is
 * re-emitted through this process's logger under the browser's own category
 * (`zen.browser.follow`), at its level, with `process: "browser"`, the tab's `page`, and
 * `at` — the browser's clock; the line's `@timestamp` is this server's receipt. So the file
 * has every layer, the same sink redacts every layer, and `bun run logs --process browser`
 * finds them.
 *
 * ⚠ Bounded, and never a source of its own records. The body is capped and the batch is a
 * closed schema (200 records, `zen.browser.*` only, a message length); a bad batch is a 400
 * that says why and is NOT logged — a page in a loop sending garbage would otherwise write
 * its garbage here at one line per attempt. The browser drops a failed POST for the same
 * reason (`browser-logging.ts`).
 */

export const MAX_LOG_BODY_BYTES = 256 * 1024;

export type LogsRouteOutcome =
	| { readonly status: 204 }
	| { readonly status: 400; readonly reason: string }
	| { readonly status: 413; readonly reason: string };

/** The layer's root, so a batch is re-emitted under it and never under another layer's. */
const BROWSER_CATEGORY_PREFIX = "zen.browser";

export function receiveBrowserLogs(body: string): LogsRouteOutcome {
	if (body.length > MAX_LOG_BODY_BYTES)
		return { status: 413, reason: `a log batch is at most ${MAX_LOG_BODY_BYTES} bytes` };
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return { status: 400, reason: "a log batch is JSON" };
	}
	if (!Check(ZenBrowserLogBatchSchema, parsed))
		return { status: 400, reason: "a log batch must match ZenBrowserLogBatch" };
	const batch: ZenBrowserLogBatch = parsed;
	for (const record of batch.records) {
		const subcategory = record.logger.slice(BROWSER_CATEGORY_PREFIX.length + 1);
		const log = zenLogger("browser", ...(subcategory.length === 0 ? [] : subcategory.split(".")));
		const properties = { ...record.properties, process: "browser", page: batch.page, at: record.at };
		if (record.level === "error") log.error(record.message, properties);
		else if (record.level === "warning") log.warn(record.message, properties);
		else log.info(record.message, properties);
	}
	return { status: 204 };
}
