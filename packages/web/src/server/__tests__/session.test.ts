import { expect, test } from "bun:test";
import { EventType } from "@ag-ui/core";
import type {
	PiCommand,
	PiDialogResponse,
	PiEventDelivery,
	PiPromptOutcome,
	PiPromptRequest,
	PiRpcEvent,
	PiSession,
} from "@zen/core";
import { createDialogRegistry } from "../dialog-registry.ts";
import { type ChatRunOutcome, resumeChat, runChat } from "../session.ts";

/**
 * Everything a fake session records — the assertions read these instead of wire strings.
 * `prompts` is what reached pi; `answers` are the dialog responses delivered; `commandLookups`
 * counts `listCommands` calls (a prose prompt must never trigger one).
 */
interface FakeSessionRecord {
	prompts: PiPromptRequest[];
	answers: PiDialogResponse[];
	commandLookups: number;
	disposed: number;
	/** Live `subscribe` handles — a run must leave none behind once it ends unparked (#69 PR 2). */
	subscriberCount: () => number;
}

interface FakeSessionScript {
	/** What `listCommands` returns. */
	commands?: string[];
	/** Called when a prompt arrives — the fake decides when to accept, reject, and emit. */
	onPrompt: (context: FakeSessionContext, request: PiPromptRequest, outcome: PiPromptOutcome) => void;
	/** Called when a dialog answer arrives — the fake decides what pi does next. */
	onAnswer?: (context: FakeSessionContext, response: PiDialogResponse) => void;
}

interface FakeSessionContext {
	/** Emit one wire-shaped event, as a JSON string (the tests read like the old wire fixtures). */
	emit: (eventJson: string) => void;
	record: FakeSessionRecord;
}

/**
 * A scripted `PiSession`. The events are still written as JSON strings so every fixture
 * below reads exactly as it did over the subprocess wire — the host delivers the same
 * shapes in-process (#69), which is the point these tests keep pinned.
 */
function fakeSession(script: FakeSessionScript): { session: PiSession; record: FakeSessionRecord } {
	const listeners = new Set<(event: PiRpcEvent, delivery: PiEventDelivery) => void>();
	const record: FakeSessionRecord = {
		prompts: [],
		answers: [],
		commandLookups: 0,
		disposed: 0,
		subscriberCount: () => listeners.size,
	};
	const context: FakeSessionContext = {
		emit: (eventJson) => {
			const event = JSON.parse(eventJson) as PiRpcEvent;
			for (const listener of listeners) listener(event, "live");
		},
		record,
	};
	const session: PiSession = {
		prompt: (request, outcome) => {
			record.prompts.push(request);
			script.onPrompt(context, request, outcome);
		},
		answerDialog: (response) => {
			record.answers.push(response);
			script.onAnswer?.(context, response);
		},
		listCommands: () => {
			record.commandLookups += 1;
			return (script.commands ?? []).map((name): PiCommand => ({ name, source: "extension" }));
		},
		// A receipt shaped like the host's: default mode, and picc's modes as far as this
		// fake's command list registers them (#84). Reads `script.commands` directly rather
		// than through `listCommands`, mirroring the host — so `commandLookups` still counts
		// only refusal-path lookups.
		permissionModeState: () => ({
			mode: "default",
			available: (script.commands ?? []).filter((name) => name !== "mode"),
		}),
		subscribe: (onEvent) => {
			listeners.add(onEvent);
			return () => listeners.delete(onEvent);
		},
		abort: () => Promise.resolve(),
		dispose: () => {
			record.disposed += 1;
		},
	};
	return { session, record };
}

/** A scripted pi: accepts the prompt, then emits whatever the test lists — asynchronously, as pi does. */
function scriptedPi(events: string[], commands: string[] = []) {
	return fakeSession({
		commands,
		onPrompt: (context, _request, outcome) => {
			queueMicrotask(() => {
				outcome.onAccepted();
				for (const event of events) context.emit(event);
			});
		},
	});
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
			answerTimeoutMs: 5000,
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
	for await (const chunk of runChat({
		session: pi.session,
		ids,
		prompt: "hello",
		onProblem: undefined,
		...wiring,
		...(images ? { images } : {}),
	})) {
		chunks.push(chunk);
	}
	return { chunks, record: pi.record };
}
type ChatImages = ReadonlyArray<{ type: "image"; data: string; mimeType: string }>;

