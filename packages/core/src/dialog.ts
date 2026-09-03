import { Type, type Static } from "typebox";
import { Compile } from "typebox/compile";

/**
 * pi's blocking extension dialogs, as data (#27).
 *
 * pi's rpc mode has four dialog methods — `select`, `confirm`, `input`, `editor` — that
 * emit an `extension_ui_request` and BLOCK the extension until an `extension_ui_response`
 * with the matching id arrives on stdin (pi `rpc-types.d.ts`, read at v0.84.4). These
 * schemas are the harness's model of that exchange: the QUESTION (`ZenDialogSpec`), which
 * rides to the browser inside an AG-UI interrupt, and the ANSWER (`ZenDialogAnswer`),
 * which rides back in the resume request's payload.
 *
 * ⚠ The answer shapes mirror pi's response contract EXACTLY, minus the envelope
 * (`type`/`id`), so the server can forward a validated answer by adding the envelope and
 * nothing else:
 *
 *     select | input | editor  →  { value: string }      (rpc-mode.js:84,86 — the select
 *                                                          value is returned to the
 *                                                          extension VERBATIM, so it must
 *                                                          be one of the offered options)
 *     confirm                  →  { confirmed: boolean }  (rpc-mode.js:85)
 *     any                      →  cancellation, which has NO payload here — it travels as
 *                                  the resume entry's `status: "cancelled"` and the server
 *                                  writes pi's `{ cancelled: true }` form
 */

/**
 * The metadata key an AG-UI interrupt carries the dialog spec under.
 *
 * ⚠ NO DOT, DELIBERATELY — same reasoning as `ZEN_TOOL_RESULT_KEY`: a dot inside a key is
 * legal JSON but collides with every path-based accessor.
 */
export const ZEN_DIALOG_KEY = "zen:dialog" as const;

/**
 * One dialog question, per method.
 *
 * `timeout` is pi's OWN deadline (milliseconds), when the requesting extension set one:
 * pi resolves the dialog itself when it lapses, so an answer arriving after it is written
 * to an id nobody is waiting on. Carried so a surface can stop offering a dead question.
 */
export const ZenDialogSpec = Type.Union([
	Type.Object({
		method: Type.Literal("select"),
		title: Type.String(),
		options: Type.Array(Type.String(), { minItems: 1 }),
		timeout: Type.Optional(Type.Number({ minimum: 0 })),
	}),
	Type.Object({
		method: Type.Literal("confirm"),
		title: Type.String(),
		message: Type.String(),
		timeout: Type.Optional(Type.Number({ minimum: 0 })),
	}),
	Type.Object({
		method: Type.Literal("input"),
		title: Type.String(),
		placeholder: Type.Optional(Type.String()),
		timeout: Type.Optional(Type.Number({ minimum: 0 })),
	}),
	Type.Object({
		method: Type.Literal("editor"),
		title: Type.String(),
		prefill: Type.Optional(Type.String()),
	}),
]);
export type ZenDialogSpec = Static<typeof ZenDialogSpec>;

/** A resolved answer. Cancellation is NOT an answer — see the module header. */
export const ZenDialogAnswer = Type.Union([
	Type.Object({ value: Type.String() }),
	Type.Object({ confirmed: Type.Boolean() }),
]);
export type ZenDialogAnswer = Static<typeof ZenDialogAnswer>;

/**
 * One entry of a TanStack resume request (`body.resume`), as this server accepts it.
 *
 * The shape is TanStack's (`ResumeEntry` in `@ag-ui/core`); the schema exists because the
 * bytes arrive over HTTP and are validated like any other untrusted input. `payload` stays
 * `Unknown` here — whether it is a valid ANSWER depends on which dialog it answers, which
 * is `validateDialogAnswer`'s job, not the transport schema's.
 */
export const ZenDialogResumeEntry = Type.Object({
	interruptId: Type.String({ minLength: 1 }),
	status: Type.Union([Type.Literal("resolved"), Type.Literal("cancelled")]),
	payload: Type.Optional(Type.Unknown()),
});
export type ZenDialogResumeEntry = Static<typeof ZenDialogResumeEntry>;

const dialogSpecValidator = Compile(ZenDialogSpec);
const dialogAnswerValidator = Compile(ZenDialogAnswer);
const resumeEntryValidator = Compile(ZenDialogResumeEntry);

export function isZenDialogSpec(value: unknown): value is ZenDialogSpec {
	return dialogSpecValidator.Check(value);
}

export function isZenDialogResumeEntry(value: unknown): value is ZenDialogResumeEntry {
	return resumeEntryValidator.Check(value);
}

/**
 * Does this payload answer THIS dialog?
 *
 * Returns `undefined` when it does, or a human-readable refusal. Lives beside the schemas
 * so both surfaces enforce the same rule — in particular the select rule: pi hands the
 * answered `value` to the extension verbatim, so a value outside the offered options would
 * put a string the extension never offered into its control flow. That is an injection
 * seam, and it is closed HERE rather than trusted to the renderer.
 */
export function validateDialogAnswer(spec: ZenDialogSpec, payload: unknown): string | undefined {
	if (!dialogAnswerValidator.Check(payload)) {
		return `the payload is not a dialog answer ({ value: string } or { confirmed: boolean })`;
	}
	switch (spec.method) {
		case "confirm":
			return "confirmed" in payload
				? undefined
				: `a 'confirm' dialog takes { confirmed: boolean }, got a 'value' answer`;
		case "select":
			if (!("value" in payload)) {
				return `a 'select' dialog takes { value: string }, got a 'confirmed' answer`;
			}
			return spec.options.includes(payload.value)
				? undefined
				: `'${payload.value}' is not one of the offered options`;
		case "input":
		case "editor":
			return "value" in payload
				? undefined
				: `an '${spec.method}' dialog takes { value: string }, got a 'confirmed' answer`;
	}
}
