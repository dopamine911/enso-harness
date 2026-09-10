import { afterEach, expect, test } from "bun:test";
import { reset } from "@logtape/logtape";
import { ZenBrowserLogBatch, zenLogger } from "@zen/core";
import { Check } from "typebox/value";
import {
	configureBrowserLogging,
	createLogRing,
	createLogShipper,
	type FetchLike,
	pageLogLevel,
	SHIP_BATCH_SIZE,
} from "../browser-logging.ts";

/**
 * The page's logging (#132 slice 3): the ring the drawer reads, the shipper to the server,
 * and the `?log=` knob — driven through a real `configure`, asserted at the sinks.
 */

afterEach(reset);

interface Post {
	readonly url: string;
	readonly body: unknown;
	readonly keepalive: boolean | undefined;
}

/** A `fetch` that records every POST and answers as told; `nextPost` is the signal a test awaits. */
function recordingFetch(answer: () => Promise<Response> = () => Promise.resolve(new Response(null, { status: 204 }))): {
	fetch: FetchLike;
	posts: Post[];
	nextPost: () => Promise<Post>;
} {
	const posts: Post[] = [];
	let waiting: { promise: Promise<Post>; resolve: (post: Post) => void } | undefined;
	return {
		posts,
		nextPost: () => {
			waiting ??= Promise.withResolvers<Post>();
			return waiting.promise;
		},
		fetch: (url, init) => {
			const post: Post = { url, body: JSON.parse(String(init?.body)), keepalive: init?.keepalive };
			posts.push(post);
			waiting?.resolve(post);
			waiting = undefined;
			return answer();
		},
	};
}

test("the ring keeps the last N as lines, newest last, at the page's level; the shipper takes info and up regardless", async () => {
	const { fetch, posts } = recordingFetch();
	const { ring } = await configureBrowserLogging({ fetch, level: "debug", page: "p1" });
	const log = zenLogger("browser", "probe");
	log.debug("only the ring hears this", { threadId: "t1" });
	log.warn("both hear this: {what}", { threadId: "t1", what: "a problem" });
	expect(ring.get().map((line) => [line.level, line.message, line.logger])).toEqual([
		["DEBUG", "only the ring hears this", "zen.browser.probe"],
		["WARN", "both hear this: {what}", "zen.browser.probe"],
	]);
	// A per-page count on every record, for order and for the drawer's key.
	expect(ring.get().map((line) => line.properties?.pageSequence)).toEqual([1, 2]);
	// Nothing has shipped yet: one record, under the batch size, waits on the timer.
	expect(posts).toHaveLength(0);
});

test("⚠ the shipper batches by count or by time, ships only info and up, sends a valid ZenBrowserLogBatch, and never logs a failure", async () => {
	const { fetch, posts, nextPost } = recordingFetch(() => Promise.reject(new Error("server down")));
	const shipper = createLogShipper({ fetch, page: "p2", flushMs: 1 });
	const at = Date.now();
	const record = (level: "debug" | "info" | "warning", message: string) => ({
		category: ["zen", "browser", "follow"],
		level,
		timestamp: at,
		message: [message],
		rawMessage: message,
		properties: { threadId: "t1" },
	});
	shipper.sink(record("debug", "not shipped"));
	shipper.sink(record("info", "shipped"));
	expect(posts).toHaveLength(0);
	// The timer's flush: awaited as the POST it produces, not as a duration.
	await nextPost();
	expect(posts).toHaveLength(1);
	expect(Check(ZenBrowserLogBatch, posts[0]?.body)).toBe(true);
	expect(posts[0]?.body).toMatchObject({
		page: "p2",
		records: [{ level: "info", logger: "zen.browser.follow", message: "shipped", properties: { threadId: "t1" } }],
	});
	// By count: a full batch goes at once, without the timer.
	for (let index = 0; index < SHIP_BATCH_SIZE; index += 1) shipper.sink(record("warning", `w${index}`));
	expect(posts).toHaveLength(2);
	const second = posts[1]?.body as ZenBrowserLogBatch | undefined;
	expect(second?.records).toHaveLength(SHIP_BATCH_SIZE);
	// The rejected POSTs above were swallowed — the test is still running, nothing threw.
	// A hide-time flush is `keepalive`, so the browser lets it finish after the page goes.
	shipper.sink(record("info", "last words"));
	shipper.flush(true);
	expect(posts[2]?.keepalive).toBe(true);
});

test("the ring is bounded", () => {
	const ring = createLogRing(3);
	for (let index = 0; index < 5; index += 1) {
		ring.sink({
			category: ["zen"],
			level: "info",
			timestamp: 0,
			message: [`m${index}`],
			rawMessage: `m${index}`,
			properties: {},
		});
	}
	expect(ring.get().map((line) => line.message)).toEqual(["m2", "m3", "m4"]);
});

test("?log= is the page's knob: a level, warn for warning, anything else is info", () => {
	expect(pageLogLevel("")).toBe("info");
	expect(pageLogLevel("?debug")).toBe("info");
	expect(pageLogLevel("?debug&log=trace")).toBe("trace");
	expect(pageLogLevel("?log=warn")).toBe("warning");
	expect(pageLogLevel("?log=loud")).toBe("info");
});