test("a run opens with RUN_STARTED, then the mode receipt, then TEXT_MESSAGE_START (#84)", async () => {
	const { chunks } = await collect(['{"type":"agent_settled"}']);
	expect(chunks.slice(0, 3).map((c) => c.type)).toEqual([
		EventType.RUN_STARTED,
		EventType.CUSTOM,
		EventType.TEXT_MESSAGE_START,
	]);
	expect(chunks[1]).toMatchObject({ name: "zen.mode", value: { mode: "default" } });
});

test("⚠ the mode receipt carries the session's own state, and rides even on a REFUSED command (#84)", async () => {
	// The dropdown's option list is what the session registers — here the fake registers
	// two mode commands beside `/mode` — and a refused run must still tell the browser what
	// mode it is in: that refusal IS the #73 scenario the receipt exists to make legible.
	const pi = piWithCommands(["mode", "default", "acceptEdits"]);
	const chunks = await runWith(pi, "/settings");
	expect(chunks.some((c) => c.type === EventType.RUN_ERROR)).toBe(true);
	expect(chunks[1]).toMatchObject({
		type: EventType.CUSTOM,
		name: "zen.mode",
		value: { mode: "default", available: ["default", "acceptEdits"] },
	});
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

test("images are forwarded verbatim on the prompt", async () => {
	const { record } = await collect(
		['{"type":"agent_settled"}'],
		[{ type: "image", data: "aGk=", mimeType: "image/png" }],
	);
	expect(record.prompts[0]?.images?.[0]).toMatchObject({ mimeType: "image/png", data: "aGk=" });
});

// A rejected prompt is a protocol outcome; the client must be told why, not disconnected.
test("a rejected prompt yields RUN_ERROR rather than throwing", async () => {
	const pi = fakeSession({
		onPrompt: (_context, _request, outcome) => queueMicrotask(() => outcome.onRejected("already streaming")),
	});
	const chunks = [];
	for await (const chunk of runChat({ session: pi.session, ids, prompt: "x", onProblem: undefined, ...runWiring() }))
		chunks.push(chunk);
	const error = chunks.find((c) => c.type === EventType.RUN_ERROR);
	expect(error).toMatchObject({ runId: "r1", message: "already streaming" });
});

// ⓘ The subprocess era had a "malformed record is reported and does not hang" case here.
// In-process there is no wire to garble: the host translates typed events, and a
// translation failure is reported by the host (`agent-host.ts`) rather than seen here.

test("an unmodelled pi event still reaches the client, as CUSTOM", async () => {
	const { chunks } = await collect(['{"type":"queue_update","depth":3}', '{"type":"agent_settled"}']);
	// Name-specific: the run's own `zen.mode` receipt is also a CUSTOM chunk (#84).
	const custom = chunks.find((c) => c.type === EventType.CUSTOM && "name" in c && c.name === "zen.unmapped");
	expect(custom).toMatchObject({ name: "zen.unmapped" });
});

/**
 * ⚠ Slash-command handling. Observed in a real session: `/settings` was forwarded as an
 * ordinary prompt and the MODEL answered it by reading config files — a plausible,
 * unauthoritative guess that looked like the command had worked. pi's docs are explicit
 * that built-in TUI commands cannot execute over rpc, so they must be refused locally.
 */
function piWithCommands(commandNames: string[], events: string[] = ['{"type":"agent_settled"}']) {
	return scriptedPi(events, commandNames);
}

async function runWith(pi: { session: PiSession }, prompt: string) {
	const chunks = [];
	for await (const chunk of runChat({ session: pi.session, ids, prompt, onProblem: undefined, ...runWiring() })) {
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
	expect(pi.record.prompts).toHaveLength(0);
});

test("a KNOWN slash command is forwarded, because pi can run it", async () => {
	const pi = piWithCommands(["mode", "plan"]);
	const chunks = await runWith(pi, "/mode auto");
	expect(chunks.some((chunk) => chunk.type === EventType.RUN_ERROR)).toBe(false);
	expect(pi.record.prompts).toHaveLength(1);
	expect(chunks.at(-1)?.type).toBe(EventType.RUN_FINISHED);
});

test("ordinary prose never triggers a command lookup", async () => {
	const pi = piWithCommands(["mode"]);
	await runWith(pi, "what is in this repo?");
	expect(pi.record.commandLookups).toBe(0);
});

test("the refusal says 'none' rather than an empty list when pi has no commands", async () => {
	const pi = piWithCommands([]);
	const chunks = await runWith(pi, "/anything");
	expect((chunks.find((c) => c.type === EventType.RUN_ERROR) as { message: string }).message).toContain("none");
});

test("a bare slash is treated as prose, not a command lookup", async () => {
	const pi = piWithCommands(["mode"]);
	await runWith(pi, "/");
	expect(pi.record.commandLookups).toBe(0);
});

/**
 * ⚠⚠ The no-progress guard. Observed with `/mode`: the command emitted RUN_ERROR and then
 * left the SSE response OPEN FOREVER, because `runChat` terminates on `agent_settled` and
 * an extension command that runs no inference never emits one. An HTTP stream that never
 * closes shows a spinner with no error raised anywhere.
 */
test("a run that never settles ends itself rather than hanging", async () => {
	// pi accepts the prompt, emits one event, then goes silent — never settling.
	const pi = scriptedPi(['{"type":"turn_start"}']);
	const chunks = [];
	for await (const chunk of runChat({
		session: pi.session,
		ids,
		prompt: "hello",
		onProblem: undefined,
		noProgressTimeoutMs: 40,
		...runWiring(),
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
		session: pi.session,
		ids,
		prompt: "hi",
		onProblem: undefined,
		noProgressTimeoutMs: 40,
		...runWiring(),
	})) {
		chunks.push(chunk);
	}
	expect(chunks.filter((chunk) => chunk.type === EventType.RUN_FINISHED)).toHaveLength(1);
});

// ⚠ #99: a tool that is WORKING must not read as a hung run. `tool_execution_update` crosses
// to the browser as nothing (AG-UI has no progress event), so before this the guard saw
// silence for the whole tool call and ended the run mid-search at the cutoff (web_search, #98).
test("⚠ a tool call running for 2× the no-progress cutoff, streaming updates, is not cut off — its result and the settle arrive", async () => {
	const cutoffMs = 40;
	const pi = fakeSession({
		onPrompt: (context, _request, outcome) => {
			outcome.onAccepted();
			context.emit('{"type":"tool_execution_start","toolCallId":"c1","toolName":"web_search","args":{"query":"x"}}');
			// Updates every quarter-cutoff for two cutoffs, then the result and the settle.
			let ticks = 0;
			const interval = setInterval(() => {
				ticks += 1;
				context.emit(
					`{"type":"tool_execution_update","toolCallId":"c1","toolName":"web_search","partialResult":{"content":[{"type":"text","text":"searching… ${ticks}"}]}}`,
				);
				if (ticks < 8) return;
				clearInterval(interval);
				context.emit(
					'{"type":"tool_execution_end","toolCallId":"c1","toolName":"web_search","result":{"content":[{"type":"text","text":"found it"}]},"isError":false}',
				);
				context.emit('{"type":"agent_settled"}');
			}, cutoffMs / 4);
		},
	});
	const chunks = [];
	for await (const chunk of runChat({
		session: pi.session,
		ids,
		prompt: "search",
		onProblem: undefined,
		noProgressTimeoutMs: cutoffMs,
		...runWiring(),
	})) {
		chunks.push(chunk);
	}
	// The result crossed — the run was alive to carry it — and the run ended on the settle, once.
	expect(chunks.some((chunk) => chunk.type === EventType.TOOL_CALL_RESULT)).toBe(true);
	expect(chunks.filter((chunk) => chunk.type === EventType.RUN_FINISHED)).toHaveLength(1);
});

/**
 * ⚠⚠ #27: a blocking dialog INTERRUPTS the run — the browser answers it, pi stays alive.
 *
 * The fake mirrors the real ordering, which is the load-bearing part: pi asks the question
 * BEFORE reporting the prompt accepted (the command cannot complete while the dialog
 * blocks), and acceptance plus everything after it arrive only once the dialog is answered.
 * The pre-#27 code hung exactly here — an await on acceptance stood in front of the drain
 * loop.
 */
function dialogPi(dialogEvent: string, afterAnswer: string[] = ['{"type":"agent_settled"}']) {
	let pendingOutcome: PiPromptOutcome | undefined;
	return fakeSession({
		commands: ["mode"],
		onPrompt: (context, _request, outcome) => {
			pendingOutcome = outcome;
			queueMicrotask(() => context.emit(dialogEvent));
		},
		onAnswer: (context) => {
			queueMicrotask(() => {
				pendingOutcome?.onAccepted();
				for (const event of afterAnswer) context.emit(event);
			});
		},
	});
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
		session: pi.session,
		ids,
		prompt: "do a thing",
		onProblem: undefined,
		...wiring,
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
		v: 1,
		kind: "generic",
		interruptId: "d1",
		interruptedRunId: "r1",
		generation: 0,
	});
	// the question itself rides under the zen key, whole
	expect(interrupt?.metadata["zen:dialog"]).toEqual({
		method: "select",
		title: "Select permission mode",
		options: ["ask", "auto", "deny"],
	});

	// nothing was declined, the session was parked rather than stopped
	expect(pi.record.answers).toHaveLength(0);
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
		registry: wiring.registry,
		ids: resumeIds,
		parentRunId,
		resume,
		outcome,
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

	// pi received exactly the answer, keyed to the dialog id
	expect(pi.record.answers).toEqual([{ id: "d1", value: "auto" }]);
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
	expect(pi.record.answers).toHaveLength(0);
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

	expect(pi.record.answers).toEqual([{ id: "d1", cancelled: true }]);
	expect(chunks.at(-1)?.type).toBe(EventType.RUN_FINISHED);
	expect(wiring.registry.peek("t1")).toBeUndefined();
});

