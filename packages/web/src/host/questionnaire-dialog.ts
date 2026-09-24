import {
  type EnsoDialogSpec,
  ensoLogger,
  isEnsoDialogSpec,
  QUESTIONNAIRE_COMPONENT_KEY,
  questionnaireRepeat,
} from '@enso/core'

/**
 * The agent's `ask_user` questionnaire, lifted to a dialog the web card asks as one (#12).
 *
 * pi has no dialog method for a set of questions, so the tool hands `custom` a component that
 * carries its question under {@link QUESTIONNAIRE_COMPONENT_KEY} — a registered symbol, so the
 * tool and the host agree on it without either importing the other (the harness package is
 * loaded by pi, not by the web package). The component is the identity, as picc's
 * `FilePermissionDialog` is for its prompt (`permission-dialog.ts`); unlike picc's, it is ours,
 * so what it carries is the schema's shape, not a vendor's private fields.
 *
 * ⚠ Checked, never trusted: the carried value is validated against `EnsoDialogSpec` before it
 * becomes a question, so a malformed one is no dialog at all — `custom` then resolves
 * `undefined`, pi's rpc contract, and the tool falls back to asking one question at a time.
 */

const log = ensoLogger('host', 'ui')

/** The questionnaire a component carries, as the dialog spec the card asks — or `undefined`. */
export function liftQuestionnaire(
  component: unknown,
): Extract<EnsoDialogSpec, { method: 'questionnaire' }> | undefined {
  if (typeof component !== 'object' || component === null || !(QUESTIONNAIRE_COMPONENT_KEY in component)) {
    return undefined
  }
  const carried = (component as Record<typeof QUESTIONNAIRE_COMPONENT_KEY, unknown>)[QUESTIONNAIRE_COMPONENT_KEY]
  // Exactly the two fields, never a spread: the schema admits extra keys, and anything carried
  // here would ride to every follower as part of the question.
  const { title, questions } = (typeof carried === 'object' && carried !== null ? carried : {}) as {
    title?: unknown
    questions?: unknown
  }
  const candidate = { method: 'questionnaire', title, questions }
  if (!isEnsoDialogSpec(candidate) || candidate.method !== 'questionnaire') {
    log.warn('a questionnaire component carried no valid questionnaire — not asked: {carried}', { carried })
    return undefined
  }
  // The tool refuses a repeated header or label before it asks; this is the host's own fence,
  // because two tabs or rows of one name render as one and the answer could not say which.
  const repeated = questionnaireRepeat(candidate.questions)
  if (repeated !== undefined) {
    log.warn('a questionnaire repeats a {kind} in question {question} — not asked', repeated)
    return undefined
  }
  return {
    method: 'questionnaire',
    title: candidate.title,
    questions: candidate.questions.map(({ header, question, options, multiSelect }) => ({
      header,
      question,
      options: options.map(({ label, description }) =>
        description === undefined ? { label } : { label, description },
      ),
      multiSelect,
    })),
  }
}
