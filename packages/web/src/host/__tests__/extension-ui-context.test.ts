import { expect, test } from "bun:test";
import type { PiRpcEvent } from "@zen/core";
import { createZenExtensionUiContext } from "../extension-ui-context.ts";

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
