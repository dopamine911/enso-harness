import { EventType } from "@ag-ui/core";
import { expect, test } from "bun:test";
import type { PiTransport } from "@zen/core";
import { PiRpcClient } from "../../rpc/client.ts";
import { createDialogRegistry } from "../dialog-registry.ts";
import { fetchPiCommands, resumeChat, runChat, type ChatRunOutcome } from "../session.ts";

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

/**
 * Fresh #27 wiring per run: a registry with test-scale timeouts, the outcome the HTTP
 * handler would read, and a counting stopPi so process teardown is observable.
 */
function runWiring() {
	const problems: unknown[] = [];
	const wiring = {
		registry: createDialogRegistry({
			onProblem: (problem: unknown) => problems.push(problem),
			answerTimeoutMs: 5_000,
			evictionGraceMs: 5,
		}),
		outcome: { parkedAwaitingAnswer: false } as ChatRunOutcome,
		problems,
		stopCount: 0,
		stopPi: () => {
			wiring.stopCount += 1;
		},
	};
	return wiring;
}

async function collect(events: string[], images?: ChatImages) {
	const pi = scriptedPi(events);
	const wiring = runWiring();
	const chunks = [];
	for await (const chunk of runChat({ transport: pi.transport, ids, prompt: "hello", onProblem: undefined, ...wiring, ...(images ? { images } : {}) })) {
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
	for await (const chunk of runChat({ transport, ids, prompt: "x", onProblem: undefined, ...runWiring() })) chunks.push(chunk);
	const error = chunks.find((c) => c.type === EventType.RUN_ERROR);
	expect(error).toMatchObject({ runId: "r1", message: "already streaming" });
});

