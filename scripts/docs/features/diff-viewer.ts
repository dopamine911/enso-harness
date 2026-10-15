import type { FeatureSpec, MarkTarget, ReachedShot } from './spec.ts'

const PANEL: MarkTarget = { role: 'tabpanel', name: 'Diff Viewer' }
/** pi's one edit, under the third prompt, as the diff shows its new line. */
const EDITED_LINE = "required('DATABASE_URL')"

/** The Diff Viewer tab on the demo thread's third prompt: pi's one edit, between that prompt's two snapshots. */
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
      target: { role: 'button', name: 'previous prompt', within: PANEL },
      says: 'Step to the prompt before or after. The count says which prompt this is, of how many.',
    },
    {
      target: { role: 'group', name: 'what the diff compares', within: PANEL },
      says: "What the diff compares: this prompt's run alone, or the thread's baseline up to the end of it.",
    },
    {
      target: { role: 'list', name: 'prompts', within: PANEL },
      says: 'Every prompt, marked by what its run holds: `●` files changed, `○` no files changed, `?` a snapshot missing, `…` not captured yet.',
    },
    {
      target: { text: /→ the files after prompt/, within: PANEL },
      says: 'The two snapshots compared, each by its short hash: `{shown}`.',
    },
    {
      target: { text: EDITED_LINE, within: PANEL },
      says: "The prompt's change, side by side, as on the Diff tab.",
    },
  ],
}

/** The Diff Viewer (#553): the thread's prompt runs, stepped through snapshot to snapshot. */
export const DIFF_VIEWER: FeatureSpec = {
  id: 'diff-viewer',
  title: 'Diff Viewer',
  landingTagline: 'prompt by prompt · snapshot to snapshot',
  shows: [
    "The **Diff Viewer** tab steps through the thread's prompts, one at a time, and shows the files that changed while each prompt ran: the prompt and everything pi did for it, up to the next prompt. The files are compared as Enso's snapshots recorded them: the files as the prompt's run began, against the files as the next prompt's run began.",
    "Two views of a prompt: **This prompt** shows what changed while it ran, and **Up to this prompt** shows everything that changed from the thread's baseline to the end of it. The baseline is the snapshot the thread's tree was made from. A fork's baseline is the snapshot it inherited at the fork point, named in the header, and the prompts it inherited from its source are not listed: they are the source's.",
    'It is not the **Diff** tab. The Diff tab compares the files now with the last push; the Diff Viewer compares two snapshots, so a prompt shows what it showed while pi runs on, or after you change the files yourself.',
    "It counts prompts. A turn is something else: one model request, as the Stats tab counts it, and one prompt's run holds several.",
  ],
  opens: [
    '{steps}.',
    'Step with **Previous** and **Next**, or choose a prompt in the row of prompt numbers. **Show in Chat** opens the prompt in the transcript.',
  ],
  shots: [PROMPT_RUNS_SHOT],
  lookFor: [
    `The third prompt asked pi to make the app refuse to start without \`DATABASE_URL\`, and its run holds that one edit: \`src/config.ts\`, where \`Bun.env.DATABASE_URL\` became \`${EDITED_LINE}\`.`,
    'The first two prompts only read, so they are marked `○`: their two snapshots hold the same files, and choosing one says so rather than showing an empty diff. The last prompt is marked `…`: its result is captured when the next prompt begins.',
    'A prompt whose snapshot is missing says why: the run could not take one, the thread ran before snapshots existed, or the store no longer holds it. It never shows a diff in its place.',
  ],
  limits: [
    "It shows what changed on disk, not who changed it. An edit pi made, a formatter run through `bash` and your own editor's save all count, and a restore while the prompt ran is marked as part of it.",
    'It reads only. Stepping through prompts restores nothing and forks nothing: those are the buttons under a prompt in Chat. See [Thread trees](./thread-trees.md) and [Forks and lineage](./lineage.md).',
    "A prompt's result is the snapshot the next prompt's run begins with, so the last prompt has none until another prompt is sent.",
    'It does not include files a snapshot never takes: those the project ignores, such as `.env`, and an untracked `node_modules`.',
  ],
  see: [
    {
      path: 'docs/reference/routes.md',
      label: 'Routes',
      why: '`GET /api/threads/:threadId/prompt-runs`, `GET /api/threads/:threadId/prompt-runs/changes` and `GET /api/threads/:threadId/prompt-runs/file`',
    },
    {
      path: 'docs/features/thread-trees.md',
      label: 'Thread trees',
      why: "where the snapshots come from, and restoring a thread's files to a prompt",
    },
  ],
}
