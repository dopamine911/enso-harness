import { type Static, Type } from 'typebox'
import { Compile } from 'typebox/compile'
import { EnsoQuestion, EnsoQuestionAnswer } from './dialog.ts'

/**
 * The descriptor kinds Enso itself emits (#920), each with the shape of its `props` — the renderers
 * the web registers for them read `props` through these checks, because a descriptor crosses the
 * wire as `Record<string, unknown>` and a stored one may be from any version. A kind whose props do
 * not check falls back to the result's text, like any unknown kind (#18).
 *
 * ⚠ What a reader must see in every surface stays in the result's `content` (`tool-result.ts`); each
 * of these adds only what a richer card needs on top of it.
 */

/**
 * An image the tool itself returned (`read` of a PNG): its bytes, so the card shows a thumbnail. Never
 * a URL — nothing here may make the page fetch a resource the model chose.
 *
 * @group Tool results
 */
export const ENSO_IMAGES_KIND = 'enso.images' as const

/** @group Tool results */
export const EnsoImagesProps = Type.Object({
  images: Type.Array(Type.Object({ mimeType: Type.String({ pattern: '^image/' }), data: Type.String() })),
})
/** @group Tool results */
export type EnsoImagesProps = Static<typeof EnsoImagesProps>

/**
 * An `ask_user` call's answers (#920), beside the questions they answer: what the card shows as
 * question → chosen answer. Absent `answers` is a questionnaire nobody answered (declined, or no
 * user to ask) — the result's text says which.
 *
 * @group Tool results
 */
export const ENSO_QUESTIONNAIRE_ANSWERS_KIND = 'enso.questionnaire-answers' as const

/** @group Tool results */
export const EnsoQuestionnaireAnswersProps = Type.Object({
  questions: Type.Array(EnsoQuestion),
  answers: Type.Optional(Type.Array(EnsoQuestionAnswer)),
})
/** @group Tool results */
export type EnsoQuestionnaireAnswersProps = Static<typeof EnsoQuestionnaireAnswersProps>

/**
 * A `write` call's receipt (#920): whether the file was there before (overwritten) or not (new). pi's
 * own result says only `Successfully wrote to <path>`; the harness looks before the write runs.
 *
 * @group Tool results
 */
export const ENSO_WRITE_RECEIPT_KIND = 'enso.write-receipt' as const

/** @group Tool results */
export const EnsoWriteReceiptProps = Type.Object({ existed: Type.Boolean() })
/** @group Tool results */
export type EnsoWriteReceiptProps = Static<typeof EnsoWriteReceiptProps>

const imagesCheck = Compile(EnsoImagesProps)
const answersCheck = Compile(EnsoQuestionnaireAnswersProps)
const receiptCheck = Compile(EnsoWriteReceiptProps)

/** @group Tool results */
export function isEnsoImagesProps(value: unknown): value is EnsoImagesProps {
  return imagesCheck.Check(value)
}

/** @group Tool results */
export function isEnsoQuestionnaireAnswersProps(value: unknown): value is EnsoQuestionnaireAnswersProps {
  return answersCheck.Check(value)
}

/** @group Tool results */
export function isEnsoWriteReceiptProps(value: unknown): value is EnsoWriteReceiptProps {
  return receiptCheck.Check(value)
}
