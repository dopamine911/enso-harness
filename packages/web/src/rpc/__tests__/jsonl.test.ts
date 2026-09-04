import { expect, test } from "bun:test";
import { JsonLinesSplitter } from "../jsonl.ts";

const splitter = () => new JsonLinesSplitter();

test("splits complete records on LF", () => {
	expect(splitter().push('{"a":1}\n{"a":2}\n')).toEqual(['{"a":1}', '{"a":2}']);
});

test("holds a partial record until its delimiter arrives", () => {
	const s = splitter();
	expect(s.push('{"a":')).toEqual([]);
	expect(s.hasPartialRecord).toBe(true);
	expect(s.push("1}\n")).toEqual(['{"a":1}']);
	expect(s.hasPartialRecord).toBe(false);
});

test("a record arriving across three chunks is reassembled", () => {
	const s = splitter();
	s.push('{"type":"mess');
	s.push('age_update","de');
	expect(s.push('lta":"x"}\n')).toEqual(['{"type":"message_update","delta":"x"}']);
});

test("strips a trailing CR but keeps CR inside the payload", () => {
	// \r\n framing is tolerated; an escaped \r within a JSON string is data.
	expect(splitter().push('{"a":1}\r\n')).toEqual(['{"a":1}']);
	expect(splitter().push('{"a":"x\\ry"}\n')).toEqual(['{"a":"x\\ry"}']);
});

test("blank lines between records are framing, not records", () => {
	expect(splitter().push('{"a":1}\n\n{"a":2}\n')).toEqual(['{"a":1}', '{"a":2}']);
});

// ⚠⚠ THE CASE THIS MODULE EXISTS FOR.
// U+2028 and U+2029 are legal unescaped inside a JSON string, and Node's `readline`
// splits on both. A splitter that used it would emit two unparseable fragments here.
test("U+2028 inside a JSON string is DATA, not a record boundary", () => {
	const record = '{"type":"prompt","message":"line one line two"}';
	const emitted = splitter().push(`${record}\n`);
	expect(emitted).toEqual([record]);
	expect(emitted).toHaveLength(1);
	// and it still parses, which is the actual claim
	expect((JSON.parse(emitted[0] as string) as { message: string }).message).toContain(" ");
});

test("U+2029 inside a JSON string is DATA, not a record boundary", () => {
	const record = '{"message":"para one para two"}';
	expect(splitter().push(`${record}\n`)).toEqual([record]);
});

test("both separators in one record survive together", () => {
	const record = '{"message":"a b c"}';
	const emitted = splitter().push(`${record}\n`);
	expect(emitted).toHaveLength(1);
	expect((JSON.parse(emitted[0] as string) as { message: string }).message).toBe("a b c");
});

// --- flush: pi may exit without a trailing newline
test("flush yields an unterminated final record", () => {
	const s = splitter();
	expect(s.push('{"a":1}')).toEqual([]);
	expect(s.flush()).toEqual(['{"a":1}']);
});

test("flush on an empty buffer yields nothing", () => expect(splitter().flush()).toEqual([]));

test("flush is idempotent — a second call yields nothing", () => {
	const s = splitter();
	s.push('{"a":1}');
	s.flush();
	expect(s.flush()).toEqual([]);
});