test("a resume with no parked question is told so instead of hanging or crashing", async () => {
	const wiring = runWiring();
	const { chunks } = await resumeWith(wiring, [{ interruptId: "d1", status: "resolved", payload: { value: "auto" } }]);
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
	expect(pi.record.answers).toHaveLength(0);
	// ⚠ the decisive half: a bad request must not destroy the parked question
	expect(wiring.registry.peek("t1")?.dialogId).toBe("d1");
});

test("⚠ an unanswered dialog is evicted: declined, run stopped, pump released", async () => {
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

	expect(pi.record.answers).toEqual([{ id: "d1", cancelled: true }]);
	expect(wiring.stopCount).toBe(1);
	expect(wiring.registry.peek("t1")).toBeUndefined();
	// The session outlives the evicted run (#69 PR 2): the parked pump must not stay
	// subscribed for the thread's remaining lifetime, filling `pending` nobody drains.
	expect(pi.record.subscriberCount()).toBe(0);
	// eviction is reported, never silent
	expect(wiring.problems.some((problem) => String(problem).includes("unanswered"))).toBe(true);
});

// The degenerate case: blocking, but the question could not be read into a spec (no
// options on a select). Pre-#27 behaviour: decline on the wire, tell the user, run on.
test("a malformed blocking dialog is declined immediately rather than parked", async () => {
	const pi = dialogPi('{"type":"extension_ui_request","id":"d1","method":"select","title":"pick"}');
	const { chunks, wiring } = await runIntoDialog(pi);

	expect(pi.record.answers).toEqual([{ id: "d1", cancelled: true }]);
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
	const pi = fakeSession({
		onPrompt: (context, _request, outcome) =>
			queueMicrotask(() => {
				context.emit('{"type":"extension_ui_request","id":"n1","method":"setStatus","statusKey":"x"}');
				outcome.onAccepted();
				context.emit('{"type":"agent_settled"}');
			}),
	});
	for await (const _chunk of runChat({
		session: pi.session,
		ids,
		prompt: "hi",
		onProblem: undefined,
		...runWiring(),
	})) {
		// drain
	}
	expect(pi.record.answers).toHaveLength(0);
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
	let heartbeat: ReturnType<typeof setInterval> | undefined;
	const pi = fakeSession({
		onPrompt: (context, _request, outcome) =>
			queueMicrotask(() => {
				outcome.onAccepted();
				// Traffic that produces no chunks, faster than the deadline — exactly the
				// shape that defeated the first implementation.
				heartbeat = setInterval(() => {
					context.emit('{"type":"extension_ui_request","id":"h","method":"setStatus","statusKey":"quota"}');
				}, 10);
			}),
	});
	const chunks = [];
	for await (const chunk of runChat({
		session: pi.session,
		ids,
		prompt: "hello",
		onProblem: undefined,
		noProgressTimeoutMs: 80,
		...runWiring(),
	})) {
		chunks.push(chunk);
	}
	if (heartbeat !== undefined) clearInterval(heartbeat);
	// Terminating at all is the assertion — the old version looped forever here.
	expect(chunks.at(-1)?.type).toBe(EventType.RUN_FINISHED);
});

