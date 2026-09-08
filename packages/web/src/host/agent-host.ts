import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
	type ExtensionError,
	type InlineExtension,
	initTheme,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
	findRepoRoot,
	PICC_DEFAULT_PERMISSION_MODE,
	PICC_PERMISSION_MODES,
	type PiCommand,
	type PiPermissionModeState,
	type PiRpcEvent,
	type PiSession,
	quarantineSecrets,
	readPiccPersistedMode,
	type ZenThreadEvent,
} from "@zen/core";
import { createEventTail, describePiRpcEvent } from "./event-tail.ts";
import { createZenExtensionUiContext } from "./extension-ui-context.ts";
import { toRpcWireEvent } from "./session-events.ts";

/**
 * pi, hosted IN THIS PROCESS (#69) — the web server's replacement for spawning
 * `pi --mode rpc` per prompt.
 *
 * pi's own rpc docs: "If you're building a Node.js application, consider using
 * `AgentSession` directly … instead of spawning a subprocess." This module is that: one
 * `createAgentSessionServices` + `createAgentSessionFromServices` per hosted session, the
 * harness package loaded through the SAME loader path the CLI's `-e <dir>` uses, and our
 * `ExtensionUIContext` bound so dialogs reach the browser (#27) and picc's `hasUI` is true.
 *
 * ⚠⚠ ONE SERVICES OBJECT PER SESSION, NEVER SHARED. Spike receipt (2026-09-05, #69): two
 * sessions created from ONE services object share their extension INSTANCES — the probe
 * factory ran once and that single closure received `session_start` twice. Shared closures
 * mean thread A's read tracker authorises thread B's writes and A's `/mode` applies to B.
 * Two services objects gave two instances. So a services object is created per session and
 * never reused, whatever it costs in reload time (~10ms warm; the first load pays ~700ms).
 *
 * ⚠⚠ `PI_CODING_AGENT_DIR` MUST BE SET BEFORE THE FIRST SERVICES. pi-multi-account reads it
 * at MODULE IMPORT (`index.ts:714`) and derives `auth.json`, `settings.json`, `models.json`
 * from it. Spike receipt: unset, it read the operator's REAL `~/.pi/agent` — two real
 * accounts, real credentials — the exact isolation defect the first live run had (see
 * `server/index.ts`'s history). Set on `process.env` here, once, at host creation.
 *
 * ⚠⚠ `childProxy: false` IS SEEDED INTO THE AGENT DIR'S `provider-failover.json`. Spike
 * receipt: with the default `childProxy: true`, the SECOND session in one process hangs in
 * `session_start` forever — multi-account binds a fixed loopback port (41977), the second
 * instance hits EADDRINUSE, and its fallback `server.listen(0)` relies on a `listening`
 * listener that Bun (unlike Node 24) does not re-fire after an error. The proxy exists so
 * processes spawned WITHOUT the extension can ride the rotation's account; this server
 * spawns none. Read-merge-write: multi-account writes its defaults only when the file is
 * absent, and its user-facing commands read-merge-write the same file.
 *
 * ⚠ `bindExtensions` IS CALLED EXACTLY ONCE PER SESSION. Every call emits `session_start`
 * (the guards reset their read tracker on it; multi-account resets thirteen failover
 * guards). Without the call, `session_start` never fires and `ctx.hasUI` is false.
 *
 * ⚠⚠ SECRETS ARE QUARANTINED AT HOST CREATION, before the first session (#89). pi runs in
 * this process and every `bash` child inherits this process's environment, which bun's
 * `.env` autoload had filled with `TAVILY_API_KEY`; `bash env` printed it into a
 * transcript. `quarantineSecrets` deletes every secret-shaped name and every name the
 * secrets file defines. The extensions that need a key read `.zen/secrets.env` directly
 * (`readSecret`) — see `@zen/core`'s secrets.ts for why the root `.env` is the wrong place.
 */

