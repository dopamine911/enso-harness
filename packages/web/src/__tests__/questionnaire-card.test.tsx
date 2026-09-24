import { afterAll, expect, test } from 'bun:test'
import type { EnsoDialogSpec, EnsoQuestionAnswer } from '@enso/core'
import { act } from 'react'
import type { createRoot as CreateRoot, Root } from 'react-dom/client'
import type * as QuestionnaireCardModule from '../questionnaire-card.tsx'
import { ensureDom, releaseDom } from './dom-environment.ts'

/**
 * The `ask_user` card (#12), mounted: what it sends is what the server holds to the question and
 * the tool reads back as the user's words — one answer per question, in order — and it sends
 * nothing until every question has one.
 */

// ⚠ A DOM before react-dom/client and Radix evaluate.
ensureDom()
const { createRoot }: { createRoot: typeof CreateRoot } = await import('react-dom/client')
const { QuestionnaireControls }: typeof QuestionnaireCardModule = await import('../questionnaire-card.tsx')
afterAll(releaseDom)

type Questionnaire = Extract<EnsoDialogSpec, { method: 'questionnaire' }>

const DATABASE_QUESTION: Questionnaire['questions'][number] = {
  header: 'Database',
  question: 'Which database?',
  options: [
    { label: 'Postgres', description: 'relational server' },
    { label: 'SQLite', description: 'a single file' },
  ],
  multiSelect: false,
}

const TWO_QUESTIONS: Questionnaire = {
  method: 'questionnaire',
  title: '2 questions',
  questions: [
    DATABASE_QUESTION,
    {
      header: 'Checks',
      question: 'Which checks?',
      options: [{ label: 'lint' }, { label: 'types' }, { label: 'tests' }],
      multiSelect: true,
    },
  ],
}

const flush = (work: () => Promise<void> | void): Promise<void> => act(async () => work())

/** The card mounted, and every answer it sends. */
async function mounted(
  dialog: Questionnaire,
): Promise<{ sent: EnsoQuestionAnswer[][]; root: Root; container: HTMLElement }> {
  const sent: EnsoQuestionAnswer[][] = []
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await flush(() =>
    root.render(
      <QuestionnaireControls
        dialog={dialog}
        answer={({ answers }: { answers: EnsoQuestionAnswer[] }): void => {
          sent.push(answers)
        }}
        disabled={false}
      />,
    ),
  )
  return { sent, root, container }
}

/** The control a row's label names — found as a user finds it, by the words on the row. */
function control(container: HTMLElement, label: string): HTMLElement {
  const row = [...container.querySelectorAll('label')].find((each) => each.textContent?.startsWith(label))
  const target = row === undefined ? null : container.querySelector<HTMLElement>(`[id="${row.htmlFor}"]`)
  if (target === null) throw new Error(`no control labelled ${label}: ${container.textContent}`)
  return target
}

function submit(container: HTMLElement): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find((each) => each.textContent === 'Submit answers')
  if (button === undefined) throw new Error('no Submit answers button')
  return button
}

/** Type into the "Other" field the way React hears it: the native setter, then an input event. */
async function typeOther(container: HTMLElement, text: string): Promise<void> {
  const field = container.querySelector<HTMLInputElement>('input[aria-label="your own answer"]')
  if (field === null) throw new Error('no Other field')
  await flush(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, text)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

test('Submit sends one answer per question — a pick, then several choices and the user’s own words — and not before every question has one', async () => {
  const { sent, root, container } = await mounted(TWO_QUESTIONS)
  expect(submit(container).disabled).toBe(true)
  expect(container.textContent).toContain('2 questions still to answer')

  // Picking an option answers the first question and moves the card on to the second.
  await flush(() => control(container, 'Postgres').click())
  expect(container.textContent).toContain('Which checks?')
  expect(submit(container).disabled).toBe(true)

  await flush(() => control(container, 'lint').click())
  await flush(() => control(container, 'tests').click())
  await flush(() => control(container, 'Other').click())
  await typeOther(container, '  e2e ')
  expect(submit(container).disabled).toBe(false)

  await flush(() => submit(container).click())
  expect(sent).toEqual([[{ selected: ['Postgres'] }, { selected: ['lint', 'tests'], other: 'e2e' }]])
  await flush(() => root.unmount())
  container.remove()
})

test('"Other" answers a question only once it has words in it', async () => {
  const { sent, root, container } = await mounted({ ...TWO_QUESTIONS, questions: [DATABASE_QUESTION] })
  await flush(() => control(container, 'Other').click())
  expect(submit(container).disabled).toBe(true)
  await typeOther(container, '   ')
  expect(submit(container).disabled).toBe(true)
  await typeOther(container, 'DuckDB')
  await flush(() => submit(container).click())
  expect(sent).toEqual([[{ selected: [], other: 'DuckDB' }]])
  await flush(() => root.unmount())
  container.remove()
})
