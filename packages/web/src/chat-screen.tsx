import { automaticPartsForMessage, type ChatUISelectedPart, selectChatUI } from "@tanstack/ai-client/ui";
import { createChatHook, createChatHookContexts, type LayoutProps, type MessageProps } from "@tanstack/ai-react/ui";
import type { PiDialogResponse, ZenDialogSpec } from "@zen/core";
import { ArrowUpIcon, SquareIcon } from "lucide-react";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import {
	Conversation,
	ConversationContent,
	ConversationEmptyState,
	ConversationScrollButton,
} from "./components/ai-elements/conversation.tsx";
import { Message, MessageContent } from "./components/ai-elements/message.tsx";
import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert.tsx";
import { Button } from "./components/ui/button.tsx";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "./components/ui/card.tsx";
import { Input } from "./components/ui/input.tsx";
import { Textarea } from "./components/ui/textarea.tsx";
import { routeZenCustomEvent } from "./custom-event-router.ts";
import { createFixtureChat } from "./fixture-conversation.ts";
import { SessionNotifications } from "./notifications.tsx";
import { PermissionModeSelect, usePermissionMode } from "./permission-mode.tsx";
import {
	createResumableSessionsStore,
	createResumeRequests,
	fetchThreadHistory,
	sessionsNotOnThisPage,
} from "./resumable-sessions.ts";
import { SelectedMessagePart } from "./selected-message-part.tsx";
import { SessionDebugDrawer } from "./session-debug.tsx";
import { SessionStatusBar } from "./session-status.tsx";
import { SessionsRail, UNTITLED_SESSION } from "./sessions-rail.tsx";
import { ThreadStoresContext, useStore, useThreadStores } from "./store.ts";
import {
	adoptThread,
	getThreadStores,
	mintThread,
	type ThreadStores,
	threadListStore,
	titleFromMessages,
	updateThreadSummary,
} from "./thread-stores.ts";
import type { ZenRendererMap } from "./ZenToolResult.tsx";

/**
 * The zen web surface (#24, #17) — every component and the chat wiring, importable with
 * no DOM at module scope (the ENTRY that mounts it is main.tsx, kept thin so the
 * coverage manifest can import everything else). Composed per `docs/ui/react`; presentation layer per #31
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
// ⚠ `typeof window` guard: this module is imported by the coverage manifest under `bun
// test`, where no DOM exists — fixture mode is a browser concern, so headless is never
// fixture mode. The ENTRY (main.tsx) stays the only module that touches the DOM freely.
const isFixtureMode = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("fixture");
/** `?debug` opens the session debug drawer (#86) — same switch shape as `?fixture`. */
const isDebugMode = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("debug");
/**
 * The chat contexts every widget below reads through — created ONCE and handed to every
 * per-thread factory (`createThreadChatHook`), TanStack's escape hatch for "widgets in
 * other files". One `useChatContext` serves every thread's tree because each pane's
 * `AppChat` provides the same context, with its own chat instance.
 */
const chatContexts = createChatHookContexts();
const useChatContext = chatContexts.useChatContext;

/**
 * ⚠ ONE CHAT FACTORY PER THREAD (#90 PR 3), built by the thread's pane. Two facts force it:
 *
 *   • TanStack hands `onCustomEvent` only `(name, value, { toolCallId })` — no thread id —
 *     and the option is bound on the factory, not per call. The only way a `zen.usage`
 *     chunk lands in the right thread's cost is a callback that belongs to exactly one
 *     thread: this closure over its stores.
 *   • Changing `threadId` on a single `useChat` disposes the old client — `stop()` then
 *     `dispose()`, verified in `use-chat.js` — and the follow it holds open. Switching
 *     threads must therefore keep every pane mounted and change only what is visible.
 *
 * `connection` is the thread's `FollowConnection` (#112): TanStack's `SubscribeConnectionAdapter`
 * over prompt/follow. `live: true` opens the follow at mount rather than on the first send,
 * so a run another tab started on this thread renders here without prompting first.
 *
 * `?fixture` swaps the live server connection for the scripted conversation in
 * `fixture-conversation.ts` — the styling dev loop (#31). Everything downstream of the
 * connection is identical on both paths, which is the point.
 */