/** The agent dir's multi-account config file, and the one key this host must pin in it. */
const MULTI_ACCOUNT_CONFIG_FILENAME = "provider-failover.json";
const MULTI_ACCOUNT_CHILD_PROXY_KEY = "childProxy";

/** pi's `InputSource` for prompts that arrive over a wire rather than a keyboard. */
const PROMPT_SOURCE_RPC = "rpc";

/** The `ExtensionMode` we bind — `ctx.mode` as extensions see it. rpc is the truthful one: no terminal, a remote surface. */
const EXTENSION_MODE_RPC = "rpc";

export interface AgentHostOptions {
	/** The tree pi reads and writes. One per server, never from a request (see `server/index.ts`). */
	cwd: string;
	/** Scratch config dir — the operator's own packages and credentials stay invisible. */
	agentDir: string;
	/** The zen harness pi package directory; loaded as the ONLY extension source. */
	harnessPackageDir: string;
	/** Notified for load diagnostics, extension errors, and answers to unknown dialogs. Never swallowed. */
	onProblem: ((problem: unknown) => void) | undefined;
	/**
	 * The environment the secrets quarantine (#89) scrubs — `process.env` in production, the
	 * one pi and every `bash` child inherit. A seam so the quarantine is testable without a
	 * test ever touching `process.env` (the repo's rule for tests). The agent-dir pin is not
	 * on this seam: it is a process fact pi-multi-account reads at import.
	 */
	environment?: Record<string, string | undefined>;
	/**
	 * Test seam: inline extensions loaded BESIDE the harness. A test can register a probe that
	 * asks a dialog on `session_start`, or throws there, and observe what the host does — with
	 * no model, no key, no network. Never set in production.
	 */
	extensionFactories?: readonly InlineExtension[];
}

/**
 * What pi's session for one hosted thread actually contains, read straight off the
 * `SessionManager` (#86). Everything a run shows the browser is derived from the event
 * stream; this is the source those views derive from, for a human or an agent to
 * cross-check against.
 */
export interface HostedSessionInspection {
	readonly sessionId: string;
	readonly cwd: string;
	readonly sessionDir: string;
	/** The session file once pi has flushed it; null while the session lives only in memory. */
	readonly sessionFile: string | null;
	/** The branch, root to leaf, verbatim — pi's own entry shapes. */
	readonly entries: readonly unknown[];
	/** Slash commands this session registers. */
	readonly commands: readonly string[];
}

export interface HostedSession {
	readonly session: PiSession;
	/** How many extensions the loader found — the load receipt a caller may assert. */
	readonly loadedExtensionPaths: readonly string[];
	/**
	 * Read-only view of the session as pi holds it. Deliberately here and NOT on
	 * `PiSession`: that is the run contract, pinned by three fakes and the refusal-path
	 * tests, and inspection is a host concern.
	 */
	inspect(): HostedSessionInspection;
	/** The emitted tail (#97): what the host's `emit` funnel saw, with provenance. A fresh copy per call. */
	emittedEvents(): ZenThreadEvent[];
}

export interface AgentHost {
	/** A fresh session with its own services, extensions bound, events flowing. */
	createSession(): Promise<HostedSession>;
}

/**
 * Pin `childProxy: false` in the agent dir's multi-account config — see the module header.
 * Creates the file if absent; otherwise reads, sets the one key, writes. Any other key the
 * operator set is preserved verbatim.
 */
export function seedMultiAccountChildProxyOff(agentDir: string): void {
	mkdirSync(agentDir, { recursive: true });
	const configPath = join(agentDir, MULTI_ACCOUNT_CONFIG_FILENAME);
	let existing: Record<string, unknown> = {};
	if (existsSync(configPath)) {
		const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
			existing = parsed as Record<string, unknown>;
		}
	}
	if (existing[MULTI_ACCOUNT_CHILD_PROXY_KEY] === false) return;
	writeFileSync(configPath, `${JSON.stringify({ ...existing, [MULTI_ACCOUNT_CHILD_PROXY_KEY]: false }, null, "\t")}\n`);
}

