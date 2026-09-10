import { type Static, Type } from 'typebox'
import { Compile } from 'typebox/compile'

/**
 * pi's blocking extension dialogs, as data (#27, #112).
 *
 * pi's rpc mode has four dialog methods — `select`, `confirm`, `input`, `editor` — that
 * emit an `extension_ui_request` and BLOCK the extension until an `extension_ui_response`
 * with the matching id arrives (pi `rpc-types.d.ts`, read at v0.84.4). These schemas are
 * the harness's model of that exchange: the QUESTION (`ZenDialogSpec`), which rides to the
 * browser on the follow as a `zen.dialog` chunk, and the ANSWER (`ZenDialogAnswer`), which
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
 */
export const ZenDialogSpec = Type.Union([
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
    timeout: Type.Optional(Type.Number({ minimum: 0 })),
  }),
  Type.Object({
    method: Type.Literal('editor'),
    title: Type.String(),
    prefill: Type.Optional(Type.String()),
  }),
])
export type ZenDialogSpec = Static<typeof ZenDialogSpec>

/** A resolved answer. Cancellation is NOT an answer — see the module header. */
export const ZenDialogAnswer = Type.Union([
  Type.Object({ value: Type.String() }),
  Type.Object({ confirmed: Type.Boolean() }),
])
export type ZenDialogAnswer = Static<typeof ZenDialogAnswer>

/**
 * One question pi is blocked on, as the follow's snapshot lists it (#114) — so a follow
 * opened while pi waits renders the card at once, instead of a busy thread with nothing to
 * answer. `id` is the request id the answer is keyed by.
 */
export const ZenOpenDialog = Type.Object({ id: Type.String({ minLength: 1 }), dialog: ZenDialogSpec })
export type ZenOpenDialog = Static<typeof ZenOpenDialog>

const dialogSpecValidator = Compile(ZenDialogSpec)
const dialogAnswerValidator = Compile(ZenDialogAnswer)

export function isZenDialogSpec(value: unknown): value is ZenDialogSpec {
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
 */
export function validateDialogAnswer(spec: ZenDialogSpec, payload: unknown): string | undefined {
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
