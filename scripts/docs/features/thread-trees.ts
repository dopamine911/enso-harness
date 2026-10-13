import type { FeatureSpec, MarkTarget } from './spec.ts'

const STATUS: MarkTarget = { label: 'thread status' }
const SETTINGS: MarkTarget = { role: 'region', name: 'Settings' }

/**
 * Thread trees (#551, #571, #573, #578): the demo thread runs in its own worktree, as every new
 * thread does by default. The shots read that tree from the status bar and from Settings' Storage;
 * the restore and delete confirmations are said in words — a page has at most two shots — and
 * nothing is confirmed, so the thread is the same for every shot after.
 */
export const THREAD_TREES: FeatureSpec = {
  id: 'thread-trees',
  title: 'Thread trees',
  landingTagline: 'own tree · restore · disk',
  shows: [
    "Each new thread works in a tree of its own, not in your checkout. When the project is a git repository's top level, the tree is a git worktree on a branch of its own, `enso/<thread-id>`; otherwise it is a copy of the project. It starts from your checkout as you left it, uncommitted edits and untracked files included, never your ignored files such as `node_modules` or `.env`. pi's file tools stay inside it, so one thread cannot write into another thread's files, or into yours.",
    "A project says how its new trees are prepared, on its own page: **Project settings…** in the project's menu on the rail, or **Settings** on its card on the **Projects** page, opens its **Worktree settings** tab (#871). **Files to copy into a new tree** names ignored files such as `.env` to copy in from your checkout, and **Setup commands** run in each new tree, in order, before its first run: an install, so the project's tools, and its git hooks, work there. **New threads run in** set to `off` keeps the project's new threads in its folder, with no tree. Each value says where it comes from: your settings, the project's shared `.enso/config.json`, committed with it, or `.enso/config.local.json`, yours alone. **Save changes to** names the file a change goes in before you save: **Only me — this project** (`.enso/config.local.json`) or **Shared — committed with the project** (`.enso/config.json`) (#754).",
    "At the start of every run, Enso takes a snapshot of the tree. **Restore files to here**, under any prompt you sent, puts the tree's files back to how they were when that prompt ran. The conversation is not changed, but your next prompt tells pi the files went back, and to which prompt, so it doesn't work from files that are gone (#652). The files the restore replaced are kept: **Undo last restore** puts them back. A fork made at a prompt gets a tree of its own, at that prompt's snapshot.",
    "Deleting a thread removes its tree, its branch and its snapshots, after checking what the tree still holds. **Settings** → **Storage** lists every tree with what it takes on disk, and each project's group opens that project's **Storage** tab, which lists its trees alone.",
  ],
  opens: [
    "{steps}: the status bar says where the thread's edits land. Trees are on by default.",
    [
      "To keep threads in your checkout, set **New threads run in** to `off` on the project's page, or turn trees off in `ENSO_HOME/config.json`, for every project or for one:",
      '',
      '```json',
      '{ "threads": { "tree": "off" } }',
      '{ "threads": { "projects": { "~/code/big-repo": "off" } } }',
      '```',
      '',
      "A trusted project's own `.enso/config.json`, and your `.enso/config.local.json` beside it, set the same keys for that project, and win over yours: the local file first, then the shared one (#754). Trust a project, or revoke it, from its page: the confirmation lists the setup commands its files declare before anything is trusted, and the change applies to the next tree (see [Sessions and projects](./sessions-and-projects.md), #873). A launch that relies on the default says so in its log.",
    ].join('\n'),
    '**Restore files to here** is under each prompt you sent, beside **fork from here**.',
    '**Settings** → **Storage** lists the trees: **Settings** is at the foot of the rail. The trash icon in the header deletes the thread on screen, through the same confirmation.',
  ],
  shots: [
    {
      image: 'thread-trees-status',
      alt: 'The status bar of a thread on its own tree',
      go: async (ui) => {
        await ui.openThread()
      },
      region: [STATUS],
      marks: [
        {
          target: { text: 'own tree, not your checkout', exact: true, within: STATUS },
          says: "**{shown}**: this thread's edits land in its tree. Your checkout is not touched. Click it to see where the tree is and what it built.",
        },
        {
          target: { text: /^enso\//, within: STATUS },
          says: "The tree's branch, and its state: the git readout is the tree's, not your checkout's.",
        },
      ],
      measure: {
        branch: (page) =>
          page
            .getByLabel('thread status')
            .getByText(/^enso\//)
            .first(),
      },
      after: [
        "**Restore files to here**, under a prompt, first asks: the thread's files go back to how they were at that prompt, the conversation is not changed (pi is told on your next prompt), and the current files are kept as a safety snapshot. Once it is done, a notice names both snapshots, with **Undo last restore**, which puts the files from before back.",
        "**What this thread built** opens from the bar's **own tree, not your checkout**, and from **Preview** beside it once the tree holds an HTML page: the tree's full path, with **Copy path**, and the HTML pages at its top two levels. **Open preview** opens a page in a new tab, served from the tree as it is now, so you can try what the thread built.",
      ],
    },
    {
      image: 'thread-trees-listing',
      alt: 'Settings → Storage, listing the project’s trees with their sizes',
      go: async (ui) => {
        await ui.openThread()
        await ui.click({ role: 'button', name: 'Settings', exact: true })
        await ui.click({
          role: 'button',
          name: 'Storage',
          exact: true,
          within: { role: 'navigation', name: 'Settings sections' },
        })
        await ui.page
          .getByRole('region', { name: 'Settings' })
          .getByText(/^snapshots /)
          .waitFor()
      },
      region: [SETTINGS],
      marks: [
        {
          target: { label: 'storage totals', within: SETTINGS },
          says: 'The totals across every project: how many trees, what they take, and what the snapshot stores take. A sum with a size not fully read says `at least`, and how many were not.',
        },
        {
          target: { text: / on disk/, within: { role: 'region', name: /^trees of /, within: SETTINGS } },
          says: "**{shown}**: the project's trees plus its snapshot store, the same number its card on the Projects page says.",
        },
        {
          target: { text: /^snapshots /, within: SETTINGS },
          says: "**{shown}**: the project's snapshot store, shared by all its threads' snapshots.",
        },
        {
          target: {
            text: /^\d+(\.\d)? (B|kB|MB|GB|TB)$/,
            within: { role: 'list', name: /^each tree of /, within: SETTINGS },
          },
          says: 'What the tree takes on disk, ignored files and installs included. Trees are listed largest first.',
        },
        {
          target: { text: /^the tree holds work/, within: SETTINGS },
          says: "What deleting it would refuse for, in the delete's own words; `clean` when nothing.",
        },
        {
          target: { role: 'button', name: /^delete thread /, within: SETTINGS },
          says: "Deletes the thread, through the header's confirmation.",
        },
      ],
      after: [
        "The trash icon opens the header's confirmation: what goes (the conversation, the tree by path and branch, and what it takes on disk), and the work deleting would lose, named before anything goes. **Delete anyway** deletes exactly that work; work the tree gained since is named again first.",
      ],
      measure: {
        treeSize: (page) => page.getByRole('region', { name: 'Settings' }).locator('li .tabular-nums').first(),
      },
    },
  ],
  lookFor: [
    "The tree's branch, `{branch}`, is a real branch in your repository. `git worktree list` and `git branch` in your checkout show it for as long as the thread exists.",
    "The demo thread's edit is in its tree only: the checkout it started from is as it was. That is why its row above names work. The edit is uncommitted, on the tree's own branch.",
    "The tree above takes {treeSize}, since the demo project is tiny. A tree holds every tracked and unignored file, plus whatever pi installs or builds in it, so a JavaScript project's tree is often hundreds of megabytes once `node_modules` is in it. Sizes are counted as `du` counts them, under a time limit: a count that was cut short says `at least`, and why.",
    "A delete is refused while the tree holds work you would lose: untracked or modified files, a change the last snapshot doesn't have, a commit no other branch reaches. **Delete anyway** deletes exactly the work it named.",
  ],
  limits: [
    "Nothing brings a tree's work back into your checkout yet. For a worktree, `git merge enso/<thread-id>` brings what was committed. Uncommitted edits, and everything in a copy, you copy over yourself.",
    "A tree has none of your ignored files until the project's setup copies them in or recreates them. With no setup configured, a build or a test may need its install step first.",
    "Setup commands run on your machine, as you, whenever a tree is made. The project's own files are read only once you trust the project, but a change to them after that is not asked about again (#753): the commands the trust confirmation listed are the ones there when you trusted it.",
    'A setup that fails is said in **What this thread built**, with its output; the thread still opens.',
    "The isolation is of files, not of git: in a worktree, bash `git` still reaches your repository's refs, config and remotes.",
    'A tree is kept until its thread is deleted. Nothing removes old trees on its own.',
    'A restore and its undo change the files only. The conversation, and anything pi did outside the tree, stay as they were.',
    "Turning trees off for a project doesn't move a thread that already has one.",
    "A preview runs sandboxed: it cannot reach Enso, and a page's own `fetch()` of its files is blocked. Pages that load their scripts, styles and images by tag work; nothing builds the work or runs a dev server.",
  ],
  see: [
    {
      path: 'docs/architecture.md',
      label: 'Architecture',
      why: 'where trees, snapshot stores and the shared object store live, and what writes them',
    },
    {
      path: 'docs/reference/env-and-config.md',
      label: 'Environment and configuration',
      why: 'the `threads` section of `config.json`',
    },
    {
      path: 'docs/reference/routes.md',
      label: 'HTTP routes',
      why: '`POST /api/threads/:threadId/restore`, `POST /api/threads/:threadId/restore/undo`, `GET /api/threads/:threadId/delete-preview`, `DELETE /api/threads/:threadId` and `GET /api/trees`',
    },
    { path: 'docs/features/lineage.md', label: 'Forks and lineage', why: 'forking at a prompt' },
  ],
}
