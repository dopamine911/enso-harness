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
 * ⚠ WHAT THIS DOES NOT COVER
 * `bash` is only given a default timeout. It is NOT path-confined: `echo x > ~/.ssh/foo`
 * still escapes. Bash policy and egress are Tier 0 item 4 and deliberately not attempted
 * here — a partial bash filter reads as coverage and is worse than none.
 */

/** Tools whose `path` argument mutates the filesystem. */
const MUTATING_PATH_TOOLS = new Set(["write", "edit"]);
/** Tools whose `path` argument reads the filesystem. */
const READING_PATH_TOOLS = new Set(["read"]);

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

		// --- reads: deny credential material.
		if (READING_PATH_TOOLS.has(event.toolName)) {
			if (looksLikeSecret(target, policy.secretPathFragments)) {
				return {
					block: true,
					reason:
						`Reading "${candidate}" is blocked: it matches a credential pattern. ` +
						`A secret read is the precondition for exfiltration, so this is denied even for inspection.`,
				};
			}
			return undefined;
		}

		// --- writes: confine to the workspace, and never into protected internals.
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
		}

		return undefined;
	});
}
