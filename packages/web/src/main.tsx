import { fetchServerSentEvents } from "@tanstack/ai-react";
import { ChatInput, createChatHook, TextPart, ThinkingPart, ToolApproval } from "@tanstack/ai-react/ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ZenToolResult, type ZenRendererMap } from "./ZenToolResult.tsx";

/**
 * The zen web surface (#24, #17), composed the way TanStack AI's own recipes do it.
 *
 * ⚠ THIS FILE HAS BEEN WRONG TWICE, AND BOTH MISTAKES ARE WORTH KEEPING RECORDED.
 *
 * 1. It hand-rolled the chat: mapped `chat.messages` itself and guessed at `UIMessage`'s
 *    part vocabulary. That defeated the reason for adopting TanStack AI (#23) and left
 *    #18's real integration point — `partsComponents.toolResult` — unwired.
 *
 * 2. It then hand-wrote chrome that SHIPS. `<p>{part.content}</p>` rendered assistant
 *    output as plain text — no markdown, no code highlighting, no sanitisation — where
 *    `TextPart` runs react-markdown with remark-gfm, rehype-highlight and
 *    `rehype-sanitize` last. For an agent whose every reply contains fenced code that was
 *    the wrong renderer, not a styling shortfall. Sanitisation matters on its own: model
 *    output is untrusted text being put into a DOM.
 *
 * ⓘ `createChatHook`, not `createChatUI`. It is what the recipes use, and it binds options
 * AND components in one call — so the hook's generics cannot drift from the UI's, which
 * with `createChatUI` depended on remembering to share one options literal. Structural,
 * not a convention to observe.
 *
 * ⓘ `ChatMessages` is deliberately unused: deprecated in 0.9.0 in favour of the `Messages`
 * component the layout receives.
 */

/**
 * Renderers keyed by descriptor `kind` (#18).
 *
 * ⚠ Empty on purpose. Every tool result falls through to the mandatory textual form, which
 * is exactly what the contract promises for an unknown kind — so empty is the honest
 * default, not a gap. A renderer is added when a tool earns one.
 */
const descriptorRenderers: ZenRendererMap = {};

const chatOptions = { connection: fetchServerSentEvents("/api/chat") };

const { useAppChat } = createChatHook({
	options: chatOptions,
	components: {
		layout: ({ Messages, Interrupts, Queue }) => (
			<main style={{ font: "14px/1.6 system-ui", maxWidth: 820, margin: "2rem auto", padding: "0 1rem" }}>
				<h1 style={{ fontSize: 15, fontWeight: 500, opacity: 0.55, margin: "0 0 1.5rem" }}>zen-harness</h1>
				<Messages />
				{/* ⚠ Mounted before anything emits one, deliberately. This is where #4's `ask`
				    verdict reaches the browser, and an unmounted slot is precisely why an
				    approval would silently never appear. */}
				<Interrupts />
				<Queue />
				<ChatInput placeholder="ask pi something" />
			</main>
		),
		message: ({ message, Parts }) => (
			<article data-role={message.role} style={{ margin: "1.25rem 0" }}>
				<div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6, opacity: 0.45 }}>
					{message.role}
				</div>
				<Parts />
			</article>
		),
	},
	partsComponents: {
		text: ({ part }) => <TextPart content={part.content} />,
		thinking: ({ part }) => <ThinkingPart content={part.content} />,
		toolCall: ({ part }) => <div style={{ fontSize: 12, opacity: 0.65 }}>→ {part.name}</div>,
		// ⚠ THE INTEGRATION POINT #18 EXISTS FOR. TanStack dispatches a tool-result part
		// here; we read our descriptor out of its metadata and fall back to the mandatory
		// textual form when no renderer claims the kind.
		toolResult: ({ part }) => <ZenToolResult result={part} renderers={descriptorRenderers} />,
		// ⚠ An unhandled part kind renders VISIBLY rather than vanishing. `image`, `audio`,
		// `video`, `document`, `structuredOutput` and `uiResource` all exist in the
		// vocabulary and it will grow — and a silently skipped part is indistinguishable
		// from one that was never sent.
		fallback: ({ part }) => (
			<pre style={{ fontSize: 11, opacity: 0.6, whiteSpace: "pre-wrap" }}>
				{part.type}: {JSON.stringify(part)}
			</pre>
		),
	},
	interruptsComponents: {
		generic: {
			fallback: ({ interrupt }) => (
				<ToolApproval
					toolCallId={String((interrupt as { toolCallId?: unknown }).toolCallId ?? "")}
					toolName={String((interrupt as { toolName?: unknown }).toolName ?? "tool")}
					input={(interrupt as { input?: unknown }).input}
					approval={{ id: String((interrupt as { id?: unknown }).id ?? ""), needsApproval: true }}
				/>
			),
		},
	},
});

function ChatScreen(): React.ReactNode {
	const chat = useAppChat();
	return <chat.AppChat />;
}

const rootElement = document.getElementById("root");
if (rootElement === null) throw new Error("zen-harness: #root is missing from index.html");
createRoot(rootElement).render(
	<StrictMode>
		<ChatScreen />
	</StrictMode>,
);
