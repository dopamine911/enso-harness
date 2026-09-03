// ⚠ First import, deliberately: Tailwind's layers must land before any component renders,
// and this is the ONE stylesheet — shadcn's theme variables are injected into it by the
// CLI (`components.json` points here). Do not add a second css entry point.
import "./styles/global.css";
import { fetchServerSentEvents } from "@tanstack/ai-react";
import type { GenericAGUIInterrupt } from "@tanstack/ai-client";
import {
	automaticPartsForMessage,
	selectMessageUI,
	type ChatUISelectedPart,
} from "@tanstack/ai-client/ui";
// ⚠ Only `TextPart` crosses from the package's renderers. `ThinkingPart` looked like its
// sibling but renders PLAIN text inside hardcoded off-theme chrome — the Reasoning shell
// in `ai-elements/reasoning.tsx` replaces it (see that file's header).
import { createChatHook, TextPart } from "@tanstack/ai-react/ui";
import { ArrowUpIcon, MessageSquareIcon, SquareIcon } from "lucide-react";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { isZenDialogSpec, ZEN_DIALOG_KEY, type ZenDialogSpec } from "@zen/core";
import {
	Conversation,
	ConversationContent,
	ConversationEmptyState,
	ConversationScrollButton,
} from "./components/ai-elements/conversation.tsx";
import { Message, MessageContent } from "./components/ai-elements/message.tsx";
import {
	Reasoning,
	ReasoningContent,
	ReasoningTrigger,
} from "./components/ai-elements/reasoning.tsx";
import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert.tsx";
import { Button } from "./components/ui/button.tsx";
import {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "./components/ui/card.tsx";
import { Input } from "./components/ui/input.tsx";
import { Textarea } from "./components/ui/textarea.tsx";
import { createFixtureChat } from "./fixture-conversation.ts";
import { ZenToolResult, type ZenRendererMap } from "./ZenToolResult.tsx";

/**
 * The zen web surface (#24, #17), composed per `docs/ui/react`; presentation layer per #31
 * (shadcn radix-nova theme + components vendored from ai-elements, laid out after the
 * ai-elements chatbot example).
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
 * markdown rendering. There is no CSS in the package and no styled kit on npm. So the chrome
 * here is ours: shadcn/ui primitives plus the ai-elements shells vendored under
 * `components/ai-elements/` (each carries its own provenance header).
 */

/**
 * Renderers keyed by descriptor `kind` (#18).
 *
 * ⚠ Empty on purpose. Every tool result falls through to the mandatory textual form, which
 * is exactly what the contract promises for an unknown kind — so empty is the honest
 * default, not a gap. A renderer is added when a tool earns one.
 */
const descriptorRenderers: ZenRendererMap = {};

/**
 * `?fixture` swaps the live server connection for the scripted conversation in
 * `fixture-conversation.ts` — the styling dev loop (#31). Everything downstream of the
 * connection (the hook, the parts pipeline, every component below) is identical on both
 * paths, which is the point: the fixture styles the SAME renderers the live page uses.
 */
const isFixtureMode = new URLSearchParams(window.location.search).has("fixture");
const chatOptions = {
	connection: isFixtureMode ? createFixtureChat().transport() : fetchServerSentEvents("/api/chat"),
};

/**
 * Renders a run-level error as a destructive Alert.
 *
 * ⚠ Declared before the factory but calls `useChatContext` from it — legal because the
 * binding is only read at RENDER time, long after the destructuring completes. Placing it
 * here keeps the layout readable.
 */
function RunProblem(): React.ReactNode {
	const chat = useChatContext();
	if (chat.error === undefined || chat.error === null) return null;
	return (
		<Alert variant="destructive" className="my-4">
			<AlertTitle>the run failed</AlertTitle>
			<AlertDescription className="whitespace-pre-wrap">
				{chat.error instanceof Error ? chat.error.message : String(chat.error)}
			</AlertDescription>
		</Alert>
	);
}

/** The visible catch-all for an interrupt this page has no renderer for — see the note on
 * `interruptsComponents.generic.fallback` below for why it must render rather than vanish. */
function UnhandledInterrupt({ interrupt }: { interrupt: unknown }): React.ReactNode {
	return (
		<pre className="my-2 overflow-x-auto rounded-md border bg-muted/50 p-3 text-muted-foreground text-xs">
			interrupt (unhandled): {JSON.stringify(interrupt)}
		</pre>
	);
}

/**
 * pi asked a question; this is where a human answers it (#27).
 *
 * The question travels as a generic AG-UI interrupt whose `metadata["zen:dialog"]` is the
 * `ZenDialogSpec` — validated here with the same schema the server used to build it, so a
 * malformed one degrades to the visible debug block instead of a broken form.
 *
 * ⚠ The payloads handed to `resolveInterrupt` are EXACTLY pi's wire shapes minus the
 * envelope (`{value}` / `{confirmed}`) — the server validates them against the dialog spec
 * (`validateDialogAnswer`) and forwards them verbatim, so inventing a richer shape here
 * would be refused there. Cancel goes through `interrupt.cancel()`, which the client sends
 * as `status:"cancelled"` and the server writes as pi's `{cancelled:true}`.
 */
function ZenDialogInterrupt({
	interrupt,
}: {
	interrupt: GenericAGUIInterrupt;
}): React.ReactNode {
	const dialogCandidate: unknown = interrupt.metadata?.[ZEN_DIALOG_KEY];
	const dialog: ZenDialogSpec | undefined = isZenDialogSpec(dialogCandidate)
		? dialogCandidate
		: undefined;
	const canAnswer = interrupt.canResolve === true;

	if (dialog === undefined || !canAnswer) {
		// Not a pi dialog (or not resolvable): render it VISIBLY rather than dropping it —
		// a silently skipped interrupt is indistinguishable from one that was never sent.
		return <UnhandledInterrupt interrupt={interrupt} />;
	}

	const answer = (payload: { value: string } | { confirmed: boolean }): void => {
		interrupt.resolveInterrupt(payload);
	};

	return (
		<Card className="my-4">
			<CardHeader>
				<CardDescription className="uppercase tracking-wide">pi is asking</CardDescription>
				<CardTitle className="text-base">{dialog.title}</CardTitle>
			</CardHeader>
			<CardContent>
				{dialog.method === "confirm" ? (
					<div className="flex flex-col gap-3">
						<p className="text-sm">{dialog.message}</p>
						<div className="flex gap-2">
							<Button type="button" onClick={() => answer({ confirmed: true })}>
								Yes
							</Button>
							<Button type="button" variant="outline" onClick={() => answer({ confirmed: false })}>
								No
							</Button>
						</div>
					</div>
				) : dialog.method === "select" ? (
					<div className="flex flex-wrap gap-2">
						{dialog.options.map((option) => (
							<Button
								key={option}
								type="button"
								variant="outline"
								onClick={() => answer({ value: option })}
							>
								{option}
							</Button>
						))}
					</div>
				) : (
					<form
						onSubmit={(event) => {
							event.preventDefault();
							const field = event.currentTarget.elements.namedItem("answer");
							if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
								answer({ value: field.value });
							}
						}}
						className="flex items-start gap-2"
					>
						{dialog.method === "editor" ? (
							<Textarea name="answer" defaultValue={dialog.prefill ?? ""} rows={6} className="flex-1" />
						) : (
							<Input
								name="answer"
								placeholder={dialog.placeholder ?? ""}
								autoComplete="off"
								className="flex-1"
							/>
						)}
						<Button type="submit">Answer</Button>
					</form>
				)}
			</CardContent>
			<CardFooter>
				<Button type="button" variant="ghost" size="sm" onClick={() => interrupt.cancel()}>
					Cancel — decline the question
				</Button>
			</CardFooter>
		</Card>
	);
}

