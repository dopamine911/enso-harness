import { expect, test } from "bun:test";
import type { PiTransport } from "@zen/core";
import { PiRpcClient, PiTransportClosedError } from "../client.ts";
import type { PiRpcEvent } from "@zen/core";

/** A fake transport: captures writes, lets a test push stdout and close the stream. */
function fakeTransport() {
	const written: string[] = [];
	let consumeData: ((chunk: string) => void) | undefined;
	let consumeClose: (() => void) | undefined;
	const transport: PiTransport = {
		write: (line) => written.push(line),
		onData: (consume) => { consumeData = consume; },
		onClose: (consume) => { consumeClose = consume; },
	};
	return {
		transport,
		written,
		emit: (chunk: string) => consumeData?.(chunk),
		close: () => consumeClose?.(),
	};
}

function harness() {
	const fake = fakeTransport();
	const events: PiRpcEvent[] = [];
	const problems: unknown[] = [];
	let counter = 0;
	const client = new PiRpcClient({
		transport: fake.transport,
		nextCommandId: () => `test-${++counter}`,
		onEvent: (event) => events.push(event),
		onParseError: (error) => problems.push(error),
	});
	return { ...fake, client, events, problems };
}

test("a command is written as one LF-terminated JSON line with an assigned id", async () => {
	const h = harness();
	const pending = h.client.send({ type: "prompt", message: "hello" });
	expect(h.written).toEqual(['{"type":"prompt","message":"hello","id":"test-1"}\n']);
	h.emit('{"id":"test-1","type":"response","command":"prompt","success":true}\n');
	expect((await pending).success).toBe(true);
});

test("images ride on the command untouched", () => {
	const h = harness();
	void h.client.send({
		type: "prompt",
		message: "what is this",
		images: [{ type: "image", data: "aGk=", mimeType: "image/png" }],
	});
	const sent = JSON.parse(h.written[0] as string) as { images: Array<{ mimeType: string }> };
	expect(sent.images[0]?.mimeType).toBe("image/png");
});

// ⚠ #24 acceptance: interleaved responses must correlate by id, not by arrival order.
test("responses arriving OUT OF ORDER resolve the right commands", async () => {
	const h = harness();
	const first = h.client.send({ type: "prompt", message: "a" });
	const second = h.client.send({ type: "prompt", message: "b" });
	expect(h.client.pendingCommandIds).toEqual(["test-1", "test-2"]);
	// second acknowledged first
	h.emit('{"id":"test-2","type":"response","command":"prompt","success":true}\n');
	h.emit('{"id":"test-1","type":"response","command":"prompt","success":false,"error":"busy"}\n');
	expect((await second).success).toBe(true);
	const firstResponse = await first;
	expect(firstResponse.success).toBe(false);
	expect(firstResponse.error).toBe("busy");
	expect(h.client.pendingCommandIds).toEqual([]);
});

// ⚠ success:false is a protocol outcome, not an exception — the caller must inspect it.
test("a rejected command RESOLVES rather than rejecting", async () => {
	const h = harness();
	const pending = h.client.send({ type: "set_model", model: "nope" });
	h.emit('{"id":"test-1","type":"response","command":"set_model","success":false,"error":"Model not found"}\n');
	await expect(pending).resolves.toMatchObject({ success: false });
});

test("events are forwarded, including types the transport does not model", () => {
	const h = harness();
	h.emit('{"type":"message_update","delta":"hi"}\n{"type":"some_future_event","x":1}\n');
	expect(h.events.map((event) => event.type)).toEqual(["message_update", "some_future_event"]);
});

test("a record split across chunks is dispatched once whole", () => {
	const h = harness();
	h.emit('{"type":"message_up');
	expect(h.events).toHaveLength(0);
	h.emit('date","delta":"x"}\n');
	expect(h.events).toHaveLength(1);
});

// ⚠ Nothing is dropped silently — the failure shape #24 exists to avoid.
test("malformed JSON is reported, not swallowed", () => {
	const h = harness();
	h.emit("{not json}\n");
	expect(h.problems).toHaveLength(1);
	expect(h.events).toHaveLength(0);
});

test("a response with no id is reported rather than discarded", () => {
	const h = harness();
	h.emit('{"type":"response","command":"parse","success":false,"error":"bad"}\n');
	expect(h.problems).toHaveLength(1);
});

test("a response for an unknown id is reported, never guessed at", () => {
	const h = harness();
	void h.client.send({ type: "prompt", message: "a" });
	h.emit('{"id":"not-ours","type":"response","command":"prompt","success":true}\n');
	expect(h.problems).toHaveLength(1);
	expect(h.client.pendingCommandIds).toEqual(["test-1"]);
});

// ⚠ A hung await is the worst outcome: no error, no result, no timeout.
test("closing with a command outstanding reports it instead of hanging", () => {
	const h = harness();
	void h.client.send({ type: "prompt", message: "a" });
	h.close();
	const reported = h.problems.find((p) => p instanceof PiTransportClosedError);
	expect(reported).toBeInstanceOf(PiTransportClosedError);
	expect((reported as PiTransportClosedError).pendingCommandIds).toEqual(["test-1"]);
});

// pi may exit without a trailing newline; the final record must still land.
test("an unterminated final record is drained on close", async () => {
	const h = harness();
	const pending = h.client.send({ type: "prompt", message: "a" });
	h.emit('{"id":"test-1","type":"response","command":"prompt","success":true}');
	h.close();
	expect((await pending).success).toBe(true);
});

test("sending after close rejects rather than writing into a dead pipe", async () => {
	const h = harness();
	h.close();
	await expect(h.client.send({ type: "prompt", message: "a" })).rejects.toBeInstanceOf(PiTransportClosedError);
	expect(h.written).toHaveLength(0);
});

// ⚠ A record claiming `type: "response"` but missing required fields is a MALFORMED
// RESPONSE, not an event. Delivering it to onEvent would hide a protocol violation inside
// normal traffic — which is why routing is on the discriminant and validation follows.
test("a malformed response is reported, not delivered as an event", () => {
	const h = harness();
	h.emit('{"type":"response","id":"test-1"}\n');
	expect(h.problems).toHaveLength(1);
	expect(h.events).toHaveLength(0);
});
