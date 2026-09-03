import { EventType } from "@ag-ui/core";
import { expect, test } from "bun:test";
import type { PiTransport } from "@zen/core";
import { runChat } from "../session.ts";

/** A scripted pi: replies to the prompt, then emits whatever the test lists. */
function scriptedPi(events: string[]) {
	let consumeData: ((chunk: string) => void) | undefined;
	const written: string[] = [];
	const transport: PiTransport = {
		write: (line) => {
			written.push(line);
			const id = (JSON.parse(line) as { id: string }).id;
			// Acknowledge, then emit the script — asynchronously, as a real process would.
			queueMicrotask(() => {
				consumeData?.(`{"id":"${id}","type":"response","command":"prompt","success":true}\n`);
				for (const event of events) consumeData?.(`${event}\n`);
			});
		},
		onData: (consume) => { consumeData = consume; },
		onClose: () => undefined,
	};
	return { transport, written };
}

const ids = { messageId: "m1", runId: "r1", threadId: "t1" };

async function collect(events: string[], images?: ChatImages) {
	const pi = scriptedPi(events);
	const chunks = [];
	for await (const chunk of runChat({ transport: pi.transport, ids, prompt: "hello", onProblem: undefined, ...(images ? { images } : {}) })) {
		chunks.push(chunk);
	}
	return { chunks, written: pi.written };
}
type ChatImages = ReadonlyArray<{ type: "image"; data: string; mimeType: string }>;

test("a run opens with RUN_STARTED then TEXT_MESSAGE_START", async () => {
	const { chunks } = await collect(['{"type":"agent_settled"}']);
	expect(chunks.slice(0, 2).map((c) => c.type)).toEqual([
		EventType.RUN_STARTED,
		EventType.TEXT_MESSAGE_START,
	]);
});

test("text deltas stream through as AG-UI content events", async () => {
	const { chunks } = await collect([
		'{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Hi"}}',
		'{"type":"agent_settled"}',
	]);
	const content = chunks.filter((c) => c.type === EventType.TEXT_MESSAGE_CONTENT);
	expect(content).toHaveLength(1);
	expect(content[0]).toMatchObject({ messageId: "m1", delta: "Hi" });
});

// ⚠ The whole pipeline in one assertion: pi tool event → observation → AG-UI, descriptor intact.
test("a tool call and its result arrive as AG-UI events with the descriptor", async () => {
	const { chunks } = await collect([
		'{"type":"tool_execution_start","toolCallId":"c1","toolName":"bash","args":{"command":"ls"}}',
		'{"type":"tool_execution_end","toolCallId":"c1","toolName":"bash","result":{"content":"out","details":{"truncation":{"shown":5,"total":50,"unit":"lines"}}},"isError":false}',
		'{"type":"agent_settled"}',
	]);
	const kinds = chunks.map((c) => c.type);
	expect(kinds).toContain(EventType.TOOL_CALL_START);
	expect(kinds).toContain(EventType.TOOL_CALL_ARGS);
	const result = chunks.find((c) => c.type === EventType.TOOL_CALL_RESULT);
	expect(result).toMatchObject({ toolCallId: "c1", content: "out" });
	// ⚠ Bracket access, not `toHaveProperty` — the key is namespaced and a path-based
	// matcher would read a separator as nesting. That is why the key carries no dot.
	expect(Object.keys(result as object)).toContain("zen:toolResult");
});

// ⚠ Terminates on agent_settled, not agent_end — ending at agent_end would cut a retry off.
test("the stream does NOT end on agent_end, only on agent_settled", async () => {
	const { chunks } = await collect([
		'{"type":"agent_end","willRetry":true}',
		'{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"after retry"}}',
		'{"type":"agent_settled"}',
	]);
	// content emitted AFTER agent_end must be present — that is the proof
	expect(chunks.some((c) => c.type === EventType.TEXT_MESSAGE_CONTENT)).toBe(true);
	expect(chunks.at(-1)?.type).toBe(EventType.RUN_FINISHED);
	expect(chunks.some((c) => c.type === EventType.STEP_FINISHED)).toBe(true);
});

test("images are forwarded verbatim on the prompt command", async () => {
	const { written } = await collect(['{"type":"agent_settled"}'], [
		{ type: "image", data: "aGk=", mimeType: "image/png" },
	]);
	const sent = JSON.parse(written[0] as string) as { images: Array<{ mimeType: string }> };
	expect(sent.images[0]).toMatchObject({ mimeType: "image/png" });
});

// A rejected prompt is a protocol outcome; the client must be told why, not disconnected.
test("a rejected prompt yields RUN_ERROR rather than throwing", async () => {
	let consumeData: ((chunk: string) => void) | undefined;
	const transport: PiTransport = {
		write: (line) => {
			const id = (JSON.parse(line) as { id: string }).id;
			queueMicrotask(() =>
				consumeData?.(`{"id":"${id}","type":"response","command":"prompt","success":false,"error":"already streaming"}\n`),
			);
		},
		onData: (consume) => { consumeData = consume; },
		onClose: () => undefined,
	};
	const chunks = [];
	for await (const chunk of runChat({ transport, ids, prompt: "x", onProblem: undefined })) chunks.push(chunk);
	const error = chunks.find((c) => c.type === EventType.RUN_ERROR);
	expect(error).toMatchObject({ runId: "r1", message: "already streaming" });
});

// ⚠ A parse failure must not strand the stream waiting for a settle that never comes.
test("a malformed record is reported and does not hang the run", async () => {
	const problems: unknown[] = [];
	const pi = scriptedPi(["{not json}", '{"type":"agent_settled"}']);
	const chunks = [];
	for await (const chunk of runChat({
		transport: pi.transport, ids, prompt: "x", onProblem: (p) => problems.push(p),
	})) {
		chunks.push(chunk);
	}
	expect(problems).toHaveLength(1);
	expect(chunks.at(-1)?.type).toBe(EventType.RUN_FINISHED);
});

test("an unmodelled pi event still reaches the client, as CUSTOM", async () => {
	const { chunks } = await collect([
		'{"type":"queue_update","depth":3}',
		'{"type":"agent_settled"}',
	]);
	const custom = chunks.find((c) => c.type === EventType.CUSTOM);
	expect(custom).toMatchObject({ name: "zen.unmapped" });
});
