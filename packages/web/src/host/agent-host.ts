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
import type { PiCommand, PiRpcEvent, PiSession } from "@zen/core";
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
	 * Test seam: inline extensions loaded BESIDE the harness. A test can register a probe that
	 * asks a dialog on `session_start`, or throws there, and observe what the host does — with
	 * no model, no key, no network. Never set in production.
	 */
	extensionFactories?: readonly InlineExtension[];
}

export interface HostedSession {
	readonly session: PiSession;
	/** How many extensions the loader found — the load receipt a caller may assert. */
	readonly loadedExtensionPaths: readonly string[];
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

	// Order matters, and it is the module header's two ⚠⚠ items: env before any pi module
	// can be imported by the loader, and the proxy pin before the first session_start.
	process.env.PI_CODING_AGENT_DIR = agentDir;
	seedMultiAccountChildProxyOff(agentDir);
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
		// and the transcript land where the TUI's would.
		const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.create(cwd) });

		// ── The event fan-out. Records emitted before the first subscriber (everything an
		// extension says during session_start — multi-account's startup notify, a dialog a
		// probe opens) are held and replayed, so the browser sees them exactly as it saw
		// pi's unsolicited startup stdout over the pipe.
		const listeners = new Set<(event: PiRpcEvent) => void>();
		const heldUntilFirstSubscriber: PiRpcEvent[] = [];
		function emit(event: PiRpcEvent): void {
			if (listeners.size === 0) {
				heldUntilFirstSubscriber.push(event);
				return;
			}
			for (const listener of listeners) listener(event);
		}

		const ui = createZenExtensionUiContext({ emit, onProblem });

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

		const unsubscribeSession = session.subscribe((event) => {
			try {
				emit(toRpcWireEvent(event));
			} catch (error) {
				onProblem?.(error);
			}
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
			subscribe(onEvent) {
				listeners.add(onEvent);
				if (heldUntilFirstSubscriber.length > 0) {
					const held = heldUntilFirstSubscriber.splice(0);
					for (const event of held) onEvent(event);
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
		};
	}

	return { createSession };
}
