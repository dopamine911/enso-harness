import { beforeAll, expect, test } from "bun:test";
import type { PiRpcEvent } from "@zen/core";
import { type CustomComponentFactory, createZenExtensionUiContext } from "../extension-ui-context.ts";
import { PICC_PERMISSION_DIALOG_MODULE } from "../permission-dialog.ts";

/**
 * The `ExtensionUIContext` the host binds (#69), driven directly: the blocking methods
 * become `extension_ui_request` records and resolve on an answer, a cancel, an abort
 * signal or a timeout; the fire-and-forget methods emit and return; the terminal-only
 * surface is inert — pi's rpc mode's behaviour, which extensions already tolerate.
 */

function contextUnderTest() {
	const events: PiRpcEvent[] = [];
	const problems: unknown[] = [];
	const context = createZenExtensionUiContext({
		emit: (event) => events.push(event),
		onProblem: (problem) => problems.push(problem),
	});
	return { ...context, events, problems };
}

const requestId = (event: PiRpcEvent | undefined) => String(event?.id);

test("select emits a request and resolves to the answered value", async () => {
	const { uiContext, answerDialog, events, pendingDialogCount } = contextUnderTest();
	const pending = uiContext.select("Mode?", ["ask", "auto"]);
	expect(events[0]).toMatchObject({
		type: "extension_ui_request",
		method: "select",
		title: "Mode?",
		options: ["ask", "auto"],
	});
	expect(pendingDialogCount()).toBe(1);
	answerDialog({ id: requestId(events[0]), value: "auto" });
	expect(await pending).toBe("auto");
	expect(pendingDialogCount()).toBe(0);
});

test("confirm resolves true/false on the answer, and false on cancel — pi's cancel value", async () => {
	const { uiContext, answerDialog, events } = contextUnderTest();
	const yes = uiContext.confirm("Apply?", "It is reversible");
	answerDialog({ id: requestId(events[0]), confirmed: true });
	expect(await yes).toBe(true);
	const cancelled = uiContext.confirm("Again?", "m");
	answerDialog({ id: requestId(events[1]), cancelled: true });
	expect(await cancelled).toBe(false);
});

test("input and editor resolve to the value, or undefined on cancel", async () => {
	const { uiContext, answerDialog, events } = contextUnderTest();
	const typed = uiContext.input("Name?", "placeholder");
	expect(events[0]).toMatchObject({ method: "input", title: "Name?", placeholder: "placeholder" });
	answerDialog({ id: requestId(events[0]), value: "zen" });
	expect(await typed).toBe("zen");
	const edited = uiContext.editor("Edit", "prefill");
	expect(events[1]).toMatchObject({ method: "editor", title: "Edit", prefill: "prefill" });
	answerDialog({ id: requestId(events[1]), cancelled: true });
	expect(await edited).toBeUndefined();
});

test("a wrong-shaped answer degrades to the cancel value rather than a wrong type", async () => {
	const { uiContext, answerDialog, events } = contextUnderTest();
	const pending = uiContext.select("Pick", ["a"]);
	// a `confirmed` answer to a select carries no value
	answerDialog({ id: requestId(events[0]), confirmed: true });
	expect(await pending).toBeUndefined();
});

test("the caller's abort signal and timeout both resolve to the cancel value", async () => {
	const { uiContext, events, pendingDialogCount } = contextUnderTest();
	const controller = new AbortController();
	const aborted = uiContext.select("Pick", ["a"], { signal: controller.signal });
	controller.abort();
	expect(await aborted).toBeUndefined();
	const timedOut = uiContext.confirm("Slow?", "m", { timeout: 5 });
	expect(events[1]).toMatchObject({ method: "confirm", timeout: 5 });
	expect(await timedOut).toBe(false);
	// an already-aborted signal short-circuits without even registering
	const preAborted = new AbortController();
	preAborted.abort();
	expect(await uiContext.input("x", undefined, { signal: preAborted.signal })).toBeUndefined();
	expect(pendingDialogCount()).toBe(0);
});

test("cancelAllDialogs settles every pending dialog; a second answer is reported, not applied", async () => {
	const { uiContext, answerDialog, cancelAllDialogs, events, problems } = contextUnderTest();
	const a = uiContext.select("A", ["x"]);
	const b = uiContext.input("B");
	cancelAllDialogs();
	expect(await a).toBeUndefined();
	expect(await b).toBeUndefined();
	answerDialog({ id: requestId(events[0]), value: "x" });
	expect(problems).toHaveLength(1);
	expect(String(problems[0])).toContain(requestId(events[0]));
});

