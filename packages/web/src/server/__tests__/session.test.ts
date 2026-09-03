import { EventType } from "@ag-ui/core";
import { expect, test } from "bun:test";
import type { PiTransport } from "@zen/core";
import { PiRpcClient } from "../../rpc/client.ts";
import { fetchPiCommands, runChat } from "../session.ts";

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

/**
 * ⚠ Slash-command handling. Observed in a real session: `/settings` was forwarded as an
 * ordinary prompt and the MODEL answered it by reading config files — a plausible,
 * unauthoritative guess that looked like the command had worked. pi's docs are explicit
 * that built-in TUI commands cannot execute over rpc, so they must be refused locally.
 */
function piWithCommands(commandNames: string[], events: string[] = ['{"type":"agent_settled"}']) {
	let consumeData: ((chunk: string) => void) | undefined;
	const sent: string[] = [];
	const transport: PiTransport = {
		write: (line) => {
			sent.push(line);
			const parsed = JSON.parse(line) as { id: string; type: string };
			queueMicrotask(() => {
				if (parsed.type === "get_commands") {
					const commands = commandNames.map((name) => ({ name, source: "extension" }));
					consumeData?.(
						`${JSON.stringify({ id: parsed.id, type: "response", command: "get_commands", success: true, data: { commands } })}\n`,
					);
					return;
				}
				consumeData?.(`{"id":"${parsed.id}","type":"response","command":"prompt","success":true}\n`);
				for (const event of events) consumeData?.(`${event}\n`);
			});
		},
		onData: (consume) => { consumeData = consume; },
		onClose: () => undefined,
	};
	return { transport, sent };
}

async function runWith(pi: { transport: PiTransport }, prompt: string) {
	const chunks = [];
	for await (const chunk of runChat({ transport: pi.transport, ids, prompt, onProblem: undefined })) {
		chunks.push(chunk);
	}
	return chunks;
}

test("⚠ an unknown slash command is REFUSED, not forwarded to the model", async () => {
	const pi = piWithCommands(["mode", "plan"]);
	const chunks = await runWith(pi, "/settings");
	const error = chunks.find((chunk) => chunk.type === EventType.RUN_ERROR);
	expect(error).toBeDefined();
	// the refusal explains WHY, not just that it failed
	expect((error as { message: string }).message).toContain("terminal-only");
	// and names what does work, so the user is not left guessing
	expect((error as { message: string }).message).toContain("/mode");
	// ⚠ the decisive assertion: no prompt was ever sent
	expect(pi.sent.some((line) => line.includes('"type":"prompt"'))).toBe(false);
});

test("a KNOWN slash command is forwarded, because pi can run it", async () => {
	const pi = piWithCommands(["mode", "plan"]);
	const chunks = await runWith(pi, "/mode auto");
	expect(chunks.some((chunk) => chunk.type === EventType.RUN_ERROR)).toBe(false);
	expect(pi.sent.some((line) => line.includes('"type":"prompt"'))).toBe(true);
	expect(chunks.at(-1)?.type).toBe(EventType.RUN_FINISHED);
});

test("ordinary prose never triggers a get_commands round trip", async () => {
	const pi = piWithCommands(["mode"]);
	await runWith(pi, "what is in this repo?");
	expect(pi.sent.some((line) => line.includes("get_commands"))).toBe(false);
});

test("the refusal says 'none' rather than an empty list when pi has no commands", async () => {
	const pi = piWithCommands([]);
	const chunks = await runWith(pi, "/anything");
	expect((chunks.find((c) => c.type === EventType.RUN_ERROR) as { message: string }).message).toContain("none");
});

test("a bare slash is treated as prose, not a command lookup", async () => {
	const pi = piWithCommands(["mode"]);
	await runWith(pi, "/");
	expect(pi.sent.some((line) => line.includes("get_commands"))).toBe(false);
});

test("fetchPiCommands filters malformed entries rather than trusting the payload", async () => {
	let consumeData: ((chunk: string) => void) | undefined;
	const transport: PiTransport = {
		write: (line) => {
			const id = (JSON.parse(line) as { id: string }).id;
			queueMicrotask(() =>
				consumeData?.(
					`${JSON.stringify({ id, type: "response", command: "get_commands", success: true, data: { commands: [{ name: "ok", source: "extension" }, { name: "bad" }, "nope", null] } })}\n`,
				),
			);
		},
		onData: (consume) => { consumeData = consume; },
		onClose: () => undefined,
	};
	const client = new PiRpcClient({ transport });
	const commands = await fetchPiCommands(client);
	expect(commands.map((command) => command.name)).toEqual(["ok"]);
});

