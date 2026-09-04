/**
 * Conservative shell command segmenter — the parsing floor under the bash network deny (#9).
 *
 * Vendored from oh-my-pi `packages/coding-agent/src/tools/shell-tokenize.ts` (
 * `extractFlatShellCommandSegments`) and `tools/bash-interceptor.ts` (the leading
 * env-assignment stripper), MIT:
 *   Copyright (c) 2025 Mario Zechner
 *   Copyright (c) 2025-2026 Can Bölük
 *   Copyright (c) 2026 Stencil Labs, Inc.
 * Vendored as a COPY rather than a dependency: oh-my-pi does not publish these as a
 * library surface, and the guard needs the contract below to be stable under our tests.
 *
 * ⚠ THE `[]` CONTRACT IS THE LOAD-BEARING PART. The extractor deliberately returns NO
 * segments when the command contains syntax whose execution context this small scanner
 * cannot scope — command substitution `$(…)`, backticks, heredocs, `${…}`, brace groups,
 * unterminated quotes. For the network deny, an empty result means "fall back to the
 * coarse whole-string scan", which fails toward safety. A "better" version that returned
 * partial segments for those inputs would silently open the substitution door — do not
 * improve it in that direction. (Its own test file pins this contract.)
 */

/** A flat shell command segment with the context needed to gate it. */
export interface FlatShellCommandSegment {
	/** Original segment text with quoting and escaping preserved. */
	text: string;
	/** True when this segment consumes the previous stage's stdout via `|` or `|&`. */
	pipedStdin: boolean;
}

/** A `{`/`}` at word start followed by whitespace/`;`/end is a brace GROUP, not a filename. */
function isBraceGroupBoundary(nextCharacter: string | undefined): boolean {
	return nextCharacter === undefined || /[ \t\n;]/.test(nextCharacter);
}

/** `>|`, `>&`, `<&`, `&>` are redirections, not segment operators — vendored logic, un-nested. */
function isRedirectionOperator(command: string, characterIndex: number, character: string | undefined): boolean {
	if (character === "|") return command[characterIndex - 1] === ">";
	if (character === "&") {
		return (
			command[characterIndex - 1] === ">" || command[characterIndex - 1] === "<" || command[characterIndex + 1] === ">"
		);
	}
	return false;
}