/** The collapsible Reasoning shell around TanStack's `ThinkingPart` renderer. */
function ThinkingBlock({ content }: { content: string }): React.ReactNode {
	// ⚠ `isStreaming` is chat-level, not part-level, and that is a compromise stated
	// honestly: a selected part carries no streaming flag and `ThinkingPart` has none
	// either (verified in `create-ui.d.ts` / `ui/types.d.ts`), so the nearest available
	// signal is `chat.isLoading`. Consequence: the Reasoning shell stays open (and the
	// trigger pulses "Thinking...") for the WHOLE run, auto-closing when the run settles
	// rather than when the thinking part itself ends.
	const chat = useChatContext();
	return (
		<Reasoning isStreaming={chat.isLoading}>
			<ReasoningTrigger />
			<ReasoningContent>{content}</ReasoningContent>
		</Reasoning>
	);
}

/**
 * The per-part dispatcher — ours, on the library's own selection.
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
 * So the `message` slot below runs the library's OWN selection pipeline —
 * `selectMessageUI` pairs each tool result to its call (`result` rides on the selected
 * part), `automaticPartsForMessage` drops the paired duplicates — and this switch does
 * only the last hop, part → component. This is not the hand-rolled chat of mistake 1
 * above: the vocabulary, pairing and ordering are TanStack's exported selectors; only
 * the final dispatch table is ours, so an unknown TOOL renders through the mandatory
 * textual contract and an unknown PART KIND falls through to the visible debug block.
 */
