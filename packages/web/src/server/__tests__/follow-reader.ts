import { ZenFollowFrame } from "@zen/core";
import { Check } from "typebox/value";

/**
 * A follow as a test reads it: frames and keepalive comments as they arrive, awaited by
 * count — never by a guessed delay. Every frame is checked against `ZenFollowFrame` on the
 * way in, so a shape the browser could not read fails the test that produced it.
 *
 * Lives under `__tests__/` deliberately: the coverage manifest skips that directory.
 */
export interface OpenFollow {
	readonly frames: ZenFollowFrame[];
	readonly comments: () => number;
	/** Resolves once at least `count` frames have arrived. */
	readonly untilFrames: (count: number) => Promise<void>;
	/** Resolves once at least `count` keepalive comments have arrived. */
	readonly untilComments: (count: number) => Promise<void>;
	readonly close: () => void;
}

export async function openFollow(
	url: string,
	threadId: string,
	controller = new AbortController(),
): Promise<OpenFollow> {
	const response = await fetch(`${url}/api/threads/${threadId}/follow`, { signal: controller.signal });
	if (response.status !== 200) throw new Error(`follow ${threadId}: ${response.status} ${await response.text()}`);
	const frames: ZenFollowFrame[] = [];
	let comments = 0;
	const waiters: Array<() => void> = [];
	const wake = (): void => {
		for (const waiter of waiters.splice(0)) waiter();
	};
	const reader = response.body?.getReader();
	if (reader === undefined) throw new Error("no body");
	void (async () => {
		const decoder = new TextDecoder();
		let buffered = "";
		try {
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				buffered += decoder.decode(value, { stream: true });
				const lines = buffered.split("\n");
				buffered = lines.pop() ?? "";
				for (const line of lines) {
					if (line.startsWith("data: ")) {
						const frame: unknown = JSON.parse(line.slice("data: ".length));
						if (!Check(ZenFollowFrame, frame)) throw new Error(`frame off the wire fails ZenFollowFrame: ${line}`);
						frames.push(frame);
					} else if (line.startsWith(":")) comments += 1;
				}
				wake();
			}
		} catch {
			// the test closed the follow
		}
		wake();
	})();
	const until = (ready: () => boolean): Promise<void> => {
		if (ready()) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		const check = (): void => {
			if (ready()) resolve();
			else waiters.push(check);
		};
		waiters.push(check);
		return promise;
	};
	return {
		frames,
		comments: () => comments,
		untilFrames: (count) => until(() => frames.length >= count),
		untilComments: (count) => until(() => comments >= count),
		close: () => controller.abort(),
	};
}