function threadChatOptions(stores: ThreadStores) {
	return {
		threadId: stores.threadId,
		// A resumed thread mounts with its stored branch (#95); a minted one with nothing.
		initialMessages: [...stores.history],
		connection: isFixtureMode ? createFixtureChat().transport() : stores.connection,
		live: !isFixtureMode,
		/**
		 * TanStack's designated path for AG-UI CUSTOM chunks (#29) — verified against the
		 * stream processor: every CUSTOM chunk fires this with `(chunk.name, chunk.value)`.
		 * The dispatch itself lives in `custom-event-router.ts` so it is testable (#53 S1.3).
		 */
		onCustomEvent: (eventType: string, data: unknown): void => routeZenCustomEvent(stores, eventType, data),
	};
}
/** The options type the widget map below is written against — one shape for every thread. */
type ThreadChatOptions = ReturnType<typeof threadChatOptions>;

function createThreadChatHook(stores: ThreadStores) {
	return createChatHook({ options: threadChatOptions(stores), context: chatContexts, ...chatComponents });
}

/**
 * Whether THIS pane shows the `?debug` column. Provided per pane as `debugOpen && active`:
 * every live pane stays mounted, so gating on the page-level switch alone rendered the
 * column — with its fixed `id` and its own inspection fetches — once per thread, hidden or
 * not (PR #94 review). Exactly one pane is active, so exactly one column exists.
 */
const DebugOpenContext = createContext(false);

/** One selected part paired with the React key that identifies it. */
export interface KeyedPart {
	/** Stable across re-renders AND position changes — see `keyedParts` for why that matters. */
	partKey: string;
	selected: ChatUISelectedPart;
	isTrailingPart: boolean;
}

/**
 * Pairs each selected part with a React key that is an IDENTITY, not a position.
 *
 * ⚠ Tool parts MOVE. The selection runs over the whole message list (see `ChatMessageRow`'s
 * header), so a result the server stamps onto a different message re-pairs its call and
 * shifts that call's index. A key carrying the array index therefore changes identity for a
 * part that did not change — React remounts it and the rendered tool block loses its state.
 * `noArrayIndexKey` is right to refuse it, and this is the fix rather than a suppression:
 * tool parts already carry a real id (`id` on tool-call, `toolCallId` on tool-result), so
 * key by that. Text/thinking/image parts carry no id, but they are append-only within one
 * message, so a per-KIND occurrence counter identifies them without borrowing the position
 * of the whole list.
 *
 * `isTrailingPart` rides along so the caller needs no index either — see its use below.
 *
 * ⓘ Exported for `__tests__/chat-screen.test.tsx` only; nothing else imports it.
 */
export function keyedParts(parts: ChatUISelectedPart[]): KeyedPart[] {
	const seenPerKind = new Map<string, number>();
	return parts.map((selected, position) => {
		const identity = partIdentity(selected);
		if (identity !== undefined) {
			return { partKey: `${selected.key}-${identity}`, selected, isTrailingPart: position === parts.length - 1 };
		}
		const seen = seenPerKind.get(selected.key) ?? 0;
		seenPerKind.set(selected.key, seen + 1);
		return { partKey: `${selected.key}#${seen}`, selected, isTrailingPart: position === parts.length - 1 };
	});
}

/** The part's own stable id, or undefined for the kinds that carry none. */
function partIdentity(selected: ChatUISelectedPart): string | undefined {
	if (selected.key === "toolCall") return selected.part.id;
	if (selected.key === "toolResult") return selected.part.toolCallId;
	return undefined;
}

/**
 * Renders a run-level error as a destructive Alert. Reads the thread's chat through the
 * shared contexts declared above — the same `useChatContext` every widget here uses.
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

/**
 * The composer row's permission-mode control (#84): the thread's current mode, and a
 * dropdown that switches it by sending picc's per-mode slash command — `/acceptEdits`,
 * exactly what typing it does.
 * Beside the composer rather than in the page header (#90 PR 3): it is per THREAD, and
 * deepseek-harness keeps the mode selector in the composer chrome for the same reason.
 *
 * ⚠ Sent as a prompt on purpose, not through a dedicated endpoint: picc's `setMode` is
 * closure-private with no API, its registered commands are the only way in, and the
 * server already routes a slash command down the no-model extension-command path. The
 * indicator then updates from the `zen.entry` receipt that run carries — the mode picc
 * actually set — never from the click.
 *
 * ⚠ Disabled while a run is in flight, the same rule the send button follows: a mode
 * change mid-run would collide with the busy-thread semantics #75 is deciding.
 *
 * On mount it asks the server what a fresh thread starts in, so the control reads
 * `default` from the first paint rather than `unknown` until the first run. In fixture
 * mode there is no server; the fetch fails and the store honestly stays `unknown`.
 */
