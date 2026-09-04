import { existsSync } from "node:fs";
import type {
	ExtensionAPI,
	ToolCallEvent,
	ToolCallEventResult,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_GUARD_POLICY, type GuardPolicy } from "@zen/core";
import {
	createSessionReadTracker,
	isInsideAnyRoot,
	isPersistenceWriteTarget,
	isProtectedForWrite,
	looksLikeSecret,
	resolveAgainstCwd,
} from "../../core/index.ts";

/**
 * Tier 0 guards — see `docs/concepts/pi-immediate-needs.md`.
 *
 * WHY A `tool_call` HANDLER RATHER THAN A TOOL OVERRIDE
 * pi resolves tools first-wins (`registerTool` -> `getAllRegisteredTools`), so a guard
 * implemented as an override of `write` is only safe while this package loads first.
 * Handlers are additive instead — `on()` pushes onto a list, every extension's handlers
 * run, and `emitToolCall` returns immediately on the first `block`. So a block here is
 * final and cannot be un-blocked by a later extension, whatever the load order.
 *
 * WHAT IT COVERS, AND HOW THE TOOL SET IS CHOSEN
 * `write` and `edit` are an inclusion list — mutation is a small closed set worth naming.
 * Every OTHER tool carrying a `path` is gated as a reader by EXCLUSION. That asymmetry is
 * deliberate and it is the correct direction for a boundary: an over-broad reader set
 * blocks something harmless and says so, while a too-narrow one permits a credential read
 * in silence. pi ships `read`, `grep`, `find` and `ls` with a `path` today, and an
 * inclusion list naming only `read` left `grep` over ~/.aws returning the credential line.
 *
 * ⚠ WHAT THIS DOES NOT COVER
 * 1. `bash` is only given a default timeout. It is NOT path-confined: `echo x > ~/.ssh/foo`
 *    still escapes, `cat ~/.aws/credentials` bypasses the reader gate entirely, and
 *    `echo x >> ~/.bashrc` bypasses the #21 persistence denial the same way. Bash
 *    policy and egress are Tier 0 item 4, deliberately not attempted here — a partial bash
 *    filter reads as coverage and is worse than none.
 * 2. Tool-name CASE. Matching is case-sensitive, so a tool registered as `Write` or
 *    `Grep` is not recognised. Vendor packages in this ecosystem do register
 *    Claude-Code-style capitalised names.
 *
 * ⚠ Shell-init and agent-config PERSISTENCE paths (`~/.bashrc`, `~/.gitconfig`,
 * `~/.claude.json`, `.mcp.json`, …) were gap 2 here until #21: they are not secrets —
 * nothing is exfiltrated, something is installed — so `looksLikeSecret` never caught
 * them. `isPersistenceWriteTarget` now denies `write`/`edit` on them UNCONDITIONALLY —
 * every mode, every surface, including print runs where picc is absent entirely (#20).
 * picc reaches at most "ask" for the same set, and an ask is mode-shaped (auto's
 * classifier may approve one); this layer is the always-on floor beneath that.
 *
 * READ-BEFORE-WRITE (#10, Tier 1 item 5): `write` to an EXISTING file requires that this
 * session has seen its content — a successful `read` (or its own successful `write`; see
 * KNOWLEDGE_CONFERRING_TOOLS for why `edit` does not count). Creation is untouched. The
 * state lives in a session-scoped tracker reset on `session_start`. ⚠ Known limit, accepted:
 * the tracker survives context compaction, the model's memory of the file may not — the
 * SESSION has seen the file even when the model no longer has the bytes in context.
 */

/**
 * Tools whose `path` argument mutates the filesystem.
 *
 * ⚠ This is the ONLY inclusion list here, and it is deliberate: mutation is a small
 * closed set worth naming, and a tool wrongly treated as a reader gets the weaker
 * check. Everything else carrying a `path` is treated as a READER by exclusion — see
 * the dispatch below for why that direction is the safe one.
 */
const MUTATING_PATH_TOOLS = new Set(["write", "edit"]);

/**
 * Tools whose successful RESULT means the session has seen the target file's content (#10).
 *
 * `read` is the obvious member. `write` is a deliberate widening of the issue's rule
 * ("already read, or does not exist"): after a successful write the session authored every
 * byte, and without it the common create-then-revise flow would block on its own second
 * write. ⚠ `edit` is deliberately NOT a member: a successful edit proves knowledge of one
 * matched fragment (which could have come from grep output), not of the whole file — and
 * whole-file knowledge is exactly what a follow-up `write` claims. The cost is one `read`
 * before a wholesale rewrite of an edited file, which is the rule working.
 */
const KNOWLEDGE_CONFERRING_TOOLS = new Set(["read", "write"]);

