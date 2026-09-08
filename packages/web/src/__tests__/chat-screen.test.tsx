import { expect, test } from "bun:test";
import type { GenericAGUIInterrupt } from "@tanstack/ai-client";
import type { ChatUISelectedPart } from "@tanstack/ai-client/ui";
import { ZEN_DIALOG_KEY, type ZenDialogSpec } from "@zen/core";
import { renderToStaticMarkup } from "react-dom/server";
import {
	DialogAnswerControls,
	type KeyedPart,
	keyedParts,
	ThreadPane,
	UnhandledInterrupt,
	ZenDialogInterrupt,
} from "../chat-screen.tsx";
import { mintThread } from "../thread-stores.ts";

/**
 * #49, first pass: the dialog components had live receipts (#27, the e2e smoke) and no unit
 * render, so chat-screen.tsx sat at ~14% lines. These are static renders in the style of
 * selected-message-part.test.tsx — what each dialog METHOD puts on screen, and the visible
 * fallback for an interrupt the page cannot read. Click behaviour stays with the e2e smoke
 * (renderToStaticMarkup runs no handlers).
 */

const SELECT_DIALOG: ZenDialogSpec = {
	method: "select",
	title: "Select permission mode",
	options: ["Default", "Plan"],
};

function neverCalled(): void {
	// Static markup runs no handlers; the callbacks exist only to satisfy the props.
}

/** A fully-typed generic interrupt — no casts, so a TanStack shape change fails here. */
function genericInterrupt(overrides: Partial<GenericAGUIInterrupt> = {}): GenericAGUIInterrupt {
	return {
		kind: "generic",
		id: "i1",
		interruptId: "d1",
		reason: "zen:dialog",
		threadId: "t1",
		interruptedRunId: "r1",
		generation: 0,
		status: "pending",
		errors: [],
		canResolve: true,
		binding: { v: 1, kind: "generic", interruptId: "d1", interruptedRunId: "r1", generation: 0 },
		metadata: { [ZEN_DIALOG_KEY]: SELECT_DIALOG },
		resolveInterrupt: neverCalled,
		cancel: neverCalled,
		clearResolution: neverCalled,
		...overrides,
	};
}

const answerControls = (dialog: ZenDialogSpec) =>
	renderToStaticMarkup(<DialogAnswerControls dialog={dialog} answer={neverCalled} />);

// --- one render per dialog method
test("confirm renders the message with Yes and No", () => {
	const rendered = answerControls({ method: "confirm", title: "Proceed?", message: "Really overwrite?" });
	expect(rendered).toContain("Really overwrite?");
	expect(rendered).toContain(">Yes<");
	expect(rendered).toContain(">No<");
});

test("select renders one button per option, in order", () => {
	const rendered = answerControls(SELECT_DIALOG);
	expect(rendered.indexOf(">Default<")).toBeGreaterThan(-1);
	expect(rendered.indexOf(">Plan<")).toBeGreaterThan(rendered.indexOf(">Default<"));
	expect(rendered.match(/<button/g)).toHaveLength(2);
});

test("input renders a single-line field with the placeholder and an Answer button", () => {
	const rendered = answerControls({ method: "input", title: "Name?", placeholder: "your name" });
	expect(rendered).toContain('placeholder="your name"');
	expect(rendered).toContain("<input");
	expect(rendered).not.toContain("<textarea");
	expect(rendered).toContain(">Answer<");
});

test("editor renders a multi-line field prefilled with the draft", () => {
	const rendered = answerControls({ method: "editor", title: "Edit", prefill: "draft text" });
	expect(rendered).toContain("<textarea");
	expect(rendered).toContain("draft text");
	expect(rendered).toContain(">Answer<");
});

// --- the interrupt shell
test("a readable, resolvable dialog renders the pi-is-asking card with its title and a cancel", () => {
	const rendered = renderToStaticMarkup(<ZenDialogInterrupt interrupt={genericInterrupt()} />);
	expect(rendered).toContain("pi is asking");
	expect(rendered).toContain("Select permission mode");
	expect(rendered).toContain("Cancel — decline the question");
	expect(rendered).toContain(">Default<");
});