function SelectedMessagePart({ selected }: { selected: ChatUISelectedPart }): React.ReactNode {
	// ⚠ THE INTEGRATION POINT #18 EXISTS FOR. Every tool call renders through
	// `ZenToolResult`: the descriptor is read from the result's metadata, and an absent
	// result (the call is still in flight) renders the visible pending state.
	if (selected.key === "toolCall") {
		return (
			<div className="flex flex-col gap-1">
				<div className="font-mono text-muted-foreground text-xs">→ {selected.part.name}</div>
				<ZenToolResult result={selected.result} renderers={descriptorRenderers} />
			</div>
		);
	}
	// An UNMATCHED result (its call never streamed — a protocol wrinkle, not a normal
	// state) still renders through the same contract rather than vanishing.
	if (selected.key === "toolResult") {
		return <ZenToolResult result={selected.part} renderers={descriptorRenderers} />;
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
		return <ThinkingBlock content={selected.part.content} />;
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
		input: function ChatPromptInput() {
			// Application-owned, per `ChatInput`'s deprecation notice. `useChatContext` is the
			// one returned by `createChatHook` above — referenced at render time, so the
			// binding is initialised by then.
			const chat = useChatContext();
			// Controlled, so the send button can disable on empty — the ai-elements chatbot
			// example's PromptInput does the same.
			const [draft, setDraft] = useState("");

			const sendDraft = (): void => {
				if (draft.trim().length === 0) return;
				void chat.sendMessage(draft);
				setDraft("");
			};

			return (
				<form
					onSubmit={(event) => {
						event.preventDefault();
						sendDraft();
					}}
					className="mx-auto w-full max-w-3xl px-4 pb-4"
				>
					<div className="flex items-end gap-2 rounded-xl border bg-background p-2 shadow-sm focus-within:ring-1 focus-within:ring-ring">
						<Textarea
							name="message"
							value={draft}
							onChange={(event) => setDraft(event.target.value)}
							onKeyDown={(event) => {
								// Enter sends; Shift+Enter keeps its newline (the chatbot-example
								// convention, and what anyone typing to an agent expects).
								if (event.key === "Enter" && !event.shiftKey) {
									event.preventDefault();
									sendDraft();
								}
							}}
							placeholder="ask pi something"
							autoComplete="off"
							rows={1}
							className="max-h-40 min-h-9 flex-1 resize-none border-0 shadow-none focus-visible:ring-0 dark:bg-transparent"
						/>
						{chat.isLoading ? (
							// A run is in flight: the affordance is stop, not send. `stop()` is
							// request-local on the hook return (verified in `types.d.ts`).
							<Button
								type="button"
								size="icon"
								variant="outline"
								aria-label="stop the current response"
								onClick={() => chat.stop()}
							>
								<SquareIcon />
							</Button>
						) : (
							<Button
								type="submit"
								size="icon"
								aria-label="send message"
								disabled={draft.trim().length === 0}
							>
								<ArrowUpIcon />
							</Button>
						)}
					</div>
				</form>
			);
		},
		/**
		 * ⚠⚠ A RUN_ERROR HAD NOWHERE TO RENDER, WHICH IS HOW `/mode` LOOKED LIKE NOTHING.
		 *
		 * Daniel typed `/mode`, the server correctly emitted RUN_ERROR explaining that pi was
		 * blocked on an interactive dialog — and the page showed an empty assistant turn,
		 * because the layout mounted Messages, Interrupts, Queue and Input and nothing read
		 * `chat.error`. The transcript he pasted back was the INPUT PLACEHOLDER, which was
		 * simply the next visible text on the page.
		 *
		 * Errors are not a message part, so no `partsComponents` entry catches them. They
		 * live on the chat instance and have to be rendered deliberately.
		 */
		layout: function ChatLayout({ Messages, Interrupts, Queue, Input }) {
			const chat = useChatContext();
			return (
				<div className="flex h-dvh flex-col bg-background text-foreground">
					<header className="flex items-center gap-2 border-b px-4 py-2">
						<h1 className="font-medium text-muted-foreground text-sm">zen-harness</h1>
						{isFixtureMode ? (
							<span className="rounded-full border px-2 py-0.5 text-muted-foreground text-xs">
								fixture
							</span>
						) : null}
					</header>
					<Conversation>
						<ConversationContent className="mx-auto w-full max-w-3xl">
							{chat.messages.length === 0 ? (
								<ConversationEmptyState
									icon={<MessageSquareIcon className="size-8" />}
									title="No messages yet"
									description="ask pi something to get started"
								/>
							) : (
								<Messages />
							)}
							{/* ⚠ Mounted before anything emits one, deliberately. This is where #4's
							    `ask` verdict reaches the browser, and an unmounted slot is precisely
							    why an approval would silently never appear. */}
							<Interrupts />
							<Queue />
							<RunProblem />
						</ConversationContent>
						<ConversationScrollButton />
					</Conversation>
					<Input />
				</div>
			);
		},
		/**
		 * ⚠ Ignores the bound `Parts` component ON PURPOSE — see `SelectedMessagePart`'s
		 * header for why (TanStack's own dispatcher drops tools it has no name for). The
		 * selection below is the library's, so ordering and call/result pairing match what
		 * `Parts` would have rendered; only the dispatch table differs.
		 */
		message: ({ message }) => (
			<Message from={message.role} data-role={message.role}>
				<MessageContent>
					{automaticPartsForMessage(selectMessageUI(message, {})).map((selected, partIndex) => (
						<SelectedMessagePart
							key={`${message.id}-${selected.key}-${partIndex}`}
							selected={selected}
						/>
					))}
				</MessageContent>
			</Message>
		),
	},
	// ⚠ Deliberately empty, and load-bearing as documentation: nothing renders the bound
	// `Parts` component (the `message` slot above dispatches parts itself), so any entry
	// written here is dead code that LOOKS live — which is precisely the state this
	// arrangement replaced (`partsComponents.toolCall` sat here for weeks, unreachable).
	partsComponents: {},
	interruptsComponents: {
		// ⚠ Application-owned, because `ToolApproval` is deprecated too. A generic `fallback`
		// rather than named ids: the server stamps every pi dialog as a plain generic
		// interrupt (no `defineInterrupt` registration), so the fallback IS the dialog
		// renderer — and anything that is not a pi dialog still renders visibly below
		// rather than vanishing.
		generic: {
			// ⚠ Narrowed HERE, on the discriminant, because the slot's union also carries
			// tool-approval interrupts whose `resolveInterrupt` takes (approved, options) —
			// a different call shape. Only `kind:"generic"` has the payload-taking resolver
			// the pi-dialog answers use.
			fallback: ({ interrupt }) =>
				interrupt.kind === "generic" ? (
					<ZenDialogInterrupt interrupt={interrupt} />
				) : (
					<UnhandledInterrupt interrupt={interrupt} />
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
