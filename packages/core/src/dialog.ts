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
 *
 * ⚠ ONE KIND IS OURS, NOT pi's: `questionnaire` — the agent's `ask_user` (#12), a whole set of
 * questions asked and answered as one card. pi has no such method; the tool hands `custom` a
 * component carrying the question under {@link QUESTIONNAIRE_COMPONENT_KEY}, and the host lifts
 * it (as it lifts any component it knows to a dialog). Its answer is `{ answers }`, one
 * entry per question, and the host hands it to the tool — pi's response contract never sees it.
 */

/**
 * One question of a questionnaire. The shape is the one a model is asked for — Claude's
 * AskUserQuestion: a short `header` (the card's tab), the `question`, the options (each a
 * label and what choosing it means), and whether several may be chosen. A free-text answer
 * ("Other") is always offered; the model does not list it.
 *
 * @group Dialogs
 */
export const EnsoQuestion = Type.Object({
  header: Type.String({ minLength: 1 }),
  question: Type.String({ minLength: 1 }),
  options: Type.Array(
    Type.Object({ label: Type.String({ minLength: 1 }), description: Type.Optional(Type.String()) }),
    { minItems: 1 },
  ),
  multiSelect: Type.Boolean(),
})
/** @group Dialogs */
export type EnsoQuestion = Static<typeof EnsoQuestion>

/**
 * What a questionnaire repeats that must be distinct: a question's tab `header` (two tabs of one
 * name cannot be told apart, and the card keys its tabs by it), or an option `label` within one
 * question. The same label in two DIFFERENT questions is fine — each question is answered alone.
 *
 * @group Dialogs
 */
export type QuestionnaireRepeat =
  | { readonly kind: 'header'; readonly question: number; readonly header: string }
  | { readonly kind: 'label'; readonly question: number; readonly label: string }

/**
 * The first repeat a questionnaire carries, numbered by the question it is found in — or
 * `undefined` when headers and labels are distinct. The schema cannot say "unique by field", and a
 * repeat breaks everything downstream: the card's two tabs or rows collide, a plain prompt can only
 * ever pick the first, and the answer cannot say which was meant. So the tool refuses such a call,
 * and the host refuses to lift one.
 *
 * @group Dialogs
 */
export function questionnaireRepeat(questions: readonly EnsoQuestion[]): QuestionnaireRepeat | undefined {
  const headers = new Set<string>()
  for (const [questionIndex, question] of questions.entries()) {
    if (headers.has(question.header)) return { kind: 'header', question: questionIndex + 1, header: question.header }
    headers.add(question.header)
    const labels = new Set<string>()
    for (const { label } of question.options) {
      if (labels.has(label)) return { kind: 'label', question: questionIndex + 1, label }
      labels.add(label)
    }
  }
  return undefined
}

/**
 * How one question was answered: the labels chosen, and the free text when "Other" was used.
 *
 * @group Dialogs
 */
export const EnsoQuestionAnswer = Type.Object({
  selected: Type.Array(Type.String()),
  other: Type.Optional(Type.String()),
})
/** @group Dialogs */
export type EnsoQuestionAnswer = Static<typeof EnsoQuestionAnswer>

/**
 * A questionnaire's answers: one per question, in order — what the dialog body carries.
 *
 * @group Dialogs
 */
export const EnsoQuestionAnswers = Type.Array(EnsoQuestionAnswer)

/**
 * Where a questionnaire component carries its question for the host to read — a registered
 * symbol, so the tool and the host agree on it without either importing the other.
 *
 * @group Dialogs
 */
export const QUESTIONNAIRE_COMPONENT_KEY: unique symbol = Symbol.for('enso.questionnaire')

/**
 * What a questionnaire resolves to in the asking tool: the answers, or a real decline. Never
 * `undefined` from a host that lifted it — `undefined` means the host could not show it at all
 * (pi's own rpc mode), and the tool falls back to asking one question at a time.
 *
 * @group Dialogs
 */
export type EnsoQuestionnaireResult = { cancelled: true } | { answers: EnsoQuestionAnswer[] }

/**
 * A page the person must open to answer (#388): a login's authorization page. Only `http(s)` —
 * the browser renders it as a link that opens a new tab, and a `javascript:` or `file:` URL must
 * not become one.
 *
 * @group Dialogs
 */
export const EnsoDialogLink = Type.Object({
  url: Type.String({ pattern: '^https?://' }),
  label: Type.String({ minLength: 1 }),
})
/** @group Dialogs */
export type EnsoDialogLink = Static<typeof EnsoDialogLink>

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
     * `select` has none; a surface that lifts a component dialog to a select may add it
     * (#73), because a permission decision needs to see what it is deciding about.
     * Preformatted text: rendered as-is, never as markdown.
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
    /**
     * What the answer is and where it comes from (#388): a login's code prompt says that the
     * login completes by itself when finished in a browser on this machine, and what to paste
     * when it does not. Plain text, never markdown. pi's own `input` has none; the host sets it.
     */
    message: Type.Optional(Type.String()),
    /** The page to open to get the answer (#388): the login's authorization URL. The host sets it. */
    link: Type.Optional(EnsoDialogLink),
    timeout: Type.Optional(Type.Number({ minimum: 0 })),
  }),
  Type.Object({
    method: Type.Literal('editor'),
    title: Type.String(),
    prefill: Type.Optional(Type.String()),
  }),
  Type.Object({
    method: Type.Literal('questionnaire'),
    title: Type.String(),
    questions: Type.Array(EnsoQuestion, { minItems: 1 }),
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
  Type.Object({ answers: EnsoQuestionAnswers }),
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
    return `the payload is not a dialog answer ({ value: string }, { confirmed: boolean } or { answers: [...] })`
  }
  switch (spec.method) {
    case 'confirm':
      return 'confirmed' in payload ? undefined : `a 'confirm' dialog takes { confirmed: boolean }`
    case 'select':
      if (!('value' in payload)) return `a 'select' dialog takes { value: string }`
      return spec.options.includes(payload.value) ? undefined : `'${payload.value}' is not one of the offered options`
    case 'input':
    case 'editor':
      return 'value' in payload ? undefined : `an '${spec.method}' dialog takes { value: string }`
    case 'questionnaire':
      if (!('answers' in payload)) return `a 'questionnaire' dialog takes { answers: [...] }`
      return questionnaireRefusal(spec.questions, payload.answers)
  }
}