// ⚠ Visible, never dropped: a silently skipped interrupt is indistinguishable from one
// that was never sent.
test("an interrupt whose metadata is not a dialog spec renders the visible unhandled block", () => {
	const rendered = renderToStaticMarkup(
		<ZenDialogInterrupt interrupt={genericInterrupt({ metadata: { [ZEN_DIALOG_KEY]: { method: "select" } } })} />,
	);
	expect(rendered).toContain("interrupt (unhandled)");
	expect(rendered).not.toContain("pi is asking");
});

test("an unresolvable interrupt renders the unhandled block even when its dialog is readable", () => {
	const rendered = renderToStaticMarkup(<ZenDialogInterrupt interrupt={genericInterrupt({ canResolve: false })} />);
	expect(rendered).toContain("interrupt (unhandled)");
});

test("the unhandled block shows the interrupt as JSON so a reader can see what arrived", () => {
	const rendered = renderToStaticMarkup(<UnhandledInterrupt interrupt={{ reason: "mystery", detail: 42 }} />);
	expect(rendered).toContain("&quot;reason&quot;:&quot;mystery&quot;");
	expect(rendered).toContain("42");
});

// ── part keys are identities, not positions (#82) ─────────────────────────────
// The suppression these replace claimed the array index was fine because parts arrive in
// stable document order. Tool parts do NOT: the selection runs over the whole message list,
// so a result stamped onto another message re-pairs its call and shifts that call's index.

const textPart = (content: string): ChatUISelectedPart => ({ key: "text", part: { type: "text", content } });
const toolCallPart = (id: string): ChatUISelectedPart => ({
	key: "toolCall",
	part: { type: "tool-call", id, name: "read", arguments: "{}", state: "complete" },
});

test("⚠ a tool part keeps its key when its POSITION changes — an index key would remount it", () => {
	const call = toolCallPart("call-1");
	const first = keyedParts([call, textPart("after")]);
	const shifted = keyedParts([textPart("before"), textPart("between"), call]);
	const keyOf = (parts: KeyedPart[], id: string): string | undefined =>
		parts.find(({ selected }) => selected.key === "toolCall" && selected.part.id === id)?.partKey;
	expect(keyOf(first, "call-1")).toBe(keyOf(shifted, "call-1"));
});

test("two id-less parts of the same kind get distinct keys, so neither collides", () => {
	const keys = keyedParts([textPart("one"), textPart("two")]).map(({ partKey }) => partKey);
	expect(new Set(keys).size).toBe(2);
});

test("only the final part is the trailing one — what gates the streaming indicator", () => {
	const trailing = keyedParts([textPart("one"), toolCallPart("call-1"), textPart("two")]).map(
		({ isTrailingPart }) => isTrailingPart,
	);
	expect(trailing).toEqual([false, false, true]);
});

// ── the panes (#90 PR 3) ─────────────────────────────────────────────────────
// Every live thread's pane stays mounted (switching away must not abort its run), so
// anything gated on a page-level switch alone renders once PER THREAD. The debug column
// carries a fixed id and its own inspection fetches; it must exist in the active pane only.

test("⚠ two mounted panes with ?debug open render exactly ONE debug column, in the active pane", () => {
	const first = mintThread();
	const second = mintThread();
	const rendered = renderToStaticMarkup(
		<>
			<ThreadPane threadId={first.threadId} active={true} debugOpen={true} />
			<ThreadPane threadId={second.threadId} active={false} debugOpen={true} />
		</>,
	);
	expect(rendered.match(/id="session-debug-pane"/g)).toHaveLength(1);
	// The active pane is laid out; the other is hidden, not gone — its chat stays mounted.
	expect(rendered.match(/class="hidden"/g)).toHaveLength(1);
	expect(rendered.match(/id="session-status"/g)).toHaveLength(2);
	// And with the switch off, no pane shows one.
	const closed = renderToStaticMarkup(<ThreadPane threadId={first.threadId} active={true} debugOpen={false} />);
	expect(closed).not.toContain('id="session-debug-pane"');
});