// ⚠ A parse failure must not strand the stream waiting for a settle that never comes.
test("a malformed record is reported and does not hang the run", async () => {
	const problems: unknown[] = [];
	const pi = scriptedPi(["{not json}", '{"type":"agent_settled"}']);
	const chunks = [];
	for await (const chunk of runChat({
		transport: pi.transport, ids, prompt: "x", onProblem: (p) => problems.push(p), ...runWiring(),
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
	for await (const chunk of runChat({ transport: pi.transport, ids, prompt, onProblem: undefined, ...runWiring() })) {
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
		transport, ids, prompt: "hello", onProblem: undefined, noProgressTimeoutMs: 40, ...runWiring(),
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
		transport: pi.transport, ids, prompt: "hi", onProblem: undefined, noProgressTimeoutMs: 40, ...runWiring(),
	})) {
		chunks.push(chunk);
	}
	expect(chunks.filter((chunk) => chunk.type === EventType.RUN_FINISHED)).toHaveLength(1);
});

/**
 * ⚠⚠ #27: a blocking dialog INTERRUPTS the run — the browser answers it, pi stays alive.
 *
 * The fake mirrors the real ordering, which is the load-bearing part: pi asks the question
 * BEFORE acknowledging the prompt (the command cannot complete while the dialog blocks),
 * and the acknowledgement plus everything after it arrive only once an
 * `extension_ui_response` is written. The pre-#27 code hung exactly here — an await on the
 * prompt acknowledgement stood in front of the drain loop.
 */
function dialogPi(dialogEvent: string, afterAnswer: string[] = ['{"type":"agent_settled"}']) {
	let consumeData: ((chunk: string) => void) | undefined;
	const written: string[] = [];
	let promptId = "";
	const transport: PiTransport = {
		write: (line) => {
			written.push(line);
			const parsed = JSON.parse(line) as { id?: string; type: string };
			if (parsed.type === "get_commands") {
				queueMicrotask(() =>
					consumeData?.(
						`${JSON.stringify({ id: parsed.id, type: "response", command: "get_commands", success: true, data: { commands: [{ name: "mode", source: "extension" }] } })}\n`,
					),
				);
				return;
			}
			if (parsed.type === "prompt") {
				promptId = parsed.id ?? "";
				queueMicrotask(() => consumeData?.(`${dialogEvent}\n`));
				return;
			}
			if (parsed.type === "extension_ui_response") {
				queueMicrotask(() => {
					consumeData?.(`{"id":"${promptId}","type":"response","command":"prompt","success":true}\n`);
					for (const event of afterAnswer) consumeData?.(`${event}\n`);
				});
			}
		},
		onData: (consume) => { consumeData = consume; },
		onClose: () => undefined,
	};
	return { transport, written };
}

const SELECT_DIALOG =
	'{"type":"extension_ui_request","id":"d1","method":"select","title":"Select permission mode","options":["ask","auto","deny"]}';

type InterruptChunk = {
	outcome?: {
		type: string;
		interrupts: Array<{
			id: string;
			reason: string;
			message: string;
			expiresAt?: string;
			metadata: Record<string, unknown>;
		}>;
	};
};

/** Run a prompt against a dialog-opening pi and return everything observable. */
async function runIntoDialog(pi: ReturnType<typeof dialogPi>, wiring = runWiring()) {
	const chunks = [];
	// ⚠ Ordinary prose, not "/x" — a slash prompt would trigger the command lookup, which
	// this fake does not answer. Dialog behaviour is independent of slash handling.
	for await (const chunk of runChat({
		transport: pi.transport, ids, prompt: "do a thing", onProblem: undefined, ...wiring,
	})) {
		chunks.push(chunk);
	}
	return { chunks, wiring };
}

test("⚠⚠ a blocking dialog interrupts the run: parked, stamped, nothing declined", async () => {
	const pi = dialogPi(SELECT_DIALOG);
	const { chunks, wiring } = await runIntoDialog(pi);

	// Reaching here at all re-proves the original hang fix: the prompt acknowledgement has
	// NOT arrived (the fake withholds it until an answer), yet the run completed.
	const last = chunks.at(-1) as InterruptChunk & { type: string };
	expect(last.type).toBe(EventType.RUN_FINISHED);
	expect(last.outcome?.type).toBe("interrupt");

	const interrupt = last.outcome?.interrupts[0];
	expect(interrupt).toMatchObject({ id: "d1", reason: "pi-dialog:select" });
	// ⚠ The binding stamp is what makes the interrupt RESOLVABLE — without it TanStack
	// classifies it unbound/canResolve:false. interruptedRunId must be THIS run.
	expect(interrupt?.metadata["tanstack:interruptBinding"]).toEqual({
		v: 1, kind: "generic", interruptId: "d1", interruptedRunId: "r1", generation: 0,
	});
	// the question itself rides under the zen key, whole
	expect(interrupt?.metadata["zen:dialog"]).toEqual({
		method: "select", title: "Select permission mode", options: ["ask", "auto", "deny"],
	});

	// nothing was declined, the process was parked rather than stopped
	expect(pi.written.some((line) => line.includes("extension_ui_response"))).toBe(false);
	expect(wiring.outcome.parkedAwaitingAnswer).toBe(true);
	expect(wiring.registry.peek("t1")?.dialogId).toBe("d1");
	expect(wiring.stopCount).toBe(0);
});

/** Resume against whatever the wiring's registry holds. */
async function resumeWith(
	wiring: ReturnType<typeof runWiring>,
	resume: unknown,
	parentRunId: string | undefined = "r1",
) {
	const resumeIds = { messageId: "m2", runId: "r2", threadId: "t1" };
	const outcome = { parkedAwaitingAnswer: false };
	const chunks = [];
	for await (const chunk of resumeChat({
		registry: wiring.registry, ids: resumeIds, parentRunId, resume, outcome,
		onProblem: undefined,
	})) {
		chunks.push(chunk);
	}
	return { chunks, outcome };
}

test("an answered select is delivered verbatim and the run continues to completion", async () => {
	const pi = dialogPi(SELECT_DIALOG, [
		'{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"mode set"}}',
		'{"type":"agent_settled"}',
	]);
	const { wiring } = await runIntoDialog(pi);

	const { chunks, outcome } = await resumeWith(wiring, [
		{ interruptId: "d1", status: "resolved", payload: { value: "auto" } },
	]);

	// pi received exactly its own wire format, keyed to the dialog id
	const answer = pi.written.find((line) => line.includes("extension_ui_response"));
	expect(JSON.parse(answer as string)).toEqual({ type: "extension_ui_response", id: "d1", value: "auto" });
	// the continuation streamed on the RESUME response and settled
	expect(chunks.some((c) => c.type === EventType.TEXT_MESSAGE_CONTENT)).toBe(true);
	expect(chunks.at(-1)?.type).toBe(EventType.RUN_FINISHED);
	// and the question is spent: nothing parked, no second park
	expect(wiring.registry.peek("t1")).toBeUndefined();
	expect(outcome.parkedAwaitingAnswer).toBe(false);
});

test("⚠ an answer outside the offered options is refused and the question re-presented", async () => {
	const pi = dialogPi(SELECT_DIALOG);
	const { wiring } = await runIntoDialog(pi);

	const { chunks, outcome } = await resumeWith(wiring, [
		{ interruptId: "d1", status: "resolved", payload: { value: "root" } },
	]);

	// ⚠ Nothing reached pi — pi hands a select's value to the extension VERBATIM, so an
	// unoffered value is an injection seam, closed server-side.
	expect(pi.written.some((line) => line.includes("extension_ui_response"))).toBe(false);
	// the user sees the refusal as text, then the SAME question again
	const text = chunks.find((c) => c.type === EventType.TEXT_MESSAGE_CONTENT);
	expect((text as { delta: string }).delta).toContain("refused");
	const last = chunks.at(-1) as InterruptChunk & { type: string };
	expect(last.outcome?.type).toBe("interrupt");
	// ⚠ re-stamped onto THIS run, so the next resume's parentRunId correlates
	const binding = last.outcome?.interrupts[0]?.metadata["tanstack:interruptBinding"] as {
		interruptedRunId: string;
	};
	expect(binding.interruptedRunId).toBe("r2");
	expect(wiring.registry.peek("t1")?.interruptedRunId).toBe("r2");
	expect(outcome.parkedAwaitingAnswer).toBe(true);
});

test("cancel from the UI is delivered as pi's cancellation and the run completes", async () => {
	const pi = dialogPi(SELECT_DIALOG);
	const { wiring } = await runIntoDialog(pi);

	const { chunks } = await resumeWith(wiring, [{ interruptId: "d1", status: "cancelled" }]);

	const written = pi.written.find((line) => line.includes("extension_ui_response"));
	expect(JSON.parse(written as string)).toEqual({ type: "extension_ui_response", id: "d1", cancelled: true });
	expect(chunks.at(-1)?.type).toBe(EventType.RUN_FINISHED);
	expect(wiring.registry.peek("t1")).toBeUndefined();
});

test("a resume with no parked question is told so instead of hanging or crashing", async () => {
	const wiring = runWiring();
	const { chunks } = await resumeWith(wiring, [
		{ interruptId: "d1", status: "resolved", payload: { value: "auto" } },
	]);
	const error = chunks.find((c) => c.type === EventType.RUN_ERROR);
	expect((error as { message: string }).message).toContain("no open question");
});

test("a stale parentRunId is refused and the question stays open", async () => {
	const pi = dialogPi(SELECT_DIALOG);
	const { wiring } = await runIntoDialog(pi);

	const { chunks } = await resumeWith(
		wiring,
		[{ interruptId: "d1", status: "resolved", payload: { value: "auto" } }],
		"r0",
	);

	expect(chunks.some((c) => c.type === EventType.RUN_ERROR)).toBe(true);
	expect(pi.written.some((line) => line.includes("extension_ui_response"))).toBe(false);
	// ⚠ the decisive half: a bad request must not destroy the parked question
	expect(wiring.registry.peek("t1")?.dialogId).toBe("d1");
});

test("⚠ an unanswered dialog is evicted: declined on the wire, process stopped", async () => {
	const pi = dialogPi(SELECT_DIALOG);
	const wiring = runWiring();
	wiring.registry = createDialogRegistry({
		onProblem: (problem: unknown) => wiring.problems.push(problem),
		answerTimeoutMs: 20,
		evictionGraceMs: 5,
	});
	await runIntoDialog(pi, wiring);
	expect(wiring.registry.peek("t1")).toBeDefined();

	await new Promise((resolve) => setTimeout(resolve, 80));

	const declined = pi.written.find((line) => line.includes("extension_ui_response"));
	expect(JSON.parse(declined as string)).toMatchObject({ id: "d1", cancelled: true });
	expect(wiring.stopCount).toBe(1);
	expect(wiring.registry.peek("t1")).toBeUndefined();
	// eviction is reported, never silent
	expect(wiring.problems.some((problem) => String(problem).includes("unanswered"))).toBe(true);
});

// The degenerate case: blocking, but the question could not be read into a spec (no
// options on a select). Pre-#27 behaviour: decline on the wire, tell the user, run on.
test("a malformed blocking dialog is declined immediately rather than parked", async () => {
	const pi = dialogPi('{"type":"extension_ui_request","id":"d1","method":"select","title":"pick"}');
	const { chunks, wiring } = await runIntoDialog(pi);

	const declined = pi.written.find((line) => line.includes("extension_ui_response"));
	expect(JSON.parse(declined as string)).toMatchObject({ id: "d1", cancelled: true });
	const error = chunks.find((chunk) => chunk.type === EventType.RUN_ERROR);
	expect((error as { message: string }).message).toContain("declined");
	expect((error as { message: string }).message).not.toContain("is blocked");
	expect(wiring.outcome.parkedAwaitingAnswer).toBe(false);
	expect(chunks.at(-1)?.type).toBe(EventType.RUN_FINISHED);
});

test("a second dialog in the continuation re-interrupts on the new run", async () => {
	const secondDialog =
		'{"type":"extension_ui_request","id":"d2","method":"confirm","title":"Apply now?","message":"Restart the agent"}';
	const pi = dialogPi(SELECT_DIALOG, [secondDialog]);
	const { wiring } = await runIntoDialog(pi);

	const { chunks, outcome } = await resumeWith(wiring, [
		{ interruptId: "d1", status: "resolved", payload: { value: "auto" } },
	]);

	const last = chunks.at(-1) as InterruptChunk & { type: string };
	expect(last.outcome?.type).toBe("interrupt");
	expect(last.outcome?.interrupts[0]).toMatchObject({ id: "d2", reason: "pi-dialog:confirm" });
	const binding = last.outcome?.interrupts[0]?.metadata["tanstack:interruptBinding"] as {
		interruptedRunId: string;
	};
	expect(binding.interruptedRunId).toBe("r2");
	expect(outcome.parkedAwaitingAnswer).toBe(true);
	expect(wiring.registry.peek("t1")?.dialogId).toBe("d2");
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
	for await (const _chunk of runChat({ transport, ids, prompt: "hi", onProblem: undefined, ...runWiring() })) {
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
		transport, ids, prompt: "hello", onProblem: undefined, noProgressTimeoutMs: 80, ...runWiring(),
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
		transport, ids, prompt: "hello", onProblem: undefined, noProgressTimeoutMs: 60, ...runWiring(),
	})) {
		chunks.push(chunk);
	}
	// All four deltas arrived and the run settled normally rather than timing out.
	expect(chunks.filter((chunk) => chunk.type === EventType.TEXT_MESSAGE_CONTENT)).toHaveLength(4);
	expect(chunks.at(-1)?.type).toBe(EventType.RUN_FINISHED);
});

