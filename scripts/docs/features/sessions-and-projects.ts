import { DEMO_PROJECT, SECOND_MODEL } from '../feature-session.ts'
import type { FeatureSpec, MarkTarget } from './spec.ts'

const START_DIALOG: MarkTarget = { role: 'dialog', name: 'Start a session' }
const RAIL: MarkTarget = { role: 'navigation', name: 'threads' }
/** A field of the Start dialog, by its label. */
const field = (label: string): MarkTarget => ({ text: label, exact: true, within: START_DIALOG })

/** Sessions and projects (#395, #86): the Start dialog as the demo session opens, and its thread cold after a restart. */
export const SESSIONS_AND_PROJECTS: FeatureSpec = {
  id: 'sessions-and-projects',
  title: 'Sessions and projects',
  landingTagline: 'where and how a run starts',
  shows: [
    "A project is a folder pi works in. The rail lists your projects, and each project's threads under it. A new thread asks how to start: which model, how much effort, which permission mode, which system prompt, and the first prompt. They are applied together when you start.",
    "A thread you ran before is still there after a restart. Until you run it again it is *cold*: Enso reads it from pi's session file, and nothing is running.",
    "A thread is titled by its first prompt. **Rename** in the header (the pencil) gives it a name of its own, which the rail and the header show and the thread keeps: it is pi's own session name, the one pi's `/name` sets. When two prompts in a project start alike, the rail shows each from the words where they part (\"…Approach B: a parser\"), with the whole prompt as the row's hover.",
  ],
  opens: [
    'The folder you ran `bun run dev` in is always a project.',
    [
      "**Add project** in the rail, or at the top of the Projects page, opens the Add project page, at its own address `?page=add-project` (#866, #872). No config file and no restart are needed. It takes two steps. **Choose a folder**: type its path (`~/` works) and press **Use this path**, or browse from your home folder and press **Choose this folder**. A folder that already is a project is marked **already a project**; choosing it says which project it is, with **Open it**. A folder Enso won't add says why — *\"That's your home folder. An agent there could reach everything you own, so Enso won't add it.\"*, *\"There's no folder at ~/nope.\"* — and nothing is chosen. Hidden folders (`.config`, `.ssh`, …) are left out unless you tick **show hidden folders**. **Confirm access**: the folder, with **Change** to go back to the path you typed; **Name in Enso**, the name the rail and the project's page show (the folder's own name to start with; it can't be empty, and it doesn't rename the folder); and what pi can reach there: everything in the folder, because Enso does not sandbox agents; a tree of it, as the project's tree mode says; and your permission rules, with a link to Settings › Permissions. A folder inside a hidden one says so. **Trust this project’s own settings** is off; ticked, the project is added first, then the trust confirmation below names its files and setup commands before anything is trusted — **Not now** leaves it untrusted, and a trust that could not be saved says so: the project is there, untrusted (#873). **Back** adds nothing; **Add project** adds it and opens the new project's page. Some folders are never projects:",
      '  - your home folder itself, and any folder that holds it (`/` included);',
      "  - Enso's own home (`ENSO_HOME`, `~/.enso` by default) and anything in it.",
      '',
      '  To fence projects in, declare roots in `ENSO_HOME/config.json`; then a project must sit under one of them:',
      '',
      '  ```json',
      '  { "projects": { "roots": ["~/code"] } }',
      '  ```',
    ].join('\n'),
    '**New Thread**, or the **+** beside a project, opens **Start a session**.',
    "Each project has a page of its own, at `?page=project&project=<id>&tab=threads|worktrees|storage` (#871): **Project settings…** in a project's menu on the rail (the `⋯` beside its **+**, the launch folder's included) opens it at **Worktree settings**: how its new threads' trees are made, the files copied into them and the commands that set them up, each with the file it comes from (see [Thread trees](./thread-trees.md), #754). **Threads** lists the project's threads with their state, the model each last ran on, and when; **Storage** lists its trees with their sizes, under the project's one total. Over the tabs, the page says when the project's folder is missing — **Check again** reads the projects again, and the notice goes once the folder is back — and whether the project is trusted. Under them, **Remove project…** says what removing does before it does it; the folder Enso was started in can't be removed.",
    "A project's trust decides whether Enso reads its own settings — `.enso/config.json`, `.enso/config.local.json`, and its `.pi/` folder — including the setup commands that run on your machine in every new tree. Not trusted, the project's page says which files it does not read, with **Trust this project…**: the confirmation lists each of those files that is there, with the setup commands it declares as written, or *none*; a file it can't show (a link, say) is named, with a note that trusting reads it anyway. Trusted, the page says so, with **Revoke trust…**. Both write pi's `trust.json`, the answer a thread's **Trust project** saves too, so each shows in the other. A revoke is saved as *not trusted*, so a new thread doesn't ask again; trust it again from the page. Either change applies to the next thread and the next tree: a thread already open keeps what it loaded until it closes (#873).",
    "**Projects** at the foot of the rail opens the Projects page, at its own address `?page=projects` (#870). Every project is a card, the folder Enso was started in first. A card shows the project's name and badges: **current** (the project of the thread behind the page), **started here**, **not trusted** (Enso does not read its own settings files) and **folder missing**. It also shows the path, how many threads the project holds and when one was last active, and what it takes on disk: its thread trees plus its snapshot store, the same number Settings › Storage gives for it. When part of that could not be measured, the size reads \"at least\" and says how much. Last on the card is what a new thread gets: a worktree, a copy, or the folder itself. **Open threads** opens the project's most recent thread, or starts a thread there when it has none. **Settings** opens the project's settings, as **Project settings…** does. The trash opens the rail's own **Remove project — its threads stay on disk**; the folder Enso was started in has none. **Add project** at the top opens the Add project page, as the rail's does.",
    'Click a thread in the rail to open it. A cold thread opens from its file straight away.',
  ],
  shots: [
    {
      image: 'sessions-start',
      alt: 'The Start a session dialog',
      during: 'start-dialog',
      marks: [
        {
          target: field('Model'),
          says: '**{shown}**: the models your login gives you. **filter models…** narrows the list. (The screenshots use a scripted stand-in, listed as `demo`.)',
        },
        { target: field('Effort'), says: '**{shown}**: the thinking levels this model offers.' },
        {
          target: field('Mode'),
          says: '**{shown}**: what pi may do without asking. See [Permission modes](./permission-modes.md).',
        },
        {
          target: field('System prompt'),
          says: '**{shown}**: `pi default`, or a system or append prompt from your library, with its size in tokens. It is **fixed for the whole session**. A library file that cannot be read is listed under the field by name. See [Prompts](./prompts.md).',
        },
        {
          target: field('Saved prompt'),
          says: '**{shown}**: fills the prompt box from one of your session prompts. It is there only when the library has one.',
        },
        {
          target: field('Prompt'),
          says: '**{shown}**: the first message. Enter starts the session, Shift+Enter adds a line.',
        },
      ],
    },
    {
      image: 'sessions-cold-thread',
      alt: 'A cold thread, opened from the rail',
      cold: true,
      go: async (ui) => {
        await ui.openThread()
      },
      marks: [
        { target: { text: DEMO_PROJECT, exact: true, within: RAIL }, says: 'The project, with its threads under it.' },
        {
          target: { text: 'Where does the app read', within: RAIL },
          says: 'A stored thread. Hover it to see when it last ran.',
        },
        { target: { text: 'Add project', within: RAIL }, says: '**{shown}**.' },
        {
          target: { text: /^model \(recorded\):/ },
          says: 'The model the thread last ran on, `{shown}`, marked recorded because nothing is running yet.',
        },
      ],
    },
  ],
  lookFor: [
    'Nothing in the dialog changes anything until you press **Start session**. Then the system prompt, the model, the effort and the mode are sent in one request, in that order. If one of them is refused, the dialog stays open and says which one, and the prompt is not sent. So you never get a session that runs your prompt on the wrong model, or under the wrong system prompt.',
    `The thread above was opened after a restart of the app, so it is cold. Its last run was on \`${SECOND_MODEL}\`, which the composer shows as \`model (recorded):\`. The thinking selector is hidden, because there is no live session to change. Sending a prompt starts the session again under the same id, and the chip becomes the live model.`,
    "If a thread's last run was cut off before pi answered, the thread shows a notice with a **Continue** button. Continue picks up from the stored state without a new message. See [Forks and lineage](./lineage.md), which also covers what a thread records about the conditions it ran under.",
    "The status bar also says where the project stands in git. It shows the branch, `↑` for commits not pushed yet, `↓` for commits on the remote this branch doesn't have, and the files that changed: `main ↑2 · 1 staged · 3 unstaged`. The file counts are the project folder's own, even when the folder sits inside a larger repository; the commits are the whole repository's. Hover it to see what it is measured from. That is the last push to the branch's upstream if it has one. A branch pushed without an upstream is measured from its copy on the remote. A branch never pushed is measured from where it branched off the remote's default branch, such as `origin/main`. A project with no remote counts only uncommitted changes. The readout updates when a tool call finishes, so a commit or a push by pi shows up straight away. A project outside git says `no git`. The same state is served at `GET /api/threads/:threadId/git`.",
    "A thread on a tree of its own, the default, reads its tree: the branch is the tree's, `enso/<thread-id>`, and the bar says `own tree, not your checkout`. See [Thread trees](./thread-trees.md).",
  ],
  limits: [
    'A project must be strictly inside a declared root. Hidden folders, and links that lead out of a root, are not offered.',
    'Removing a project only forgets the registration. Its threads stay on disk but are not listed or opened until you add the folder again; then they come back.',
    'A thread is stored once pi has answered at least once. A thread closed before its first reply is not kept.',
    'Enso never fetches, pushes or changes anything in git. "Last push" is what this copy of the repository last saw of the remote; run `git fetch` yourself to update it.',
  ],
  see: [
    {
      path: 'docs/flows/resume.md',
      label: 'Resume',
      why: "how a stored thread is opened again, and what a cold thread can and can't do",
    },
    {
      path: 'docs/seams/thread-runtime.md',
      label: 'Thread runtime seam',
      also: { path: 'docs/seams/storage.md', label: 'Storage seam' },
    },
    {
      path: 'docs/reference/env-and-config.md',
      label: 'Environment and configuration',
      why: '`projects.roots` and the rest of `config.json`',
    },
  ],
}
