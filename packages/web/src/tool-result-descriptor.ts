/**
 * The web half of the tool-result payload contract (#18).
 *
 * WHY THIS SHAPE, AND WHY IT IS NOT A NEW ENVELOPE
 * TanStack AI's `ToolResultPart` already mandates the two properties #18 spent its
 * acceptance criteria on, so we ride inside it rather than wrapping it:
 *
 *   content:   string | ContentPart[]        — MANDATORY. The textual form. A surface with
 *                                             no renderer for our descriptor shows this, so
 *                                             an unknown descriptor renders visibly rather
 *                                             than empty. #18's sharpest requirement is
 *                                             satisfied by the envelope, not by us.
 *   metadata?: Record<string, unknown>       — OPTIONAL. Where the descriptor lives. Being
 *                                             optional is what makes this a two-surface
 *                                             contract instead of a web contract with a
 *                                             terminal fallback: the TUI can ignore metadata
 *                                             entirely and still render a correct result.
 *   state / error                            — the outcome fields #18 said we would have to add.
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

/** The metadata key our descriptor occupies. Namespaced: `metadata` is a shared bag. */
export const ZEN_TOOL_RESULT_KEY = "zen.toolResult" as const;

/** How confident a surface can be that it understood the payload. */
export type ZenRenderTier = "descriptor" | "text-only";

/**
 * A tool result, described rather than rendered.
 *
 * `kind` is the type tag a surface resolves to a renderer. It is a plain string rather than
 * a closed union on purpose: a vendor extension can emit a kind we have never seen, and the
 * unknown-kind path must be a visible fallback rather than a type error at the boundary.
 */
export interface ZenToolResultDescriptor {
	/** Renderer selector. Unknown values MUST fall back to the envelope's `content`. */
	kind: string;
	/** Serializable props for the selected renderer. Never a rendered element. */
	props: Record<string, unknown>;
	/**
	 * Truncation carried as data, never pre-rendered (#18). A terminal and a browser make
	 * different decisions about how to show "and 4,000 more lines", and a pre-truncated
	 * string forces the terminal's choice onto the browser.
	 */
	truncated?: { shown: number; total: number; unit: "lines" | "bytes" | "items" };
}

/** Runtime shape check. Deliberately permissive on `props` — see `kind` above. */
export function isZenToolResultDescriptor(value: unknown): value is ZenToolResultDescriptor {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.kind === "string" &&
		candidate.kind.length > 0 &&
		typeof candidate.props === "object" &&
		candidate.props !== null
	);
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