function PermissionModeControl(): React.ReactNode {
	const chat = useChatContext();
	const stores = useThreadStores();
	const { mode, available } = usePermissionMode();
	useEffect(() => {
		void stores.permissionMode.seed(async () => (await fetch("/api/mode")).json());
	}, [stores]);
	return (
		<PermissionModeSelect
			mode={mode}
			available={available}
			disabled={chat.sessionGenerating}
			// picc registers one command per mode, named exactly the mode (index.ts:526-536).
			onSelect={(next) => void chat.sendMessage(`/${next}`)}
		/>
	);
}

/*
 * ⓘ `DialogAnswerControls`, `ZenDialogCard` and `PendingDialog` are exported for
 * `__tests__/chat-screen.test.tsx` (#49): static renders of each dialog method. Nothing
 * outside this file and that test imports them.
 */

/**
 * pi's blocking dialogs — `select`, `confirm`, `input`, `editor` — answered from the page (#27, #112).
 *
 * The question arrives on the follow as a `zen.dialog` chunk (the `ZenDialogSpec` the
 * server built, validated again by the router before it reaches the store), and the answer
 * is one `POST /api/threads/:id/dialog`. No interrupt: the run keeps going on the follow
 * while the human decides, and nothing on the server is parked.
 *
 * ⚠ The payloads handed to `answer` are EXACTLY pi's wire shapes minus the envelope
 * (`{value}` / `{confirmed}`) — the server validates them against the question
 * (`validateDialogAnswer`) and forwards them verbatim, so inventing a richer shape here
 * would be refused there. Cancel is pi's `{cancelled: true}`.
 */
/**
 * The per-method answer controls, one early return per dialog method — extracted from a
 * ternary chain so each shape reads on its own. `input` and `editor` share the form; the
 * only difference is the field element.
 */
export function DialogAnswerControls({
	dialog,
	answer,
}: {
	dialog: ZenDialogSpec;
	answer: (payload: { value: string } | { confirmed: boolean }) => void;
}): React.ReactNode {
	if (dialog.method === "confirm") {
		return (
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
		);
	}
	if (dialog.method === "select") {
		return (
			<div className="flex flex-col gap-3">
				{/* The detail behind the question (#73): a file preview, a diff, a command. Preformatted,
				    never markdown — model-chosen file content must not render as HTML. */}
				{dialog.message === undefined || dialog.message.length === 0 ? null : (
					<pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/50 p-3 text-xs">
						{dialog.message}
					</pre>
				)}
				<div className="flex flex-wrap gap-2">
					{dialog.options.map((option) => (
						<Button key={option} type="button" variant="outline" onClick={() => answer({ value: option })}>
							{option}
						</Button>
					))}
				</div>
			</div>
		);
	}
	return (
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
				<Input name="answer" placeholder={dialog.placeholder ?? ""} autoComplete="off" className="flex-1" />
			)}
			<Button type="submit">Answer</Button>
		</form>
	);
}

export function ZenDialogCard({
	dialog,
	answer,
	cancel,
}: {
	dialog: ZenDialogSpec;
	answer: (payload: { value: string } | { confirmed: boolean }) => void;
	cancel: () => void;
}): React.ReactNode {
	return (
		<Card className="my-4">
			<CardHeader>
				<CardDescription className="uppercase tracking-wide">pi is asking</CardDescription>
				<CardTitle className="text-base">{dialog.title}</CardTitle>
			</CardHeader>
			<CardContent>
				<DialogAnswerControls dialog={dialog} answer={answer} />
			</CardContent>
			<CardFooter>
				<Button type="button" variant="ghost" size="sm" onClick={cancel}>
					Cancel — decline the question
				</Button>
			</CardFooter>
		</Card>
	);
}

/**
 * Answer the thread's open question through its connection. The slot clears once the
 * question is SPENT — taken by the server (`answered`), or already settled from another
 * tab or expired (`gone`). A `refused` answer (an unoffered value, 422) leaves the question
 * open on the server, so it stays on screen with the reason as a notice: nothing would
 * re-show it otherwise, and the thread would sit busy behind a card that vanished (PR #113
 * review). `unreachable` (the request never arrived) leaves it open the same way.
 * ⓘ Exported for `__tests__/chat-screen.test.tsx`.
 */