/**
 * The questionnaire rule, per question and in order: every chosen label is one the question
 * offered (the tool reads them back, so a label it never offered is the select-injection seam
 * again), none twice; a single-choice question has exactly one answer — a label or "Other"; a
 * multi-choice one at least one; and "Other" is never blank. A decline is `{ cancelled: true }`,
 * not an empty answer, so an unanswered question is refused rather than read as "none".
 */
function questionnaireRefusal(
  questions: readonly EnsoQuestion[],
  answers: readonly EnsoQuestionAnswer[],
): string | undefined {
  if (answers.length !== questions.length) {
    return `${answers.length} answers for ${questions.length} questions`
  }
  for (const [questionIndex, question] of questions.entries()) {
    const refusal = questionAnswerRefusal(question, answers[questionIndex], questionIndex + 1)
    if (refusal !== undefined) return refusal
  }
  return undefined
}

/** One question's answer against what it offered and allows — `number` is its place, for the refusal. */
function questionAnswerRefusal(
  question: EnsoQuestion,
  answer: EnsoQuestionAnswer | undefined,
  number: number,
): string | undefined {
  if (answer === undefined) return `question ${number} has no answer`
  const offered = question.options.map((option) => option.label)
  const stranger = answer.selected.find((label) => !offered.includes(label))
  if (stranger !== undefined) return `'${stranger}' is not one of question ${number}'s options`
  if (new Set(answer.selected).size !== answer.selected.length) return `question ${number} names an option twice`
  if (answer.other?.trim() === '') return `question ${number}'s other answer is blank`
  const count = answer.selected.length + (answer.other === undefined ? 0 : 1)
  if (count === 0) return `question ${number} is unanswered`
  if (!question.multiSelect && count > 1) return `question ${number} takes one answer, got ${count}`
  return undefined
}
