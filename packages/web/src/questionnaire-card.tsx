import type { EnsoDialogSpec, EnsoQuestion, EnsoQuestionAnswer } from '@enso/core'
import { CheckIcon } from 'lucide-react'
import { useId, useState } from 'react'
import { Button } from './components/ui/button.tsx'
import { Checkbox } from './components/ui/checkbox.tsx'
import { Field, FieldContent, FieldDescription, FieldLabel, FieldTitle } from './components/ui/field.tsx'
import { Input } from './components/ui/input.tsx'
import { RadioGroup, RadioGroupItem } from './components/ui/radio-group.tsx'
import { Tabs, TabsContent, TabsList, TabsTrigger } from './components/ui/tabs.tsx'

/**
 * The agent's `ask_user` questionnaire as one card (#12): a tab per question, each option a row
 * with its label and what choosing it means, an "Other" row for an answer in the user's own words,
 * and one "Submit answers" once every question has one. The card's own Cancel (`EnsoDialogCard`)
 * declines the whole questionnaire — a real decline, whatever kind the questions are.
 *
 * The answer is `{ answers }`, one entry per question in order — the shape `validateDialogAnswer`
 * holds it to on the server, which refuses a label the question never offered. Headers and each
 * question's labels are distinct by the time a card is shown (`questionnaireRepeat`: the tool and
 * the host both refuse a repeat), so they are the keys.
 */

type Questionnaire = Extract<EnsoDialogSpec, { method: 'questionnaire' }>

/** One question while it is being answered. `other` is the free text, used while `otherChosen`. */
interface Draft {
  readonly selected: readonly string[]
  readonly otherChosen: boolean
  readonly other: string
}

const EMPTY_DRAFT: Draft = { selected: [], otherChosen: false, other: '' }

/** The radio value that stands for "Other" — never a label, since it is not a string a model writes. */
const OTHER_VALUE = '\u0000other'

function isAnswered(draft: Draft): boolean {
  return draft.selected.length > 0 || (draft.otherChosen && draft.other.trim().length > 0)
}

function answerOf(draft: Draft): EnsoQuestionAnswer {
  const other = draft.other.trim()
  return draft.otherChosen && other.length > 0
    ? { selected: [...draft.selected], other }
    : { selected: [...draft.selected] }
}

/** The "Other" row's text field, shown once "Other" is chosen. */
function OtherField({
  id,
  draft,
  disabled,
  onText,
}: {
  id: string
  draft: Draft
  disabled: boolean
  onText: (text: string) => void
}): React.ReactNode {
  if (!draft.otherChosen) return null
  return (
    <Input
      id={id}
      aria-label="your own answer"
      placeholder="Type your answer"
      value={draft.other}
      disabled={disabled}
      onChange={(event: React.ChangeEvent<HTMLInputElement>) => onText(event.target.value)}
    />
  )
}

/** One option row: the control, then the label and what choosing it means. */
function OptionRow({
  id,
  option,
  control,
}: {
  id: string
  option: EnsoQuestion['options'][number]
  control: React.ReactNode
}): React.ReactNode {
  return (
    <FieldLabel htmlFor={id}>
      <Field orientation="horizontal">
        {control}
        <FieldContent>
          <FieldTitle>{option.label}</FieldTitle>
          {option.description === undefined || option.description.length === 0 ? null : (
            <FieldDescription>{option.description}</FieldDescription>
          )}
        </FieldContent>
      </Field>
    </FieldLabel>
  )
}

/** A single-choice question: one radio per option, and "Other". */
function SingleChoice({
  idPrefix,
  question,
  draft,
  disabled,
  onDraft,
  onChosen,
}: {
  idPrefix: string
  question: EnsoQuestion
  draft: Draft
  disabled: boolean
  onDraft: (draft: Draft) => void
  /** A label was picked — the card moves on to the next question. */
  onChosen: () => void
}): React.ReactNode {
  const value = draft.otherChosen ? OTHER_VALUE : (draft.selected[0] ?? '')
  return (
    <div className="flex flex-col gap-2">
      <RadioGroup
        value={value}
        disabled={disabled}
        aria-label={question.question}
        onValueChange={(picked: string) => {
          if (picked === OTHER_VALUE) {
            onDraft({ ...draft, selected: [], otherChosen: true })
            return
          }
          onDraft({ ...draft, selected: [picked], otherChosen: false })
          onChosen()
        }}
      >
        {question.options.map((option, index) => (
          <OptionRow
            key={option.label}
            id={`${idPrefix}-${index}`}
            option={option}
            control={<RadioGroupItem id={`${idPrefix}-${index}`} value={option.label} />}
          />
        ))}
        <OptionRow
          id={`${idPrefix}-other`}
          option={{ label: 'Other', description: 'Answer in your own words' }}
          control={<RadioGroupItem id={`${idPrefix}-other`} value={OTHER_VALUE} />}
        />
      </RadioGroup>
      <OtherField
        id={`${idPrefix}-other-text`}
        draft={draft}
        disabled={disabled}
        onText={(other: string) => onDraft({ ...draft, other })}
      />
    </div>
  )
}