export async function settleDialog(
	stores: Pick<ThreadStores, "connection" | "dialog">,
	response: PiDialogResponse,
): Promise<void> {
	const outcome = await stores.connection.answerDialog(response);
	if (outcome === "answered" || outcome === "gone") stores.dialog.set(undefined);
}

/** The thread's open question, if any — see {@link settleDialog}. */
export function PendingDialog(): React.ReactNode {
	const stores = useThreadStores();
	const pending = useStore(stores.dialog);
	if (pending === undefined) return null;
	const settle = (response: PiDialogResponse): void => {
		void settleDialog(stores, response);
	};
	return (
		<ZenDialogCard
			dialog={pending.dialog}
			answer={(payload) => settle({ id: pending.id, ...payload })}
			cancel={() => settle({ id: pending.id, cancelled: true })}
		/>
	);
}

/**
 * The widget map every per-thread factory is built from — declared once, so all threads
 * render identically. Type-annotated by inference through `createThreadChatHook`.
 */
const chatComponents = {
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
			const stores = useThreadStores();
			const disconnected = useStore(stores.disconnected);
			// Controlled, so the send button can disable on empty — the ai-elements chatbot
			// example's PromptInput does the same.
			const [draft, setDraft] = useState("");

			// Nothing sends while disconnected (#119, PR #123 review): the prompt would reach a
			// server that rebuilds the thread, but this page's follow is gone, so the reply would
			// land nowhere this page can see. Same shape as the missing stop; the placeholder says why.
			const canSend = draft.trim().length > 0 && !disconnected;
			const sendDraft = (): void => {
				if (!canSend) return;
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
					{/* The composer chrome (#90): the knobs at the point of use, deepseek's shape. */}
					<div className="flex items-center justify-end px-1 pb-1">
						<PermissionModeControl />
					</div>
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
							placeholder={disconnected ? "disconnected — reload and resume from the rail" : "ask pi something"}
							autoComplete="off"
							rows={1}
							className="max-h-40 min-h-9 flex-1 resize-none border-0 shadow-none focus-visible:ring-0 dark:bg-transparent"
						/>
						{/* Stop while a run is in flight (#116), through the thread's connection —
						    `POST …/abort` → pi's own abort. ⚠ NOT `chat.stop()`: that aborts this
						    client's POST, which returned at admission, and touches nothing on the
						    server. The run ends on the follow (`settled`, `status`) like any other,
						    so this button changes nothing itself; the feed does. Read off
						    `sessionGenerating`, the shared run flag — `isLoading` never rises here
						    (#103 receipt). Not offered once the follow has ended (#119): the flag
						    is then as of that moment, and a stop that may stop nothing is the #4 shape. */}
						{chat.sessionGenerating && !disconnected ? (
							<Button
								type="button"
								size="icon"
								variant="outline"
								aria-label="stop the run"
								title="stop the run in flight — pi is told; the run ends on the feed"
								onClick={() => void stores.connection.abort()}
							>
								<SquareIcon />
							</Button>
						) : null}
						{/* Send stays in flight too: a prompt during a run QUEUES through pi (#75). */}
						<Button type="submit" size="icon" aria-label="send message" disabled={!canSend}>
							<ArrowUpIcon />
						</Button>
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
		layout: function ChatLayout({ Messages, Queue, Input }: LayoutProps<ThreadChatOptions>) {
			const chat = useChatContext();
			const debugOpen = useContext(DebugOpenContext);
			return (
				<div className="flex min-h-0 flex-1 flex-col">
					<div className="flex min-h-0 flex-1">
						<div className="flex min-h-0 min-w-0 flex-1 flex-col">
							<Conversation>
								<ConversationContent className="mx-auto w-full max-w-3xl">
									{chat.messages.length === 0 ? (
										<ConversationEmptyState
											icon={<img src="/logo-full.png" alt="zen-harness" className="w-44" />}
											title=""
											description="ask pi something to get started"
										/>
									) : (
										<Messages />
									)}
									{/* pi's notify lines (#29) — the transcript tail, above the question,
									    so "Mode set to X" reads next to the run it belongs to. */}
									<SessionNotifications />
									{/* ⚠ Mounted before anything opens one, deliberately. This is where #4's
									    `ask` verdict reaches the browser, and an unmounted slot is precisely
									    why an approval would silently never appear. */}
									<PendingDialog />
									<Queue />
									<RunProblem />
								</ConversationContent>
								<ConversationScrollButton />
							</Conversation>
							<Input />
						</div>
						{/* The session debug pane (#86): what the browser believes beside what pi's
						    session holds, for THIS thread. Scrolls on its own so a long branch never
						    moves the composer. */}
						{debugOpen ? (
							<div id="session-debug-pane" className="w-[30rem] shrink-0 overflow-y-auto border-l">
								<SessionDebugDrawer />
							</div>
						) : null}
					</div>
					{/* The status bar (#90): activity, turns, tool calls, cost — always visible, full
					    width under transcript AND debug pane, so it is the one place to look. */}
					<SessionStatusBar messages={chat.messages} generating={chat.sessionGenerating} />
				</div>
			);
		},
		/**
		 * ⚠ Ignores the bound `Parts` component ON PURPOSE — see `SelectedMessagePart`'s
		 * header for why (TanStack's own dispatcher drops tools it has no name for).
		 *
		 * The selection is the library's, run over the WHOLE message list — the same input
		 * its own Messages component gives `selectChatUI` — so a tool result the server
		 * stamps onto a DIFFERENT message than its call still pairs. A per-message
		 * `selectMessageUI` was the first draft and would have shown such a call as
		 * "running…" forever. O(messages²) per render is irrelevant at chat scale.
		 */
		message: function ChatMessageRow({ message }: MessageProps<ThreadChatOptions>) {
			const chat = useChatContext();
			const selectedMessage = selectChatUI({ messages: chat.messages }).messages.find(
				(entry) => entry.message.id === message.id,
			);
			const selectedParts = selectedMessage === undefined ? [] : automaticPartsForMessage(selectedMessage);
			const isLastMessage = chat.messages.at(-1)?.id === message.id;
			return (
				<Message from={message.role} data-role={message.role}>
					<MessageContent>
						{keyedParts(selectedParts).map(({ partKey, selected, isTrailingPart }) => (
							<SelectedMessagePart
								key={`${message.id}-${partKey}`}
								selected={selected}
								// ⚠ Part-level, not chat-level: true only for the TRAILING part of
								// the TRAILING message while a run is in flight. Passing bare
								// `chat.isLoading` here re-opened EVERY prior thinking block on
								// every later send (the Reasoning shell's auto-close latches after
								// its first close, so they also never closed again) and overwrote
								// each block's "Thought for N seconds" with the later run's timing.
								isStreaming={chat.sessionGenerating && isLastMessage && isTrailingPart}
								renderers={descriptorRenderers}
							/>
						))}
					</MessageContent>
				</Message>
			);
		},
	},
	// ⚠ Deliberately empty, and load-bearing as documentation: nothing renders the bound
	// `Parts` component (the `message` slot above dispatches parts itself), so any entry
	// written here is dead code that LOOKS live — which is precisely the state this
	// arrangement replaced (`partsComponents.toolCall` sat here for weeks, unreachable).
	partsComponents: {},
	// No `interruptsComponents`: pi's questions are not AG-UI interrupts on this surface
	// (#112) — they arrive as `zen.dialog` chunks and render through `PendingDialog` above.
};