test("fire-and-forget methods emit the rpc-shaped record and return immediately", () => {
	const { uiContext, events } = contextUnderTest();
	uiContext.notify("hello", "warning");
	uiContext.setStatus("quota", "50%");
	uiContext.setWidget("w", ["line 1", "line 2"], { placement: "belowEditor" });
	// a component FACTORY has no serialisable form — pi's rule too — so it emits nothing
	uiContext.setWidget("ignored", () => ({ render: () => [], invalidate: () => undefined }));
	uiContext.setTitle("zen");
	uiContext.setEditorText("draft");
	expect(events.map((event) => event.method)).toEqual([
		"notify",
		"setStatus",
		"setWidget",
		"setTitle",
		"set_editor_text",
	]);
	expect(events[0]).toMatchObject({ message: "hello", notifyType: "warning" });
	expect(events[2]).toMatchObject({
		widgetKey: "w",
		widgetLines: ["line 1", "line 2"],
		widgetPlacement: "belowEditor",
	});
	expect(events[4]).toMatchObject({ text: "draft" });
});

test("the terminal-only surface is inert, exactly as in pi's rpc mode", async () => {
	const { uiContext, events } = contextUnderTest();
	expect(uiContext.onTerminalInput(() => undefined)()).toBeUndefined();
	uiContext.setWorkingMessage("x");
	uiContext.setWorkingVisible(true);
	uiContext.setWorkingIndicator();
	uiContext.setHiddenThinkingLabel("x");
	uiContext.setFooter(undefined);
	uiContext.setHeader(undefined);
	uiContext.pasteToEditor("x");
	uiContext.addAutocompleteProvider((current) => current);
	uiContext.setEditorComponent(undefined);
	uiContext.setToolsExpanded(true);
	expect(await uiContext.custom(() => ({ render: () => [], invalidate: () => undefined }))).toBeUndefined();
	expect(uiContext.getEditorText()).toBe("");
	expect(uiContext.getEditorComponent()).toBeUndefined();
	expect(uiContext.getAllThemes()).toEqual([]);
	expect(uiContext.getTheme("any")).toBeUndefined();
	expect(uiContext.setTheme("any").success).toBe(false);
	expect(uiContext.getToolsExpanded()).toBe(false);
	// the theme getter returns a real Theme, built once
	expect(uiContext.theme.getColorMode()).toBe("256color");
	expect(uiContext.theme).toBe(uiContext.theme);
	// none of that emitted anything
	expect(events).toEqual([]);
});

// ── picc's permission prompt, through `custom` (#73) ─────────────────────────

/** picc's `createFilePermissionDialogFactory(opts)` — the value it hands `ctx.ui.custom`. */
type PermissionFactoryBuilder = (options: Record<string, unknown>) => CustomComponentFactory<string | null>;

let createFilePermissionDialogFactory: PermissionFactoryBuilder;

beforeAll(async () => {
	// Runtime import, as the host does it: picc's sources must not enter this package's type graph.
	const loaded = (await import(PICC_PERMISSION_DIALOG_MODULE)) as {
		createFilePermissionDialogFactory: PermissionFactoryBuilder;
	};
	createFilePermissionDialogFactory = loaded.createFilePermissionDialogFactory;
});

/** Drain microtasks until `count` records exist — the lift awaits a cached module promise, so depth is not one tick. */
async function untilEmitted(events: PiRpcEvent[], count: number): Promise<void> {
	for (let drained = 0; drained < 100 && events.length < count; drained += 1) await Promise.resolve();
}

const WRITE_PROMPT = {
	options: ["Yes", "Yes, allow all edits during this session (shift+tab)", "No"],
	title: "Create file",
	subtitle: "receipt-73.txt",
	question: "Do you want to create this file: receipt-73.txt?",
	previewLines: ["ok"],
	showPanel: true,
};

test("⚠⚠ picc's permission prompt reaches the browser as a select with its options and detail, and the answer is the option string", async () => {
	const { uiContext, answerDialog, events, pendingDialogCount } = contextUnderTest();
	// Exactly picc's call: `ctx.ui.custom<FilePermissionChoice>(createFilePermissionDialogFactory(opts), {overlay…})`.
	const pending = uiContext.custom<string | null>(createFilePermissionDialogFactory(WRITE_PROMPT), { overlay: true });
	await untilEmitted(events, 1); // the factory and the lift are awaited before the request is emitted
	expect(events).toHaveLength(1);
	expect(events[0]).toMatchObject({
		type: "extension_ui_request",
		method: "select",
		title: "Create file",
		options: WRITE_PROMPT.options,
	});
	expect(String(events[0]?.message)).toContain("Do you want to create this file: receipt-73.txt?");
	expect(String(events[0]?.message)).toContain("ok");
	expect(pendingDialogCount()).toBe(1);
	answerDialog({ id: requestId(events[0]), value: "Yes" });
	// picc's own check is `choice === "Yes"` — the string it offered, back verbatim.
	expect(await pending).toBe("Yes");
	expect(pendingDialogCount()).toBe(0);
});

