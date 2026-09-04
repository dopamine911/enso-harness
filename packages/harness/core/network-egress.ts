import { basename } from "node:path";
import { extractFlatShellCommandSegments, withoutLeadingEnvironmentAssignments } from "./shell-segments.ts";
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
 *   segment's command word (leading env assignments stripped, path prefix ignored,
 *   case-folded). `echo "curl is a tool"` passes — the word is quoted argument text.
 * - UNPARSEABLE commands (the segmenter returned [] — command substitution, backticks,
 *   heredocs) fall back to a word-boundary scan of the RAW string. Coarser on purpose:
 *   substitution is exactly where evasion lives, so a false positive there is friction
 *   toward safety ("rewrite without the substitution"), not a broken gate.
 * PowerShell commands always take the raw scan — the segmenter speaks POSIX, not PS.
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

function commandWordOf(segmentText: string): string | undefined {
	const withoutAssignments = withoutLeadingEnvironmentAssignments(segmentText) ?? segmentText;
	const firstWord = withoutAssignments.trim().split(/[ \t]/, 1)[0];
	if (firstWord === undefined || firstWord.length === 0) return undefined;
	// `/usr/bin/curl` and `curl` are the same binary; quotes around the word defeat the
	// segment path anyway (the raw scan still sees the name on unparseable input).
	return canonicalToolName(basename(firstWord));
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
			for (const segment of segments) {
				const commandWord = commandWordOf(segment.text);
				if (commandWord !== undefined && denied.has(commandWord)) {
					return { matched: commandWord, via: "command-position" };
				}
			}
			return undefined;
		}
		// [] — the command carries syntax the segmenter cannot scope; fall through coarse.
	}
	const rawMatch = rawScanFor(command, deniedBinaries);
	return rawMatch === undefined ? undefined : { matched: rawMatch, via: "raw-scan" };
}
