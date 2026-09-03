// ⚠ Only `TextPart` crosses from the package's renderers. `ThinkingPart` looked like its
// sibling but renders PLAIN text inside hardcoded off-theme chrome — the Reasoning shell
// in `ai-elements/reasoning.tsx` replaces it (see that file's header).
import { TextPart } from "@tanstack/ai-react/ui";
import type { ChatUISelectedPart } from "@tanstack/ai-client/ui";
import {
	Reasoning,
	ReasoningContent,
	ReasoningTrigger,
} from "./components/ai-elements/reasoning.tsx";
import { ZenToolResult, type ZenRendererMap } from "./ZenToolResult.tsx";

/** The collapsible Reasoning shell around the thinking text. */
function ThinkingBlock({
	content,
	isStreaming,
}: {
	content: string;
	isStreaming: boolean;
}): React.ReactNode {
	return (
		<Reasoning isStreaming={isStreaming}>
			<ReasoningTrigger />
			<ReasoningContent>{content}</ReasoningContent>
		</Reasoning>
	);
}

/**
 * The per-part dispatcher — ours, on the library's own selection. A leaf module with no
 * dependency on the `createChatHook` factory, so it is directly testable.
 *
 * ⚠ WHY THE BOUND `Parts` COMPONENT IS NOT USED (found by the fixture, 2026-09-03):
 * TanStack's dispatcher routes every `toolCall` selected part EXCLUSIVELY to
 * `toolsComponents[name]` — an exact-name lookup with NO fallback — and a miss renders
 * NOTHING beyond a console warning ("Missing tools.bash component"). pi's tool set is
 * dynamic (extensions, MCP servers), so no static name map can be complete, and an
 * unanticipated tool vanishing silently is exactly the failure mode this page refuses
 * everywhere else. (`partsComponents.toolCall` is admitted by the TYPE but unreachable
 * in the dispatcher — noted as an upstream mismatch in the #31 PR.)
 *
 * So the `message` slot in main.tsx runs the library's OWN selection pipeline —
 * `selectChatUI` pairs each tool result to its call across the whole message list
 * (`result` rides on the selected part), `automaticPartsForMessage` drops the paired
 * duplicates — and this switch does only the last hop, part → component. This is not the
 * hand-rolled chat of mistake 1 in main.tsx's header: the vocabulary, pairing and
 * ordering are TanStack's exported selectors; only the final dispatch table is ours, so
 * an unknown TOOL renders through the mandatory textual contract and an unknown PART
 * KIND falls through to the visible debug block.
 *
 * `isStreaming` is true only for the trailing part of the trailing message while a run
 * is in flight — the caller computes it, because only the caller can see the whole list.
 */
export function SelectedMessagePart({
	selected,
	isStreaming,
	renderers,
}: {
	selected: ChatUISelectedPart;
	isStreaming: boolean;
	renderers: ZenRendererMap;
}): React.ReactNode {
	// ⚠ THE INTEGRATION POINT #18 EXISTS FOR. Every tool call renders through
	// `ZenToolResult`: the descriptor is read from the result's metadata, and an absent
	// result (the call is still in flight) renders the visible pending state.
	if (selected.key === "toolCall") {
		return (
			<div className="flex flex-col gap-1">
				<div className="font-mono text-muted-foreground text-xs">→ {selected.part.name}</div>
				<ZenToolResult result={selected.result} renderers={renderers} />
			</div>
		);
	}
	// An UNMATCHED result (its call never streamed — a protocol wrinkle, not a normal
	// state) still renders through the same contract rather than vanishing.
	if (selected.key === "toolResult") {
		return <ZenToolResult result={selected.part} renderers={renderers} />;
	}
	// TextPart is the markdown pipeline of record (react-markdown, sanitize LAST). `prose`
	// is @tailwindcss/typography — TextPart emits bare markdown HTML with no classes of
	// its own, so the typography plugin is what styles it.
	if (selected.part.type === "text") {
		return (
			<div className="prose prose-sm dark:prose-invert max-w-none">
				<TextPart content={selected.part.content} />
			</div>
		);
	}
	if (selected.part.type === "thinking") {
		return <ThinkingBlock content={selected.part.content} isStreaming={isStreaming} />;
	}
	// ⚠ An unhandled part kind renders VISIBLY rather than vanishing. `image`, `audio`,
	// `video`, `document`, `structuredOutput` and `uiResource` are all in the vocabulary
	// and it will grow — and a silently skipped part is indistinguishable from one that
	// was never sent.
	return (
		<pre className="overflow-x-auto rounded-md border bg-muted/50 p-2 text-muted-foreground text-xs">
			{selected.part.type}: {JSON.stringify(selected.part)}
		</pre>
	);
}