test("real output DOES renew the deadline, so a slow answer is not cut off", async () => {
	const pi = fakeSession({
		onPrompt: (context, _request, outcome) =>
			queueMicrotask(async () => {
				outcome.onAccepted();
				// Four deltas at 30ms with a 60ms window: each renews, so none is cut off.
				for (let index = 0; index < 4; index += 1) {
					await new Promise((resolve) => setTimeout(resolve, 30));
					context.emit(
						'{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"x"}}',
					);
				}
				context.emit('{"type":"agent_settled"}');
			}),
	});
	const chunks = [];
	for await (const chunk of runChat({
		session: pi.session,
		ids,
		prompt: "hello",
		onProblem: undefined,
		noProgressTimeoutMs: 60,
		...runWiring(),
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
		session: pi.session,
		ids,
		prompt: "/mode auto",
		onProblem: undefined,
		noProgressTimeoutMs: 5000,
		slashCommandGraceMs: 30,
		...runWiring(),
	})) {
		chunks.push(chunk);
	}
	expect(chunks.at(-1)?.type).toBe(EventType.RUN_FINISHED);
	// well inside the 5s guard — the grace closed it, not the guard
	expect(Date.now() - startedAt).toBeLessThan(1000);
});

test("⚠ an ordinary prompt is NOT closed by its ack — ack means accepted, not done", async () => {
	// Same silent-after-ack shape, but prose: only the no-progress guard may end it.
	const pi = piWithCommands([], []);
	const startedAt = Date.now();
	const chunks = [];
	for await (const chunk of runChat({
		session: pi.session,
		ids,
		prompt: "hello",
		onProblem: undefined,
		noProgressTimeoutMs: 120,
		slashCommandGraceMs: 5,
		...runWiring(),
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
		session: pi.session,
		ids,
		prompt: "/mode",
		onProblem: undefined,
		noProgressTimeoutMs: 5000,
		slashCommandGraceMs: 25,
		...wiring,
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
		registry: wiring.registry,
		ids: resumeIds,
		parentRunId: "r1",
		resume: [{ interruptId: "d1", status: "resolved", payload: { value: "auto" } }],
		outcome: { parkedAwaitingAnswer: false },
		onProblem: undefined,
		noProgressTimeoutMs: 5000,
		slashCommandGraceMs: 25,
	})) {
		chunks2.push(chunk);
	}
	expect(chunks2.at(-1)?.type).toBe(EventType.RUN_FINISHED);
	expect(Date.now() - startedAt).toBeLessThan(1000);
});