/** `PiCommand` with `description` present only when pi supplied one (`exactOptionalPropertyTypes`). */
function describeCommand(name: string, source: PiCommand["source"], description: string | undefined): PiCommand {
	return description === undefined ? { name, source } : { name, source, description };
}

export function createAgentHost(options: AgentHostOptions): AgentHost {
	const { cwd, agentDir, harnessPackageDir, onProblem } = options;

	// Order matters, and it is the module header's ⚠⚠ items: env before any pi module can
	// be imported by the loader, the proxy pin before the first session_start, and the
	// secrets out of the environment before anything can inherit it (#89).
	process.env.PI_CODING_AGENT_DIR = agentDir;
	seedMultiAccountChildProxyOff(agentDir);
	// The secrets file is a fact about THIS checkout (the harness), not about the tree pi
	// operates on — `cwd` may be anywhere, a tmpdir in tests — so it resolves from here.
	const quarantine = quarantineSecrets(options.environment ?? process.env, findRepoRoot(import.meta.url));
	if (quarantine.removed.length > 0)
		onProblem?.(`secrets kept out of the tool environment (#89): ${quarantine.removed.join(", ")}`);
	if (quarantine.misplaced.length > 0) {
		onProblem?.(
			`⚠ the root .env defines ${quarantine.misplaced.join(", ")} — bun autoloads .env into every bun child, ` +
				`so a tool can still read it there. Move it to .zen/secrets.env (#89); it is not read from .env.`,
		);
	}
	// The theme registry pi's UI code consults; harmless without a terminal, required once.
	initTheme();

	async function createSession(): Promise<HostedSession> {
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			resourceLoaderOptions: {
				// The isolation triple `scripts/zen.mjs` documents, expressed as loader options:
				// no discovery (`--no-extensions`), no ~/.agents skills (`--no-skills`), and the
				// harness package as the one extension source (`-e <dir>` — pi resolves a
				// directory's `pi` manifest for extensions, skills, prompts AND themes).
				noExtensions: true,
				noSkills: true,
				additionalExtensionPaths: [harnessPackageDir],
				...(options.extensionFactories === undefined ? {} : { extensionFactories: [...options.extensionFactories] }),
			},
		});
		for (const diagnostic of services.diagnostics) {
			onProblem?.(`pi ${diagnostic.type}: ${diagnostic.message}`);
		}
		const extensionsResult = services.resourceLoader.getExtensions();
		for (const loadError of extensionsResult.errors) {
			// pi does not throw on a resource that fails to load; the failure would otherwise be
			// silent and the symptom unrelated (the vendor-links incident, `server/index.ts`).
			onProblem?.(`pi extension failed to load: ${loadError.path}: ${loadError.error}`);
		}

		// A fresh session file per hosted session, under the agent dir pi resolves from the env
		// set above — the same default `pi --mode rpc` used, so picc's persisted "modes" entry
		// and the transcript land where the TUI's would. Retained: `permissionMode()` below
		// walks its branch, the same walk picc's `restoreState` does.
		const sessionManager = SessionManager.create(cwd);
		const { session } = await createAgentSessionFromServices({ services, sessionManager });

		// ── The event fan-out. Records emitted before the FIRST subscriber (everything an
		// extension says during session_start — multi-account's startup notify, a dialog a
		// probe opens) are held and replayed, so the browser sees them exactly as it saw
		// pi's unsolicited startup stdout over the pipe.
		//
		// ⚠ Held ONLY until the first subscriber, never between runs. The session now lives
		// across runs (#69 PR 2) and each run subscribes its own pump. Holding between runs
		// would replay an aborted run's `agent_settled` into the NEXT run's pump — which would
		// end that run before its first token (the disconnect-then-prompt race). Events with
		// nobody listening after the first subscriber are dropped, like status heartbeats
		// were when no rpc client was reading the pipe.
		const listeners = new Set<(event: PiRpcEvent) => void>();
		const heldUntilFirstSubscriber: PiRpcEvent[] = [];
		let hasHadSubscriber = false;
		// The emitted tail (#97): every event through this funnel, with HOW it was delivered.
		// Recorded at the one place all of them pass, so the record and the delivery cannot
		// disagree — a held record's later replay is recorded again, as `replayed`, when it
		// actually reaches a subscriber (see `subscribe`).
		const emitted = createEventTail();
		function emit(event: PiRpcEvent): void {
			const described = describePiRpcEvent(event);
			if (listeners.size === 0) {
				if (!hasHadSubscriber) {
					heldUntilFirstSubscriber.push(event);
					emitted.record(described.type, described.name, "held");
					return;
				}
				emitted.record(described.type, described.name, "dropped");
				return;
			}
			emitted.record(described.type, described.name, "live");
			for (const listener of listeners) listener(event);
		}

		const ui = createZenExtensionUiContext({ emit, onProblem });

		// ⚠ SUBSCRIBE BEFORE BINDING (#88). Extensions persist state during `session_start` —
		// picc writes its opening `modes` entry there — and pi emits `entry_appended` to whoever
		// is listening at that moment. Subscribing after `bindExtensions` returned meant those
		// entries went to nobody: the held-until-first-subscriber buffer sits behind THIS
		// subscription, so nothing put them in it, and the browser saw one `modes` entry where
		// the branch had two. The `ui` notifies always crossed because `ui` binds `emit` directly.
		// Nothing session_start emits is run progress (`agent_settled` comes from the run loop
		// only), so replaying it into the first run's pump is inert.
		const unsubscribeSession = session.subscribe((event) => {
			try {
				emit(toRpcWireEvent(event));
			} catch (error) {
				onProblem?.(error);
			}
		});

		// Bound ONCE — see the module header. Errors thrown by an extension handler arrive here
		// (spike receipt: a throwing session_start is routed to onError and bindExtensions
		// resolves; it neither hangs nor rejects), and cross as the same `extension_error`
		// record the rpc mode emitted.
		await session.bindExtensions({
			uiContext: ui.uiContext,
			mode: EXTENSION_MODE_RPC,
			onError: (error: ExtensionError) => {
				emit({ type: "extension_error", extensionPath: error.extensionPath, event: error.event, error: error.error });
			},
		});

		let disposed = false;
		const piSession: PiSession = {
			prompt(request, outcome) {
				let accepted = false;
				// ⚠ Fire-and-forget, exactly as pi's rpc mode does: `prompt()` resolves only when
				// the whole run finishes, and awaiting it in front of the drain loop is the
				// original `/mode` hang. Acceptance is the preflight callback; completion is the
				// `agent_settled` event. A rejection AFTER acceptance is dropped here on purpose —
				// this is pi's own rpc-mode handler line for line (dist/modes/rpc/rpc-mode.js,
				// `case "prompt"`), and pi's `_runAgentPrompt` emits `agent_settled` from a
				// `finally`, so the run still terminates; only the error text is lost. Model and
				// tool errors never reach this path — the agent loop turns them into an assistant
				// message with `stopReason: "error"`, which the stream carries as usual.
				void session
					.prompt(request.message, {
						...(request.images === undefined ? {} : { images: [...request.images] }),
						...(request.streamingBehavior === undefined ? {} : { streamingBehavior: request.streamingBehavior }),
						source: PROMPT_SOURCE_RPC,
						preflightResult: (didSucceed) => {
							if (didSucceed) {
								accepted = true;
								outcome.onAccepted();
							}
						},
					})
					.catch((error: unknown) => {
						if (!accepted) outcome.onRejected(error instanceof Error ? error.message : String(error));
					});
			},
			answerDialog(response) {
				ui.answerDialog(response);
			},
			listCommands(): PiCommand[] {
				// The three sources pi's rpc `get_commands` assembles, in its order.
				const commands: PiCommand[] = [];
				for (const command of session.extensionRunner.getRegisteredCommands()) {
					commands.push(describeCommand(command.invocationName, "extension", command.description));
				}
				for (const template of session.promptTemplates) {
					commands.push(describeCommand(template.name, "prompt", template.description));
				}
				for (const skill of session.resourceLoader.getSkills().skills) {
					commands.push(describeCommand(`skill:${skill.name}`, "skill", skill.description));
				}
				return commands;
			},
			permissionModeState(): PiPermissionModeState {
				// picc's own `restoreState` walk (#84): the LAST `modes` entry on the branch wins,
				// and a branch with none is the initial mode by construction — this host creates a
				// fresh session file per hosted session, so nothing precedes it. Walked from the
				// end so the newest entry is the first hit.
				//
				// ⚠ Deliberately NOT cached (PR #85 review). A cache of "the last mode we saw"
				// would have to skip `getBranch()` to change anything, and that assumes the branch
				// is append-only — it is not: `/tree`, `/fork` and `/branch` move the leaf onto a
				// path whose last `modes` entry can differ, which is exactly why picc re-walks in
				// `restoreState`. `getBranch()` is itself one parent-pointer walk that builds a
				// fresh array; this is a second linear pass of pointer comparisons over it.
				// Correctness under branch navigation is worth microseconds per run.
				let mode: string = PICC_DEFAULT_PERMISSION_MODE;
				const branch = sessionManager.getBranch();
				for (let position = branch.length - 1; position >= 0; position -= 1) {
					const entry = branch[position];
					if (entry?.type !== "custom") continue;
					const persisted = readPiccPersistedMode(entry);
					if (persisted !== undefined) {
						mode = persisted;
						break;
					}
				}
				// The dropdown offers picc's modes AS REGISTERED HERE: picc names one command per
				// mode, exactly after it, so the intersection is a name lookup. Read off the
				// registry directly rather than through `listCommands` — that call's count is a
				// contract the refusal path's tests pin, and this is not a refusal lookup.
				const registered = new Set(
					session.extensionRunner.getRegisteredCommands().map((command) => command.invocationName),
				);
				return { mode, available: PICC_PERMISSION_MODES.filter((candidate) => registered.has(candidate)) };
			},
			subscribe(onEvent) {
				listeners.add(onEvent);
				hasHadSubscriber = true;
				if (heldUntilFirstSubscriber.length > 0) {
					const held = heldUntilFirstSubscriber.splice(0);
					for (const event of held) {
						const described = describePiRpcEvent(event);
						emitted.record(described.type, described.name, "replayed");
						onEvent(event);
					}
				}
				return () => {
					listeners.delete(onEvent);
				};
			},
			abort() {
				return session.abort();
			},
			dispose() {
				if (disposed) return;
				disposed = true;
				ui.cancelAllDialogs();
				unsubscribeSession();
				// `AgentSession.dispose()` does NOT emit session_shutdown — only pi's runtime layer
				// does. multi-account clears its timers on that event ("for ANY reason"), so the
				// host emits it the way `AgentSessionRuntime.dispose` does, then releases.
				void session.extensionRunner
					.emit({ type: "session_shutdown", reason: "quit" })
					.catch((error: unknown) => onProblem?.(error))
					.finally(() => session.dispose());
			},
		};

		return {
			session: piSession,
			loadedExtensionPaths: extensionsResult.extensions.map((extension) => extension.path),
			emittedEvents: () => emitted.recent(),
			inspect(): HostedSessionInspection {
				// ⚠ `getSessionFile()` names the path pi WILL write, from creation — but pi flushes
				// lazily, holding every entry until the first assistant message. So the path is
				// reported only once the file exists; before that the branch below is the only copy.
				const plannedFile = sessionManager.getSessionFile();
				return {
					sessionId: sessionManager.getSessionId(),
					cwd: sessionManager.getCwd(),
					sessionDir: sessionManager.getSessionDir(),
					sessionFile: plannedFile !== undefined && existsSync(plannedFile) ? plannedFile : null,
					entries: sessionManager.getBranch(),
					commands: piSession.listCommands().map((command) => command.name),
				};
			},
		};
	}

	return { createSession };
}