/**
 * ⚠⚠ The no-progress guard. Observed with `/mode`: the command emitted RUN_ERROR and then
 * left the SSE response OPEN FOREVER, because `runChat` terminates on `agent_settled` and
 * an extension command that runs no inference never emits one. An HTTP stream that never
 * closes shows a spinner with no error raised anywhere.
 */
test("a run that never settles ends itself rather than hanging", async () => {
	// pi acknowledges the prompt, emits one event, then goes silent — never settling.
	let consumeData: ((chunk: string) => void) | undefined;
	const transport: PiTransport = {
		write: (line) => {
			const parsed = JSON.parse(line) as { id: string; type: string };
			if (parsed.type !== "prompt") return;
			queueMicrotask(() => {
				consumeData?.(`{"id":"${parsed.id}","type":"response","command":"prompt","success":true}\n`);
				consumeData?.('{"type":"turn_start"}\n');
			});
		},
		onData: (consume) => { consumeData = consume; },
		onClose: () => undefined,
	};
	const chunks = [];
	for await (const chunk of runChat({
		transport, ids, prompt: "hello", onProblem: undefined, noProgressTimeoutMs: 40,
	})) {
		chunks.push(chunk);
	}
	// It terminated — reaching this line at all is the assertion.
	expect(chunks.at(-1)?.type).toBe(EventType.RUN_FINISHED);
	// and the event that DID arrive was not discarded by the timeout
	expect(chunks.some((chunk) => chunk.type === EventType.CUSTOM)).toBe(true);
});

test("a settled run is unaffected by the timeout", async () => {
	const pi = piWithCommands([], ['{"type":"agent_settled"}']);
	const chunks = [];
	for await (const chunk of runChat({
		transport: pi.transport, ids, prompt: "hi", onProblem: undefined, noProgressTimeoutMs: 40,
	})) {
		chunks.push(chunk);
	}
	expect(chunks.filter((chunk) => chunk.type === EventType.RUN_FINISHED)).toHaveLength(1);
});

// ⚠ A blocking dialog must be CANCELLED, or pi never acknowledges the prompt and the run
// hangs before the drain loop is even entered — which is what `/mode` did.
test("a blocking dialog is cancelled on the wire so pi can proceed", async () => {
	let consumeData: ((chunk: string) => void) | undefined;
	const written: string[] = [];
	const transport: PiTransport = {
		write: (line) => {
			written.push(line);
			const parsed = JSON.parse(line) as { id: string; type: string };
			if (parsed.type !== "prompt") return;
			queueMicrotask(() => {
				// pi asks a question BEFORE acknowledging the prompt — the real ordering.
				consumeData?.('{"type":"extension_ui_request","id":"d1","method":"select","title":"pick"}\n');
				consumeData?.(`{"id":"${parsed.id}","type":"response","command":"prompt","success":true}\n`);
				consumeData?.('{"type":"agent_settled"}\n');
			});
		},
		onData: (consume) => { consumeData = consume; },
		onClose: () => undefined,
	};
	const chunks = [];
	// ⚠ Ordinary prose, not "/x". A slash prompt would trigger the command lookup, and this
	// fake answers only `prompt` — so the test would hang on `get_commands` and look like a
	// code defect. The dialog behaviour is independent of slash handling.
	for await (const chunk of runChat({ transport, ids, prompt: "do a thing", onProblem: undefined })) {
		chunks.push(chunk);
	}
	// the cancellation was written, keyed to the request id
	const cancellation = written.find((line) => line.includes("extension_ui_response"));
	expect(cancellation).toBeDefined();
	expect(JSON.parse(cancellation as string)).toMatchObject({ id: "d1", cancelled: true });
	// and the user is told why, rather than the dialog vanishing silently
	const error = chunks.find((chunk) => chunk.type === EventType.RUN_ERROR);
	expect((error as { message: string }).message).toContain("select");
	// ⚠ The message must describe the state AFTER the cancellation — declined, the command
	// did nothing — not the pre-fix state the text was originally written for. The first
	// wording said pi "is blocked", which told the user the agent was hung at the exact
	// moment the run was completing normally.
	expect((error as { message: string }).message).toContain("declined");
	expect((error as { message: string }).message).not.toContain("is blocked");
});

