/**
 * picc's permission prompt, lifted to a question the web surface can ask (#73).
 *
 * picc gates every mutating tool in `default` mode behind `ctx.ui.custom(...)`, handing pi
 * a factory that builds a `FilePermissionDialog` — a terminal component with keyboard
 * focus. The web host has no terminal: pi's own rpc mode resolves `custom` to `undefined`,
 * picc reads that as "user dismissed dialog", and the tool is refused. Since #69 made the
 * mode persistent, a thread that never ran `/mode` could never write anything (#73).
 *
 * The component is the identity. `FilePermissionDialog` is an EXPORTED class, so
 * `instanceof` recognises it with no change on picc's side, and its fields are exactly a
 * `select`'s inputs: the OPTIONS picc will read back verbatim (`"Yes"`, `"No"`, `"Yes, allow
 * all edits during this session (shift+tab)"`…) and the detail a human decides on — the
 * question, a file preview or diff, a command. The select rides the #27 park-and-resume
 * path like `/mode`'s does; the answer reaches picc through the same `done` its own dialog
 * would have called.
 *
 * ⚠ picc IS LOADED AT RUNTIME, NEVER AT TYPE LEVEL. pi loads picc's TypeScript source
 * directly and so does this import — but a static `import` would pull picc's whole source
 * tree into this package's `tsc`, where it fails under `exactOptionalPropertyTypes` (40
 * diagnostics, none ours). The specifier is a variable so TypeScript types the import as
 * opaque; the vendor symlink resolves to the same real file pi loaded, so the class object
 * is the same one and `instanceof` holds.
 *
 * ⚠ THIS READS picc's PRIVATE FIELDS. They are TypeScript-private (`private readonly`),
 * not runtime-private, and there is no public accessor — picc expects to render them, not
 * hand them out. The coupling is pinned by `__tests__/permission-dialog.test.ts`, which
 * constructs the real class from known options and asserts what is lifted: a picc refactor
 * that renames a field fails that test loudly instead of silently reopening #73 (a missing
 * `options` would read as no lift; a missing `question` as no detail).
 */

/** The one module of picc's this surface reaches into. `pi loads ./index.ts`; this is its sibling. */
export const PICC_PERMISSION_DIALOG_MODULE = "@ladbabynpm/picc-permission-modes/filePermissionDialog.ts";

/** picc's `DiffLine` (utils.ts), the three fields the detail block reads. */
interface PermissionDiffLine {
	readonly type: "add" | "del" | "context";
	readonly text: string;
}

/** What `FilePermissionDialog` holds — its constructor's assignments, read by name. */
interface PermissionDialogFields {
	readonly message: string;
	readonly description: string;
	readonly options: readonly string[];
	readonly title: string;
	readonly subtitle: string;
	readonly question: string;
	readonly diffLines: readonly PermissionDiffLine[];
	readonly previewLines: readonly string[];
	readonly showPanel: boolean;
	readonly command: string;
	readonly note: string;
	readonly showBashPanel: boolean;
}

/** The select a permission prompt becomes. `message` is the preformatted detail. */
export interface LiftedPermissionDialog {
	readonly title: string;
	readonly options: readonly string[];
	readonly message: string;
}

/** Preview and diff bodies are clipped so a 10 000-line write does not become the dialog. */
export const PERMISSION_DETAIL_MAX_LINES = 120;

type ComponentClass = abstract new (...args: never[]) => object;

let dialogClass: Promise<ComponentClass> | undefined;

/** picc's `FilePermissionDialog` class object, loaded once. Rejects if picc is not installed. */
function permissionDialogClass(): Promise<ComponentClass> {
	dialogClass ??= import(PICC_PERMISSION_DIALOG_MODULE).then((loaded: { FilePermissionDialog?: unknown }) => {
		if (typeof loaded.FilePermissionDialog !== "function") {
			throw new Error(`${PICC_PERMISSION_DIALOG_MODULE} exports no FilePermissionDialog class`);
		}
		return loaded.FilePermissionDialog as ComponentClass;
	});
	return dialogClass;
}

function clipped(lines: readonly string[]): string[] {
	if (lines.length <= PERMISSION_DETAIL_MAX_LINES) return [...lines];
	return [...lines.slice(0, PERMISSION_DETAIL_MAX_LINES), `… ${lines.length - PERMISSION_DETAIL_MAX_LINES} more lines`];
}

const DIFF_MARKER: Record<PermissionDiffLine["type"], string> = { add: "+", del: "-", context: " " };

/** The detail block: question first, then whatever picc would have drawn in its panel. */
function detailOf(dialog: PermissionDialogFields): string {
	const lines: string[] = [];
	if (dialog.message.length > 0 && dialog.message !== dialog.question) lines.push(dialog.message);
	lines.push(dialog.question);
	if (dialog.showBashPanel) {
		if (dialog.description.length > 0) lines.push("", dialog.description);
		lines.push("", `$ ${dialog.command}`);
		if (dialog.note.length > 0) lines.push("", dialog.note);
	} else if (dialog.showPanel) {
		if (dialog.subtitle.length > 0) lines.push("", dialog.subtitle);
		if (dialog.diffLines.length > 0) {
			lines.push("", ...clipped(dialog.diffLines.map((line) => `${DIFF_MARKER[line.type]} ${line.text}`)));
		} else if (dialog.previewLines.length > 0) {
			lines.push("", ...clipped(dialog.previewLines));
		}
	}
	return lines.join("\n");
}

/**
 * The select a component becomes, or `undefined` for a component this surface does not
 * know — pi's rpc contract then applies (`custom` resolves `undefined`).
 */
export async function liftPermissionDialog(component: unknown): Promise<LiftedPermissionDialog | undefined> {
	if (!(component instanceof (await permissionDialogClass()))) return undefined;
	// The instanceof check is the identity; the field view is the coupling the test pins.
	const dialog = component as unknown as PermissionDialogFields;
	if (!Array.isArray(dialog.options) || dialog.options.length === 0) return undefined;
	const fallbackTitle = dialog.showBashPanel ? "Run command" : "Permission";
	return {
		title: dialog.title.length > 0 ? dialog.title : fallbackTitle,
		options: [...dialog.options],
		message: detailOf(dialog),
	};
}
