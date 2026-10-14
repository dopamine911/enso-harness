import { DEMO_PROJECT, SECOND_MODEL } from '../feature-session.ts'
import type { FeatureSpec, MarkTarget } from './spec.ts'

const LAUNCH_PANEL: MarkTarget = { role: 'region', name: 'What should pi work on?' }
const RAIL: MarkTarget = { role: 'navigation', name: 'threads' }
/** A setting chip of the launch panel, by its accessible name `Setting: value`. */
const chip = (role: 'button' | 'combobox', setting: string): MarkTarget => ({
  role,
  name: new RegExp(`^${setting}: `),
  within: LAUNCH_PANEL,
})

/** Sessions and projects (#395, #86, #877): a new thread's launch panel as the demo session starts, and its thread cold after a restart. */
export const SESSIONS_AND_PROJECTS: FeatureSpec = {
  id: 'sessions-and-projects',
  title: 'Sessions and projects',
  landingTagline: 'where and how a run starts',
  shows: [
    'A project is a folder pi works in. The rail lists your projects, each with its threads under it. A new thread opens on its launch panel, **What should pi work on?**, with the project it runs in and where its work goes (the project folder itself, a copy, or a worktree of its own). The composer under it holds the first prompt, with chips for how the session starts: which model, how much effort, which permission mode, which system prompt. They are applied together when you press **Start session**, and the composer then docks under the transcript, holding what you attached.',
    "Under the composer, **Or pick up where you left off** lists up to three of the project's other threads, the most recent first, each with its state and when it was last active; click one to open it.",
    "A new thread can't start in a project whose folder is gone, or in no project the server lists. The panel says so, **A new thread can’t start here**, with why and **Manage projects**, and **Start session** stays off.",
    "Each project in the rail opens and closes like an accordion. The **current** project (the project of the thread on screen, or behind the page) is open; the others are closed until you open one. Click a project's name to open or close it; the rail keeps what you chose for each project across reloads. A closed project never hides work: when any of its threads is waiting on you, its name shows the violet dot and how many are waiting; otherwise, when any is running, the running dot and how many are running. The signal goes as soon as you answer, or the run ends. Opening a thread of another project makes that project current: it opens, and the one you left goes back to closed unless you had opened it yourself.",
    "At the very top of the rail is the project switcher, named for the current project. Its menu lists every project with its path and its trouble: **folder missing**, and **not trusted** (read as the menu opens). Threads in a project the server no longer lists are under **Not in a project**, with how many there are. The current project is checked. Choosing a project makes it current: it opens its most recent thread (or starts one when it has none), opens it in the rail, and **New thread** then starts there. A project whose folder is gone and which holds no thread can't be chosen. **Add project…** opens the Add project page; **Manage projects** opens the Projects page. The menu works from the keyboard: **Enter** or the down arrow opens it, the arrow keys move, **Enter** chooses, **Escape** closes it.",
    "Inside a project, the rail lists threads under **Today**, **Yesterday** and **Earlier**, by when each was last active, in your browser's own day: Today starts at your local midnight. Within a day, threads that share a title fold into one row with a count (`×31`); click it to open the fold in place, and again to close it. A fold opens by itself when it holds the thread on screen. A closed fold never hides work: when one of its threads is running, or waiting on you, the fold's row shows that dot. A thread with a name of its own folds by that name; a draft, which has no title yet, never folds.",
    '**Search threads**, at the top of the rail under **New thread**, keeps only the threads whose title (or name) holds what you type, in any case, across every project, current or not. A closed project opens while it holds a match, and goes back to how you left it when the search is cleared; a fold whose title matches shows with its count. When nothing matches, the rail says so, with **Clear search**. The × in the box (**clear search**), or **Escape**, empties it.',
    "A thread you ran before is still there after a restart. Until you run it again it is *cold*: Enso reads it from pi's session file, and nothing is running.",
    "A thread is titled by its first prompt. Under the title, the header says what it runs with: its project, model and effort, the model marked `(recorded)` while the thread is cold, and left out until something has said it. Click the title, or choose **Rename** in the header's **thread actions** menu (⋯), and the title becomes a field: **Enter** saves a name of its own, which the rail and the header show and the thread keeps (pi's own session name, the one pi's `/name` sets); **Escape** leaves it as it was. When two prompts in a project start alike, the rail shows each from the words where they part (\"…Approach B: a parser\"), with the whole prompt as the row's hover.",
    'A new thread is **not started** until its first prompt: nothing of it is on the server yet, so it has no Context, Stats or Diff to show, and its **thread actions** menu offers **Discard draft** instead of a delete. A draft you leave with nothing typed in it (no words in its prompt box, no image attached) is dropped from the rail when you open another thread, so unused drafts never pile up; one holding words stays. A thread the server holds but never started (a **Start session** refused, then the page reloaded) opens on its launch panel again, not on an empty transcript.',
    'A thread the rail still lists but the server no longer holds (deleted from another tab, say) opens a page in its place: **This thread isn’t on the server**, with its id, **Start a new thread**, and **Search threads**, which puts you in the rail’s search box.',
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
    '**New thread**, or the **+** beside a project, opens a new thread on its launch panel.',
    "Each project has a page of its own, at `?page=project&project=<id>&tab=threads|worktrees|storage` (#871): **Project settings…** in a project's menu on the rail (the `⋯` beside its **+**, the launch folder's included) opens it at **Worktree settings**: how its new threads' trees are made, the files copied into them and the commands that set them up, each with the file it comes from (see [Thread trees](./thread-trees.md), #754). **Threads** lists the project's threads with their state, the model each last ran on, and when; **Storage** lists its trees with their sizes, under the project's one total. Over the tabs, the page says when the project's folder is missing — **Check again** reads the projects again, and the notice goes once the folder is back — and whether the project is trusted. Under them, **Remove project…** says what removing does before it does it; the folder Enso was started in can't be removed.",
    "A project's name is the one it was added under, or its folder's. Click the name at the top of its page (a pencil shows on hover) and it becomes a field: **Enter** saves a new name, which the rail, the project switcher, the Projects page and the page show, and which a reload or a restart keeps (#939); **Escape** leaves it as it was. Only the name changes: the folder keeps its name and its path. The folder Enso was started in can be renamed too; Enso then remembers it as a project, so started in another folder, it is listed under its new name, as a project added from the page is, when the project rules allow it.",
    "A project's trust decides whether Enso reads its own settings — `.enso/config.json`, `.enso/config.local.json`, and its `.pi/` folder — including the setup commands that run on your machine in every new tree. Not trusted, the project's page says which files it does not read, with **Trust this project…**: the confirmation lists each of those files that is there, with the setup commands it declares as written, or *none*; a file it can't show (a link, say) is named, with a note that trusting reads it anyway. Trusted, the page says so, with **Revoke trust…**. Both write pi's `trust.json`, the answer a thread's **Trust project** saves too, so each shows in the other. A revoke is saved as *not trusted*, so a new thread doesn't ask again; trust it again from the page. A revoke applies at once: Enso won't revoke while one of the project's threads is running, and its open threads that aren't running are closed, so each is rebuilt without the trust at its next prompt. A grant reaches new threads and trees, and an open thread when it is next built (#873).",
    "**Projects** at the foot of the rail opens the Projects page, at its own address `?page=projects` (#870). Every project is a card, the folder Enso was started in first. A card shows the project's name and badges: **current** (the project of the thread behind the page), **started here**, **not trusted** (Enso does not read its own settings files) and **folder missing**. It also shows the path, how many threads the project holds and when one was last active, and what it takes on disk: its thread trees plus its snapshot store, the same number Settings › Storage gives for it. When part of that could not be measured, the size reads \"at least\" and says how much. Last on the card is what a new thread gets: a worktree, a copy, or the folder itself. **Open threads** opens the project's most recent thread, or starts a thread there when it has none. **Settings** opens the project's settings, as **Project settings…** does. The trash opens the rail's own **Remove project — its threads stay on disk**; the folder Enso was started in has none. **Add project** at the top opens the Add project page, as the rail's does.",
    'Click a thread in the rail to open it. A cold thread opens from its file straight away.',
  ],
  shots: [
    {
      image: 'sessions-start',
      alt: 'A new thread’s launch panel',
      during: 'launch-panel',
      marks: [
        {
          target: chip('button', 'Model'),
          says: "**{shown}**: the model the session starts on. It opens the model picker: **Recent** first, the models of your latest threads; then one group per provider under its own name, the ones you're logged in to first. Within a provider, models go by family, newest version first, and each row ends on the effort levels it offers (`off–high`). A provider set up but not logged in is folded under its name with how many models it has: open it to see them, but log in (`/login`) to pick one. **Filter models** narrows the list by name or provider. (The screenshots use a scripted stand-in, listed as `Demo`.)",
        },
        {
          target: chip('combobox', 'Effort'),
          says: "**{shown}**: the thinking level the session will run at, out of the levels this model offers: your setting for the model, else your default, else pi's own. It says `pi's default` when the model names none.",
        },
        {
          target: chip('combobox', 'Mode'),
          says: '**{shown}**: what pi may do without asking. See [Permission modes](./permission-modes.md).',
        },
        {
          target: chip('combobox', 'System prompt'),
          says: '**{shown}**: `pi default`, or a system or append prompt from your library, with its size in tokens. It is fixed for the whole session. A library file that cannot be read is named under the chips. See [Prompts](./prompts.md).',
        },
        {
          target: chip('combobox', 'Saved prompt'),
          says: '**{shown}**: fills the prompt box from one of your session prompts. It is there only when the library has one.',
        },
        {
          target: { role: 'button', name: 'Start session', within: LAUNCH_PANEL },
          says: '**{shown}**: applies the settings, then sends the prompt. Enter in the prompt box does the same; Shift+Enter adds a line. A prompt that starts with `/` cannot start a session: the slash commands belong to a running one.',
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
        {
          target: { role: 'button', name: /Switch project$/ },
          says: 'The project switcher: the current project, where **New thread** starts. Its menu picks another.',
        },
        {
          target: { placeholder: 'Search threads' },
          says: '**Search threads**: keeps the threads whose title holds what you type, across every project.',
        },
        {
          target: { role: 'button', name: DEMO_PROJECT, exact: true, within: { role: 'region', name: DEMO_PROJECT } },
          says: 'The current project, open, with its threads under it. Another project is closed until you open it.',
        },
        {
          target: { text: 'Today', exact: true, within: RAIL },
          says: '**Today**: the threads last active since your local midnight; **Yesterday** and **Earlier** follow.',
        },
        {
          target: { text: 'Where does the app read', within: RAIL },
          says: 'A stored thread. Hover it to see when it last ran.',
        },
        { target: { text: 'Add project', within: RAIL }, says: '**{shown}**.' },
        {
          target: { role: 'button', name: /^Model \(recorded\): / },
          says: 'The model the thread last ran on, `{shown}`, on a chip named **Model (recorded)** because nothing is running yet.',
        },
      ],
    },
  ],
  lookFor: [
    'Nothing on the launch panel changes anything until you press **Start session**. Then the system prompt, the model, the effort and the mode are sent in one request, in that order. If one of them is refused, the panel stays, says which one and why, and marks its chip; the prompt is not sent, and stays in the box with what you attached. So you never get a session that runs your prompt on the wrong model, or under the wrong system prompt.',
    `The thread above was opened after a restart of the app, so it is cold. Its last run was on \`${SECOND_MODEL}\`, which the composer's Model chip names **Model (recorded)**. The Effort chip is hidden, because there is no live session to change. Sending a prompt starts the session again under the same id, and the chip becomes the live model.`,
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