test("cancelling the lifted prompt resolves picc's 'dismissed' value; a non-picc component still resolves undefined at once", async () => {
	const { uiContext, answerDialog, cancelAllDialogs, events } = contextUnderTest();
	const dismissed = uiContext.custom<string | null>(createFilePermissionDialogFactory(WRITE_PROMPT));
	await untilEmitted(events, 1);
	answerDialog({ id: requestId(events[0]), cancelled: true });
	expect(await dismissed).toBeUndefined();
	// teardown while a prompt is open: the extension is released, not left hanging
	const torn = uiContext.custom<string | null>(createFilePermissionDialogFactory(WRITE_PROMPT));
	await untilEmitted(events, 2);
	cancelAllDialogs();
	expect(await torn).toBeUndefined();
	// and pi's rpc contract for anything else is untouched: no request, undefined
	const before = events.length;
	expect(await uiContext.custom(() => ({ render: () => [], invalidate: () => undefined }))).toBeUndefined();
	expect(events).toHaveLength(before);
});

// ⚠ The catch that exists so a picc module that fails to load can never silently reopen #73:
// the extension is released with "dismissed", the operator is told why, no request is emitted.
test("⚠ a lift that rejects (picc's module did not load) fails closed: undefined to the extension, a report to onProblem, no request", async () => {
	const events: PiRpcEvent[] = [];
	const problems: unknown[] = [];
	const { uiContext } = createZenExtensionUiContext({
		emit: (event) => events.push(event),
		onProblem: (problem) => problems.push(problem),
		liftDialog: () => Promise.reject(new Error("Cannot find module filePermissionDialog.ts")),
	});
	const answer = await uiContext.custom<string | null>(createFilePermissionDialogFactory(WRITE_PROMPT));
	expect(answer).toBeUndefined();
	expect(events).toEqual([]);
	expect(problems).toHaveLength(1);
	expect(String(problems[0])).toContain("#73");
	expect(String(problems[0])).toContain("Cannot find module");
});

test("a factory that resolves no component degrades to undefined instead of throwing on dispose", async () => {
	const { uiContext, events } = contextUnderTest();
	// Outside the declared type on purpose: a buggy extension, not a typed caller.
	const noComponent = (() => undefined) as unknown as CustomComponentFactory<unknown>;
	expect(await uiContext.custom(noComponent)).toBeUndefined();
	expect(events).toEqual([]);
});

// ⚠ pi's rpc mode never ran the factory, so every non-picc factory used to get `undefined` at
// once. Building against the inert terminal must not take that away (Codex, PR #107): a factory
// that throws, rejects, or never produces a component falls back the same way, with a report.
test("⚠ a factory that throws or rejects against the inert terminal falls back to undefined, reported, no request", async () => {
	const { uiContext, events, problems } = contextUnderTest();
	const throwing = (() => {
		throw new Error("tui.requestRender is not a function");
	}) as unknown as CustomComponentFactory<unknown>;
	expect(await uiContext.custom(throwing)).toBeUndefined();
	const rejecting = (() => Promise.reject(new Error("no terminal"))) as unknown as CustomComponentFactory<unknown>;
	expect(await uiContext.custom(rejecting)).toBeUndefined();
	expect(events).toEqual([]);
	expect(problems.map(String).every((problem) => problem.includes("resolving undefined"))).toBe(true);
	expect(problems).toHaveLength(2);
});

test("⚠ an async factory that never produces a component is cut off at the build budget, not awaited forever", async () => {
	const events: PiRpcEvent[] = [];
	const problems: unknown[] = [];
	const { uiContext } = createZenExtensionUiContext({
		emit: (event) => events.push(event),
		onProblem: (problem) => problems.push(problem),
		// The code's own timer with a tiny budget — the test awaits the promise it exposes, not a sleep.
		componentBuildTimeoutMs: 1,
	});
	const waitingOnATerminal = (() => new Promise(() => undefined)) as unknown as CustomComponentFactory<unknown>;
	expect(await uiContext.custom(waitingOnATerminal)).toBeUndefined();
	expect(events).toEqual([]);
	expect(String(problems[0])).toContain("no component within 1 ms");
});
