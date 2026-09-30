import { EnsoContextEventKind } from '../../../packages/core/src/thread-context.ts'
import { SECOND_MODEL } from '../feature-session.ts'
import { stringsIn } from '../source-constants.ts'
import type { FeatureSpec, FeatureUi, MarkTarget } from './spec.ts'

/**
 * What each Context Events kind means, in a reader's words; empty where the kind's name says it.
 * Keyed by the core type, so a kind added to `EnsoContextEventKind` fails the typecheck here.
 */
const EVENT_MEANS: Readonly<Record<EnsoContextEventKind, string>> = {
  inject: 'a section or message added to the context',
  compact: '',
  prune: 'part of the context edited out',
  switch: 'the model or the thinking level',
  mode: '',
}

/** Every event kind, in the order core declares them. */
const EVENT_KINDS = EnsoContextEventKind.anyOf.map((literal) => literal.const)

const EVENT_LIST = EVENT_KINDS.map((kind) =>
  EVENT_MEANS[kind] === '' ? `\`${kind}\`` : `\`${kind}\` (${EVENT_MEANS[kind]})`,
)

/** The tools File Activity follows (`context-history.ts`). */
const FILE_TOOLS = stringsIn('packages/web/src/host/context-history.ts', 'FILE_TOOLS')

/** `a`, `b` and `c`: a list as a sentence says it. */
function listed(items: readonly string[]): string {
  const last = items.at(-1)
  if (last === undefined) throw new Error('context-browser: an empty list')
  return items.length === 1 ? last : `${items.slice(0, -1).join(', ')} and ${last}`
}

const BROWSER: MarkTarget = { role: 'region', name: 'Context Browser' }
const EVENTS: MarkTarget = { role: 'region', name: 'Context Events' }
/** The model switch's row in Context Events: its title names the model it switched to. */
const SWITCH_EVENT: MarkTarget = { text: new RegExp(`^model \\S*${SECOND_MODEL}`), within: EVENTS }
/** The **tool results** category's header, by its name alone: the makeup legend names the category too. */
const TOOL_RESULTS: MarkTarget = {
  text: 'tool results',
  exact: true,
  within: { role: 'button', name: /^tool results/, within: BROWSER },
}
/** The result of pi's read of the config file: its row, and the label a reader picks it by. */
const CONFIG_ROW: MarkTarget = { role: 'button', name: /config\.ts/, within: BROWSER }
const CONFIG_READ: MarkTarget = { text: /config\.ts/, within: CONFIG_ROW }

/** The request after the model switch, opened from its `switch` event: the event opens the first request it reached. */
async function openSwitchedRequest(ui: FeatureUi): Promise<void> {
  await ui.openThread()
  await ui.tab('Context')
  await ui.click(SWITCH_EVENT)
  await ui.scrollTo({ text: 'Context Browser', exact: true })
}

/** The Context Browser (#361): one request after the model switch, then one element of it opened. */
export const CONTEXT_BROWSER: FeatureSpec = {
  id: 'context-browser',
  title: 'Context browser',
  landingTagline: 'exact request elements',
  shows: [
    "The Context Browser opens one model request and shows what the model received, element by element: each prompt section, each tool's schema, each message, each reply, and each tool result beside the call that produced it. Pick an element to read it exactly as it was sent.",
    "Beside it, **Context Events** lists what changed the context other than the conversation, and **File Activity** lists what pi's file tools touched.",
  ],
  opens: [
    'On the **Context** tab, pick a bar in **Trend**, then **Open in browser**.',
    '**Open next request** on the **Now** card opens the request that has not been sent yet.',
    'Once it is open, the arrows and the request picker move between requests.',
  ],
  shots: [
    {
      image: 'context-browser',
      alt: 'The Context Browser, Context Events and File Activity',
      go: openSwitchedRequest,
      marks: [
        {
          target: { role: 'combobox', name: 'the request to open' },
          says: "The request picker. Each request shows its prompt and pi's estimate.",
        },
        {
          target: { text: /entered since request \d+/, within: BROWSER },
          says: 'What entered since the request before. In a category, a row marked **+ new** is one of them.',
        },
        { target: SWITCH_EVENT, says: 'A `switch` event in **Context Events**: the model changed here.' },
        {
          target: { text: 'File Activity', exact: true },
          says: "**File Activity**: every read, write and search by pi's file tools, and the ones that failed.",
        },
      ],
      measure: {
        enteredSince: (page) =>
          page
            .getByRole('region', { name: 'Context Browser' })
            .getByText(/entered since /)
            .first(),
      },
    },
    {
      image: 'context-browser-element',
      alt: 'One element opened: a tool result beside its call',
      go: async (ui) => {
        await openSwitchedRequest(ui)
        await ui.click(TOOL_RESULTS)
        await ui.click(CONFIG_READ)
        await ui.page.getByRole('group', { name: 'show the text' }).waitFor()
      },
      marks: [
        {
          target: CONFIG_ROW,
          says: "The element: the `read` of `src/config.ts`, under **tool results**. The panel shows the call's arguments, then the result as the model received it.",
        },
        {
          target: { role: 'group', name: 'show the text' },
          says: '**raw** or **markdown**: the text as sent, or rendered.',
        },
      ],
    },
  ],
  lookFor: [
    `Open the request after a model switch. In the thread above, the request after the switch says \`{enteredSince}\`, yet on the **Stats** tab it is the most expensive turn. **Context Events** has the reason: a \`switch\` event at that request, to \`${SECOND_MODEL}\`. The context was the same; the cache was not.`,
    `**Context Events** shows these kinds of event: ${listed(EVENT_LIST)}. The figure on an event is the change in pi's estimate across it. Click an event to open the first request it reached.`,
    '**File Activity** follows the bar you pick in **Trend**, so it shows the files touched up to that request. Above, the read of `.env` is marked **failed**: the guard refused it. The `grep` and `cat` pi ran in the shell are not listed at all (see below). Click a row to open its tool result.',
  ],
  limits: [
    `**File Activity** covers pi's file tools only: ${listed(FILE_TOOLS.map((tool) => `\`${tool}\``))}. A file touched through \`bash\` is not listed, because a shell command names no file Enso can trust.`,
    "The sizes are pi's estimate. The provider's count for the whole request is in the summary line, and is not split.",
    'An image in a request shows as a preview, and as a note instead of a preview when it is too large.',
  ],
  see: [
    { path: 'docs/features/context.md', label: 'Context', why: 'the tab this opens from' },
    {
      path: 'docs/concepts/prompt-cache-architecture.md',
      label: 'Prompt cache architecture',
      why: 'why a switch costs more than its content',
    },
    {
      path: 'docs/reference/routes.md',
      label: 'HTTP routes',
      why: '`GET /api/threads/:threadId/context/:request`, which serves each request',
    },
    { path: 'docs/seams/observation.md', label: 'Observation seam' },
  ],
}
