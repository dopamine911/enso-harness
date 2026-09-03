import type { ExtensionAPI, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_GUARD_POLICY,
	type GuardPolicy,
	isInsideAnyRoot,
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
 *    still escapes, and `cat ~/.aws/credentials` bypasses the reader gate entirely. Bash
 *    policy and egress are Tier 0 item 4, deliberately not attempted here — a partial bash
 *    filter reads as coverage and is worse than none.
 * 2. Shell-init and agent-config PERSISTENCE paths (`~/.bashrc`, `~/.gitconfig`,
 *    `~/.claude.json`, `.mcp.json`). Those are not secrets — nothing is exfiltrated,
 *    something is installed — so `looksLikeSecret` does not catch them and
 *    `protectedWriteFragments` holds only `/.git/`.
 * 3. Tool-name CASE. Matching is case-sensitive, so a tool registered as `Write` or
 *    `Grep` is not recognised. Vendor packages in this ecosystem do register
 *    Claude-Code-style capitalised names.
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

function pathArgumentOf(event: ToolCallEvent): string | undefined {
	const input = event.input as Record<string, unknown>;
	const value = input.path;
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export default function guards(pi: ExtensionAPI): void {
	const policy: GuardPolicy = DEFAULT_GUARD_POLICY;

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
			if (looksLikeSecret(target, policy.secretPathFragments)) {
				return {
					block: true,
					reason: `Writing to "${candidate}" is blocked: it matches a credential pattern.`,
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
