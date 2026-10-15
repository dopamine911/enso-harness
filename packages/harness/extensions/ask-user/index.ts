import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
  ExtensionUIDialogOptions,
} from '@earendil-works/pi-coding-agent'
import {
  ASK_USER_TOOL_NAME,
  AskUserToolParameters,
  ENSO_QUESTIONNAIRE_ANSWERS_KIND,
  ENSO_TOOL_RESULT_KEY,
  type EnsoToolResultDescriptor,
  type EnsoQuestion,
  type EnsoQuestionAnswer,
  type EnsoQuestionnaireResult,
  QUESTIONNAIRE_COMPONENT_KEY,
  questionnaireRepeat,
} from '@enso/core'

/**
 * The agent's `ask_user` tool (#12): the model asks the user one to four questions, and the
 * answers come back as the tool's result. It replaces the adopted `@d3ara1n/pi-ask-user`, whose
 * web path asked each question as a plain `select` and could not cancel a multi-choice one.
 *
 * TWO WAYS TO ASK, by what the surface can show:
 *
 *   1. ONE CARD — outside a terminal, the tool hands `custom` a component carrying the whole
 *      questionnaire under `QUESTIONNAIRE_COMPONENT_KEY`. The Enso host lifts it to a
 *      `questionnaire` dialog (`packages/web/src/host/questionnaire-dialog.ts`), the web card
 *      asks every question at once, and the result is the answers or a real decline.
 *   2. ONE PROMPT AT A TIME — in the terminal, or where `custom` resolves `undefined` (pi's own
 *      rpc mode, a host that cannot lift it): plain `select`/`input` prompts, which every surface
 *      renders. A multi-choice question is a toggle list closed by "Done", so dismissing a prompt
 *      is always a decline, never a silent "none of these".
 *
 * With no user interface at all (`--print`), nothing is asked and the result says so.
 */

/** The prompt row that opens a free-text answer. */
export const OTHER_ROW = '✎ Other — type an answer'
/** The prompt row that closes a multi-choice question. */
export const DONE_ROW = '✓ Done'

/** The questionnaire, as the component carries it for the host to lift. */
interface CarriedQuestionnaire {
  readonly title: string
  readonly questions: EnsoQuestion[]
}

/**
 * What the tool hands `custom`. A terminal would draw it, but the tool never shows it in one —
 * it carries the questionnaire for a host that can ask it as one card.
 */
class QuestionnaireComponent {
  readonly [QUESTIONNAIRE_COMPONENT_KEY]: CarriedQuestionnaire
  constructor(carried: CarriedQuestionnaire) {
    this[QUESTIONNAIRE_COMPONENT_KEY] = carried
  }
  render(): string[] {
    return [this[QUESTIONNAIRE_COMPONENT_KEY].title]
  }
  invalidate(): void {
    // Nothing is cached: the one line is the title.
  }
}

/** A row as a prompt shows it: the label, and what choosing it means. */
function optionRow(option: EnsoQuestion['options'][number]): string {
  return option.description === undefined || option.description.length === 0
    ? option.label
    : `${option.label} — ${option.description}`
}

/** The prompt title: the question, after its short header. */
function promptTitle(question: EnsoQuestion): string {
  return `${question.header} — ${question.question}`
}

async function askSingle(
  ui: ExtensionUIContext,
  question: EnsoQuestion,
  dialogOptions: ExtensionUIDialogOptions | undefined,
): Promise<EnsoQuestionAnswer | undefined> {
  const rows = question.options.map(optionRow)
  for (;;) {
    const picked = await ui.select(promptTitle(question), [...rows, OTHER_ROW], dialogOptions)
    if (picked === undefined) return undefined
    if (picked === OTHER_ROW) {
      const text = (await ui.input(question.question, 'Type your answer', dialogOptions))?.trim()
      if (text !== undefined && text.length > 0) return { selected: [], other: text }
      continue
    }
    const option = question.options[rows.indexOf(picked)]
    if (option !== undefined) return { selected: [option.label] }
  }
}

