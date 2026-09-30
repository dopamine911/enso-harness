import { expect, test } from 'bun:test'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import {
  ASK_USER_TOOL_NAME,
  type EnsoQuestion,
  type EnsoQuestionnaireResult,
  QUESTIONNAIRE_COMPONENT_KEY,
} from '@enso/core'
import askUser, { DONE_ROW, OTHER_ROW } from '../index.ts'

/**
 * The ask_user extension (#12) against a scripted UI: which way it asks on which surface, and what
 * the plain-prompt path does with each answer — the path every surface can render, and the one a
 * terminal user answers with the keyboard.
 */

interface CapturedTool {
  name: string
  /** pi's five positional execute arguments, named as a tuple — the gate caps declared parameters at four. */
  execute: (
    ...executeArguments: [
      toolCallId: string,
      params: { questions: EnsoQuestion[] },
      signal: AbortSignal | undefined,
      onUpdate: undefined,
      extensionContext: unknown,
    ]
  ) => Promise<{ content: { type: string; text: string }[]; terminate?: boolean }>
}

function loadTool(): CapturedTool {
  let captured: CapturedTool | undefined
  askUser({ registerTool: (tool: CapturedTool) => (captured = tool) } as unknown as ExtensionAPI)
  if (captured === undefined) throw new Error('no tool registered')
  return captured
}

const DATABASE: EnsoQuestion = {
  header: 'Database',
  question: 'Which database?',
  options: [
    { label: 'Postgres', description: 'relational server' },
    { label: 'SQLite', description: 'a single file' },
  ],
  multiSelect: false,
}
const CHECKS: EnsoQuestion = {
  header: 'Checks',
  question: 'Which checks?',
  options: [
    { label: 'lint', description: 'style' },
    { label: 'tests', description: 'behaviour' },
  ],
  multiSelect: true,
}

/** A UI whose prompts answer from a script, recording what was asked. */
function scriptedContext(options: {
  mode: 'tui' | 'rpc' | 'print'
  hasUI?: boolean
  card?: EnsoQuestionnaireResult | undefined
  answers?: (string | undefined)[]
}): { context: unknown; asked: string[]; cards: unknown[] } {
  const asked: string[] = []
  const cards: unknown[] = []
  const script = [...(options.answers ?? [])]
  const next = (kind: string, title: string): Promise<string | undefined> => {
    asked.push(`${kind}: ${title}`)
    return Promise.resolve(script.shift())
  }
  const ui = {
    select: (title: string): Promise<string | undefined> => next('select', title),
    input: (title: string): Promise<string | undefined> => next('input', title),
    custom: (factory: () => unknown): Promise<EnsoQuestionnaireResult | undefined> => {
      cards.push(factory())
      return Promise.resolve(options.card)
    },
  }
  return { context: { mode: options.mode, hasUI: options.hasUI ?? true, ui }, asked, cards }
}

async function runResult(
  questions: EnsoQuestion[],
  context: unknown,
): Promise<{ text: string; terminate: boolean | undefined }> {
  const result = await loadTool().execute('call-1', { questions }, undefined, undefined, context)
  return { text: result.content.map((part) => part.text).join(''), terminate: result.terminate }
}

async function run(questions: EnsoQuestion[], context: unknown): Promise<string> {
  return (await runResult(questions, context)).text
}

test('outside a terminal it asks as ONE card carrying the whole questionnaire, and reads the answers back in plain words', async () => {
  const scripted = scriptedContext({
    mode: 'rpc',
    card: { answers: [{ selected: ['SQLite'] }, { selected: ['lint', 'tests'], other: 'e2e' }] },
  })
  const text = await run([DATABASE, CHECKS], scripted.context)
  expect(loadTool().name).toBe(ASK_USER_TOOL_NAME)
  expect(scripted.asked).toEqual([])
  expect((scripted.cards[0] as Record<symbol, unknown>)[QUESTIONNAIRE_COMPONENT_KEY]).toEqual({
    title: '2 questions',
    questions: [DATABASE, CHECKS],
  })
  expect(text).toBe(
    [
      'The user answered:',
      '- Which database? → SQLite',
      '- Which checks? → lint, tests, in their own words: "e2e"',
    ].join('\n'),
  )
})