/**
 * One thread's pane: its chat factory, its stores in context, its summary kept current for
 * the rail. Stays mounted while another thread is on screen — see `createThreadChatHook`
 * for why hiding, not unmounting, is load-bearing.
 *
 * ⓘ Exported for `__tests__/chat-screen.test.tsx` only, which mounts two of them to pin
 * that a hidden pane renders no debug column. Nothing else imports it.
 */
export function ThreadPane({
	threadId,
	active,
	debugOpen,
}: {
	threadId: string;
	active: boolean;
	/** The page's `?debug` switch; the column itself opens only in the active pane. */
	debugOpen: boolean;
}): React.ReactNode {
	const stores = getThreadStores(threadId);
	const { useAppChat } = useMemo(() => createThreadChatHook(stores), [stores]);
	const chat = useAppChat();
	useEffect(() => {
		updateThreadSummary(threadId, { title: titleFromMessages(chat.messages), busy: chat.sessionGenerating });
	}, [threadId, chat.messages, chat.sessionGenerating]);
	return (
		<div className={active ? "flex min-h-0 min-w-0 flex-1 flex-col" : "hidden"}>
			<ThreadStoresContext.Provider value={stores}>
				<DebugOpenContext.Provider value={debugOpen && active}>
					<chat.AppChat />
				</DebugOpenContext.Provider>
			</ThreadStoresContext.Provider>
		</div>
	);
}