/** A multi-choice question while it is being answered: what is ticked, and any free text. */
interface MultiDraft {
  readonly chosen: Set<string>
  other: string | undefined
}

/** The rows a multi-choice prompt offers now: each option ticked or not, "Other", "Done". */
function multiRows(question: EnsoQuestion, draft: MultiDraft): string[] {
  const rows = question.options.map((option) => `${draft.chosen.has(option.label) ? '☑' : '☐'} ${optionRow(option)}`)
  return [...rows, draft.other === undefined ? OTHER_ROW : `${OTHER_ROW}: ${draft.other}`, DONE_ROW]
}

/** The draft as an answer, once something is chosen — `undefined` while nothing is. */
function multiAnswer(question: EnsoQuestion, draft: MultiDraft): EnsoQuestionAnswer | undefined {
  if (draft.chosen.size === 0 && draft.other === undefined) return undefined
  const selected = question.options.map((option) => option.label).filter((label) => draft.chosen.has(label))
  return draft.other === undefined ? { selected } : { selected, other: draft.other }
}

/**
 * Apply one pick to the draft: ticking or unticking an option, or asking for the free text.
 * Returns the finished answer when the pick was "Done" with something chosen.
 */
async function applyMultiPick(
  pick: { question: EnsoQuestion; draft: MultiDraft; picked: string; index: number },
  ui: ExtensionUIContext,
  dialogOptions: ExtensionUIDialogOptions | undefined,
): Promise<EnsoQuestionAnswer | undefined> {
  const { question, draft, picked, index } = pick
  if (picked === DONE_ROW) return multiAnswer(question, draft)
  if (index === question.options.length) {
    const text = await ui.input(question.question, draft.other ?? 'Type your answer', dialogOptions)
    if (text !== undefined) draft.other = text.trim().length > 0 ? text.trim() : undefined
    return undefined
  }
  const label = question.options[index]?.label
  if (label !== undefined && !draft.chosen.delete(label)) draft.chosen.add(label)
  return undefined
}

async function askMulti(
  ui: ExtensionUIContext,
  question: EnsoQuestion,
  dialogOptions: ExtensionUIDialogOptions | undefined,
): Promise<EnsoQuestionAnswer | undefined> {
  const draft: MultiDraft = { chosen: new Set(), other: undefined }
  const title = `${promptTitle(question)} (choose any, then ${DONE_ROW})`
  for (;;) {
    const rows = multiRows(question, draft)
    const picked = await ui.select(title, rows, dialogOptions)
    if (picked === undefined) return undefined
    const answer = await applyMultiPick({ question, draft, picked, index: rows.indexOf(picked) }, ui, dialogOptions)
    if (answer !== undefined) return answer
  }
}

/** Ask each question as plain prompts. Any dismissed prompt declines the whole questionnaire. */
export async function askOneAtATime(
  ui: ExtensionUIContext,
  questions: readonly EnsoQuestion[],
  signal: AbortSignal | undefined,
): Promise<EnsoQuestionnaireResult> {
  const dialogOptions = signal === undefined ? undefined : { signal }
  const answers: EnsoQuestionAnswer[] = []
  for (const question of questions) {
    const answer = question.multiSelect
      ? await askMulti(ui, question, dialogOptions)
      : await askSingle(ui, question, dialogOptions)
    if (answer === undefined) return { cancelled: true }
    answers.push(answer)
  }
  return { answers }
}

/** How one answer reads to the model. */
function answerText(answer: EnsoQuestionAnswer | undefined): string {
  const parts = [...(answer?.selected ?? [])]
  if (answer?.other !== undefined) parts.push(`in their own words: "${answer.other}"`)
  return parts.join(', ')
}

/** What the model reads back: the user's answers in plain words, or that they gave none. */
export function toolResultText(questions: readonly EnsoQuestion[], result: EnsoQuestionnaireResult | 'no-ui'): string {
  if (result === 'no-ui') return 'Nothing was asked: this session has no interactive user who could answer.'
  if ('cancelled' in result) return 'The user declined to answer and chose nothing.'
  const lines = questions.map((question, index) => `- ${question.question} → ${answerText(result.answers[index])}`)
  return ['The user answered:', ...lines].join('\n')
}