/**
 * Split a bash command into flat command segments on `;`, `&&`, `||`, `|`, `&` and
 * newlines, preserving each segment's original text. Returns `[]` for syntax it cannot
 * scope — see the module header for why that emptiness is a feature.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: a character scanner is one linear read against the shell grammar it recognises; splitting it into helpers would scatter the quote/operator state machine. Vendored shape kept close to upstream so a diff against oh-my-pi stays readable.
export function extractFlatShellCommandSegments(command: string): FlatShellCommandSegment[] {
	const segments: FlatShellCommandSegment[] = [];
	let segmentStart = 0;
	let inSingle = false;
	let inDouble = false;
	let atWordStart = true;
	let currentPiped = false;

	const pushSegment = (end: number): boolean => {
		const segment = command.slice(segmentStart, end).trim();
		if (segment.length === 0) return false;
		segments.push({ text: segment, pipedStdin: currentPiped });
		return true;
	};

	for (let characterIndex = 0; characterIndex < command.length; characterIndex++) {
		const character = command[characterIndex];
		if (inSingle) {
			if (character === "'") inSingle = false;
			continue;
		}
		if (inDouble) {
			if (character === "\\") {
				if (characterIndex + 1 >= command.length) return [];
				characterIndex++;
				continue;
			}
			if (character === '"') {
				inDouble = false;
				continue;
			}
			if (character === "`" || (character === "$" && command[characterIndex + 1] === "(")) return [];
			continue;
		}

		if (character === "'") {
			inSingle = true;
			atWordStart = false;
			continue;
		}
		if (character === '"') {
			inDouble = true;
			atWordStart = false;
			continue;
		}
		if (character === "\\") {
			if (characterIndex + 1 >= command.length) return [];
			characterIndex++;
			atWordStart = false;
			continue;
		}
		if (
			character === "`" ||
			character === "(" ||
			character === ")" ||
			(character === "$" && command[characterIndex + 1] === "(") ||
			(character === "$" && command[characterIndex + 1] === "{") ||
			(character === "<" && command[characterIndex + 1] === "<") ||
			((character === "{" || character === "}") && atWordStart && isBraceGroupBoundary(command[characterIndex + 1]))
		) {
			return [];
		}
		if (character === "#" && atWordStart) {
			const pushed = pushSegment(characterIndex);
			const newline = command.indexOf("\n", characterIndex + 1);
			if (newline === -1) return segments;
			characterIndex = newline;
			segmentStart = newline + 1;
			atWordStart = true;
			// Preserve a pending pipe through a comment-only continuation.
			if (pushed) currentPiped = false;
			continue;
		}
		const isRedirectionOperatorCharacter = isRedirectionOperator(command, characterIndex, character);
		if (
			(character === "\n" || character === ";" || character === "|" || character === "&") &&
			!isRedirectionOperatorCharacter
		) {
			const pushed = pushSegment(characterIndex);
			const doubled = (character === "|" || character === "&") && command[characterIndex + 1] === character;
			const pipeStderr = character === "|" && command[characterIndex + 1] === "&";
			if (doubled || pipeStderr) characterIndex++;
			// `|` and `|&` pipe into the next segment; other operators reset the state.
			if (pushed || character !== "\n") currentPiped = character === "|" && !doubled;
			segmentStart = characterIndex + 1;
			atWordStart = true;
			continue;
		}
		atWordStart = character === " " || character === "\t";
	}

	if (inSingle || inDouble) return [];
	pushSegment(command.length);
	return segments;
}

/** Finds the end of a shell word, respecting quotes and escapes; null for incomplete syntax. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the same vendored character-scanner shape as the extractor above — one linear read of quote/escape state, kept close to upstream for diffability.
function skipShellWord(command: string, start: number): number | null {
	let inSingle = false;
	let inDouble = false;
	for (let characterIndex = start; characterIndex < command.length; characterIndex++) {
		const character = command[characterIndex];
		if (inSingle) {
			if (character === "'") inSingle = false;
			continue;
		}
		if (inDouble) {
			if (character === "\\") {
				if (characterIndex + 1 >= command.length) return null;
				characterIndex++;
				continue;
			}
			if (character === '"') inDouble = false;
			continue;
		}
		if (character === "'") {
			inSingle = true;
			continue;
		}
		if (character === '"') {
			inDouble = true;
			continue;
		}
		if (character === "\\") {
			if (characterIndex + 1 >= command.length) return null;
			characterIndex++;
			continue;
		}
		if (character === " " || character === "\t") return characterIndex;
	}
	return inSingle || inDouble ? null : command.length;
}

/**
 * Remove leading `NAME=value` assignments without interpreting shell syntax, so
 * `FOO=1 curl …` exposes `curl` at command position. Returns null when the input has no
 * leading assignment (caller keeps the original) or when the syntax is incomplete.
 */
export function withoutLeadingEnvironmentAssignments(command: string): string | null {
	let index = 0;
	let foundAssignment = false;
	while (index < command.length) {
		while (command[index] === " " || command[index] === "\t") index++;
		const assignmentStart = index;
		if (!/[A-Za-z_]/.test(command[index] ?? "")) break;
		let nameEnd = index + 1;
		while (/[A-Za-z0-9_]/.test(command[nameEnd] ?? "")) nameEnd++;
		if (command[nameEnd] !== "=") {
			return foundAssignment ? command.slice(assignmentStart).trimStart() : null;
		}
		const wordEnd = skipShellWord(command, nameEnd + 1);
		if (wordEnd === null) return null;
		foundAssignment = true;
		index = wordEnd;
		if (index === command.length) return null;
	}
	if (!foundAssignment) return null;
	const commandWithoutAssignments = command.slice(index).trimStart();
	return commandWithoutAssignments.length > 0 ? commandWithoutAssignments : null;
}
