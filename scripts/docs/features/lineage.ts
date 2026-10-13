import { FEATURE_SCRIPT, PROMPTS } from '../feature-session.ts'
import type { FeatureSpec, MarkTarget } from './spec.ts'

/** The prompt the fork is made at, 1-based: the one that had pi edit a file. */
const FORK_AT = 3

const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four'] as const
const ORDINAL_WORDS = ['', 'first', 'second', 'third', 'fourth'] as const

function wordFor(words: readonly string[], number: number): string {
  const word = words[number]
  if (word === undefined || word === '') throw new Error(`lineage: no word for ${number}`)
  return word
}

if (PROMPTS[FORK_AT - 1] === undefined) throw new Error(`lineage: the demo session has no prompt ${FORK_AT}`)

/** The file the forked-at prompt had pi change: the path of the demo script's edit. */
const EDITED_PATH = FEATURE_SCRIPT.replies
  .flat()
  .flatMap((part) => (part.kind === 'tool' && part.tool === 'edit' ? [part.input.path] : []))[0]
if (typeof EDITED_PATH !== 'string') throw new Error('lineage: the demo script makes no edit to name')

const RAIL: MarkTarget = { role: 'navigation', name: 'threads' }
const FORK_POINT_TITLE: MarkTarget = { text: 'fork point', exact: true }
const FORK_POINT: MarkTarget = { label: 'fork point' }

/**
 * Forks and lineage (#433, #435): the fork the demo thread's third prompt makes, then that fork's
 * fork point. The second shot starts on the fork the first one opened, so it reads the fork's record.
 */
export const LINEAGE: FeatureSpec = {
  id: 'lineage',
  title: 'Forks and lineage',
  landingTagline: 'fork point · provenance · conditions',
  shows: [
    'A fork is a new thread that starts from a point in another one: everything before a prompt you pick, with that prompt back in the composer, ready to send again as it is or changed. The fork is its own thread, with its own id and its own session file. The one it came from is left exactly as it was, and the rail says which thread each fork came from.',
    'Every thread also carries a record of the conditions it ran under, its *fork point*. That makes two forks comparable: the same history, and a list of what differed.',
    [
      '- *What pi records:* the model, the thinking level, and the permission mode.',
      "- *What Enso adds at the start of a run:* the project's git revision and whether the tree was dirty, a hash of the resolved Enso config and the files it came from, the loaded skills, the context files the model received (such as `AGENTS.md`), a hash of the mode's rules, and a snapshot of the thread's files: the one **Restore files to here** puts back, and a fork at that prompt starts from.",
    ].join('\n'),
  ],
  opens: [
    '**fork from here**, under any prompt you sent, forks the thread before that prompt.',
    "`/fork` in the command palette, or **Fork thread** in the header's **thread actions** menu (⋯), forks before the last prompt.",
    'The new thread opens straight away. In the rail, it shows `forked from` and the title of the thread it came from.',
    "Add `?debug` to a thread's URL to see its **fork point** in the session debug drawer.",
    'A thread whose last run was cut off before pi answered shows a notice with **Continue**, which picks the run up from its stored state.',
  ],
  shots: [
    {
      image: 'lineage-fork',
      alt: 'A fork, opened with its prompt back in the composer',
      go: async (ui) => {
        await ui.openThread()
        await ui.forkAt(FORK_AT)
      },
      marks: [
        {
          target: { text: /^forked from /, within: RAIL },
          says: 'The fork in the rail, under the thread it came from, and which one that is.',
        },
        {
          // By role, not placeholder: the source thread's pane stays mounted, hidden, with a
          // composer of its own, and only the fork's visible one is in the accessibility tree.
          target: { role: 'textbox', name: 'ask pi something', exact: true },
          says: 'The prompt it was forked at, back in the composer. Nothing has been sent yet.',
        },
      ],
    },
    {
      image: 'lineage-fork-point',
      alt: "The fork's fork point in the debug drawer",
      go: async (ui) => {
        // The thread on screen is the fork the shot above opened, so the drawer is the fork's.
        await ui.debugDrawer()
        await ui.page.getByLabel('fork point').first().waitFor()
        await ui.scrollTo(FORK_POINT_TITLE)
      },
      region: [FORK_POINT_TITLE, FORK_POINT],
      marks: [
        {
          target: FORK_POINT_TITLE,
          says: "**{shown}**: identity first (the thread, the entry its branch ends at, the thread it was forked from), then the conditions, among them the **system prompt**: `pi default`, or a library prompt's name, its mode and the start of its hash.",
        },
        { target: { text: 'forked from', exact: true, within: FORK_POINT }, says: "The parent thread's id." },
        {
          target: { text: 'git', exact: true, within: FORK_POINT },
          says: "The conditions Enso recorded at the last run start: `git` is the project's revision, `config` the hash of the resolved config and where it came from, then the skills, the context files and the mode's rules.",
        },
      ],
    },
  ],
  lookFor: [
    `The thread above was forked before its ${wordFor(ORDINAL_WORDS, FORK_AT)} prompt, the one that asked pi to change \`${EDITED_PATH}\`. The fork holds the first ${wordFor(NUMBER_WORDS, FORK_AT - 1)} prompts and their answers, and nothing after. That is the point to fork from when you want to try the same request another way: on another model, in another mode, or after changing a context file.`,
    "Then compare the two fork points. Outside the identity rows, they should differ in exactly what you changed. If they differ in something else, such as a revision you didn't expect or a context file that changed under you, the two runs are not the comparison you meant. The same goes for two threads started with different system prompts: the **system prompt** row is where they differ. A fork keeps its parent's system prompt, since the prompt is fixed once a thread has sent its first request.",
    'The run context is written only when something in it changes. A thread that answered ten prompts on an unchanged tree carries one record, not ten. A fork inherits the records on its branch, so its first run adds one only if a condition changed.',
    'A thread you open after a restart shows the model it last ran on, marked `model (recorded):`, before anything runs. See [Sessions and projects](./sessions-and-projects.md).',
  ],
  limits: [
    'It records hashes and paths, never the contents of a config value, a context file or a system prompt. It can tell you that `AGENTS.md` changed, or which library prompt a thread started with, not what is in them.',
    "With trees turned off, forking doesn't copy files: the checkout is shared, so a fork that edits a file edits it for every thread in that project. With trees on, the default, a fork gets a tree of its own at that prompt's snapshot. See [Thread trees](./thread-trees.md).",
    "The browser forks at a prompt, as pi's `/fork` does. Moving inside one thread's tree (pi's `/tree` and `/branch`) is not in the browser.",
    'There is no side-by-side comparison view. You compare the two fork points yourself, or with [Session eval](./session-eval.md).',
    "**Continue** doesn't run pi's start-of-prompt hooks, so the continued turn gets no mode reminder and no fresh run-context check.",
  ],
  see: [
    {
      path: 'docs/seams/storage.md',
      label: 'Storage seam',
      why: "how a fork's session file is written, and why the source is never touched",
    },
    { path: 'docs/flows/resume.md', label: 'Resume', why: 'how a stored thread opens cold' },
    { path: 'docs/glossary.md', label: 'Glossary', why: '*fork point* and *run provenance*' },
    {
      path: 'docs/reference/routes.md',
      label: 'HTTP routes',
      why: '`POST /api/threads/:threadId/fork`, `GET /api/threads/:threadId/manifest` and `POST /api/threads/:threadId/continue`',
    },
  ],
}
