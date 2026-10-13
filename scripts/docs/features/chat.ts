import { ENSO_IMAGE_MAX_BYTES, ENSO_PROMPT_MAX_IMAGES } from '../../../packages/core/src/follow.ts'
import { ENSO_CONTEXT_COMMAND } from '../../../packages/core/src/thread-context.ts'
import { ENSO_FORK_COMMAND } from '../../../packages/core/src/thread-inspection.ts'
import { constantIn } from '../source-constants.ts'
import type { FeatureSpec, MarkTarget } from './spec.ts'

const RAIL: MarkTarget = { role: 'navigation', name: 'threads' }
const STATUS: MarkTarget = { label: 'thread status' }

/** A host command's name, as the host declares it. */
function commandIn(path: string, name: string): string {
  const value = constantIn(path, name)
  if (typeof value !== 'string') throw new Error(`chat: ${path}: ${name} is not a string`)
  return `\`/${value}\``
}

const HOST_COMMANDS = 'packages/web/src/host/host-commands.ts'
const HOST_FLOWS = 'packages/web/src/host/host-flows.ts'
/** The settings group's rows; `/logout` is said apart, since the host lists it only once a login is stored. */
const SETTINGS_COMMANDS = [
  commandIn(HOST_COMMANDS, 'HOST_COMMAND_MODEL'),
  commandIn(HOST_COMMANDS, 'HOST_COMMAND_THINKING'),
  commandIn(HOST_FLOWS, 'HOST_FLOW_LOGIN'),
  commandIn(HOST_FLOWS, 'HOST_ACTION_COMPACT'),
  `\`/${ENSO_CONTEXT_COMMAND}\``,
  `\`/${ENSO_FORK_COMMAND}\``,
].join(', ')
const LOGOUT = commandIn(HOST_FLOWS, 'HOST_FLOW_LOGOUT')

/** The palette's group headings, in the order it shows them (`command-palette.tsx`). */
function paletteHeadings(): string[] {
  const groups = constantIn('packages/web/src/command-palette.tsx', 'GROUPS')
  if (!Array.isArray(groups)) throw new Error('chat: command-palette.tsx GROUPS is not an array')
  return groups.map((group) => {
    const heading = typeof group === 'object' && group !== null && !Array.isArray(group) ? group['heading'] : undefined
    if (typeof heading !== 'string') throw new Error('chat: a command-palette.tsx group has no heading')
    return heading
  })
}
const [SETTINGS_GROUP, ...OTHER_GROUPS] = paletteHeadings()
if (SETTINGS_GROUP === undefined) throw new Error('chat: command-palette.tsx GROUPS is empty')
const OTHER_GROUP_WORDS = OTHER_GROUPS.map((heading) => `**${heading}**`)
  .join(', ')
  .replace(/, ([^,]*)$/, ' and $1')

const IMAGE_MEGABYTES = ENSO_IMAGE_MAX_BYTES / (1024 * 1024)

