import { basename } from "node:path";
import {
	extractFlatShellCommandSegments,
	literalShellWord,
	shellWordsOf,
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
 *
 * ⚠ Fourth stated non-coverage: BINARY RELOCATION (`cp /usr/bin/curl /tmp/f && /tmp/f …`)
 * — no name check can see it, and chasing it is full path confinement, #9's explicit
 * option-4 non-goal. Wrapper indirection, by contrast, IS covered (round 3): a segment
 * led by a transparent process wrapper (`timeout`, `env`, `nohup`, `xargs`, `sudo`,
 * `sh -c`, …) gets every word checked, since the wrapped command sits verbatim past
 * word 1 at an offset no wrapper-agnostic scan can know.
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
	via: "command-position" | "raw-scan" | "dev-socket" | "command-word-synthesis" | "wrapped-command";
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

/**
 * Commands that transparently exec their argument vector as the next command — no code
 * interpretation, the wrapped command sits VERBATIM in later words (PR #55 review,
 * round 3: `timeout 30 curl …`, `env curl …`). A segment led by one of these gets
 * WRAPPER MODE: every subsequent word receives the command-word treatment, which also
 * makes wrapper STACKING free (`nohup timeout 30 curl …` — the scan reaches curl without
 * modelling any wrapper's own options). `sh -c "curl …"` rides the same list: unlike
 * python/node, its payload is THIS grammar, and the quoted payload's first token is
 * checkable — assembled eval payloads remain interpreter non-coverage.
 */
const TRANSPARENT_COMMAND_WRAPPERS = new Set([
	"env",
	"timeout",
	"nohup",
	"nice",
	"ionice",
	"setsid",
	"stdbuf",
	"taskset",
	"chrt",
	"numactl",
	"flock",
	"watch",
	"xargs",
	"command",
	"exec",
	"eval",
	"time",
	"sudo",
	"doas",
	"strace",
	"ltrace",
	"sh",
	"bash",
	"zsh",
	"dash",
	"ksh",
]);

/**
 * Wrapper-word exemptions: `[` is the test builtin; `{}` is xargs's -I placeholder and
 * expands to NOTHING in bash (brace expansion needs a comma or range), so neither can
 * synthesize a name.
 */
const WRAPPER_WORD_EXEMPTIONS = new Set(["[", "{}"]);

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

type WrappedWordFinding =
	| { kind: "denied"; word: string }
	| { kind: "synthesis"; word: string }
	| { kind: "unresolvable" };

/**
 * Scan every word of a wrapper-led segment with the command-word treatment. A word's
 * LITERAL value is checked by its first internal whitespace token (so a quoted payload
 * like `bash -c "curl https://x"` is caught by its leading token), basename'd and
 * case-folded; `NAME=value` words (env's assignments) and the exempted `[`/`{}` are
 * skipped; synthesis and runtime-expansion words report as themselves so the caller
 * denies or escalates exactly as it would at command position.
 */
function deniedWordInWrappedSegment(segmentText: string, denied: Set<string>): WrappedWordFinding | undefined {
	const rawWords = shellWordsOf(segmentText);
	if (rawWords === null) return { kind: "unresolvable" };
	let sawUnresolvable = false;
	for (const rawWord of rawWords.slice(1)) {
		if (WRAPPER_WORD_EXEMPTIONS.has(rawWord)) continue;
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(rawWord)) continue;
		const resolved = literalShellWord(rawWord);
		if (resolved.kind === "word-synthesis") return { kind: "synthesis", word: rawWord };
		if (resolved.kind !== "literal") {
			sawUnresolvable = true;
			continue;
		}
		const firstToken = resolved.value.trim().split(/\s/, 1)[0] ?? "";
		if (firstToken.length === 0) continue;
		const canonical = canonicalToolName(basename(firstToken));
		if (denied.has(canonical)) return { kind: "denied", word: canonical };
	}
	return sawUnresolvable ? { kind: "unresolvable" } : undefined;
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
 * Gate ONE parseable segment: a match to deny on, "escalate" when a word's value is only
 * knowable at runtime (the caller falls back to the whole-command raw scan), or undefined
 * to pass. WRAPPER MODE (round 3) lives here: when the command word is a transparent
 * process wrapper, the effective command sits past word 1 at an offset no wrapper-agnostic
 * scan can know (each wrapper has its own options/operands) — so EVERY subsequent word
 * gets the command-word treatment. ⚠ The accepted false positive, pinned in a test: a
 * denied NAME as a plain argument inside a wrapped segment denies (`timeout 30 grep curl
 * f`), where the unwrapped form passes — the friction self-remediates (drop the wrapper)
 * and errs toward safety.
 */
function gateSegment(segmentText: string, denied: Set<string>): NetworkEgressMatch | "escalate" | undefined {
	const commandWord = commandWordOf(segmentText);
	if (commandWord.kind === "deny-synthesis") {
		return { matched: commandWord.rawWord, via: "command-word-synthesis" };
	}
	if (commandWord.kind === "escalate-to-raw-scan") return "escalate";
	if (denied.has(commandWord.canonical)) {
		return { matched: commandWord.canonical, via: "command-position" };
	}
	if (!TRANSPARENT_COMMAND_WRAPPERS.has(commandWord.canonical)) return undefined;
	const wrapped = deniedWordInWrappedSegment(segmentText, denied);
	if (wrapped === undefined) return undefined;
	if (wrapped.kind === "unresolvable") return "escalate";
	return {
		matched: wrapped.word,
		via: wrapped.kind === "denied" ? "wrapped-command" : "command-word-synthesis",
	};
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
				const verdict = gateSegment(segment.text, denied);
				if (verdict === "escalate") {
					hasUnresolvableCommandWord = true;
					continue;
				}
				if (verdict !== undefined) return verdict;
			}
			if (!hasUnresolvableCommandWord) return undefined;
		}
		// [] or an unresolvable word — syntax the precise path cannot scope; go coarse.
	}
	const rawMatch = rawScanFor(command, deniedBinaries);
	return rawMatch === undefined ? undefined : { matched: rawMatch, via: "raw-scan" };
}
