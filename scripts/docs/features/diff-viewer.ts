import type { FeatureSpec, MarkTarget, ReachedShot } from './spec.ts'

const PANEL: MarkTarget = { role: 'tabpanel', name: 'Diff Viewer' }
/** pi's one edit, in the third prompt's turn, as the diff shows its new line. */
const EDITED_LINE = "required('DATABASE_URL')"

/** The Diff Viewer tab on the demo thread's third turn: pi's one edit, between that turn's two snapshots. */
const PROMPT_RUNS_SHOT: ReachedShot = {
  image: 'diff-viewer',
  alt: 'The Diff Viewer tab',
  go: async (ui) => {
    await ui.openThread()
    await ui.tab('Diff Viewer')
    await ui.page.getByRole('tabpanel', { name: 'Diff Viewer' }).getByText(EDITED_LINE).first().waitFor()
  },
  marks: [
    {
      target: { role: 'button', name: 'previous turn', within: PANEL },
      says: 'Step to the turn before or after. The count says which turn this is, of how many.',
    },
    {
      target: { role: 'group', name: 'what the diff compares', within: PANEL },
      says: "What the diff compares: this turn alone, or the thread's baseline up to the end of this turn.",
    },
    {
      target: { role: 'list', name: 'prompts', within: PANEL },
      says: 'Every turn, marked by what it holds: `●` files changed, `○` no files changed, `?` a snapshot missing, `…` not captured yet.',
    },
    {
      target: { text: /→ the files after turn/, within: PANEL },
      says: 'The two snapshots compared, each by its short hash: `{shown}`.',
    },
    {
      target: { text: EDITED_LINE, within: PANEL },
      says: "The turn's change, side by side, as on the Diff tab.",
    },
  ],
}

/** The Diff Viewer (#553): the thread's prompts, stepped through snapshot to snapshot. */
export const DIFF_VIEWER: FeatureSpec = {
  id: 'diff-viewer',
  title: 'Diff Viewer',
  landingTagline: 'turn by turn · snapshot to snapshot',
  shows: [
    "The **Diff Viewer** tab is the Diff Viewer: it steps through the thread's prompts, one prompt at a time, and shows the files each turn changed. A turn's files are compared as Enso's snapshots recorded them: the files as the turn began, against the files as the next turn began.",
    "Two views of a turn: **This turn** shows what changed during it, and **Up to this turn** shows everything that changed from the thread's baseline to the end of it. The baseline is the snapshot the thread's tree was made from. A fork's baseline is the snapshot it inherited at the fork point, named in the header, and the prompts it inherited from its source are not listed: they are the source's.",
    'It is not the **Diff** tab. The Diff tab compares the files now with the last push; the Diff Viewer compares two snapshots, so a turn shows what it showed while pi runs on, or after you change the files yourself.',
  ],
  opens: [
    '{steps}.',
    "Step with **Previous** and **Next**, or choose a turn in the row of turn numbers. **Show in Chat** opens the turn's prompt in the transcript.",
  ],
  shots: [PROMPT_RUNS_SHOT],
  lookFor: [
    `The third prompt asked pi to make the app refuse to start without \`DATABASE_URL\`, and its turn holds that one edit: \`src/config.ts\`, where \`Bun.env.DATABASE_URL\` became \`${EDITED_LINE}\`.`,
    'The first two prompts only read, so they are marked `○`: their two snapshots hold the same files, and choosing one says so rather than showing an empty diff. The last turn is marked `…`: its result is captured when the next prompt begins.',
    'A turn whose snapshot is missing says why: the run could not take one, the thread ran before snapshots existed, or the store no longer holds it. It never shows a diff in its place.',
  ],
  limits: [
    "It shows what changed on disk, not who changed it. An edit pi made, a formatter run through `bash` and your own editor's save all count, and a restore during the turn is marked as part of it.",
    'It reads only. Stepping through prompts restores nothing and forks nothing: those are the buttons under a prompt in Chat. See [Thread trees](./thread-trees.md) and [Forks and lineage](./lineage.md).',
    "A turn's result is the snapshot the next prompt's run begins with, so the last turn has none until another prompt is sent.",
    'It does not include files a snapshot never takes: those the project ignores, such as `.env`, and an untracked `node_modules`.',
  ],
  see: [
    {
      path: 'docs/reference/routes.md',
      label: 'Routes',
      why: '`GET /api/threads/:threadId/prompts`, `GET /api/threads/:threadId/prompt-runs/changes` and `GET /api/threads/:threadId/prompt-runs/file`',
    },
    {
      path: 'docs/features/thread-trees.md',
      label: 'Thread trees',
      why: "where the snapshots come from, and restoring a thread's files to a prompt",
    },
  ],
}
