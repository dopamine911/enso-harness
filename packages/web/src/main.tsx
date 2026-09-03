import { fetchServerSentEvents, useChat } from "@tanstack/ai-react";
import { createChatUI } from "@tanstack/ai-react/ui";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { ZenToolResult, type ZenRendererMap } from "./ZenToolResult.tsx";

/**
 * The first live surface (#24, #17), built on TanStack AI's own UI layer.
 *
 * ⚠ THE FIRST VERSION OF THIS FILE HAND-ROLLED THE CHAT AND WAS WRONG.
 * It mapped `chat.messages` itself and guessed at `UIMessage`'s part vocabulary, which
 * defeated the entire reason for choosing TanStack AI (#23) and left #18's real integration
 * point — `partsComponents.toolResult` — untested. `createChatUI` is the supported seam:
 * it walks the message list, dispatches each part to a registered component by KIND, and
 * hands tool results the typed `{part, result, interrupt}` shape.
 *
 * Deliberately minimal chrome. Its job is to prove the pipeline renders, not to be the
 * nine-pane vision in `docs/architecture.md`.
 */

/**
 * Renderers keyed by descriptor `kind` (#18).
 *
 * ⚠ Empty on purpose. Every tool result currently falls through to the mandatory textual
 * form, which is exactly what the contract promises for an unknown kind — so an empty map
 * is the honest default rather than a gap. A renderer is added when a tool earns one.
 */
const descriptorRenderers: ZenRendererMap = {};

/**
 * Chat options, bound once at module scope.
 *
 * ⚠ Shared between `createChatUI` and `useChat` deliberately: the factory takes them as a
 * TYPE carrier to infer tool and interrupt names, so a second literal here would let the
 * UI's generics drift from the hook's without a type error.
 */
const chatOptions = { connection: fetchServerSentEvents("/api/chat") };

const ui = createChatUI(chatOptions, {
	components: {
		layout: ({ Messages, Interrupts, Queue, Input }) => (
			<main style={{ font: "14px/1.6 system-ui", maxWidth: 780, margin: "2rem auto", padding: "0 1rem" }}>
				<h1 style={{ fontSize: 16, opacity: 0.6, fontWeight: 500 }}>zen-harness</h1>
				<Messages />
				{/* ⚠ Interrupts is where a tool approval renders — #4's `ask` verdict reaching
				    the browser. Mounted now even though nothing emits one yet, because an
				    unmounted slot is why an approval would silently never appear. */}
				<Interrupts />
				<Queue />
				<Input />
			</main>
		),
		message: ({ message, Parts }) => (
			<section style={{ margin: "1.25rem 0" }}>
				<div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.6, opacity: 0.5 }}>
					{message.role}
				</div>
				<Parts />
			</section>
		),
		input: () => {
			const chat = ui.useChatContext();
			const [draft, setDraft] = useState("");
			return (
				<form
					onSubmit={(event) => {
						event.preventDefault();
						if (draft.trim().length === 0) return;
						void chat.sendMessage(draft);
						setDraft("");
					}}
				>
					<input
						value={draft}
						onChange={(event) => setDraft(event.target.value)}
						placeholder="ask pi something"
						style={{ width: "100%", padding: "0.6rem", font: "inherit", boxSizing: "border-box" }}
					/>
				</form>
			);
		},
	},
	partsComponents: {
		// ⚠ `content`, not `text`. `TextPart` is `{type, content, metadata?}` — the field
		// name the typechecker corrected me on, and one a hand-rolled renderer reading
		// `part.text` would have shown as blank with no error anywhere.
		text: ({ part }) => <p style={{ whiteSpace: "pre-wrap", margin: "0.25rem 0" }}>{part.content}</p>,
		thinking: ({ part }) => (
			<details style={{ opacity: 0.65, margin: "0.25rem 0" }}>
				<summary style={{ cursor: "pointer" }}>thinking</summary>
				<pre style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>{part.content}</pre>
			</details>
		),
		toolCall: ({ part }) => (
			<div style={{ fontSize: 12, opacity: 0.7 }}>
				→ {part.name}
			</div>
		),
		// ⚠ THE INTEGRATION POINT #18 EXISTS FOR. TanStack dispatches a tool-result part
		// here; we read our descriptor out of its metadata and fall back to the mandatory
		// textual form when there is no renderer for the kind.
		toolResult: ({ part }) => <ZenToolResult result={part} renderers={descriptorRenderers} />,
		// ⚠ A part kind we do not handle renders visibly rather than vanishing. TanStack's
		// part vocabulary will grow, and a silently skipped part is indistinguishable from
		// one that was never sent.
		fallback: ({ part }) => (
			<pre style={{ fontSize: 11, opacity: 0.6, whiteSpace: "pre-wrap" }}>
				{part.type}: {JSON.stringify(part)}
			</pre>
		),
	},
});

function App(): React.ReactNode {
	const chat = useChat(chatOptions);
	return <ui.Chat chat={chat} />;
}

const rootElement = document.getElementById("root");
if (rootElement === null) throw new Error("zen-harness: #root is missing from index.html");
createRoot(rootElement).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