/**
 * ⚠⚠ The slash-command quick close. An extension command never emits `agent_settled` —
 * its completion signal is the prompt ACKNOWLEDGEMENT (pi acks a prompt only after the
 * command it starts finishes). Observed live: the first answered `/mode` held its HTTP
 * response open for the full 90-second guard AFTER the mode had visibly changed.
 */
test("a slash-command run closes shortly after its ack, not at the no-progress guard", async () => {
	// Acks the prompt (= command completed), emits nothing else, never settles.
	const pi = piWithCommands(["mode"], []);
	const startedAt = Date.now();
	const chunks = [];
	for await (const chunk of runChat({
		transport: pi.transport, ids, prompt: "/mode auto", onProblem: undefined,
		noProgressTimeoutMs: 5_000, slashCommandGraceMs: 30, ...runWiring(),
	})) {
		chunks.push(chunk);
	}
	expect(chunks.at(-1)?.type).toBe(EventType.RUN_FINISHED);
	// well inside the 5s guard — the grace closed it, not the guard
	expect(Date.now() - startedAt).toBeLessThan(1_000);
});

test("⚠ an ordinary prompt is NOT closed by its ack — ack means accepted, not done", async () => {
	// Same silent-after-ack shape, but prose: only the no-progress guard may end it.
	const pi = piWithCommands([], []);
	const startedAt = Date.now();
	const chunks = [];
	for await (const chunk of runChat({
		transport: pi.transport, ids, prompt: "hello", onProblem: undefined,
		noProgressTimeoutMs: 120, slashCommandGraceMs: 5, ...runWiring(),
	})) {
		chunks.push(chunk);
	}
	expect(chunks.at(-1)?.type).toBe(EventType.RUN_FINISHED);
	// it waited for the guard, so the 5ms grace demonstrably did not apply
	expect(Date.now() - startedAt).toBeGreaterThanOrEqual(120);
});

