import {
  ENSO_IMAGES_KIND,
  ENSO_QUESTIONNAIRE_ANSWERS_KIND,
  ENSO_WRITE_RECEIPT_KIND,
  type EnsoQuestionAnswer,
  type EnsoQuestion,
  isEnsoImagesProps,
  isEnsoQuestionnaireAnswersProps,
  isEnsoWriteReceiptProps,
} from '@enso/core'
import { CheckIcon } from 'lucide-react'
import { createContext, useContext } from 'react'
import { keyedByPlace } from './context-browser.tsx'
import type { EnsoRendererMap, ToolTextView } from './EnsoToolResult.tsx'
import { cn } from './lib/utils.ts'

/**
 * Each tool's card as a person reads it (#920): the call's arguments and its result in the tool's own
 * terms — `bash` as the command, `edit` as the change, `ask_user` as question → answer — instead of
 * the model's JSON. The raw JSON stays one click away on the row (`selected-message-part.tsx`).
 *
 * ⚠ MODEL-CONTROLLED, SO TEXT ONLY. Every argument and every result here is written by the model or
 * a tool it drove: each is a React text node — no HTML, no markdown, no link built from it, no `img`
 * from a URL it chose. The one image is bytes a tool itself returned (`enso.images`), as a `data:`
 * URL of an `image/*` type.
 */

/** Opens the Diff view at one file (#920: a `write` card's link) — provided by the views' box. */
export const OpenInDiffContext = createContext<((path: string) => void) | undefined>(undefined)

const PRE = 'max-h-60 overflow-y-auto break-words whitespace-pre-wrap'
const LABEL = 'rounded-xs border px-1.5 text-detail text-muted-foreground'

/** A string argument, if the input has one under `key`. */
function stringAt(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key]
  return typeof value === 'string' ? value : undefined
}

/** A number argument, if the input has one under `key` — `null` (bash's unset timeout) is none. */
function numberAt(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key]
  return typeof value === 'number' ? value : undefined
}

/** Text behind a fold: its one-line `label` shown, the text a click away. */
function Folded({ label, text }: { label: React.ReactNode; text: string }): React.ReactNode {
  return (
    <details className="group/fold">
      <summary className="cursor-pointer list-none text-muted-foreground marker:hidden">
        <span aria-hidden="true" className="mr-1 inline-block transition-transform group-open/fold:rotate-90">
          ›
        </span>
        {label}
      </summary>
      <pre className={cn(PRE, 'mt-1')}>{text}</pre>
    </details>
  )
}

