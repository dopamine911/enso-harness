/**
 * A minimal SSE reader for the provider streams (#63).
 *
 * Adapted from pi-web-search 1.4.0 (github.com/ttttmr/pi-web-search), © ttttmr, MIT
 * (declared in its package.json; the repo ships no LICENSE file).
 *
 * Reads `event:`/`data:` lines, JSON-parses each event's data, and hands
 * `{ eventName, data }` to the callback. Non-JSON data lines and `[DONE]` sentinels are
 * skipped. The callback may return `true` to stop reading early (the OpenAI Codex stream
 * never closes on its own after `response.completed`).
 */

export interface SseEvent {
	eventName: string;
	/** The JSON-parsed event payload. Provider wire data — each caller narrows it. */
	data: unknown;
}

export async function readSseEvents(
	response: Response,
	signal: AbortSignal | undefined,
	onEvent: (event: SseEvent) => boolean | undefined,
): Promise<void> {
	const responseBody = response.body;
	if (responseBody === null) {
		throw new Error("the streaming response has no body");
	}

	const reader = responseBody.getReader();
	const decoder = new TextDecoder();
	let lineBuffer = "";
	let currentEventData = "";
	let currentEventName = "";
	let stopRequested = false;
	let reachedEndOfStream = false;

	const flushEvent = (): boolean => {
		if (currentEventData.length === 0) return false;
		const rawData = currentEventData.trim();
		currentEventData = "";
		const eventName = currentEventName;
		currentEventName = "";
		if (rawData.length === 0 || rawData === "[DONE]") return false;

		let data: unknown;
		try {
			data = JSON.parse(rawData);
		} catch {
			return false;
		}
		return onEvent({ eventName, data }) === true;
	};

	const bufferLine = (line: string): void => {
		if (line.startsWith("data:")) {
			const data = line.slice("data:".length).trim();
			currentEventData = currentEventData.length > 0 ? `${currentEventData}\n${data}` : data;
		} else if (line.startsWith("event:")) {
			currentEventName = line.slice("event:".length).trim();
		}
	};

	try {
		readLoop: for (;;) {
			if (signal?.aborted === true) {
				throw new Error("the request was aborted");
			}

			const { done, value } = await reader.read();
			if (done) {
				reachedEndOfStream = true;
				break;
			}

			lineBuffer += decoder.decode(value, { stream: true });
			const lines = lineBuffer.split("\n");
			lineBuffer = lines.pop() ?? "";

			for (const line of lines) {
				if (line === "" || line === "\r") {
					if (flushEvent()) {
						stopRequested = true;
						break readLoop;
					}
					continue;
				}
				bufferLine(line);
			}
		}

		// A final event may end at EOF without the blank-line terminator.
		if (!stopRequested && lineBuffer.trim().length > 0) {
			bufferLine(lineBuffer.trim());
		}
		if (!stopRequested) flushEvent();
	} finally {
		if (!reachedEndOfStream) {
			try {
				await reader.cancel();
			} catch {
				// Ignore cancellation failures while cleaning up an interrupted stream.
			}
		}
		reader.releaseLock();
	}
}