/** A multi-choice question: one checkbox per option, and "Other". */
function MultiChoice({
  idPrefix,
  question,
  draft,
  disabled,
  onDraft,
}: {
  idPrefix: string
  question: EnsoQuestion
  draft: Draft
  disabled: boolean
  onDraft: (draft: Draft) => void
}): React.ReactNode {
  const toggle = (label: string, checked: boolean): void => {
    const selected = question.options
      .map((option) => option.label)
      .filter((candidate) => (candidate === label ? checked : draft.selected.includes(candidate)))
    onDraft({ ...draft, selected })
  }
  return (
    <fieldset aria-label={question.question} className="flex flex-col gap-2">
      {question.options.map((option, index) => (
        <OptionRow
          key={option.label}
          id={`${idPrefix}-${index}`}
          option={option}
          control={
            <Checkbox
              id={`${idPrefix}-${index}`}
              checked={draft.selected.includes(option.label)}
              disabled={disabled}
              onCheckedChange={(checked: boolean | 'indeterminate') => toggle(option.label, checked === true)}
            />
          }
        />
      ))}
      <OptionRow
        id={`${idPrefix}-other`}
        option={{ label: 'Other', description: 'Answer in your own words' }}
        control={
          <Checkbox
            id={`${idPrefix}-other`}
            checked={draft.otherChosen}
            disabled={disabled}
            onCheckedChange={(checked: boolean | 'indeterminate') =>
              onDraft({ ...draft, otherChosen: checked === true })
            }
          />
        }
      />
      <OtherField
        id={`${idPrefix}-other-text`}
        draft={draft}
        disabled={disabled}
        onText={(other: string) => onDraft({ ...draft, other })}
      />
    </fieldset>
  )
}

export function QuestionnaireControls({
  dialog,
  answer,
  disabled,
}: {
  dialog: Questionnaire
  answer: (payload: { answers: EnsoQuestionAnswer[] }) => void
  disabled: boolean
}): React.ReactNode {
  const baseId = useId()
  const [drafts, setDrafts] = useState<readonly Draft[]>(() => dialog.questions.map(() => EMPTY_DRAFT))
  const [active, setActive] = useState('0')
  const draftAt = (index: number): Draft => drafts[index] ?? EMPTY_DRAFT
  const setDraft = (index: number, draft: Draft): void =>
    setDrafts((current) => current.map((each, at) => (at === index ? draft : each)))
  const unanswered = dialog.questions.filter((_question, index) => !isAnswered(draftAt(index))).length
  return (
    <div className="flex flex-col gap-4">
      <Tabs value={active} onValueChange={setActive}>
        <TabsList>
          {dialog.questions.map((question, index) => (
            <TabsTrigger key={question.header} value={String(index)}>
              {isAnswered(draftAt(index)) ? <CheckIcon aria-label="answered" /> : null}
              {question.header}
            </TabsTrigger>
          ))}
        </TabsList>
        {dialog.questions.map((question, index) => (
          <TabsContent key={question.header} value={String(index)} className="flex flex-col gap-3 pt-2">
            <p className="font-medium text-sm">{question.question}</p>
            {question.multiSelect ? (
              <MultiChoice
                idPrefix={`${baseId}-${index}`}
                question={question}
                draft={draftAt(index)}
                disabled={disabled}
                onDraft={(draft: Draft) => setDraft(index, draft)}
              />
            ) : (
              <SingleChoice
                idPrefix={`${baseId}-${index}`}
                question={question}
                draft={draftAt(index)}
                disabled={disabled}
                onDraft={(draft: Draft) => setDraft(index, draft)}
                onChosen={() => {
                  if (index + 1 < dialog.questions.length) setActive(String(index + 1))
                }}
              />
            )}
          </TabsContent>
        ))}
      </Tabs>
      <div className="flex items-center gap-3">
        <Button
          type="button"
          disabled={disabled || unanswered > 0}
          onClick={() => answer({ answers: dialog.questions.map((_question, index) => answerOf(draftAt(index))) })}
        >
          Submit answers
        </Button>
        {unanswered > 0 ? (
          <span className="text-muted-foreground text-xs">
            {unanswered === 1 ? '1 question' : `${unanswered} questions`} still to answer
          </span>
        ) : null}
      </div>
    </div>
  )
}
