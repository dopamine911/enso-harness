/**
 * JSONL record splitting for pi's rpc mode (#24).
 *
 * ⚠⚠ WHY THIS EXISTS INSTEAD OF `readline`
 * pi's `docs/rpc.md` § Framing is explicit: rpc uses strict JSONL with LF (`\n`) as the
 * ONLY record delimiter, and **Node's `readline` is not protocol-compliant** because it
 * also splits on `U+2028` (LINE SEPARATOR) and `U+2029` (PARAGRAPH SEPARATOR) — both of
 * which are legal, unescaped, inside a JSON string.
 *
 * The failure mode is why this is worth 60 lines rather than one import: a message whose
 * text contains either character is silently split into two fragments, each of which fails
 * to parse. It only fires on content nobody thinks to test, it corrupts rather than throws
 * at the transport layer, and the symptom appears far from the cause.
 *
 * So: split on `\n`, tolerate a trailing `\r`, and treat every other Unicode separator as
 * ordinary data.
 */

const RECORD_DELIMITER = "\n";
const CARRIAGE_RETURN = "\r";

/**
 * Incremental JSONL splitter.
 *
 * Chunk boundaries from a pipe fall wherever the OS decides, so a record routinely arrives
 * in pieces and two records routinely arrive together. This holds the partial tail between
 * pushes; `push` returns only complete records.
 */
export class JsonLinesSplitter {
	#pending = "";

	/** Feed a chunk. Returns every complete record it completed, in order. */
	push(chunk: string): string[] {
		this.#pending += chunk;
		const records: string[] = [];

		// Deliberately indexOf/slice rather than split(): split() on the accumulated buffer
		// would re-scan the retained tail on every chunk, which is quadratic on a long
		// streaming message. pi emits `message_update` per token.
		let delimiterIndex = this.#pending.indexOf(RECORD_DELIMITER);
		while (delimiterIndex !== -1) {
			const record = this.#pending.slice(0, delimiterIndex);
			this.#pending = this.#pending.slice(delimiterIndex + 1);
			const trimmed = record.endsWith(CARRIAGE_RETURN) ? record.slice(0, -1) : record;
			// A blank line between records is legal framing, not a record.
			if (trimmed.length > 0) records.push(trimmed);
			delimiterIndex = this.#pending.indexOf(RECORD_DELIMITER);
		}
		return records;
	}

	/**
	 * Whatever is buffered but unterminated.
	 *
	 * pi may exit without a trailing newline, so a caller draining on close must ask for
	 * this — otherwise the last record is dropped, which looks exactly like pi having
	 * nothing more to say.
	 */
	flush(): string[] {
		const remainder = this.#pending.endsWith(CARRIAGE_RETURN)
			? this.#pending.slice(0, -1)
			: this.#pending;
		this.#pending = "";
		return remainder.length > 0 ? [remainder] : [];
	}

	/** True when a partial record is held. Useful for asserting a clean shutdown. */
	get hasPartialRecord(): boolean {
		return this.#pending.length > 0;
	}
}
