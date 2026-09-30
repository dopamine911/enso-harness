import { ensoPromptsDir } from '../../../packages/core/src/paths.ts'
import {
  EnsoLibraryPromptCategory,
  EnsoLibraryPromptWrite,
  parseLibraryPrompt,
} from '../../../packages/core/src/prompt-library.ts'
import { PROMPT_LIBRARY } from '../feature-session.ts'
import type { FeatureSpec, MarkTarget } from './spec.ts'

/** The example file: the capture's own library prompt, the one the screenshot is open on. */
const REVIEWER_FILE = 'reviewer.md'
const REVIEWER_TEXT = PROMPT_LIBRARY[REVIEWER_FILE]
const reviewerParse = parseLibraryPrompt(REVIEWER_FILE.replace(/\.md$/, ''), REVIEWER_TEXT)
if (reviewerParse.kind !== 'prompt')
  throw new Error(`prompts: the library refuses ${REVIEWER_FILE}: ${reviewerParse.reason}`)
const REVIEWER = reviewerParse.prompt

/** The frontmatter keys a prompt file carries: the written fields, less the body under them. */
const FRONTMATTER_KEYS = Object.keys(EnsoLibraryPromptWrite.properties).filter((key) => key !== 'body')

/**
 * Where each category's text goes, in a reader's words. Keyed by the category type, so a category
 * added to the library fails the typecheck here until it has its line.
 */
const GOES: Readonly<Record<EnsoLibraryPromptCategory, string>> = {
  system:
    "A *system* prompt replaces the opening of pi's system prompt, and pi then leaves out its own sections on tools, rules and docs. Your project's context, skills and working folder are still pi's, and the tool definitions are sent either way.",
  append: "An *append* prompt is added to the end of pi's.",
  session: 'A *session* prompt is a first message you use often. It fills the prompt box in the start dialog.',
}

/** The categories in the order the library declares them. */
const CATEGORIES = EnsoLibraryPromptCategory.anyOf.map((literal) => literal.const)

const DIALOG: MarkTarget = { role: 'dialog', name: 'Prompts', exact: true }
const LIBRARY_LIST: MarkTarget = { role: 'navigation', name: 'prompts', within: DIALOG }
const BREAKDOWN: MarkTarget = { role: 'table', name: 'what the model receives', within: DIALOG }

/** `word` with the article a reader says before it. */
const withArticle = (word: string): string => `${/^[aeiou]/.test(word) ? 'an' : 'a'} ${word}`