/**
 * The first thread is minted when this module loads, as the page's single thread was
 * (#86): every page load starts a fresh session, mode and all.
 */
const FIRST_THREAD_ID = mintThread().threadId;

/**
 * The stored sessions the rail can come back to (#95). Page-level, refreshed on load and
 * whenever a run settles — the moments a session file appears or grows.
 */
const resumableSessions = createResumableSessionsStore();

/** The page (#90): header, the sessions rail, and one mounted pane per live thread. */
export function ChatScreen(): React.ReactNode {
	const threads = useStore(threadListStore);
	const stored = useStore(resumableSessions);
	const [activeThreadId, setActiveThreadId] = useState(FIRST_THREAD_ID);
	const [resumeError, setResumeError] = useState<string | undefined>(undefined);
	const anyBusy = threads.some((thread) => thread.busy);
	useEffect(() => {
		// Load, and every time the page goes from a run in flight to none: something settled.
		if (!(anyBusy || isFixtureMode)) void resumableSessions.refresh();
	}, [anyBusy]);
	const pageThreadIds = new Set(threads.map((thread) => thread.threadId));
	// Last click wins (PR #104 review) — the race lives in `createResumeRequests`, tested there.
	// The two setters are stable, so the coordinator is created once per page.
	const resume = useMemo(
		() =>
			createResumeRequests(
				fetchThreadHistory,
				(history) => {
					setResumeError(undefined);
					setActiveThreadId(adoptThread(history).threadId);
				},
				setResumeError,
			),
		[],
	);
	// The debug column (#86) is a right-hand pane, not a bottom drawer: stacked under the
	// transcript it took forty percent of the height and squeezed the conversation it
	// exists to explain. Opt-in by `?debug`; open by default when it is, and collapsible
	// from the header so it can get out of the way without a reload.
	const [debugOpen, setDebugOpen] = useState(isDebugMode);
	const active = threads.find((thread) => thread.threadId === activeThreadId);
	return (
		<div className="flex h-dvh flex-col bg-background text-foreground">
			<header className="flex items-center gap-2 border-b px-4 py-2">
				{/* The ensō mark, cropped from .local/logo.png into public/enso.png —
				    kanagawa fujiWhite cream, so it reads on the Wave background. */}
				<img src="/enso.png" alt="" className="size-6" />
				<h1 className="font-medium text-muted-foreground text-sm">zen-harness</h1>
				{isFixtureMode ? (
					<span className="rounded-full border px-2 py-0.5 text-muted-foreground text-xs">fixture</span>
				) : null}
				{/* Where you are: the active thread's title, the same one the rail shows. */}
				<span className="min-w-0 flex-1 truncate text-sm" title={activeThreadId}>
					{active?.title ?? UNTITLED_SESSION}
				</span>
				{isDebugMode ? (
					<Button
						type="button"
						size="sm"
						variant={debugOpen ? "secondary" : "outline"}
						aria-expanded={debugOpen}
						aria-controls="session-debug-pane"
						onClick={() => setDebugOpen((open) => !open)}
					>
						{debugOpen ? "hide debug" : "show debug"}
					</Button>
				) : null}
			</header>
			<div className="flex min-h-0 flex-1">
				<SessionsRail
					threads={threads}
					activeThreadId={activeThreadId}
					earlier={sessionsNotOnThisPage(stored.sessions, pageThreadIds)}
					earlierError={stored.error ?? resumeError}
					now={new Date()}
					onSelect={setActiveThreadId}
					onResume={resume}
					onNew={() => setActiveThreadId(mintThread().threadId)}
				/>
				{threads.map((thread) => (
					<ThreadPane
						key={thread.threadId}
						threadId={thread.threadId}
						active={thread.threadId === activeThreadId}
						debugOpen={isDebugMode && debugOpen}
					/>
				))}
			</div>
		</div>
	);
}
