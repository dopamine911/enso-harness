import { basename } from "node:path";
import {
	extractFlatShellCommandSegments,
	literalShellWord,
	withoutLeadingEnvironmentAssignments,
} from "./shell-segments.ts";
import { canonicalToolName } from "./tool-identity.ts";

/**
 * The bash network deny (#9) — a BAR, deliberately not a boundary.
 *
 * pi has no web tool, so the egress path is `bash` plus an ad-hoc client, and the guard
 * gates exactly that: the named HTTP/TCP client binaries at COMMAND POSITION per shell
 * segment, plus bash's own `/dev/tcp` / `/dev/udp` sockets anywhere in the string.
 *
 * ⚠ WHAT IT DELIBERATELY DOES NOT COVER, so nobody reads it as confinement:
 * - `git` remotes. git push IS this harness's job; git is the largest egress path and
 *   cannot be on the list without breaking every PR the agents make.
 * - Interpreters. `python -c`, `node -e` can open sockets — the unbounded long tail that
 *   #9's option-4 warning is about. A list that chased it would read as coverage and
 *   not be coverage.
 *
 * Three match modes, chosen by what the command word turned out to be:
 * - PARSEABLE commands (the segmenter returned segments): the denied name must be the
 *   segment's command word — leading env assignments stripped, then resolved to the
 *   LITERAL value the shell would execute (quote/escape removal: `"curl"`, `\curl` and
 *   `cu"rl"` all resolve to `curl` — PR #55 review, round 1), path prefix ignored,
 *   case-folded. `echo "curl is a tool"` passes — the word is quoted argument text.
 * - UNPARSEABLE commands (the segmenter returned [] — command substitution, backticks,
 *   heredocs) AND runtime-expanded command words (`$C https://…`) fall back to a
 *   word-boundary scan of the RAW string. Coarser on purpose: substitution and
 *   indirection are exactly where evasion lives, so a false positive there is friction
 *   toward safety ("rewrite without the substitution"), not a broken gate.
 * - SYNTHESIZED command words (PR #55 review, round 2) — unquoted brace/glob characters
 *   (`{c,}url`, `/usr/bin/cur[l]`, both of which execute curl, verified live) — are
 *   DENIED OUTRIGHT: expansion assembles the name from pieces, so no scan of the
 *   unexpanded text can ever see it, and escalating to the raw scan would be theater.
 *   Glob/brace as ARGUMENTS (`ls *.ts`) are untouched — only the command word is gated —
 *   and the bare `[` test builtin is exempt.
 * PowerShell commands always take the raw scan — the segmenter speaks POSIX, not PS.
 *
 * ⚠ Third stated non-coverage, with git and the interpreters: variable indirection ACROSS
 * tool calls (`export C=curl` in one call, `$C …` in the next) — the second call's raw
 * scan sees no denied name, because the value lives in session state no string scan can
 * reach. Same-command indirection (`C=curl; $C …`) IS caught, via the escalation.
 */

/** How the deny matched — carried into the block reason so a denial is explainable. */
export interface NetworkEgressMatch {
	/** The denied name (or device path) that matched. */
	matched: string;
	/**
	 * Which mode found it — segment-precise, the coarse raw scan, the bash socket device,
	 * or a brace/glob-synthesized command word (denied without knowing the final name,
	 * because expansion assembles it from pieces no scan can see contiguously).
	 */
	via: "command-position" | "raw-scan" | "dev-socket" | "command-word-synthesis";
}

/** bash's built-in TCP/UDP redirection devices — no legitimate use in this harness. */
const BASH_SOCKET_DEVICE_PATTERN = /\/dev\/(?:tcp|udp)\//i;

/**
 * The segment's command word, resolved to the LITERAL value the shell would execute —
 * or the reason it cannot be, which decides the caller's move.
 *
 * ⚠ Literal resolution is load-bearing (PR #55 review, round 1): `"curl"`, `\curl` and
 * `cu"rl"` are all `curl` to bash but were unequal to it as raw text — and because a
 * balanced-quoted command is fully PARSEABLE, the coarse fallback never ran. Round 2 of
 * the same review found the second class: brace/glob SYNTHESIS (`{c,}url`), where the
 * raw scan is no net at all — see LiteralShellWordResult's doc for the split.
 */