/** Prompts (#443): the prompt manager, open on the capture's append prompt, beside the thread it was opened from. */
export const PROMPTS: FeatureSpec = {
  id: 'prompts',
  title: 'Prompts',
  shows: [
    `Your prompt library: markdown files you write once and start sessions with. Each prompt is one file, \`${ensoPromptsDir('ENSO_HOME')}/<id>.md\`, with a short frontmatter block (${FRONTMATTER_KEYS.map((key) => `\`${key}\``).join(', ')}) and the text under it. The category says where the text goes:`,
    CATEGORIES.map((category) => `- ${GOES[category]}`).join('\n'),
    'The prompt manager is where you read, write and organise them. While you write, it shows what the prompt costs and what the model will receive with it.',
  ],
  opens: [
    '{steps}. **prompts** is the scroll icon in the header, beside **settings**, and opens **Prompts**.',
    '**New Thread** opens **Start a session**, where **System prompt** and **Saved prompt** pick from the library. See [Sessions and projects](./sessions-and-projects.md).',
    [
      'The files are plain markdown, so you can also edit them in any editor. The manager and the start dialog read the folder again each time they open. A file looks like this:',
      '',
      '```markdown',
      REVIEWER_TEXT.trimEnd(),
      '```',
    ].join('\n'),
  ],
  shots: [
    {
      image: 'prompts-manager',
      alt: `The prompt manager, open on ${withArticle(REVIEWER.category)} prompt`,
      go: async (ui) => {
        await ui.openThread()
        await ui.click({ role: 'button', name: 'prompts', exact: true })
        await ui.click({ text: REVIEWER.name, exact: true, within: LIBRARY_LIST })
        // pi renders the draft on the live thread; the breakdown is there once it has.
        await ui.page
          .getByRole('dialog', { name: 'Prompts', exact: true })
          .getByRole('table', { name: 'what the model receives' })
          .waitFor({ timeout: 60_000 })
      },
      marks: [
        {
          target: { text: 'pi default', exact: true, within: LIBRARY_LIST },
          says: '**{shown}**: the system prompt pi builds for the thread on screen, marked **read-only**. **Copy as a new prompt** starts a prompt from it.',
        },
        {
          target: { text: 'Append prompts', exact: true, within: LIBRARY_LIST },
          says: 'The library, by category: **System prompts**, **Append prompts** and **Session prompts**, each with its size in tokens. A file that cannot be read as a prompt is listed under them by name, with the reason.',
        },
        {
          target: { role: 'button', name: 'New', exact: true, within: DIALOG },
          says: '**{shown}** starts a blank prompt. **Copy** in the editor starts one from the prompt that is open.',
        },
        {
          target: { role: 'button', name: 'Save', exact: true, within: DIALOG },
          says: "**{shown}** writes the file. **Delete** asks again, naming the file, before it removes it. The editor also has the file's **Name**, **File**, **Description** and **Category**, and shows the markdown as `source` or `preview`.",
        },
        {
          target: { label: 'prompt size', within: DIALOG },
          says: "The size bar: the file's bytes, the text's tokens, and the share of the model's context window. For a system or append prompt it also gives the whole system prompt's tokens, since that is what the model is sent.",
        },
        {
          target: BREAKDOWN,
          says: "What the model receives: pi's sections of the system prompt, which of them come from this prompt, the **tool definitions** pi sends beside them, and the **total**.",
        },
      ],
    },
  ],
  lookFor: [
    "The numbers are the ones the rest of the app uses. The tokens are the same estimate the Context tab gives system text, and the breakdown is pi's own rendering on the thread on screen. So the total here is what the Context tab counts, for the first request of a thread started with this prompt, across its system prompt and tool schemas — and, for an append prompt, the addendum, which the Context tab files under injected context. A system prompt can come out well under pi's default, because pi leaves out its own tools, rules and docs sections. An append prompt always costs pi's whole prompt plus its own text.",
    'A prompt with changes you have not saved says `● unsaved` beside its name. Opening another prompt, starting a new one, or closing the dialog asks first: **Discard them** or **Keep editing**.',
    'The files can change under you: another tab, or an editor open on the same file. **Save** only replaces the version you opened. If the file changed on disk since, nothing is written, and the editor says so with two choices: **Reload from disk**, which drops your edits for the file as it is now, or **Overwrite with mine**. A new prompt, or a rename, is never saved over a file that is already there, even one the library could not read. **Delete** likewise removes only the version you opened.',
    'In the start dialog, **System prompt** lists `pi default` and every system and append prompt, each with its size. It is **fixed for the whole session**. **Saved prompt** lists the session prompts and puts the one you pick into the prompt box, where you can still change it before you send it.',
    `Once a thread has started, the Context tab names its system prompt on the system row: \`system prompt · ${REVIEWER.name}\` for a system prompt, \`system prompt · pi default + ${REVIEWER.name}\` for an append prompt, or \`system prompt · pi default\`. An append prompt's own tokens are its **addendum**, counted under **injected context** with what else was added to pi's prompt (project context, skills); the element is labelled \`addendum · ${REVIEWER.name}\`.`,
  ],
  limits: [
    'There is one library, in `ENSO_HOME`. A project cannot have prompts of its own yet.',
    "A thread's system prompt cannot change after its first request. To run the same work with another one, start a new thread. A fork, a resume and a restart keep the prompt the thread started with, even if the file has been edited or deleted since.",
    "These are not pi's prompt templates, the `/name` commands under **prompts** in the command palette (see [Chat](./chat.md)). Those are pi's own and are not listed here.",
  ],
  see: [
    {
      path: 'docs/reference/env-and-config.md',
      label: 'Environment and configuration',
      why: `\`${ensoPromptsDir('ENSO_HOME')}\` among the other files in \`ENSO_HOME\``,
    },
    {
      path: 'docs/reference/routes.md',
      label: 'HTTP routes',
      why: '`/api/prompts`, and the configure route the start dialog sends the system prompt through',
    },
    { path: 'docs/features/context.md', label: 'Context', why: 'how the system prompt is counted in each request' },
    { path: 'docs/glossary.md', label: 'Glossary', why: '*library prompt* and the system-prompt modes' },
  ],
}