/** How many lines a text has, not counting the newline that ends its last. */
function lineCount(text: string): number {
  if (text.length === 0) return 0
  return text.replace(/\n$/, '').split('\n').length
}

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`

/** The exit code pi's bash appends to a failed command's output — `Command exited with code 1`. */
export function bashExitCode(text: string): number | undefined {
  const match = /(?:^|\n)Command exited with code (\d+)$/.exec(text)
  return match?.[1] === undefined ? undefined : Number(match[1])
}

/** A read's range, as the call asked it: `lines 10–29`, `from line 10`, `first 20 lines`. */
function readRange(input: Record<string, unknown>): string | undefined {
  const offset = numberAt(input, 'offset')
  const limit = numberAt(input, 'limit')
  if (offset !== undefined && limit !== undefined) return `lines ${offset}–${offset + limit - 1}`
  if (offset !== undefined) return `from line ${offset}`
  if (limit !== undefined) return `first ${plural(limit, 'line', 'lines')}`
  return undefined
}

/** One `edit` replacement as old lines over new ones, in the Diff view's colours and markers. */
function EditChange({ oldText, newText }: { oldText: string; newText: string }): React.ReactNode {
  const lines = [
    ...keyedByPlace(oldText.split('\n'), 'old').map((placed) => ({ ...placed, tone: 'bg-refuse/15', marker: '−' })),
    ...keyedByPlace(newText.split('\n'), 'new').map((placed) => ({ ...placed, tone: 'bg-ok/15', marker: '+' })),
  ]
  return (
    <div className="overflow-x-auto rounded-xs border">
      {lines.map(({ item: line, slot, tone, marker }) => (
        <div key={slot} className={cn(tone, 'px-2 break-all whitespace-pre-wrap')}>
          <span aria-hidden="true" className="select-none">
            {marker}{' '}
          </span>
          {line}
        </div>
      ))}
    </div>
  )
}

/** The `edits` an edit call carries, the ones shaped `{ oldText, newText }`. */
function editsOf(input: Record<string, unknown>): { oldText: string; newText: string }[] {
  const edits = input['edits']
  if (!Array.isArray(edits)) return []
  return edits.flatMap((edit: { oldText?: unknown; newText?: unknown } | null) =>
    typeof edit?.oldText === 'string' && typeof edit.newText === 'string'
      ? [{ oldText: edit.oldText, newText: edit.newText }]
      : [],
  )
}

/** A value of an unknown tool's arguments, as text: nested objects and arrays indented beneath their key. */
function ValueList({ value }: { value: unknown }): React.ReactNode {
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-muted-foreground">(none)</span>
    return (
      <ol className="border-l pl-3">
        {keyedByPlace(value, 'item').map(({ item: element, slot }, position) => (
          <li key={slot} className="flex gap-2">
            <span className="text-muted-foreground select-none">{position + 1}.</span>
            <div className="min-w-0 flex-1">
              <ValueList value={element} />
            </div>
          </li>
        ))}
      </ol>
    )
  }
  if (typeof value === 'object' && value !== null) return <KeyValues record={value as Record<string, unknown>} />
  if (typeof value === 'string') return <span className="break-words whitespace-pre-wrap">{value}</span>
  return <span className="text-muted-foreground">{value === undefined ? '(unset)' : JSON.stringify(value)}</span>
}

/** An object as `key: value` rows, the value beside its key or indented beneath it when it nests. */
function KeyValues({ record }: { record: Record<string, unknown> }): React.ReactNode {
  const entries = Object.entries(record)
  if (entries.length === 0) return <span className="text-muted-foreground">(no arguments)</span>
  return (
    <dl data-enso-tool-input="key-values" className="flex flex-col gap-1">
      {entries.map(([key, value]) => {
        const nests = typeof value === 'object' && value !== null
        return (
          <div key={key} className={nests ? 'flex flex-col gap-1' : 'flex gap-2'}>
            <dt className="shrink-0 font-semibold">{key}:</dt>
            <dd className={cn('min-w-0', nests && 'pl-3')}>
              <ValueList value={value} />
            </dd>
          </div>
        )
      })}
    </dl>
  )
}

/** The `write` card's way to the Diff view, at the file it wrote — only where a Diff view exists. */
function OpenInDiff({ path }: { path: string }): React.ReactNode {
  const open = useContext(OpenInDiffContext)
  if (open === undefined) return null
  return (
    <button
      type="button"
      onClick={() => open(path)}
      className="text-detail text-muted-foreground underline underline-offset-2 hover:text-foreground"
    >
      open in Diff
    </button>
  )
}

/** A path with its labels on one line. */
function PathLine({ path, children }: { path: string; children?: React.ReactNode }): React.ReactNode {
  return (
    <p className="flex flex-wrap items-baseline gap-2">
      <span className="break-all text-foreground">{path}</span>
      {children}
    </p>
  )
}

/** The `ask_user` questions as the call asked them — the answers are the result's. */
function QuestionList({ questions }: { questions: readonly EnsoQuestion[] }): React.ReactNode {
  return (
    <ol className="flex flex-col gap-1 font-sans text-sm">
      {questions.map((question) => (
        <li key={question.header}>
          <span className={cn(LABEL, 'mr-2 font-mono')}>{question.header}</span>
          {question.question}
        </li>
      ))}
    </ol>
  )
}

/** The questions an `ask_user` input carries, when it carries them in the tool's shape. */
function questionsOf(input: Record<string, unknown>): EnsoQuestion[] | undefined {
  const questions = input['questions']
  if (!Array.isArray(questions)) return undefined
  const valid = questions.every(
    (question: Partial<EnsoQuestion> | null) =>
      typeof question?.question === 'string' && typeof question.header === 'string' && Array.isArray(question.options),
  )
  return valid ? (questions as EnsoQuestion[]) : undefined
}

/** One tool's reading of its arguments, or `undefined` when they are not in the tool's shape. */
type InputView = (input: Record<string, unknown>, name: string) => React.ReactNode | undefined

/**
 * A tool read by the string argument it is about — `path`, `command`, `pattern`, `url` — drawn by
 * `draw`; not in the tool's shape when that argument is missing and there is no `fallback`.
 */
function about(
  key: string,
  draw: (subject: string, input: Record<string, unknown>) => React.ReactNode,
  fallback?: string,
): InputView {
  return (input, name) => {
    const subject = stringAt(input, key) ?? fallback
    if (subject === undefined) return undefined
    return (
      <div data-enso-tool-input={name} className="flex flex-col gap-1">
        {draw(subject, input)}
      </div>
    )
  }
}

const subjectLine = (subject: string): React.ReactNode => <PathLine path={subject} />

const readInput = about('path', (path, input) => {
  const range = readRange(input)
  return <PathLine path={path}>{range === undefined ? null : <span className={LABEL}>{range}</span>}</PathLine>
})

const writeInput = about('path', (path, input) => {
  const content = stringAt(input, 'content') ?? ''
  const bytes = new TextEncoder().encode(content).length
  return (
    <>
      <PathLine path={path}>
        <span className={LABEL}>
          {plural(bytes, 'byte', 'bytes')}, {plural(lineCount(content), 'line', 'lines')}
        </span>
        <OpenInDiff path={path} />
      </PathLine>
      <Folded label="content" text={content} />
    </>
  )
})

const editInput = about('path', (path, input) => {
  const edits = editsOf(input)
  return (
    <>
      <PathLine path={path}>
        <span className={LABEL}>{plural(edits.length, 'change', 'changes')}</span>
        <OpenInDiff path={path} />
      </PathLine>
      {keyedByPlace(edits, 'edit').map(({ item: edit, slot }) => (
        <EditChange key={slot} oldText={edit.oldText} newText={edit.newText} />
      ))}
    </>
  )
})

/** `grep` and `find`: the pattern, where, and grep's file filter. */
const patternInput = about('pattern', (pattern, input) => {
  const glob = stringAt(input, 'glob')
  return (
    <PathLine path={pattern}>
      <span className={LABEL}>in {stringAt(input, 'path') ?? '.'}</span>
      {glob === undefined ? null : <span className={LABEL}>{glob}</span>}
    </PathLine>
  )
})

const bashInput = about('command', (command, input) => {
  const timeout = numberAt(input, 'timeout')
  const cwd = stringAt(input, 'cwd')
  return (
    <>
      <pre className={cn(PRE, 'text-foreground')}>{command}</pre>
      {timeout === undefined && cwd === undefined ? null : (
        <p className="flex gap-2">
          {timeout === undefined ? null : <span className={LABEL}>timeout {timeout}s</span>}
          {cwd === undefined ? null : <span className={LABEL}>in {cwd}</span>}
        </p>
      )}
    </>
  )
})

function askUserInput(input: Record<string, unknown>): React.ReactNode | undefined {
  const questions = questionsOf(input)
  if (questions === undefined) return undefined
  return (
    <div data-enso-tool-input="ask_user">
      <QuestionList questions={questions} />
    </div>
  )
}

/** The tools Enso reads the arguments of, by name; any other is a `key: value` list. */
const INPUT_VIEWS: Readonly<Record<string, InputView>> = {
  bash: bashInput,
  read: readInput,
  write: writeInput,
  edit: editInput,
  ask_user: askUserInput,
  grep: patternInput,
  find: patternInput,
  ls: about('path', subjectLine, '.'),
  web_fetch: about('url', subjectLine),
  web_search: about('query', subjectLine),
}

/**
 * A tool call's arguments as a person reads them (#920): per tool for the ones Enso knows, a
 * `key: value` list for any other — and for a known tool whose arguments are not in its shape.
 */
export function ToolInput({ name, input }: { name: string; input: unknown }): React.ReactNode {
  if (typeof input !== 'object' || input === null) return <ValueList value={input} />
  const record = input as Record<string, unknown>
  return INPUT_VIEWS[name]?.(record, name) ?? <KeyValues record={record} />
}

/** The lines of a listing result that are results — not pi's closing `[… limit reached]` notices. */
function listedLines(text: string): number {
  return text.split('\n').filter((line) => line.trim().length > 0 && !line.startsWith('[')).length
}

/** What a listing tool says when it found nothing. */
const NOTHING_FOUND = new Set(['No matches found', 'No files found matching pattern', '(empty directory)'])

/** A listing's count over its folded results: `12 matches`. */
function listingView(one: string, many: string): ToolTextView {
  return (text) =>
    NOTHING_FOUND.has(text.trim()) ? (
      <p className="text-muted-foreground">{text}</p>
    ) : (
      <Folded label={plural(listedLines(text), one, many)} text={text} />
    )
}

/**
 * How a tool's text result reads (#920), for the tools whose text has a shape; `undefined` prints it
 * as it came. An error's text is never drawn through this — the result's error treatment is
 * unchanged (`EnsoToolResult.tsx`).
 */
export function toolTextView(name: string): ToolTextView | undefined {
  if (name === 'bash') {
    return (text) => (
      <div data-enso-tool-output="bash" className="flex flex-col gap-1">
        <pre className={cn(PRE, 'rounded-xs bg-muted/50 p-2 text-foreground')}>
          {text.length === 0 ? '(no output)' : text}
        </pre>
        <p className="text-detail text-ok">exited 0</p>
      </div>
    )
  }
  if (name === 'read') {
    return (text) => <Folded label={plural(lineCount(text), 'line', 'lines')} text={text} />
  }
  if (name === 'grep') return listingView('match', 'matches')
  if (name === 'find') return listingView('file', 'files')
  if (name === 'ls') return listingView('entry', 'entries')
  if (name === 'web_fetch' || name === 'web_search') {
    return (text) => <Folded label={text.split('\n', 1)[0] ?? ''} text={text} />
  }
  return undefined
}

/** One answer as words: the chosen labels, then any "Other" text. */
function AnswerRows({
  question,
  answer,
}: {
  question: EnsoQuestion
  answer: EnsoQuestionAnswer | undefined
}): React.ReactNode {
  const chosen = new Set(answer?.selected ?? [])
  return (
    <ul className="flex flex-col gap-1">
      {question.options.map((option) => (
        <li
          key={option.label}
          data-chosen={chosen.has(option.label) ? '' : undefined}
          className={cn(
            'flex items-start gap-2',
            chosen.has(option.label) ? 'text-foreground' : 'text-muted-foreground',
          )}
        >
          <CheckIcon
            aria-hidden="true"
            className={cn('mt-1 size-3 shrink-0', !chosen.has(option.label) && 'invisible')}
          />
          <span>{option.label}</span>
        </li>
      ))}
      {answer?.other === undefined ? null : (
        <li data-chosen="" className="flex items-start gap-2 text-foreground">
          <CheckIcon aria-hidden="true" className="mt-1 size-3 shrink-0" />
          <span>
            Other: <q>{answer.other}</q>
          </span>
        </li>
      )}
    </ul>
  )
}

/**
 * The renderers of the descriptor kinds Enso emits (#18, #920), keyed by `kind`. A descriptor whose
 * props do not check is drawn by the text fallback, like any unknown kind.
 */
export const TOOL_RESULT_RENDERERS: EnsoRendererMap = {
  [ENSO_IMAGES_KIND]: (props) =>
    isEnsoImagesProps(props) ? (
      <div className="flex flex-wrap gap-2">
        {keyedByPlace(props.images, 'image').map(({ item: image, slot }) => (
          <img
            key={slot}
            alt="returned by the tool"
            className="max-h-48 max-w-full rounded-xs border"
            src={`data:${image.mimeType};base64,${image.data}`}
          />
        ))}
      </div>
    ) : null,
  [ENSO_QUESTIONNAIRE_ANSWERS_KIND]: (props) => {
    if (!isEnsoQuestionnaireAnswersProps(props)) return null
    const { questions, answers } = props
    return (
      <div className="flex flex-col gap-3 font-sans text-sm">
        {answers === undefined ? <p className="text-muted-foreground">Not answered.</p> : null}
        {questions.map((question, index) => (
          <section key={question.header} aria-label={question.question} className="flex flex-col gap-1">
            <p className="font-medium text-foreground">
              <span className={cn(LABEL, 'mr-2 font-mono font-normal')}>{question.header}</span>
              {question.question}
              {question.multiSelect ? <span className="ml-2 text-detail text-muted-foreground">(any)</span> : null}
            </p>
            {answers === undefined ? null : <AnswerRows question={question} answer={answers[index]} />}
          </section>
        ))}
      </div>
    )
  },
  [ENSO_WRITE_RECEIPT_KIND]: (props) =>
    isEnsoWriteReceiptProps(props) ? (
      <p className="text-ok">{props.existed ? 'overwrote the file' : 'created a new file'}</p>
    ) : null,
}