test("an answered slash-command dialog closes its continuation at the grace too", async () => {
	// /mode opens the dialog; the answer completes the command (ack), nothing settles.
	const pi = dialogPi(SELECT_DIALOG, []);
	const wiring = runWiring();
	const chunks1 = [];
	for await (const chunk of runChat({
		transport: pi.transport, ids, prompt: "/mode", onProblem: undefined,
		noProgressTimeoutMs: 5_000, slashCommandGraceMs: 25, ...wiring,
	})) {
		chunks1.push(chunk);
	}
	expect((chunks1.at(-1) as InterruptChunk).outcome?.type).toBe("interrupt");
	// ⚠ the parked entry carries the slash-command fact to the continuation
	expect(wiring.registry.peek("t1")?.isExtensionCommand).toBe(true);

	const startedAt = Date.now();
	const resumeIds = { messageId: "m2", runId: "r2", threadId: "t1" };
	const chunks2 = [];
	for await (const chunk of resumeChat({
		registry: wiring.registry, ids: resumeIds, parentRunId: "r1",
		resume: [{ interruptId: "d1", status: "resolved", payload: { value: "auto" } }],
		outcome: { parkedAwaitingAnswer: false }, onProblem: undefined,
		noProgressTimeoutMs: 5_000, slashCommandGraceMs: 25,
	})) {
		chunks2.push(chunk);
	}
	expect(chunks2.at(-1)?.type).toBe(EventType.RUN_FINISHED);
	expect(Date.now() - startedAt).toBeLessThan(1_000);
});
