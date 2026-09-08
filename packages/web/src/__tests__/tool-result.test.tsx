import { expect, test } from "bun:test";
import type { ToolResultPart } from "@tanstack/ai";
import { isZenToolResultDescriptor, readZenToolResultDescriptor, ZEN_TOOL_RESULT_KEY } from "@zen/core";
import { renderToStaticMarkup } from "react-dom/server";
import { type ZenRendererMap, ZenToolResult } from "../ZenToolResult.tsx";

const partWith = (overrides: Partial<ToolResultPart>): ToolResultPart => ({
	type: "tool-result",
	toolCallId: "call-1",
	content: "PLAIN TEXT FORM",
	state: "complete" as ToolResultPart["state"],
	...overrides,
});

const renderers: ZenRendererMap = {
	diff: (props) => <span data-known>{String(props.summary)}</span>,
};

const html = (result?: ToolResultPart) => renderToStaticMarkup(<ZenToolResult result={result} renderers={renderers} />);

// --- the descriptor reader, pure and surface-independent
test("reads a well-formed descriptor out of metadata", () => {
	const found = readZenToolResultDescriptor({
		[ZEN_TOOL_RESULT_KEY]: { kind: "diff", props: { summary: "3 files" } },
	});
	expect(found?.kind).toBe("diff");
});
test("absent metadata yields no descriptor", () => expect(readZenToolResultDescriptor(undefined)).toBeUndefined());
test("a malformed descriptor is rejected, not coerced", () => {
	expect(isZenToolResultDescriptor({ kind: "", props: {} })).toBe(false);
	expect(isZenToolResultDescriptor({ kind: "diff" })).toBe(false);
	expect(isZenToolResultDescriptor("diff")).toBe(false);
});

// --- rendering. ⚠ Every case below must produce VISIBLE output; a blank render is the
// failure mode this contract exists to prevent.
test("a known kind renders through its renderer", () => {
	const rendered = html(
		partWith({ metadata: { [ZEN_TOOL_RESULT_KEY]: { kind: "diff", props: { summary: "3 files" } } } }),
	);
	expect(rendered).toContain("3 files");
	expect(rendered).toContain('data-zen-kind="diff"');
});

test("⚠ an UNKNOWN kind falls back to the envelope text, never to blank", () => {
	const rendered = html(partWith({ metadata: { [ZEN_TOOL_RESULT_KEY]: { kind: "no-such-renderer", props: {} } } }));
	expect(rendered).toContain("PLAIN TEXT FORM");
	expect(rendered.length).toBeGreaterThan(0);
});

test("no descriptor at all falls back to the envelope text", () =>
	expect(html(partWith({}))).toContain("PLAIN TEXT FORM"));

test("an in-flight call says so rather than rendering nothing", () => expect(html(undefined)).toContain("running"));

test("an errored result shows the error, not the descriptor", () => {
	const rendered = html(
		partWith({
			error: "tool exploded",
			metadata: { [ZEN_TOOL_RESULT_KEY]: { kind: "diff", props: { summary: "x" } } },
		}),
	);
	expect(rendered).toContain("tool exploded");
	expect(rendered).not.toContain("data-zen-kind");
});

test("truncation is rendered from data, not from a pre-rendered string", () => {
	const rendered = html(
		partWith({
			metadata: {
				[ZEN_TOOL_RESULT_KEY]: {
					kind: "diff",
					props: { summary: "s" },
					truncated: { shown: 500, total: 4000, unit: "lines" },
				},
			},
		}),
	);
	expect(rendered).toContain("500");
	expect(rendered).toContain("4000");
	expect(rendered).toContain("lines");
});

// `content` is `string | ContentPart[]` (#53 S3: the array branch was never rendered).
test("array content renders every part as JSON, one per line, never dropped", () => {
	const rendered = html(
		partWith({
			content: [
				{ type: "text", content: "first" },
				{ type: "image", source: { type: "data", value: "aGk=", mimeType: "image/png" } },
			],
		}),
	);
	expect(rendered).toContain("first");
	expect(rendered).toContain("image/png");
	expect(rendered).toContain('data-zen-tool-result="text"');
});
