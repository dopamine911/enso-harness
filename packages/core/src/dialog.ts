import { type Static, Type } from 'typebox'
import { Compile } from 'typebox/compile'

/**
 * pi's blocking extension dialogs, as data (#27, #112).
 *
 * pi's rpc mode has four dialog methods — `select`, `confirm`, `input`, `editor` — that
 * emit an `extension_ui_request` and BLOCK the extension until an `extension_ui_response`
 * with the matching id arrives (pi `rpc-types.d.ts`, read at v0.87.1). These schemas are
 * the harness's model of that exchange: the QUESTION (`EnsoDialogSpec`), which rides to the
 * browser on the follow as a blocking `extension-ui-request`, and the ANSWER (`EnsoDialogAnswer`), which
 * rides back in `POST /api/threads/:id/dialog`.
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
 *                                  pi's own `{ cancelled: true }` form and needs no check
 */

/**
 * One dialog question, per method.
 *
 * `timeout` is pi's OWN deadline (milliseconds), when the requesting extension set one:
 * pi resolves the dialog itself when it lapses, so an answer arriving after it is written
 * to an id nobody is waiting on. Carried so a surface can stop offering a dead question.
 *
 * @group Dialogs
 */
export const EnsoDialogSpec = Type.Union([
  Type.Object({
    method: Type.Literal('select'),
    title: Type.String(),
    options: Type.Array(Type.String(), { minItems: 1 }),
    /**
     * The detail behind the question — a file preview, a diff, a command. pi's own
     * `select` has none; the host adds it when it lifts a component dialog to a select
     * (#73: picc's permission prompt), because a permission decision needs to see what it
     * is deciding about. Preformatted text: rendered as-is, never as markdown.
     */
    message: Type.Optional(Type.String()),
    timeout: Type.Optional(Type.Number({ minimum: 0 })),
  }),
  Type.Object({
    method: Type.Literal('confirm'),
    title: Type.String(),
    message: Type.String(),
    timeout: Type.Optional(Type.Number({ minimum: 0 })),
  }),
  Type.Object({
    method: Type.Literal('input'),
    title: Type.String(),
    placeholder: Type.Optional(Type.String()),
    /**
     * The answer is a credential (#338 slice 3): an API key typed into `/login`. The browser
     * masks the field and the answer is never echoed into a transcript line. pi's own
     * `input` has no such flag — its login flow asks through `AuthPrompt.type: 'secret'` — so
     * the host sets it when it lifts that prompt to a dialog.
     */
    secret: Type.Optional(Type.Literal(true)),
    timeout: Type.Optional(Type.Number({ minimum: 0 })),
  }),
  Type.Object({
    method: Type.Literal('editor'),
    title: Type.String(),
    prefill: Type.Optional(Type.String()),
  }),
])
/** @group Dialogs */
export type EnsoDialogSpec = Static<typeof EnsoDialogSpec>

/**
 * A resolved answer. Cancellation is NOT an answer — see the module header.
 *
 * @group Dialogs
 */
export const EnsoDialogAnswer = Type.Union([
  Type.Object({ value: Type.String() }),
  Type.Object({ confirmed: Type.Boolean() }),
])
/** @group Dialogs */
export type EnsoDialogAnswer = Static<typeof EnsoDialogAnswer>

/**
 * One question pi is blocked on, as the follow's snapshot lists it (#114) — so a follow
 * opened while pi waits renders the card at once, instead of a busy thread with nothing to
 * answer.
 *
 * `id` is the request id the answer is keyed by.
 *
 * @group Dialogs
 */
export const EnsoOpenDialog = Type.Object({ id: Type.String({ minLength: 1 }), dialog: EnsoDialogSpec })
/** @group Dialogs */
export type EnsoOpenDialog = Static<typeof EnsoOpenDialog>

const dialogSpecValidator = Compile(EnsoDialogSpec)
const dialogAnswerValidator = Compile(EnsoDialogAnswer)

/** @group Dialogs */
export function isEnsoDialogSpec(value: unknown): value is EnsoDialogSpec {
  return dialogSpecValidator.Check(value)
}

/**
 * Does this payload answer THIS dialog?
 *
 * Returns `undefined` when it does, or a human-readable refusal. Lives beside the schemas
 * so both surfaces enforce the same rule — in particular the select rule: pi hands the
 * answered `value` to the extension verbatim, so a value outside the offered options would
 * put a string the extension never offered into its control flow. That is an injection
 * seam, and it is closed HERE rather than trusted to the renderer.
 *
 * @group Dialogs
 */
export function validateDialogAnswer(spec: EnsoDialogSpec, payload: unknown): string | undefined {
  if (!dialogAnswerValidator.Check(payload)) {
    return `the payload is not a dialog answer ({ value: string } or { confirmed: boolean })`
  }
  switch (spec.method) {
    case 'confirm':
      return 'confirmed' in payload
        ? undefined
        : `a 'confirm' dialog takes { confirmed: boolean }, got a 'value' answer`
    case 'select':
      if (!('value' in payload)) {
        return `a 'select' dialog takes { value: string }, got a 'confirmed' answer`
      }
      return spec.options.includes(payload.value) ? undefined : `'${payload.value}' is not one of the offered options`
    case 'input':
    case 'editor':
      return 'value' in payload
        ? undefined
        : `an '${spec.method}' dialog takes { value: string }, got a 'confirmed' answer`
  }
}
