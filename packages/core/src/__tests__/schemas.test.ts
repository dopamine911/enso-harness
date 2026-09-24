import { expect, test } from 'bun:test'
import { Check } from 'typebox/value'
import {
  type EnsoDialogSpec,
  EnsoObservation,
  EnsoToolResultDescriptor,
  EnsoUsage,
  isEnsoToolResultDescriptor,
  PromptImageContent,
  validateDialogAnswer,
} from '../index.ts'

/**
 * These prove the TypeBox conversion bought RUNTIME VALIDATION and a JSON Schema, not just
 * types. Without them the schemas would be decorative — the "built claims need a caller"
 * failure, applied to a refactor of my own.
 */

// --- the schemas really are JSON Schema objects, which is the reason for choosing TypeBox
test('a schema is literally a JSON Schema object', () => {
  expect(EnsoToolResultDescriptor).toMatchObject({ type: 'object' })
  expect(EnsoToolResultDescriptor.required).toContain('kind')
  expect(EnsoToolResultDescriptor.required).toContain('props')
  // optional fields are absent from `required`, which is what an OpenAPI consumer reads
  expect(EnsoToolResultDescriptor.required).not.toContain('truncated')
})

test('the observation union is expressed as a JSON Schema union', () => expect(EnsoObservation).toHaveProperty('anyOf'))

// --- and the validators actually reject
test('the descriptor validator rejects every malformed shape', () => {
  expect(isEnsoToolResultDescriptor({ kind: 'diff', props: {} })).toBe(true)
  expect(isEnsoToolResultDescriptor({ kind: '', props: {} })).toBe(false)
  expect(isEnsoToolResultDescriptor({ kind: 'diff' })).toBe(false)
  expect(isEnsoToolResultDescriptor({ props: {} })).toBe(false)
  expect(isEnsoToolResultDescriptor('diff')).toBe(false)
  expect(isEnsoToolResultDescriptor(null)).toBe(false)
})

test('a negative truncation count is rejected, not silently rendered', () =>
  expect(isEnsoToolResultDescriptor({ kind: 'd', props: {}, truncated: { shown: -1, total: 5, unit: 'lines' } })).toBe(
    false,
  ))

test('an unknown truncation unit is rejected by the schema', () =>
  expect(
    isEnsoToolResultDescriptor({ kind: 'd', props: {}, truncated: { shown: 1, total: 5, unit: 'furlongs' } }),
  ).toBe(false))

test('usage rejects non-integer token counts', () => {
  expect(Check(EnsoUsage, { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 })).toBe(true)
  expect(Check(EnsoUsage, { input: 1.5, output: 2, cacheRead: 0, cacheWrite: 0 })).toBe(false)
  expect(Check(EnsoUsage, { input: 1, output: 2 })).toBe(false)
})

// --- pi wire schemas
test('image content is validated, so a malformed attachment fails at the boundary', () => {
  expect(Check(PromptImageContent, { type: 'image', data: 'aGk=', mimeType: 'image/png' })).toBe(true)
  expect(Check(PromptImageContent, { type: 'file', data: 'aGk=', mimeType: 'image/png' })).toBe(false)
  expect(Check(PromptImageContent, { type: 'image', data: 'aGk=' })).toBe(false)
})