// ⚠ #379, #465: an unanswered question ends the turn — the user's "no" is a stop, not a cue for
// the model to pick for them or to route around the question. An answer carries the run on.
test('a declined card is a decline, not "none of these", and it ends the turn', async () => {
  const scripted = scriptedContext({ mode: 'rpc', card: { cancelled: true } })
  expect(await runResult([DATABASE], scripted.context)).toEqual({
    text: 'The user declined to answer and chose nothing.',
    terminate: true,
  })
  expect(scripted.asked).toEqual([])
  const answered = scriptedContext({ mode: 'rpc', card: { answers: [{ selected: ['SQLite'] }] } })
  expect((await runResult([DATABASE], answered.context)).terminate).toBeUndefined()
})

// pi's own rpc mode resolves `custom` to `undefined` (it cannot show a component); the terminal
// is never handed the card at all. Both fall back to plain prompts, which every surface renders.
test('where the card cannot be shown, and in a terminal, it asks one plain prompt at a time', async () => {
  const unlifted = scriptedContext({ mode: 'rpc', card: undefined, answers: ['SQLite — a single file'] })
  expect(await run([DATABASE], unlifted.context)).toBe('The user answered:\n- Which database? → SQLite')
  expect(unlifted.cards).toHaveLength(1)
  const terminal = scriptedContext({ mode: 'tui', answers: ['Postgres — relational server'] })
  expect(await run([DATABASE], terminal.context)).toBe('The user answered:\n- Which database? → Postgres')
  expect(terminal.cards).toEqual([])
  expect(terminal.asked).toEqual(['select: Database — Which database?'])
})

test('with no one to ask, nothing is asked, the model is told so, and the turn ends', async () => {
  const scripted = scriptedContext({ mode: 'print', hasUI: false })
  const result = await runResult([DATABASE], scripted.context)
  expect(result.text).toContain('Nothing was asked')
  expect(result.terminate).toBe(true)
  expect(scripted.asked).toEqual([])
  expect(scripted.cards).toEqual([])
})

test('plain prompts: "Other" takes words, a multi-choice list toggles and needs one pick before Done', async () => {
  const scripted = scriptedContext({
    mode: 'tui',
    answers: [
      OTHER_ROW,
      '  ', // a blank answer is no answer: back to the list
      OTHER_ROW,
      'DuckDB',
      DONE_ROW, // nothing chosen yet: Done does not finish
      '☐ lint — style',
      '☐ tests — behaviour',
      '☑ lint — style', // ticked again: unticked
      DONE_ROW,
    ],
  })
  expect(await run([DATABASE, CHECKS], scripted.context)).toBe(
    ['The user answered:', '- Which database? → in their own words: "DuckDB"', '- Which checks? → tests'].join('\n'),
  )
})

test('plain prompts: dismissing any prompt declines the whole questionnaire, even mid-way through a multi-choice list', async () => {
  const scripted = scriptedContext({ mode: 'tui', answers: ['SQLite — a single file', '☐ lint — style', undefined] })
  expect(await run([DATABASE, CHECKS], scripted.context)).toBe('The user declined to answer and chose nothing.')
})

test('a repeated label or header is refused before anything is asked, naming what to fix', async () => {
  const scripted = scriptedContext({ mode: 'rpc', card: { answers: [] } })
  const twice: EnsoQuestion = { ...DATABASE, options: [...DATABASE.options, { label: 'SQLite', description: 'again' }] }
  await expect(run([CHECKS, twice], scripted.context)).rejects.toThrow('question 2 lists the option "SQLite" twice')
  await expect(run([DATABASE, { ...CHECKS, header: 'Database' }], scripted.context)).rejects.toThrow(
    'question 2 repeats the header "Database"',
  )
  expect(scripted.cards).toEqual([])
  expect(scripted.asked).toEqual([])
})
