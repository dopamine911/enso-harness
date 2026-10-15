import { THREAD_STATUS_WORDS } from '../../../packages/core/src/thread-status-words.ts'
import type { FeatureSpec } from './spec.ts'

/** Questions and dialogs (#114): the demo session's questionnaire, then the permission engine's prompt, each while pi waits. */
export const QUESTIONS_AND_DIALOGS: FeatureSpec = {
  id: 'questions-and-dialogs',
  title: 'Questions and dialogs',
  landingTagline: 'answer pi in the browser',
  shows: [
    'Sometimes pi needs an answer from you before it can go on. Enso shows the question as a card in the chat, and your answer goes back to pi. There are two kinds:',
    [
      '- *A questionnaire*, when pi calls the `ask_user` tool. It holds one or more questions, each with options, and you answer all of them at once.',
      "- *pi's own prompts*: a choice, a yes or no, or a line of text. The permission engine asks this way before an edit, and so does `/login`.",
    ].join('\n'),
    'While a question is waiting, pi waits too. The status bar says `{waiting}` with the question, over whatever else pi is doing; the question is a link to its card.',
  ],
  opens: [
    'There is nothing to open. The card appears at the end of the chat when pi asks. It also appears in any other tab that has the same thread open, and whichever answers first wins.',
  ],
  shots: [
    {
      image: 'questions-ask-user',
      alt: 'An ask_user questionnaire',
      during: 'questionnaire',
      marks: [
        {
          target: { role: 'tablist', name: 'questions' },
          says: 'One tab per question, named by its header. A tab gets a check once it is answered. A single-choice question moves you to the next tab when you choose.',
        },
        {
          target: { placeholder: 'Type your answer' },
          says: '**Other** opens a field for your own answer. Here it adds a third test to the two offered.',
        },
        {
          target: { role: 'button', name: 'Submit answers' },
          says: '**{shown}** sends every answer together. It stays disabled until each question has one.',
        },
      ],
      measure: {
        waiting: (page) => page.getByLabel('thread status').getByText(THREAD_STATUS_WORDS.waiting).first(),
      },
    },
    {
      image: 'questions-permission-prompt',
      alt: 'A permission prompt before an edit',
      during: 'permission-prompt',
      marks: [
        { target: { text: 'pi is asking' }, says: '**{shown}**, then what kind of question it is.' },
        {
          target: { role: 'button', name: 'Yes', exact: true },
          says: "The options, exactly as the permission engine offered them. The text above them is the engine's own: the tool, and what it would touch.",
        },
        { target: { text: 'Cancel — decline the question' }, says: '**{shown}**.' },
      ],
    },
  ],
  lookFor: [
    'Read the detail before you answer. A permission prompt shows the file and the change, or the command, that pi wants to run. The options that end in "for this session" allow that tool or pattern for the rest of the thread without asking again; they do not change the mode. "No, provide reason" asks for a line pi reads with the refusal.',
    "In the thread above, pi asks both before it edits anything, and each question is its own card with its own answer. While a card waits, the status bar says `{waiting}` and the question, not that pi is working: the tool call is open until you answer. The page header and the thread's row in the rail say it too, so a question in a thread you are not looking at is not missed.",
    'If you open a thread and find a card already waiting, that question was asked while you were away. It is still live, and answering it now lets pi continue.',
    "Declining an `ask_user` questionnaire ends pi's turn: it does not pick an answer for you or carry on without one. The next move is yours.",
  ],
  limits: [
    'A question lives only while the thread runs. A thread opened from its file, with nothing running, has no questions to answer.',
    'A question can end without you: when pi is stopped, or when the extension that asked gives up after its own timeout.',
    'The questionnaire has no notes field. The only free text is **Other**.',
    'A choice outside the options offered is refused by the server. The browser cannot answer with an option pi never offered.',
    'When pi asks in the same reply as other tool calls, a decline does not end its turn. pi reads the decline and carries on.',
  ],
  see: [
    {
      path: 'docs/seams/dialog.md',
      label: 'Dialog seam',
      why: 'the question kinds and the rule that an answer must match its question',
    },
    {
      path: 'docs/flows/dialog-ask-answer-settled.md',
      label: 'Ask, answer, settled',
      why: 'a question from pi to the card and back',
    },
    { path: 'docs/features/permission-modes.md', label: 'Permission modes' },
  ],
}
