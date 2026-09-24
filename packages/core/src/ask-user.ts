import { type Static, Type } from 'typebox'

/**
 * The agent's `ask_user` tool (#12): what the model writes when it has a question only the user
 * can answer. The shape is Claude's AskUserQuestion — one to four questions, each a short tab
 * `header`, the `question`, two to four options (a label and what choosing it means), and whether
 * several may be chosen. A free-text "Other" is always offered and never listed.
 *
 * A call that satisfies these parameters is also a valid questionnaire (`dialog.ts`'s
 * `EnsoQuestion`), which is looser: the limits here are for the model, the card takes any count.
 */

/** @group Dialogs */
export const ASK_USER_TOOL_NAME = 'ask_user'

/** @group Dialogs */
export const AskUserToolParameters = Type.Object({
  questions: Type.Array(
    Type.Object({
      question: Type.String({
        minLength: 1,
        description:
          'The complete question, ending with a question mark — e.g. "Which database should the project use?"',
      }),
      header: Type.String({
        minLength: 1,
        maxLength: 12,
        description: 'A very short label for the question, shown as its tab — e.g. "Database". At most 12 characters.',
      }),
      options: Type.Array(
        Type.Object({
          label: Type.String({ minLength: 1, description: 'The choice, in one to five words.' }),
          description: Type.String({ description: 'What choosing it means — its trade-off or consequence.' }),
        }),
        {
          minItems: 2,
          maxItems: 4,
          description: 'Two to four distinct choices. Do not add an "Other" option: one is always offered.',
        },
      ),
      multiSelect: Type.Boolean({ description: 'True when the user may choose several options.' }),
    }),
    { minItems: 1, maxItems: 4, description: 'One to four questions, asked together.' },
  ),
})
/** @group Dialogs */
export type AskUserToolParameters = Static<typeof AskUserToolParameters>
