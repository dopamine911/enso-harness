import { expect, test } from "bun:test";
import { type AttachmentLimits, selectAttachments } from "../components/ai-elements/prompt-input.tsx";

const file = (name: string, type: string, bytes = 10): File => new File([new Uint8Array(bytes)], name, { type });

const LIMITS: AttachmentLimits = { accept: "image/png,image/jpeg", maxFileSize: 100, maxFiles: 3, held: 0 };

// ⚠ Upstream reported a refusal only when the WHOLE batch failed; a mixed drop lost files silently (PR #141 review).
test("a mixed batch attaches what it can and REPORTS each refusal with a count — two PNGs and a PDF is two attached, one said", () => {
	const { accepted, errors } = selectAttachments(
		[file("a.png", "image/png"), file("b.pdf", "application/pdf"), file("c.jpg", "image/jpeg")],
		LIMITS,
	);
	expect(accepted.map((accepted) => accepted.name)).toEqual(["a.png", "c.jpg"]);
	expect(errors).toEqual([{ code: "accept", message: "Some files do not match the accepted types.", count: 1 }]);
});

test("each check reports its own refusals: the kind, then the size, then the room — one batch can trip all three", () => {
	const batch = [
		file("a.png", "image/png"),
		file("b.txt", "text/plain"),
		file("big.png", "image/png", 101),
		file("c.png", "image/png"),
		file("d.png", "image/png"),
		file("e.png", "image/png"),
	];
	const { accepted, errors } = selectAttachments(batch, LIMITS);
	expect(accepted.map((accepted) => accepted.name)).toEqual(["a.png", "c.png", "d.png"]);
	expect(errors).toEqual([
		{ code: "accept", message: "Some files do not match the accepted types.", count: 1 },
		{ code: "max_file_size", message: "Some files exceed the maximum size.", count: 1 },
		{ code: "max_files", message: "Too many files. Some were not added.", count: 1 },
	]);
});

test("the count cap is across adds: with two already held, a third attaches and a fourth is refused; at the cap, nothing attaches and it is said", () => {
	const two = selectAttachments([file("c.png", "image/png"), file("d.png", "image/png")], { ...LIMITS, held: 2 });
	expect(two.accepted.map((accepted) => accepted.name)).toEqual(["c.png"]);
	expect(two.errors).toEqual([{ code: "max_files", message: "Too many files. Some were not added.", count: 1 }]);

	const full = selectAttachments([file("e.png", "image/png")], { ...LIMITS, held: 3 });
	expect(full.accepted).toEqual([]);
	expect(full.errors).toEqual([{ code: "max_files", message: "Too many files. Some were not added.", count: 1 }]);
});

test("a whole batch that passes reports nothing; an empty batch reports nothing; `image/*` accepts any image kind; no accept takes anything", () => {
	expect(selectAttachments([file("a.png", "image/png")], LIMITS).errors).toEqual([]);
	expect(selectAttachments([], LIMITS)).toEqual({ accepted: [], errors: [] });
	expect(selectAttachments([file("a.webp", "image/webp")], { ...LIMITS, accept: "image/*" }).accepted).toHaveLength(1);
	expect(selectAttachments([file("a.bin", "application/octet-stream")], { held: 0 }).accepted).toHaveLength(1);
});
