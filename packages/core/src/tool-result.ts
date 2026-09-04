import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";

/**
 * The tool-result payload contract (#18), as a TypeBox schema.
 *
 * WHY TYPEBOX AND NOT A PLAIN INTERFACE
 * The repo's convention, and #18's acceptance: one schema library, no bridge, no conversion
 * step. A TypeBox schema literally IS a JSON Schema object, so the same declaration serves
 * three consumers that would otherwise each need their own copy — TypeScript types via
 * `Static<>`, the HTTP contract and its OpenAPI description, and a runtime validator. A
 * hand-written type guard beside a hand-written interface is two things to keep in step,
 * and the drift between them is silent.
 *
 * WHY THIS SHAPE, AND WHY IT IS NOT A NEW ENVELOPE
 * TanStack AI's `ToolResultPart` already mandates the two properties #18 spent its
 * acceptance criteria on, so we ride inside it rather than wrapping it:
 *
 *   content:   string | ContentPart[]   — MANDATORY. The textual form. A surface with no
 *                                        renderer for our descriptor shows this, so an
 *                                        unknown descriptor renders visibly rather than
 *                                        empty. #18's sharpest requirement is satisfied by
 *                                        the envelope, not by us.
 *   metadata?: Record<string, unknown>  — OPTIONAL. Where the descriptor lives. Being
 *                                        optional is what makes this a two-surface contract
 *                                        rather than a web contract with a terminal
 *                                        fallback: the TUI can ignore metadata entirely and
 *                                        still render a correct result.
 *   state / error                       — the outcome fields #18 said we would have to add.
 *
 * ⚠ So the descriptor is deliberately NOT self-sufficient. It carries only what a richer
 * renderer needs on top of the text. Anything a reader must see in every surface belongs in
 * `content`, and duplicating it here is how the two drift apart.
 *
 * The pattern is the one three independent systems converged on — see #16, #17:
 *   BlackBelt PromptBus   `PromptComponent { type, props }` + optional native rendering
 *   pi-dashboard slots    a descriptor tier alongside a React tier
 *   TanStack AI           `metadata` alongside a mandatory `content`
 */

/**
 * The metadata key our descriptor occupies. Namespaced, because `metadata` is a shared bag.
 *
 * ⚠ NO DOT, DELIBERATELY. The first version was `"zen.toolResult"`, and a dot inside a key
 * is legal JSON but collides with every path-based accessor — `expect(...).toHaveProperty()`,
 * lodash `get`, JSONPath — all of which read `a.b` as "property b of property a". That cost
 * a failing test within minutes of the key being used, and it would have cost a consumer
 * the same confusion later, further from the cause.
 *
 * A colon namespaces just as well and is not path syntax anywhere.
 */
export const ZEN_TOOL_RESULT_KEY = "zen:toolResult" as const;

/** Units a truncation can be counted in. Closed, because a surface must render each one. */
export const ZenTruncationUnit = Type.Union([Type.Literal("lines"), Type.Literal("bytes"), Type.Literal("items")]);
export type ZenTruncationUnit = Static<typeof ZenTruncationUnit>;

/**
 * Truncation carried as data, never pre-rendered (#18).
 *
 * A terminal and a browser make different decisions about how to show "and 4,000 more
 * lines", and a pre-truncated string forces the terminal's choice onto the browser.
 */
export const ZenTruncation = Type.Object({
	shown: Type.Integer({ minimum: 0 }),
	total: Type.Integer({ minimum: 0 }),
	unit: ZenTruncationUnit,
});
export type ZenTruncation = Static<typeof ZenTruncation>;

/**
 * A tool result, described rather than rendered.
 *
 * ⚠ `kind` is `Type.String()` rather than a closed union on purpose: a vendor extension can
 * emit a kind we have never seen, and the unknown-kind path must be a visible fallback
 * rather than a validation failure at the boundary. Closing this union would turn an
 * unrecognised renderer into a dropped result.
 */
export const ZenToolResultDescriptor = Type.Object({
	/** Renderer selector. Unknown values MUST fall back to the envelope's `content`. */
	kind: Type.String({ minLength: 1 }),
	/** Serializable props for the selected renderer. Never a rendered element. */
	props: Type.Record(Type.String(), Type.Unknown()),
	truncated: Type.Optional(ZenTruncation),
});
export type ZenToolResultDescriptor = Static<typeof ZenToolResultDescriptor>;

/**
 * JIT validator, compiled once at module load.
 *
 * `Compile` rather than `Check` because this runs on every tool result that crosses the
 * wire; `Check` re-walks the schema per call.
 */
const descriptorValidator = Compile(ZenToolResultDescriptor);

/** Runtime shape check, from the schema rather than beside it. */
export function isZenToolResultDescriptor(value: unknown): value is ZenToolResultDescriptor {
	return descriptorValidator.Check(value);
}

/**
 * Read the descriptor out of a `ToolResultPart`'s metadata.
 *
 * Takes the metadata bag rather than the whole part, so this stays usable from the TUI
 * renderer too — which has no TanStack types and must not gain them.
 */
export function readZenToolResultDescriptor(
	metadata: Record<string, unknown> | undefined,
): ZenToolResultDescriptor | undefined {
	if (metadata === undefined) return undefined;
	const candidate = metadata[ZEN_TOOL_RESULT_KEY];
	return isZenToolResultDescriptor(candidate) ? candidate : undefined;
}