test("a fire-and-forget UI request is NOT cancelled — nothing is waiting on it", async () => {
	const written: string[] = [];
	let consumeData: ((chunk: string) => void) | undefined;
	const transport: PiTransport = {
		write: (line) => {
			written.push(line);
			const parsed = JSON.parse(line) as { id: string; type: string };
			if (parsed.type !== "prompt") return;
			queueMicrotask(() => {
				consumeData?.('{"type":"extension_ui_request","id":"n1","method":"setStatus","statusKey":"x"}\n');
				consumeData?.(`{"id":"${parsed.id}","type":"response","command":"prompt","success":true}\n`);
				consumeData?.('{"type":"agent_settled"}\n');
			});
		},
		onData: (consume) => { consumeData = consume; },
		onClose: () => undefined,
	};
	for await (const _chunk of runChat({ transport, ids, prompt: "hi", onProblem: undefined })) {
		// drain
	}
	expect(written.some((line) => line.includes("extension_ui_response"))).toBe(false);
});

/**
 * ⚠⚠ The guard must measure PROGRESS, not traffic.
 *
 * The first version reset its deadline on any incoming event, which made it inert against
 * the real case: pi-multi-account emits periodic `setStatus` heartbeats that we DROP
 * without emitting anything, so they renewed the deadline forever and `/mode` still hung
 * past 120 seconds with the guard "in place".
 */
test("dropped status heartbeats do NOT keep a stalled run alive", async () => {
	let consumeData: ((chunk: string) => void) | undefined;
	let heartbeat: ReturnType<typeof setInterval> | undefined;
	const transport: PiTransport = {
		write: (line) => {
			const parsed = JSON.parse(line) as { id: string; type: string };
			if (parsed.type !== "prompt") return;
			queueMicrotask(() => {
				consumeData?.(`{"id":"${parsed.id}","type":"response","command":"prompt","success":true}\n`);
				// Traffic that produces no chunks, faster than the deadline — exactly the
				// shape that defeated the first implementation.
				heartbeat = setInterval(() => {
					consumeData?.(
						'{"type":"extension_ui_request","id":"h","method":"setStatus","statusKey":"quota"}\n',
					);
				}, 10);
			});
		},
		onData: (consume) => { consumeData = consume; },
		onClose: () => undefined,
	};
	const chunks = [];
	for await (const chunk of runChat({
		transport, ids, prompt: "hello", onProblem: undefined, noProgressTimeoutMs: 80,
	})) {
		chunks.push(chunk);
	}
	if (heartbeat !== undefined) clearInterval(heartbeat);
	// Terminating at all is the assertion — the old version looped forever here.
	expect(chunks.at(-1)?.type).toBe(EventType.RUN_FINISHED);
});

test("real output DOES renew the deadline, so a slow answer is not cut off", async () => {
	let consumeData: ((chunk: string) => void) | undefined;
	const transport: PiTransport = {
		write: (line) => {
			const parsed = JSON.parse(line) as { id: string; type: string };
			if (parsed.type !== "prompt") return;
			queueMicrotask(async () => {
				consumeData?.(`{"id":"${parsed.id}","type":"response","command":"prompt","success":true}\n`);
				// Four deltas at 30ms with a 60ms window: each renews, so none is cut off.
				for (let index = 0; index < 4; index += 1) {
					await new Promise((resolve) => setTimeout(resolve, 30));
					consumeData?.(
						`{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"x"}}\n`,
					);
				}
				consumeData?.('{"type":"agent_settled"}\n');
			});
		},
		onData: (consume) => { consumeData = consume; },
		onClose: () => undefined,
	};
	const chunks = [];
	for await (const chunk of runChat({
		transport, ids, prompt: "hello", onProblem: undefined, noProgressTimeoutMs: 60,
	})) {
		chunks.push(chunk);
	}
	// All four deltas arrived and the run settled normally rather than timing out.
	expect(chunks.filter((chunk) => chunk.type === EventType.TEXT_MESSAGE_CONTENT)).toHaveLength(4);
	expect(chunks.at(-1)?.type).toBe(EventType.RUN_FINISHED);
});
