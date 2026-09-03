import { fetchServerSentEvents } from "@tanstack/ai-react";
import { createChatHook, TextPart, ThinkingPart } from "@tanstack/ai-react/ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ZenToolResult, type ZenRendererMap } from "./ZenToolResult.tsx";

/**
 * The zen web surface (#24, #17), composed per `docs/ui/react`.
 *
 * ⚠ THIS FILE WAS WRONG THREE TIMES. Each mistake is recorded because each was corrected
 * by Daniel rather than by the code, and the next session should not repeat any of them.
 *
 * 1. HAND-ROLLED THE CHAT. Mapped `chat.messages` and guessed at `UIMessage`'s part
 *    vocabulary — defeating the reason for adopting TanStack AI (#23) and leaving #18's
 *    real integration point (`partsComponents.toolResult`) unwired. It also read
 *    `part.text` where `TextPart` is `{type, content}`, which would have rendered every
 *    assistant message BLANK with no error at all.
 *
 * 2. HAND-WROTE CHROME THAT SHIPS. `<p>{part.content}</p>` rendered assistant output as
 *    plain text where `TextPart` runs react-markdown with remark-gfm, rehype-highlight and
 *    `rehype-sanitize` LAST. Every reply from a coding agent is markdown, and sanitisation
 *    matters on its own: model output is untrusted text entering a DOM.
 *
 * 3. OVER-CORRECTED INTO DEPRECATED COMPONENTS. Six of the eight exports are
 *    `@deprecated`, removed at 1.0.0 — `Chat`, `ChatMessage`, `ChatMessages`, `ChatInput`,
 *    `ToolApproval`. Only `TextPart` and `ThinkingPart` are current, and both are content
 *    renderers rather than chrome. `ChatInput`'s own notice says "use an application-owned
 *    input component", so the form deleted in step 2 was the right SHAPE all along.
 *
 *    ⚠ It failed loudly, which was the one mercy:
 *        Uncaught Error: Chat components must be wrapped in <Chat>.
 *    `ChatInput` reads the DEPRECATED `<Chat>` provider's context, not the one
 *    `createChatHook` installs. The two APIs cannot be mixed and nothing in the types says
 *    so.
 *
 * ⓘ TanStack AI is HEADLESS. It supplies the client, the protocol, the dispatch factory and
 * markdown rendering. There is no CSS in the package and no styled kit on npm. So the panes
 * in `docs/architecture.md` are entirely ours to build, and this library contributes the
 * message pipeline rather than the look.
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

const { useAppChat, useChatContext } = createChatHook({
	options: chatOptions,
	components: {
		/**
		 * ⚠ `input` MUST be declared before `layout`.
		 *
		 * `docs/ui/react`: "Define `input` before `layout` in your component map to ensure
		 * TypeScript recognizes it as registered." `LayoutProps` only carries `Input` when a
		 * `components.input` is present, and that conditional type resolves in literal
		 * property order — so declaring `layout` first makes `Input` vanish from its props
		 * with a confusing error. Property order is load-bearing here, which is not a thing
		 * one expects of an object literal.
		 */
		input: function Input() {
			// Application-owned, per `ChatInput`'s deprecation notice. `useChatContext` is the
			// one returned by `createChatHook` above — referenced at render time, so the
			// binding is initialised by then.
			const chat = useChatContext();
			return (
				<form
					onSubmit={(event) => {
						event.preventDefault();
						const field = event.currentTarget.elements.namedItem("message");
						if (!(field instanceof HTMLInputElement)) return;
						if (field.value.trim().length === 0) return;
						void chat.sendMessage(field.value);
						field.value = "";
					}}
					style={{ display: "flex", gap: "0.5rem", marginTop: "1.5rem" }}
				>
					<input
						name="message"
						placeholder="ask pi something"
						autoComplete="off"
						style={{ flex: 1, padding: "0.6rem", font: "inherit" }}
					/>
					<button type="submit" style={{ padding: "0.6rem 1rem", font: "inherit" }}>
						Send
					</button>
				</form>
			);
		},
		layout: ({ Messages, Interrupts, Queue, Input }) => (
			<main style={{ font: "14px/1.6 system-ui", maxWidth: 820, margin: "2rem auto", padding: "0 1rem" }}>
				<h1 style={{ fontSize: 15, fontWeight: 500, opacity: 0.55, margin: "0 0 1.5rem" }}>zen-harness</h1>
				<Messages />
				{/* ⚠ Mounted before anything emits one, deliberately. This is where #4's `ask`
				    verdict reaches the browser, and an unmounted slot is precisely why an
				    approval would silently never appear. */}
				<Interrupts />
				<Queue />
				<Input />
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
		// The two CURRENT components in the package, both doing real work.
		text: ({ part }) => <TextPart content={part.content} />,
		thinking: ({ part }) => <ThinkingPart content={part.content} />,
		toolCall: ({ part }) => <div style={{ fontSize: 12, opacity: 0.65 }}>→ {part.name}</div>,
		// ⚠ THE INTEGRATION POINT #18 EXISTS FOR. TanStack dispatches a tool-result part
		// here; we read our descriptor out of its metadata and fall back to the mandatory
		// textual form when no renderer claims the kind.
		toolResult: ({ part }) => <ZenToolResult result={part} renderers={descriptorRenderers} />,
		// ⚠ An unhandled part kind renders VISIBLY rather than vanishing. `image`, `audio`,
		// `video`, `document`, `structuredOutput` and `uiResource` are all in the vocabulary
		// and it will grow — and a silently skipped part is indistinguishable from one that
		// was never sent.
		fallback: ({ part }) => (
			<pre style={{ fontSize: 11, opacity: 0.6, whiteSpace: "pre-wrap" }}>
				{part.type}: {JSON.stringify(part)}
			</pre>
		),
	},
	interruptsComponents: {
		// ⚠ Application-owned, because `ToolApproval` is deprecated too. A generic `fallback`
		// rather than named ids: nothing emits an interrupt yet, and a fallback means the
		// first one to arrive is VISIBLE rather than silently unhandled.
		generic: {
			fallback: ({ interrupt }) => (
				<pre style={{ fontSize: 12, border: "1px solid currentColor", padding: "0.5rem", opacity: 0.8 }}>
					interrupt (unhandled): {JSON.stringify(interrupt)}
				</pre>
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
