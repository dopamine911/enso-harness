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
 * Two match modes, chosen by parseability:
 * - PARSEABLE commands (the segmenter returned segments): the denied name must be the
 *   segment's command word — leading env assignments stripped, then resolved to the
 *   LITERAL value the shell would execute (quote/escape removal: `"curl"`, `\curl` and
 *   `cu"rl"` all resolve to `curl` — PR #55 review), path prefix ignored, case-folded.
 *   `echo "curl is a tool"` passes — the word is quoted argument text.
 * - UNPARSEABLE commands (the segmenter returned [] — command substitution, backticks,
 *   heredocs) AND commands whose command word is UNRESOLVABLE (`$C https://…` — expansion
 *   decides the binary at runtime) fall back to a word-boundary scan of the RAW string.
 *   Coarser on purpose: substitution and indirection are exactly where evasion lives, so
 *   a false positive there is friction toward safety ("rewrite without the substitution"),
 *   not a broken gate.
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
	/** Which mode found it — segment-precise, the coarse raw scan, or the bash socket device. */
	via: "command-position" | "raw-scan" | "dev-socket";
}

/** bash's built-in TCP/UDP redirection devices — no legitimate use in this harness. */
const BASH_SOCKET_DEVICE_PATTERN = /\/dev\/(?:tcp|udp)\//i;

/**
 * The segment's command word, resolved to the LITERAL value the shell would execute —
 * or null when that value cannot be known statically.
 *
 * ⚠ Literal resolution is load-bearing (PR #55 review): `"curl"`, `\curl` and `cu"rl"`
 * are all `curl` to bash but were unequal to it as raw text, and because a balanced-quoted
 * command is fully PARSEABLE, the segmenter happily returned segments and the coarse
 * fallback never ran — a one-character bypass of the whole deny. Comparing the resolved
 * word closes the quoting family; a word whose value expansion decides at runtime
 * (`$C https://…`) resolves to null, which the caller escalates to the coarse scan.
 */
// Return type inferred (`string | null`): the nursery noMisleadingReturnType rule
// misreads the annotated union as wider than the returns, which include both members.
function commandWordOf(segmentText: string) {
	const withoutAssignments = withoutLeadingEnvironmentAssignments(segmentText) ?? segmentText;
	const literalWord = literalShellWord(withoutAssignments.trim());
	if (literalWord === null) return null;
	if (literalWord.length === 0) return "";
	// `/usr/bin/curl` and `curl` are the same binary.
	return canonicalToolName(basename(literalWord));
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
			// ⚠ An UNRESOLVABLE command word (null — `$C https://…`) escalates the WHOLE
			// command to the coarse scan rather than comparing unequal and passing: the
			// expansion's value may sit in a sibling segment (`C=curl; $C …`), which the
			// raw scan sees. What it cannot see is a value set in an EARLIER tool call —
			// stated non-coverage, with the interpreters.
			let hasUnresolvableCommandWord = false;
			for (const segment of segments) {
				const commandWord = commandWordOf(segment.text);
				if (commandWord === null) {
					hasUnresolvableCommandWord = true;
					continue;
				}
				if (denied.has(commandWord)) {
					return { matched: commandWord, via: "command-position" };
				}
			}
			if (!hasUnresolvableCommandWord) return undefined;
		}
		// [] or an unresolvable word — syntax the precise path cannot scope; go coarse.
	}
	const rawMatch = rawScanFor(command, deniedBinaries);
	return rawMatch === undefined ? undefined : { matched: rawMatch, via: "raw-scan" };
}
