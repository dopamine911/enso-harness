import { beforeAll, expect, test } from "bun:test";
import {
	liftPermissionDialog,
	PERMISSION_DETAIL_MAX_LINES,
	PICC_PERMISSION_DIALOG_MODULE,
} from "../permission-dialog.ts";

/**
 * The coupling to picc's `FilePermissionDialog` (#73), pinned against the REAL class: the
 * lift reads TypeScript-private fields by name, so this is what fails — loudly — when a picc
 * refactor renames one. The class is loaded the way the host loads it (runtime import, no
 * type import — see the module header for why), so the test and the code share the object.
 */

/** picc's constructor: `(opts, onChoice, bold?, dim?, fg?, getTerminalRows?)`. */
type PermissionDialogConstructor = new (
	options: Record<string, unknown>,
	onChoice: (choice: string | null) => void,
) => object;

let FilePermissionDialog: PermissionDialogConstructor;

beforeAll(async () => {
	const loaded = (await import(PICC_PERMISSION_DIALOG_MODULE)) as { FilePermissionDialog: PermissionDialogConstructor };
	FilePermissionDialog = loaded.FilePermissionDialog;
});

function neverChosen(): void {
	// The lift never drives the component; `onChoice` exists to satisfy the constructor.
}

const WRITE_OPTIONS = ["Yes", "Yes, allow all edits during this session (shift+tab)", "No"];

test("⚠ a file-write prompt lifts to picc's options verbatim, titled as picc titles it, with question, path and preview", async () => {
	const dialog = new FilePermissionDialog(
		{
			message: "Allow write?",
			options: WRITE_OPTIONS,
			title: "Create file",
			subtitle: "receipt-73.txt",
			question: "Do you want to create this file: receipt-73.txt?",
			previewLines: ["ok", "second line"],
			showPanel: true,
		},
		neverChosen,
	);
	const lifted = await liftPermissionDialog(dialog);
	expect(lifted).toEqual({
		title: "Create file",
		// ⚠ Verbatim: picc reads the answer back by string equality (`choice === "Yes"`,
		// `choice.includes("during this session")`), so a reworded option would be a "no".
		options: WRITE_OPTIONS,
		message: [
			"Allow write?",
			"Do you want to create this file: receipt-73.txt?",
			"",
			"receipt-73.txt",
			"",
			"ok",
			"second line",
		].join("\n"),
	});
});

test("an edit prompt renders its diff with +/-/space markers; a bash prompt shows the command and note under 'Run command'", async () => {
	const edit = await liftPermissionDialog(
		new FilePermissionDialog(
			{
				options: WRITE_OPTIONS,
				title: "Edit file",
				subtitle: "a.ts",
				question: "Do you want to make this edit to a.ts?",
				diffLines: [
					{ type: "context", oldNo: 1, newNo: 1, text: "keep" },
					{ type: "del", oldNo: 2, newNo: 1, text: "old" },
					{ type: "add", oldNo: 2, newNo: 2, text: "new" },
				],
				showPanel: true,
			},
			neverChosen,
		),
	);
	expect(edit?.message.split("\n").slice(-3)).toEqual(["  keep", "- old", "+ new"]);

	const bash = await liftPermissionDialog(
		new FilePermissionDialog(
			{
				message: "Allow bash command?",
				description: "List the directory",
				options: ["Yes", "Yes, and don't ask again for: ls *", "No"],
				showBashPanel: true,
				command: "ls -la",
				question: "Do you want to proceed?",
				note: "This command requires approval",
			},
			neverChosen,
		),
	);
	expect(bash?.title).toBe("Run command");
	expect(bash?.options).toEqual(["Yes", "Yes, and don't ask again for: ls *", "No"]);
	expect(bash?.message).toBe(
		[
			"Allow bash command?",
			"Do you want to proceed?",
			"",
			"List the directory",
			"",
			"$ ls -la",
			"",
			"This command requires approval",
		].join("\n"),
	);
});

test("a long preview is clipped to the cap with a count of what was cut", async () => {
	const lines = Array.from({ length: PERMISSION_DETAIL_MAX_LINES + 80 }, (_, index) => `line ${index}`);
	const lifted = await liftPermissionDialog(
		new FilePermissionDialog({ options: ["Yes", "No"], previewLines: lines, showPanel: true }, neverChosen),
	);
	const body = lifted?.message.split("\n") ?? [];
	expect(body.at(-1)).toBe("… 80 more lines");
	expect(body.filter((line) => line.startsWith("line ")).length).toBe(PERMISSION_DETAIL_MAX_LINES);
});

test("a component that is not picc's permission dialog is not lifted — pi's rpc contract applies", async () => {
	expect(await liftPermissionDialog({ render: () => [], invalidate: () => undefined })).toBeUndefined();
	expect(await liftPermissionDialog(undefined)).toBeUndefined();
	// picc's class with no options is not a question anyone can answer.
	expect(await liftPermissionDialog(new FilePermissionDialog({ options: [] }, neverChosen))).toBeUndefined();
});