function pathArgumentOf(event: ToolCallEvent | ToolResultEvent): string | undefined {
	const input = event.input as Record<string, unknown>;
	const value = input.path;
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export default function guards(pi: ExtensionAPI): void {
	const policy: GuardPolicy = DEFAULT_GUARD_POLICY;

	// #10: which files this session has seen. Session-scoped twice over: pi tears the
	// extension runtime down on session replacement (fresh closure), and session_start —
	// which also fires for "reload" and "resume", where the runtime survives — resets it.
	const readTracker = createSessionReadTracker();

	pi.on("session_start", (): void => {
		readTracker.reset();
	});

	// Record knowledge from RESULTS, never from calls: a blocked call produces no
	// tool_result at all (verified in pi's agent-loop — the "immediate" path skips
	// afterToolCall), and a failed one arrives with isError, so neither can record.
	pi.on("tool_result", (event, ctx): void => {
		if (event.isError) return;
		if (!KNOWLEDGE_CONFERRING_TOOLS.has(event.toolName)) return;
		const candidate = pathArgumentOf(event);
		if (candidate === undefined) return;
		readTracker.recordKnownPath(resolveAgainstCwd(candidate, ctx.cwd));
	});

	pi.on("tool_call", (event, ctx): ToolCallEventResult | undefined => {
		const cwd = ctx.cwd;

		// --- bash: patch, do not block. `event.input` is mutable by contract, and a
		// missing timeout means a hung command holds the session indefinitely.
		if (event.toolName === "bash" || event.toolName === "powershell") {
			const input = event.input as Record<string, unknown>;
			if (input.timeout === undefined) {
				input.timeout = policy.defaultBashTimeoutSeconds;
			}
			return undefined;
		}

		const candidate = pathArgumentOf(event);
		if (candidate === undefined) return undefined;
		const target = resolveAgainstCwd(candidate, cwd);

		// --- writes first: `write` and `edit` also carry a `path`, so they must be
		// claimed before the reader fallthrough or they would get the weaker check.
		if (MUTATING_PATH_TOOLS.has(event.toolName)) {
			const roots = policy.writeRoots.length > 0 ? policy.writeRoots : [cwd];

			if (!isInsideAnyRoot(target, roots)) {
				return {
					block: true,
					reason:
						`Writing to "${candidate}" is blocked: it resolves to ${target}, outside the workspace ` +
						`(${roots.join(", ")}). pi resolves paths but does not confine them, so this guard does.`,
				};
			}
			if (isProtectedForWrite(target, policy.protectedWriteFragments)) {
				return {
					block: true,
					reason: `Writing to "${candidate}" is blocked: it targets protected internals.`,
				};
			}
			// ⚠ Checked on the write path ONLY, deliberately: READING ~/.bashrc or .mcp.json is
			// routine and harmless. The danger is installation, not disclosure (#21).
			if (isPersistenceWriteTarget(target)) {
				return {
					block: true,
					reason:
						`Writing to "${candidate}" is blocked: it targets a shell-init, git, editor or ` +
						`agent-config persistence path — a write there is harmless now and executes ` +
						`later, outside this session, as the user.`,
				};
			}
			if (looksLikeSecret(target, policy.secretPathFragments)) {
				return {
					block: true,
					reason: `Writing to "${candidate}" is blocked: it matches a credential pattern.`,
				};
			}
			// --- #10: `write` replaces a whole file knowing nothing of what it destroys, so an
			// EXISTING file may only be written once this session has seen its content. A path
			// that does not exist is unaffected — creation is the common case, and a rule that
			// fights it gets turned off. `edit` is exempt: its exact-match precondition already
			// fails a blind edit rather than corrupting.
			if (event.toolName === "write" && existsSync(target) && !readTracker.isKnownPath(target)) {
				return {
					block: true,
					reason:
						`Writing to "${candidate}" is blocked: the file exists and this session has not ` +
						`read it, so a whole-file write would replace content the session has never seen. ` +
						`Read "${candidate}" first, then write.`,
				};
			}
			return undefined;
		}

		// --- every remaining tool carrying a `path` reads the filesystem: deny credential
		// material. This is an EXCLUSION, never an inclusion list, and the asymmetry is the
		// whole point for a boundary: an over-broad reader set blocks something harmless and
		// says so, while a too-narrow one permits a credential read silently. pi ships `read`,
		// `grep`, `find` and `ls` with a `path` today — an inclusion list naming only `read`
		// left `grep` over ~/.aws returning the credential line, past a guard whose own header
		// claimed it denied secret reads.
		if (looksLikeSecret(target, policy.secretPathFragments)) {
			return {
				block: true,
				reason:
					`Reading "${candidate}" via ${event.toolName} is blocked: it matches a credential pattern. ` +
					`A secret read is the precondition for exfiltration, so this is denied even for inspection.`,
			};
		}

		return undefined;
	});
}
