import { expect, test } from "bun:test";
import type { GenericAGUIInterrupt } from "@tanstack/ai-client";
import { ZEN_DIALOG_KEY, type ZenDialogSpec } from "@zen/core";
import { renderToStaticMarkup } from "react-dom/server";
import { DialogAnswerControls, UnhandledInterrupt, ZenDialogInterrupt } from "../chat-screen.tsx";

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
