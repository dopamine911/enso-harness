import { fetchServerSentEvents, useChat } from "@tanstack/ai-react";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { ZenToolResult, type ZenRendererMap } from "./ZenToolResult.tsx";

/**
 * The first live surface (#24, #17).
 *
 * ⚠ Deliberately minimal, and NOT the nine-pane vision from `docs/architecture.md`. Its job
 * is to prove the pipeline end to end — pi rpc → observation → AG-UI → SSE → TanStack →
 * React — because every layer below it was tested in isolation and none had ever run
 * together against a real pi process.
 */

/**
 * Renderers keyed by descriptor `kind` (#18).
 *
 * ⚠ Empty on purpose. Every tool result currently falls through to the mandatory textual
 * form, which is exactly the behaviour the contract promises for an unknown kind — so an
 * empty map is the honest default rather than a gap. A renderer is added when a tool earns
 * one, not to fill the table.
 */
const renderers: ZenRendererMap = {};

function Conversation(): React.ReactNode {
	const [draft, setDraft] = useState("");
	const chat = useChat({ connection: fetchServerSentEvents("/api/chat") });

	return (
		<main style={{ font: "14px/1.5 system-ui", maxWidth: 760, margin: "2rem auto", padding: "0 1rem" }}>
			<h1 style={{ fontSize: 18 }}>zen-harness</h1>

			<ol style={{ listStyle: "none", padding: 0 }}>
				{chat.messages.map((message, messageIndex) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: streaming messages have no stable id yet
					<li key={messageIndex} style={{ margin: "1rem 0" }}>
						<strong>{message.role}</strong>
						<Parts message={message} />
					</li>
				))}
			</ol>

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
					style={{ width: "100%", padding: "0.5rem", font: "inherit" }}
				/>
			</form>

			{chat.isLoading ? <p>…</p> : null}
			{chat.error ? <pre style={{ color: "crimson" }}>{String(chat.error)}</pre> : null}
		</main>
	);
}

/**
 * Render a message's parts.
 *
 * ⚠ Defensive about shape rather than assuming it. `UIMessage`'s part vocabulary is
 * TanStack's, not ours, and it will grow — so an unrecognised part is shown as JSON instead
 * of skipped. A part that renders as nothing is indistinguishable from a part that was
 * never sent, which is the failure this whole pipeline is built to avoid.
 */
function Parts({ message }: { message: unknown }): React.ReactNode {
	const parts = (message as { parts?: unknown }).parts;
	if (!Array.isArray(parts)) {
		const content = (message as { content?: unknown }).content;
		return <div>{typeof content === "string" ? content : JSON.stringify(content)}</div>;
	}
	return (
		<div>
			{parts.map((part, partIndex) => {
				const type = (part as { type?: string }).type;
				// biome-ignore lint/suspicious/noArrayIndexKey: parts are positional within a message
				const key = partIndex;
				if (type === "text") return <p key={key}>{String((part as { text?: unknown }).text ?? "")}</p>;
				if (type === "tool-result") {
					return (
						<ZenToolResult
							key={key}
							result={part as Parameters<typeof ZenToolResult>[0]["result"]}
							renderers={renderers}
						/>
					);
				}
				return (
					<pre key={key} style={{ opacity: 0.7, fontSize: 12 }}>
						{type ?? "unknown part"}: {JSON.stringify(part)}
					</pre>
				);
			})}
		</div>
	);
}

const rootElement = document.getElementById("root");
if (rootElement === null) throw new Error("zen-harness: #root is missing from index.html");
createRoot(rootElement).render(
	<StrictMode>
		<Conversation />
	</StrictMode>,
);
