import type { ExtensionUIContext, KeybindingsManager, Theme as PiTheme } from "@earendil-works/pi-coding-agent";
import { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import {
	isZenDialogSpec,
	type PiDialogResponse,
	type PiRpcEvent,
	type ZenDialogOutcome,
	type ZenOpenDialog,
} from "@zen/core";
import { type LiftedPermissionDialog, liftPermissionDialog } from "./permission-dialog.ts";

/** The factory `ExtensionUIContext.custom` receives, named so the method can be written without `Parameters<>`. */
export type CustomComponentFactory<T> = (
	tui: TUI,
	theme: PiTheme,
	keybindings: KeybindingsManager,
	done: (result: T) => void,
) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>;

/**
 * The `ExtensionUIContext` the web server hands to an in-process `AgentSession` (#69).
 *
 * WHY THIS OBJECT EXISTS
 * Over the rpc subprocess, an extension's `ctx.ui.confirm(...)` became an
 * `extension_ui_request` line on stdout and the answer an `extension_ui_response` line on
 * stdin — pi's rpc mode owned the pending-dialog map. In-process there is no wire: the host
 * IS the UI, so it implements the interface pi's extensions call and turns each call into
 * the SAME rpc-shaped record the browser pipeline already consumes (`map-events.ts`
 * `extension_ui_request`, the #27 dialog park in `session.ts`). Replicated from pi 0.84.4
 * `dist/modes/rpc/rpc-mode.js` `createExtensionUIContext` (MIT), which is the reference
 * for "a UI with no terminal".
 *
 * ⚠ `ctx.hasUI` IS `true` THE MOMENT ANY OBJECT IS BOUND — pi's runner compares against its
 * no-op context, not against `mode`. That is load-bearing for picc-permission-modes: with
 * no UI it fails closed and denies every mutating tool (the #20 failure). So this object
 * must be bound on every session, and the blocking methods must genuinely block until a
 * human answers or the request is cancelled — never resolve a default eagerly.
 *
 * WHAT IS REAL AND WHAT IS A NO-OP
 * `select`/`confirm`/`input`/`editor` block on a pending map keyed by request id. `custom`
 * builds the extension's component and, when it is one this surface knows (#73: picc's
 * permission prompt), lifts it to a blocking `select`; any other component resolves
 * `undefined`, pi's rpc contract. `notify`, `setStatus`, `setWidget`, `setTitle`,
 * `setEditorText` emit fire-and-forget records (the mapper forwards `notify` and drops the
 * terminal-addressed rest, as before). Everything else is a terminal concern with no
 * browser equivalent and returns its inert value.
 */

/** The four dialog methods pi's rpc protocol names blocking. `map-events.ts` agrees (its `DIALOG_UI_METHODS`). */
type BlockingDialogRequest =
	| { method: "select"; title: string; options: string[]; message?: string; timeout?: number }
	| { method: "confirm"; title: string; message: string; timeout?: number }
	| { method: "input"; title: string; placeholder?: string; timeout?: number }
	| { method: "editor"; title: string; prefill?: string };

/**
 * What a component factory is handed in place of a terminal. picc's factory reads only
 * `tui.terminal.rows` (inside a try) to size its panel and never touches the keybindings;
 * nothing else on the web path touches either. Typed as pi's parameter types because that
 * is what the factory declares — the casts are the one place the "no terminal" fact meets
 * a terminal-shaped signature.
 */
const INERT_TUI = { terminal: { rows: 24, columns: 80 } } as unknown as TUI;
const INERT_KEYBINDINGS = {} as unknown as KeybindingsManager;

interface PendingDialog {
	resolve: (response: PiDialogResponse) => void;
	/** What was asked — the `extension_ui_request` minus its id — so an answer can be checked against it (#112). */
	request: BlockingDialogRequest;
}

export interface ZenExtensionUiContextOptions {
	/** Where every record goes — the host's event emitter, so records interleave with session events in order. */
	emit: (event: PiRpcEvent) => void;
	/** Notified for an answer that names no pending dialog — a replay or a stale tab. Never silent. */
	onProblem: ((problem: unknown) => void) | undefined;
	/**
	 * How a `custom` component becomes a select (#73). Defaults to `liftPermissionDialog`;
	 * ⓘ injectable so `__tests__/extension-ui-context.test.ts` can exercise the fail-closed
	 * path (the lift rejecting because picc's module did not load) without unloading picc.
	 */
	liftDialog?: (component: unknown) => Promise<LiftedPermissionDialog | undefined>;
	/** How long an ASYNC component factory may take to produce its component. Defaults to `CUSTOM_COMPONENT_BUILD_TIMEOUT_MS`; injectable for tests. */
	componentBuildTimeoutMs?: number;
}

/**
 * The budget an async `custom` factory gets to construct its component (#73, PR #107
 * review). Construction is meant to be immediate — picc's factory is synchronous — but a
 * factory may legitimately return a promise (to load something), and one that instead
 * waits on terminal interaction would hang the extension forever against a TUI that will
 * never answer. Past the budget the call falls back to pi's rpc contract (`undefined`).
 */
export const CUSTOM_COMPONENT_BUILD_TIMEOUT_MS = 2000;

export interface ZenExtensionUiContext {
	readonly uiContext: ExtensionUIContext;
	/** Deliver an answer. Unknown ids are reported, not thrown — the extension is not waiting on them. */
	answerDialog(response: PiDialogResponse): void;
	/** Every pending question, oldest first, as the follow's snapshot lists them (#114). Empty once settled. */
	openDialogs(): ZenOpenDialog[];
	/** Cancel every pending dialog — session teardown. Each blocked extension call resolves to its cancel value. */
	cancelAllDialogs(): void;
	/** How many dialogs are blocked right now — observable state for tests and for the idle-timeout logic. */
	pendingDialogCount(): number;
}

/**
 * A neutral 256-colour theme for the `theme` getter. The interface requires a `Theme`
 * instance and pi exports the class but not its singleton; no extension the harness loads
 * renders through it on the web surface (`hasUI` gates picc's footer, and footers do not
 * exist here), so the values only need to be complete — tsc enforces that — not pretty.
 */
const NEUTRAL_ANSI_256_FOREGROUND = 250;
const NEUTRAL_ANSI_256_BACKGROUND = 236;
function createNeutralTheme(): PiTheme {
	const fg = NEUTRAL_ANSI_256_FOREGROUND;
	const bg = NEUTRAL_ANSI_256_BACKGROUND;
	return new Theme(
		{
			accent: fg,
			border: fg,
			borderAccent: fg,
			borderMuted: fg,
			success: fg,
			error: fg,
			warning: fg,
			muted: fg,
			dim: fg,
			text: fg,
			thinkingText: fg,
			userMessageText: fg,
			customMessageText: fg,
			customMessageLabel: fg,
			toolTitle: fg,
			toolOutput: fg,
			mdHeading: fg,
			mdLink: fg,
			mdLinkUrl: fg,
			mdCode: fg,
			mdCodeBlock: fg,
			mdCodeBlockBorder: fg,
			mdQuote: fg,
			mdQuoteBorder: fg,
			mdHr: fg,
			mdListBullet: fg,
			toolDiffAdded: fg,
			toolDiffRemoved: fg,
			toolDiffContext: fg,
			syntaxComment: fg,
			syntaxKeyword: fg,
			syntaxFunction: fg,
			syntaxVariable: fg,
			syntaxString: fg,
			syntaxNumber: fg,
			syntaxType: fg,
			syntaxOperator: fg,
			syntaxPunctuation: fg,
			thinkingOff: fg,
			thinkingMinimal: fg,
			thinkingLow: fg,
			thinkingMedium: fg,
			thinkingHigh: fg,
			thinkingXhigh: fg,
			bashMode: fg,
		},
		{
			selectedBg: bg,
			userMessageBg: bg,
			customMessageBg: bg,
			toolPendingBg: bg,
			toolSuccessBg: bg,
			toolErrorBg: bg,
		},
		"256color",
		{ name: "zen-web-neutral" },
	);
}

export function createZenExtensionUiContext(options: ZenExtensionUiContextOptions): ZenExtensionUiContext {
	const { emit, onProblem } = options;
	const liftDialog = options.liftDialog ?? liftPermissionDialog;
	const componentBuildTimeoutMs = options.componentBuildTimeoutMs ?? CUSTOM_COMPONENT_BUILD_TIMEOUT_MS;

	/**
	 * Release a component without letting its `dispose` take the extension call down: the
	 * build path was hardened so a factory failure is non-fatal, and a throwing `dispose`
	 * is the same boundary (PR #107 review). Reported, never propagated.
	 */
	function disposeQuietly(component: (Component & { dispose?(): void }) | undefined): void {
		try {
			component?.dispose?.();
		} catch (error) {
			onProblem?.(`custom component's dispose() threw on the web surface: ${String(error)}`);
		}
	}

	/**
	 * Build the extension's component against the inert terminal, within the budget.
	 * Resolves `undefined` — never throws — when the factory throws, rejects, or does not
	 * produce a component in time: pi's rpc mode never ran the factory at all, so any
	 * factory that cannot survive a terminal-less build keeps the fallback it always had
	 * (PR #107 review). The failure is reported, not swallowed. A component that arrives
	 * AFTER the budget is disposed on arrival — nobody else will ever see it.
	 */
	async function buildComponent<T>(
		factory: CustomComponentFactory<T>,
		done: (result: T) => void,
	): Promise<(Component & { dispose?(): void }) | undefined> {
		try {
			const built = factory(INERT_TUI, uiContext.theme, INERT_KEYBINDINGS, done);
			if (!(built instanceof Promise)) return built;
			const budget = Promise.withResolvers<never>();
			const timer = setTimeout(() => {
				budget.reject(new Error(`no component within ${componentBuildTimeoutMs} ms`));
				built.then(disposeQuietly, () => undefined);
			}, componentBuildTimeoutMs);
			try {
				return await Promise.race([built, budget.promise]);
			} finally {
				clearTimeout(timer);
			}
		} catch (error) {
			onProblem?.(
				`custom component could not be built on the web surface — resolving undefined, pi's rpc contract: ${String(error)}`,
			);
			return undefined;
		}
	}
	const pendingDialogs = new Map<string, PendingDialog>();
	let neutralTheme: PiTheme | undefined;

	/**
	 * Block on a dialog until an answer, a cancellation, the caller's own abort signal, or
	 * the caller's timeout. `mapResponse` turns the wire answer into the method's return type;
	 * `cancelValue` is what the extension sees for every non-answer outcome — pi's own
	 * contract (`select`/`input`/`editor` → `undefined`, `confirm` → `false`).
	 *
	 * Every path that stops the wait goes through `finish`, which is why the settle record
	 * (#114) is emitted there and nowhere else: pi has no event for a question ending, and a
	 * follower that did not answer it has no other way to learn the card is stale.
	 */
	function awaitDialog<T>(
		request: BlockingDialogRequest,
		dialogOptions: { signal?: AbortSignal; timeout?: number } | undefined,
		cancelValue: T,
		mapResponse: (response: PiDialogResponse) => T,
	): Promise<T> {
		return new Promise<T>((resolve) => {
			const id = crypto.randomUUID();
			let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
			const finish = (value: T, outcome: ZenDialogOutcome): void => {
				if (!pendingDialogs.delete(id)) return; // already settled by another path
				if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
				dialogOptions?.signal?.removeEventListener("abort", onAbort);
				emit({ type: "extension_ui_settled", id, outcome });
				resolve(value);
			};
			const onAbort = (): void => finish(cancelValue, "aborted");
			if (dialogOptions?.signal?.aborted) {
				resolve(cancelValue);
				return;
			}
			dialogOptions?.signal?.addEventListener("abort", onAbort);
			if (dialogOptions?.timeout !== undefined) {
				timeoutHandle = setTimeout(() => finish(cancelValue, "timeout"), dialogOptions.timeout);
			}
			pendingDialogs.set(id, {
				resolve: (response) =>
					"cancelled" in response && response.cancelled
						? finish(cancelValue, "cancelled")
						: finish(mapResponse(response), "answered"),
				request,
			});
			emit({ type: "extension_ui_request", id, ...request });
		});
	}

	const uiContext: ExtensionUIContext = {
		select: (title, options, dialogOptions) =>
			awaitDialog(
				{
					method: "select",
					title,
					options,
					...(dialogOptions?.timeout === undefined ? {} : { timeout: dialogOptions.timeout }),
				},
				dialogOptions,
				undefined,
				(response) => ("value" in response ? response.value : undefined),
			),
		confirm: (title, message, dialogOptions) =>
			awaitDialog(
				{
					method: "confirm",
					title,
					message,
					...(dialogOptions?.timeout === undefined ? {} : { timeout: dialogOptions.timeout }),
				},
				dialogOptions,
				false,
				(response) => ("confirmed" in response ? response.confirmed : false),
			),
		input: (title, placeholder, dialogOptions) =>
			awaitDialog(
				{
					method: "input",
					title,
					...(placeholder === undefined ? {} : { placeholder }),
					...(dialogOptions?.timeout === undefined ? {} : { timeout: dialogOptions.timeout }),
				},
				dialogOptions,
				undefined,
				(response) => ("value" in response ? response.value : undefined),
			),
		editor: (title, prefill) =>
			awaitDialog(
				{ method: "editor", title, ...(prefill === undefined ? {} : { prefill }) },
				undefined,
				undefined,
				(response) => ("value" in response ? response.value : undefined),
			),
		notify(message, type) {
			emit({ type: "extension_ui_request", id: crypto.randomUUID(), method: "notify", message, notifyType: type });
		},
		setStatus(key, text) {
			emit({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "setStatus",
				statusKey: key,
				statusText: text,
			});
		},
		setWidget(key, content, widgetOptions) {
			// A component factory has no serialisable form; only string lines cross (pi's rule too).
			if (typeof content === "function") return;
			emit({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "setWidget",
				widgetKey: key,
				widgetLines: content,
				widgetPlacement: widgetOptions?.placement,
			});
		},
		setTitle(title) {
			emit({ type: "extension_ui_request", id: crypto.randomUUID(), method: "setTitle", title });
		},
		setEditorText(text) {
			emit({ type: "extension_ui_request", id: crypto.randomUUID(), method: "set_editor_text", text });
		},
		// ── Terminal-only surface: inert on the web, exactly as in pi's rpc mode ──────────
		onTerminalInput: () => () => undefined,
		setWorkingMessage: () => undefined,
		setWorkingVisible: () => undefined,
		setWorkingIndicator: () => undefined,
		setHiddenThinkingLabel: () => undefined,
		setFooter: () => undefined,
		setHeader: () => undefined,
		/**
		 * Build the component the extension asked for and lift it if it is one this surface
		 * knows (#73). `done` is the same callback picc's own dialog would call on a keypress;
		 * here the lifted select's answer is what calls it, so the extension's `await` settles
		 * with a string it offered — or `undefined` on cancel/dismiss, its "no" path. An
		 * unknown component resolves `undefined` at once, exactly as pi's rpc mode does.
		 */
		async custom<T>(factory: CustomComponentFactory<T>): Promise<T> {
			const { promise, resolve } = Promise.withResolvers<T>();
			const component = await buildComponent(factory, resolve);
			let lifted: LiftedPermissionDialog | undefined;
			try {
				lifted = await liftDialog(component);
			} catch (error) {
				// picc's module did not load: the prompt cannot be lifted. Fail closed the way
				// pi's rpc mode does (the extension sees "dismissed"), and say why — silently
				// refusing every write is the #73 state this exists to end.
				onProblem?.(`custom dialog could not be lifted (#73): ${String(error)}`);
			}
			if (lifted === undefined) {
				disposeQuietly(component);
				// pi's rpc contract, stated in TypeScript: an unknown component is "no component".
				resolve(undefined as T);
				return promise;
			}
			const choice = await awaitDialog(
				{ method: "select", title: lifted.title, options: [...lifted.options], message: lifted.message },
				undefined,
				undefined,
				(response) => ("value" in response ? response.value : undefined),
			);
			disposeQuietly(component);
			// The lifted select's value is one of the strings picc offered — `T` for picc is
			// `FilePermissionChoice = string | null`, and cancel is `undefined`, its "no" path.
			resolve(choice as T);
			return promise;
		},
		pasteToEditor: () => undefined,
		getEditorText: () => "",
		addAutocompleteProvider: () => undefined,
		setEditorComponent: () => undefined,
		getEditorComponent: () => undefined,
		get theme() {
			neutralTheme ??= createNeutralTheme();
			return neutralTheme;
		},
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "Theme switching is not available on the web surface" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => undefined,
	};

	return {
		uiContext,
		answerDialog(response) {
			const pending = pendingDialogs.get(response.id);
			if (pending === undefined) {
				onProblem?.(
					`dialog answer for unknown request id ${response.id} — already answered, cancelled, or never asked`,
				);
				return;
			}
			pending.resolve(response);
		},
		openDialogs() {
			const open: ZenOpenDialog[] = [];
			for (const [id, { request }] of pendingDialogs) {
				// The request IS a dialog spec structurally (the mapper builds the browser's spec
				// from the same fields); checked rather than cast, so a request shape the spec
				// does not admit (a select with no options) is not listed as a question here either.
				if (isZenDialogSpec(request)) open.push({ id, dialog: request });
			}
			return open;
		},
		cancelAllDialogs() {
			for (const [id, pending] of [...pendingDialogs]) {
				pending.resolve({ id, cancelled: true });
			}
		},
		pendingDialogCount() {
			return pendingDialogs.size;
		},
	};
}