// ── Per-thread sessions (#69 PR 2): the session outlives the run, the pump must not ─────

test("a settled run leaves no subscription on the session, and a second run on the same session streams cleanly", async () => {
	// One fake session, two prompts — the shape a thread now has. The scripted events are
	// identical, so a leaked subscriber from run 1 would show up as doubled chunks in run 2,
	// and a stale `settled` would end run 2 with no text at all.
	const events = [
		'{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"hi"}}',
		'{"type":"agent_settled"}',
	];
	const pi = scriptedPi(events);
	const wiring = runWiring();
	async function run(runId: string) {
		const chunks = [];
		for await (const chunk of runChat({
			session: pi.session,
			ids: { ...ids, runId },
			prompt: "hello",
			onProblem: undefined,
			...wiring,
		})) {
			chunks.push(chunk);
		}
		return chunks;
	}
	expect(pi.record.subscriberCount()).toBe(0);
	const first = await run("r1");
	expect(pi.record.subscriberCount()).toBe(0);
	const second = await run("r2");
	expect(pi.record.subscriberCount()).toBe(0);
	const textChunks = (chunks: typeof second) => chunks.filter((chunk) => chunk.type === EventType.TEXT_MESSAGE_CONTENT);
	expect(textChunks(first)).toHaveLength(1);
	expect(textChunks(second)).toHaveLength(1);
	expect(second.at(-1)?.type).toBe(EventType.RUN_FINISHED);
	expect(pi.record.disposed).toBe(0);
});