/** Chat (#482): the demo thread in the Chat tab, and its command palette. */
export const CHAT: FeatureSpec = {
  id: 'chat',
  title: 'Chat',
  landingTagline: 'threads · tools · images',
  shows: [
    "A thread is one conversation with pi. The reply streams in as pi writes it. Each tool call pi makes is a row you can open, and pi's thinking is a block you can expand. You can attach images to a prompt, and run commands from a palette.",
    "The thread's id is in the page URL, so a reload shows the same thread, and the browser's back and forward buttons move between the threads you opened.",
  ],
  opens: [
    'Start the web app with `bun run dev` and open `http://127.0.0.1:5178`.',
    '**New Thread** in the rail opens a new thread on its launch panel: type the first prompt and press **Start session**, and the same composer, with what you attached, docks under the transcript. See [Sessions and projects](./sessions-and-projects.md). A thread you opened before is listed under its project. Click it to open it again.',
    'The **Chat** tab shows the conversation. **Context** and **Stats** are the other two views of the same thread.',
    'The URL names the thread as `?thread=<id>`.',
    'To add an image, use the **attach an image** button, paste the image, or drop it on the composer.',
    'The **commands** button (the `/` icon in the composer) opens the command palette.',
    "Above the prompt box, the thread's settings are chips: **Model**, **Effort** and **Mode**, each opening its list (mouse or keyboard), and **System prompt**, locked once the session has started. Pressing the locked chip says why: it is fixed for this session. **Model**, like `/model` in the palette, opens the model picker: your recent models first, then each provider's, every row with its effort range. See [Sessions and projects](./sessions-and-projects.md).",
  ],
  shots: [
    {
      image: 'chat-thread',
      alt: 'A thread in the Chat tab',
      go: async (ui) => {
        await ui.openThread()
        // The first prompt's fork button: the thread from its first reply down.
        await ui.scrollTo({ text: 'fork from here' })
      },
      marks: [
        {
          target: { text: 'Where does the app read', within: RAIL },
          says: 'The thread in the rail. Its title is its first prompt.',
        },
        { target: { text: /^Thought/ }, says: "pi's thinking, folded. **Thought** opens it." },
        {
          target: { toolCall: 'DATABASE_URL', summary: true },
          says: 'A tool call as one row: the tool, what it was given, and a check when it finished. Click the row to see **in** and **out**.',
        },
        {
          target: { text: 'fork from here' },
          says: '**{shown}** starts a new thread with everything before this prompt, and puts the prompt back in the composer. See [Forks and lineage](./lineage.md).',
        },
        { target: { role: 'button', name: 'attach an image' }, says: '**{shown}**.' },
        {
          target: { role: 'button', name: /^System prompt: / },
          says: "The session's **System prompt**, locked: pi took it when the session started. Beside it, **Effort** and **Mode** open their lists.",
        },
        {
          target: STATUS,
          says: "The status bar: whether pi is working, then prompts, tool calls, refusals, failures, and the thread's cost.",
        },
      ],
      measure: {
        refused: (page) =>
          page
            .getByLabel('thread status')
            .getByText(/^\d+ refused$/)
            .first(),
        failed: (page) =>
          page
            .getByLabel('thread status')
            .getByText(/^\d+ failed$/)
            .first(),
      },
    },
    {
      image: 'chat-command-palette',
      alt: 'The command palette, open on the same thread',
      go: async (ui) => {
        await ui.openThread()
        await ui.click({ role: 'button', name: 'commands' })
        await ui.page.getByPlaceholder('filter commands…').waitFor()
        // The rows arrive from the host after the palette opens.
        await ui.page.getByRole('option').first().waitFor()
      },
      marks: [
        {
          target: { placeholder: 'filter commands…' },
          says: `**{shown}** narrows the list as you type. The **${SETTINGS_GROUP}** group comes first (${SETTINGS_COMMANDS}, and ${LOGOUT} once a login is stored), then ${OTHER_GROUP_WORDS}.`,
        },
      ],
    },
  ],
  lookFor: [
    'In the thread above, the first reply shows pi working: it thinks, runs `grep` in the shell, then reads `.env` and `src/config.ts` together. `.env` is refused. The refusal is a card of its own, not a failed row (see [Guards and receipts](./guards-and-receipts.md)). The other read ran, and pi answers from it, saying what it could not check.',
    'Most rows stay folded, and that is the point of the layout. A call that finished shows a check and nothing else. A call that failed opens itself, with a red border, so a failure is never behind a click. The status bar counts both kinds: this thread has `{refused}` and `{failed}`, and they are different things.',
    'In the palette, a command runs at once, but a prompt or a skill is only inserted into the composer as `/name `, for you to finish and send.',
    'While `/login` waits for the provider (a device code to enter, a browser page to finish), the composer shows the stop button, labelled `cancel the login to <provider>`. It cancels the login, and nothing is stored. After `/compact`, or a compaction pi runs on its own when the context fills, the transcript is re-read once the thread is idle, so it shows the compacted history without a reload.',
    'The line under the prompt box says what Enter does. While pi is idle it sends (*Enter to send · Shift+Enter for a new line*); while pi is running it queues the prompt behind the run (*pi is running · Enter queues · Shift+Enter for a new line*), and the empty box says so too.',
  ],
  limits: [
    "An image in pi's reply that lives on another host is not loaded until you click it. The button names the host first. A reply is untrusted text, and loading an image is a request to whoever wrote its URL.",
    `An attached image can be at most ${IMAGE_MEGABYTES} MB, and a prompt can carry at most ${ENSO_PROMPT_MAX_IMAGES}. A file that is not an image is refused with a notice, never dropped silently.`,
    'The thread URL is for you, on this machine. The server listens on `127.0.0.1` only, so the link does not work from another computer.',
  ],
  see: [
    {
      path: 'docs/flows/prompt-run-settle.md',
      label: 'Prompt, run, settle',
      why: 'what happens between Send and the settled reply',
    },
    {
      path: 'docs/flows/follow-snapshot-frames.md',
      label: 'Follow, snapshot and frames',
      why: 'how the page stays in step with the thread',
    },
    {
      path: 'docs/seams/presentation.md',
      label: 'Presentation seam',
      also: { path: 'docs/seams/tool-result.md', label: 'Tool result seam' },
      why: 'how a tool call becomes a row',
    },
    { path: 'docs/reference/routes.md', label: 'HTTP routes', why: 'every route the page calls' },
  ],
}