// ── `validateDialogAnswer`: "an injection seam, closed HERE" (dialog.ts) — every refusal branch ──
// Three of its four refusals had never executed in a test (#162 exit criteria). A validator that
// let a `confirmed` through to a `select`, or an arbitrary object through as an answer, would put
// a string the extension never offered into its control flow; each row below is one such bug.
test('validateDialogAnswer refuses every answer shape a dialog did not ask for, and names the shape it wanted', () => {
  const select: EnsoDialogSpec = { method: 'select', title: 'Pick', options: ['a', 'b'] }
  const confirm: EnsoDialogSpec = { method: 'confirm', title: 'Apply?', message: 'm' }
  const input: EnsoDialogSpec = { method: 'input', title: 'Name?' }
  const editor: EnsoDialogSpec = { method: 'editor', title: 'Edit' }
  // not an answer at all
  expect(validateDialogAnswer(select, { anything: 1 })).toContain('not a dialog answer')
  expect(validateDialogAnswer(select, 'a')).toContain('not a dialog answer')
  expect(validateDialogAnswer(select, { value: 1 })).toContain('not a dialog answer')
  // the wrong answer shape for the method
  expect(validateDialogAnswer(select, { confirmed: true })).toContain("'select' dialog takes { value: string }")
  expect(validateDialogAnswer(confirm, { value: 'yes' })).toContain("'confirm' dialog takes { confirmed: boolean }")
  expect(validateDialogAnswer(input, { confirmed: true })).toContain("'input' dialog takes { value: string }")
  expect(validateDialogAnswer(editor, { confirmed: false })).toContain("'editor' dialog takes { value: string }")
  // the right shape with a value the dialog never offered
  expect(validateDialogAnswer(select, { value: 'c' })).toContain("'c' is not one of the offered options")
  // and the answers that are exactly what was asked
  expect(validateDialogAnswer(select, { value: 'b' })).toBeUndefined()
  expect(validateDialogAnswer(confirm, { confirmed: false })).toBeUndefined()
  expect(validateDialogAnswer(input, { value: '' })).toBeUndefined()
  expect(validateDialogAnswer(editor, { value: 'text' })).toBeUndefined()
})

// The questionnaire's answers go back to the asking tool, which reads the labels as the user's
// choice — so each row is a way a bad answer would reach the model as something the user said.
test('validateDialogAnswer holds a questionnaire answer to what each question offered and allows', () => {
  const questionnaire: EnsoDialogSpec = {
    method: 'questionnaire',
    title: 'Two questions',
    questions: [
      {
        header: 'Database',
        question: 'Which database?',
        options: [{ label: 'Postgres' }, { label: 'SQLite' }],
        multiSelect: false,
      },
      {
        header: 'Checks',
        question: 'Which checks?',
        options: [{ label: 'lint' }, { label: 'tests' }],
        multiSelect: true,
      },
    ],
  }
  const refusal = (answers: unknown): string | undefined => validateDialogAnswer(questionnaire, { answers })
  // the answer shape a questionnaire does not take, and the questionnaire shape another kind does not
  expect(validateDialogAnswer(questionnaire, { value: 'Postgres' })).toContain("'questionnaire' dialog takes { answers")
  expect(validateDialogAnswer({ method: 'input', title: 'Name?' }, { answers: [] })).toContain(
    'takes { value: string }',
  )
  // one answer per question, in order
  expect(refusal([{ selected: ['Postgres'] }])).toBe('1 answers for 2 questions')
  // a label the question never offered, or one named twice
  expect(refusal([{ selected: ['MySQL'] }, { selected: ['lint'] }])).toContain(
    "'MySQL' is not one of question 1's options",
  )
  expect(refusal([{ selected: ['Postgres'] }, { selected: ['lint', 'lint'] }])).toContain('names an option twice')
  // unanswered, over-answered, or a blank "Other"
  expect(refusal([{ selected: [] }, { selected: ['lint'] }])).toBe('question 1 is unanswered')
  expect(refusal([{ selected: ['Postgres'], other: 'DuckDB' }, { selected: ['lint'] }])).toContain(
    'takes one answer, got 2',
  )
  expect(refusal([{ selected: [], other: '  ' }, { selected: ['lint'] }])).toContain('other answer is blank')
  // and the answers that are exactly what was asked: a pick or "Other" for the single, several for the multi
  expect(refusal([{ selected: ['SQLite'] }, { selected: ['lint', 'tests'], other: 'e2e' }])).toBeUndefined()
  expect(refusal([{ selected: [], other: 'DuckDB' }, { selected: ['tests'] }])).toBeUndefined()
})