test("a parked run keeps its subscription until the resume ends, then releases it", async () => {
	const pi = dialogPi(SELECT_DIALOG);
	const wiring = runWiring();
	for await (const _chunk of runChat({ session: pi.session, ids, prompt: "/mode", onProblem: undefined, ...wiring })) {
		// drain
	}
	expect(wiring.outcome.parkedAwaitingAnswer).toBe(true);
	// Parked: the pump is still listening, because pi's answer-side events must reach it.
	expect(pi.record.subscriberCount()).toBe(1);
	await resumeWith(wiring, [{ interruptId: "d1", status: "resolved", payload: { value: "auto" } }]);
	expect(pi.record.subscriberCount()).toBe(0);
});

test("a client that abandons the stream mid-run also releases the subscription", async () => {
	// The server's `for await` exits on a disconnect, which calls `return()` on the
	// generator; the release must run from that path too or every dropped tab leaks one.
	const pi = fakeSession({
		onPrompt: (context, _request, outcome) => {
			queueMicrotask(() => {
				outcome.onAccepted();
				context.emit(
					'{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"a"}}',
				);
			});
		},
	});
	const wiring = runWiring();
	const stream = runChat({ session: pi.session, ids, prompt: "hello", onProblem: undefined, ...wiring });
	for await (const chunk of stream) {
		if (chunk.type === EventType.TEXT_MESSAGE_CONTENT) break;
	}
	expect(pi.record.subscriberCount()).toBe(0);
});

// ── Registry shutdown and resume-shape refusal (#53 S2: both were deletable unnoticed) ──

test("⚠ registry.shutdown declines every parked dialog, stops its run, and releases its pump", async () => {
	const pi = dialogPi(SELECT_DIALOG);
	const wiring = runWiring();
	await runIntoDialog(pi, wiring);
	expect(wiring.registry.peek("t1")).toBeDefined();

	wiring.registry.shutdown();

	expect(pi.record.answers).toEqual([{ id: "d1", cancelled: true }]);
	expect(wiring.registry.peek("t1")).toBeUndefined();
	expect(pi.record.subscriberCount()).toBe(0);
	expect(wiring.problems.some((problem) => String(problem).includes("server shutdown"))).toBe(true);
	// The stop follows the eviction grace (5 ms in this wiring).
	await new Promise((resolve) => setTimeout(resolve, 30));
	expect(wiring.stopCount).toBe(1);
});

test("a resume carrying two entries is refused and the question stays parked", async () => {
	const pi = dialogPi(SELECT_DIALOG);
	const wiring = runWiring();
	await runIntoDialog(pi, wiring);
	const { chunks, outcome } = await resumeWith(wiring, [
		{ interruptId: "d1", status: "resolved", payload: { value: "auto" } },
		{ interruptId: "d1", status: "resolved", payload: { value: "deny" } },
	]);
	const error = chunks.find((chunk) => chunk.type === EventType.RUN_ERROR);
	expect(error).toMatchObject({ message: expect.stringContaining("exactly one") });
	expect(outcome.parkedAwaitingAnswer).toBe(false);
	// Nothing was delivered to pi; the parked question is still answerable.
	expect(pi.record.answers).toHaveLength(0);
	expect(wiring.registry.peek("t1")?.dialogId).toBe("d1");
});

test("⚠ a second question on a parked thread displaces the first: declined, reported, pump released", async () => {
	const first = dialogPi(SELECT_DIALOG);
	const wiring = runWiring();
	await runIntoDialog(first, wiring);
	expect(wiring.registry.peek("t1")?.dialogId).toBe("d1");

	// A second run on the SAME thread (another tab, a retry) reaches its own dialog.
	const second = dialogPi(SELECT_DIALOG.replace('"id":"d1"', '"id":"d2"'));
	const secondOutcome = { parkedAwaitingAnswer: false };
	for await (const _chunk of runChat({
		session: second.session,
		ids,
		prompt: "/mode",
		registry: wiring.registry,
		stopPi: wiring.stopPi,
		outcome: secondOutcome,
		onProblem: undefined,
	})) {
		// drain
	}

	// One thread, one live question: the first was declined on the wire and reported.
	expect(first.record.answers).toEqual([{ id: "d1", cancelled: true }]);
	expect(wiring.problems.some((problem) => String(problem).includes("displaced"))).toBe(true);
	expect(first.record.subscriberCount()).toBe(0);
	expect(wiring.registry.peek("t1")?.dialogId).toBe("d2");
	expect(second.record.subscriberCount()).toBe(1);
	expect(secondOutcome.parkedAwaitingAnswer).toBe(true);
});
