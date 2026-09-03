import { expect, test } from "bun:test";
import type { ToolResultPart } from "@tanstack/ai";
import { renderToStaticMarkup } from "react-dom/server";
import {
	isZenToolResultDescriptor,
	readZenToolResultDescriptor,
	ZEN_TOOL_RESULT_KEY,
} from "@zen/core";
import { ZenToolResult, type ZenRendererMap } from "../ZenToolResult.tsx";

const partWith = (overrides: Partial<ToolResultPart>): ToolResultPart => ({
	type: "tool-result",
	toolCallId: "call-1",
	content: "PLAIN TEXT FORM",
	state: "complete" as ToolResultPart["state"],
	...overrides,
});

const renderers: ZenRendererMap = {
	"diff": (props) => <span data-known>{String(props.summary)}</span>,
};

const html = (result?: ToolResultPart) =>
	renderToStaticMarkup(<ZenToolResult result={result} renderers={renderers} />);

// --- the descriptor reader, pure and surface-independent
test("reads a well-formed descriptor out of metadata", () => {
	const found = readZenToolResultDescriptor({
		[ZEN_TOOL_RESULT_KEY]: { kind: "diff", props: { summary: "3 files" } },
	});
	expect(found?.kind).toBe("diff");
});
test("absent metadata yields no descriptor", () =>
	expect(readZenToolResultDescriptor(undefined)).toBeUndefined());
test("a malformed descriptor is rejected, not coerced", () => {
	expect(isZenToolResultDescriptor({ kind: "", props: {} })).toBe(false);
	expect(isZenToolResultDescriptor({ kind: "diff" })).toBe(false);
	expect(isZenToolResultDescriptor("diff")).toBe(false);
});

// --- rendering. ⚠ Every case below must produce VISIBLE output; a blank render is the
// failure mode this contract exists to prevent.
test("a known kind renders through its renderer", () => {
	const out = html(partWith({ metadata: { [ZEN_TOOL_RESULT_KEY]: { kind: "diff", props: { summary: "3 files" } } } }));
	expect(out).toContain("3 files");
	expect(out).toContain('data-zen-kind="diff"');
});

test("⚠ an UNKNOWN kind falls back to the envelope text, never to blank", () => {
	const out = html(partWith({ metadata: { [ZEN_TOOL_RESULT_KEY]: { kind: "no-such-renderer", props: {} } } }));
	expect(out).toContain("PLAIN TEXT FORM");
	expect(out.length).toBeGreaterThan(0);
});

test("no descriptor at all falls back to the envelope text", () =>
	expect(html(partWith({}))).toContain("PLAIN TEXT FORM"));

test("an in-flight call says so rather than rendering nothing", () =>
	expect(html(undefined)).toContain("running"));

test("an errored result shows the error, not the descriptor", () => {
	const out = html(partWith({ error: "tool exploded", metadata: { [ZEN_TOOL_RESULT_KEY]: { kind: "diff", props: { summary: "x" } } } }));
	expect(out).toContain("tool exploded");
	expect(out).not.toContain("data-zen-kind");
});

test("truncation is rendered from data, not from a pre-rendered string", () => {
	const out = html(partWith({
		metadata: { [ZEN_TOOL_RESULT_KEY]: { kind: "diff", props: { summary: "s" }, truncated: { shown: 500, total: 4000, unit: "lines" } } },
	}));
	expect(out).toContain("500");
	expect(out).toContain("4000");
	expect(out).toContain("lines");
});