/**
 * The result's `details` (#920): the questions and the answers as a #18 descriptor, so the card shows
 * question → chosen answer instead of the model's arguments; the host lifts it as the tool emitted it.
 */
interface AnswersDetails {
  readonly [ENSO_TOOL_RESULT_KEY]: EnsoToolResultDescriptor
}

/**
 * ⚠ AN UNANSWERED QUESTION ENDS THE TURN (#379, #465): a decline is the user's "no", and a session
 * with no one to answer cannot grant what was asked — either way the user decides what's next, so
 * the model gets no turn to pick for them or to route around the question. pi ends the run once
 * every call of the batch set `terminate`; an ask_user batched with other tools does not end it.
 */
function textResult(
  text: string,
  questions: EnsoQuestion[],
  result: EnsoQuestionnaireResult | 'no-ui',
): AgentToolResult<AnswersDetails> {
  const answers = result !== 'no-ui' && 'answers' in result ? { answers: result.answers } : {}
  const details = {
    [ENSO_TOOL_RESULT_KEY]: { kind: ENSO_QUESTIONNAIRE_ANSWERS_KIND, props: { questions, ...answers } },
  }
  return result === 'no-ui' || 'cancelled' in result
    ? { content: [{ type: 'text', text }], details, terminate: true }
    : { content: [{ type: 'text', text }], details }
}

/** The title a one-card questionnaire carries: its question when alone, its count otherwise. */
function questionnaireTitle(questions: readonly EnsoQuestion[]): string {
  const [only] = questions
  return questions.length === 1 && only !== undefined ? only.question : `${questions.length} questions`
}

/** pi's five positional execute arguments, named as a tuple — the gate caps declared parameters at four. */
type AskUserExecuteArguments = [
  toolCallId: string,
  params: AskUserToolParameters,
  signal: AbortSignal | undefined,
  onUpdate: unknown,
  extensionContext: ExtensionContext,
]

async function execute(...executeArguments: AskUserExecuteArguments): Promise<AgentToolResult<AnswersDetails>> {
  const [, params, signal, , extensionContext] = executeArguments
  const questions: EnsoQuestion[] = params.questions
  // Refused before anything is asked: a repeated header or label cannot be told apart by the card,
  // a prompt, or the answer. Thrown, so pi marks the result an error the model can correct.
  const repeated = questionnaireRepeat(questions)
  if (repeated !== undefined) {
    throw new Error(
      repeated.kind === 'header'
        ? `Nothing was asked: question ${repeated.question} repeats the header "${repeated.header}". ` +
            'Give every question its own short header, and ask again.'
        : `Nothing was asked: question ${repeated.question} lists the option "${repeated.label}" twice. ` +
            'Give every option in a question a distinct label, and ask again.',
    )
  }
  if (!extensionContext.hasUI) return textResult(toolResultText(questions, 'no-ui'), questions, 'no-ui')
  const asCard =
    extensionContext.mode === 'tui'
      ? undefined
      : await extensionContext.ui.custom<EnsoQuestionnaireResult | undefined>(
          () => new QuestionnaireComponent({ title: questionnaireTitle(questions), questions }),
        )
  const result = asCard ?? (await askOneAtATime(extensionContext.ui, questions, signal))
  return textResult(toolResultText(questions, result), questions, result)
}

export default function askUser(pi: ExtensionAPI): void {
  pi.registerTool({
    name: ASK_USER_TOOL_NAME,
    label: 'Ask user',
    description:
      'Ask the user one to four questions when you need their decision to go on — to clarify an ' +
      'ambiguous request, choose between approaches, or confirm a consequential step. Each question ' +
      'offers two to four options with a short description; the user may always answer in their own ' +
      'words instead, so never add an "Other" option. Put a recommended option first and say so in its ' +
      'label. The result is the user’s answers in plain words, or that they declined.',
    promptSnippet: `${ASK_USER_TOOL_NAME}: ask the user questions and wait for their answers`,
    parameters: AskUserToolParameters,
    execute,
  })
}