type CommandWordResult =
	| { kind: "word"; canonical: string }
	| { kind: "escalate-to-raw-scan" }
	| { kind: "deny-synthesis"; rawWord: string };

function commandWordOf(segmentText: string): CommandWordResult {
	const withoutAssignments = (withoutLeadingEnvironmentAssignments(segmentText) ?? segmentText).trim();
	const resolved = literalShellWord(withoutAssignments);
	if (resolved.kind === "word-synthesis") {
		// ⚠ The one legitimate synthesis character at command position: a word that IS
		// exactly `[` is the test builtin (`[ -f x ] && …`), everywhere in shell scripts.
		// Only the BARE bracket is exempt — `cur[l]` and `[foo` stay synthesis.
		const rawWord = withoutAssignments.split(/[ \t]/, 1)[0] ?? "";
		if (rawWord === "[") return { kind: "word", canonical: "[" };
		return { kind: "deny-synthesis", rawWord };
	}
	if (resolved.kind !== "literal") return { kind: "escalate-to-raw-scan" };
	if (resolved.value.length === 0) return { kind: "word", canonical: "" };
	// `/usr/bin/curl` and `curl` are the same binary.
	return { kind: "word", canonical: canonicalToolName(basename(resolved.value)) };
}

function rawScanFor(command: string, deniedBinaries: readonly string[]): string | undefined {
	for (const deniedBinary of deniedBinaries) {
		// All list entries are [word-ish] names, so \b is well-defined at both ends;
		// escape anything regex-special defensively rather than trusting the policy data.
		const escaped = deniedBinary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		if (new RegExp(`\\b${escaped}\\b`, "i").test(command)) return deniedBinary;
	}
	return undefined;
}

/**
 * Find the first denied network egress in a shell command, or undefined when none match.
 * `coarse` forces the raw word-boundary scan (the PowerShell path).
 */
export function findDeniedNetworkEgress(
	command: string,
	deniedBinaries: readonly string[],
	options: { coarse?: boolean } = {},
): NetworkEgressMatch | undefined {
	if (BASH_SOCKET_DEVICE_PATTERN.test(command)) {
		return { matched: "/dev/tcp|/dev/udp", via: "dev-socket" };
	}
	if (options.coarse !== true) {
		const segments = extractFlatShellCommandSegments(command);
		if (segments.length > 0) {
			const denied = new Set(deniedBinaries.map((binary) => canonicalToolName(binary)));
			// Two distinct unknowable-word escalations (PR #55 review, one round each),
			// and they must NOT share a path:
			// - runtime-expansion (`$C https://…`): the coarse scan of the WHOLE command
			//   may catch a sibling assignment (`C=curl; $C …`), so escalate to it. What
			//   it cannot see is a value set in an EARLIER tool call — stated
			//   non-coverage, with the interpreters.
			// - word-synthesis (`{c,}url`, `/usr/bin/cur[l]` — both execute curl,
			//   verified live): brace/pathname expansion assembles the name from pieces,
			//   so it never appears contiguously and the raw scan is STRUCTURALLY BLIND.
			//   Escalation is not a net here — deny outright. The false-positive cost is
			//   glob/brace AT COMMAND POSITION, which legitimate commands essentially
			//   never need (the bare `[` test builtin is exempted in commandWordOf).
			let hasUnresolvableCommandWord = false;
			for (const segment of segments) {
				const commandWord = commandWordOf(segment.text);
				if (commandWord.kind === "deny-synthesis") {
					return { matched: commandWord.rawWord, via: "command-word-synthesis" };
				}
				if (commandWord.kind === "escalate-to-raw-scan") {
					hasUnresolvableCommandWord = true;
					continue;
				}
				if (denied.has(commandWord.canonical)) {
					return { matched: commandWord.canonical, via: "command-position" };
				}
			}
			if (!hasUnresolvableCommandWord) return undefined;
		}
		// [] or an unresolvable word — syntax the precise path cannot scope; go coarse.
	}
	const rawMatch = rawScanFor(command, deniedBinaries);
	return rawMatch === undefined ? undefined : { matched: rawMatch, via: "raw-scan" };
}
