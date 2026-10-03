import type { EnsoGitFileChange } from '../../../packages/core/src/git-state.ts'
import { numberIn, stringRecordIn } from '../source-constants.ts'
import type { FeatureSpec, MarkTarget } from './spec.ts'

type FileStatus = EnsoGitFileChange['status']

/**
 * What each status letter means, in a reader's words. Keyed by the core type, so a status added
 * to `EnsoGitFileStatus` fails the typecheck here until it has its words.
 */
const STATUS_MEANS: Readonly<Record<FileStatus, string>> = {
  added: 'added',
  modified: 'modified',
  deleted: 'deleted',
  renamed: 'renamed',
  copied: 'copied',
  'type-changed': 'type changed, such as a file that became a symlink',
  untracked: 'new and untracked',
}

/** The letter the tree marks each status with (`thread-changes.tsx`), in the order it declares them. */
const STATUS_LETTER = stringRecordIn('packages/web/src/thread-changes.tsx', 'STATUS_LETTER')

function meaningOf(status: string): string {
  if (!(status in STATUS_MEANS)) throw new Error(`diff: the spec has no words for the status ${status}`)
  return STATUS_MEANS[status as FileStatus]
}

const LEGEND = Object.entries(STATUS_LETTER)
  .map(([status, letter]) => `\`${letter}\` ${meaningOf(status)}`)
  .join(', ')

/** The most files the Changes route sends (`git.ts`). */
const MAX_CHANGED_FILES = numberIn('packages/core/src/git.ts', 'MAX_CHANGED_FILES')

const PANEL: MarkTarget = { role: 'tabpanel', name: 'Diff' }
/** pi's one edit, as the diff shows its new line. */
const EDITED_LINE = "required('DATABASE_URL')"

/** The Diff tab (#452): pi's one edit to the demo project, in the tree and side by side. */
export const DIFF: FeatureSpec = {
  id: 'diff',
  title: 'Diff',
  landingTagline: 'every changed file · side by side',
  shows: [
    "The **Diff** tab shows every file in the thread's project that differs from the last push, and what changed in it. The files are on the left as a tree, and the one you pick is on the right, side by side: the file at the last push on the left, the file now on the right.",
    "When the project is a folder inside a larger repository, only that folder's files are compared, and the header says `in <folder>/`. Files elsewhere in the repository are never listed or read. The status bar's counts cover the same folder, while its commits ahead and behind are the whole repository's.",
    "On a thread with a tree of its own, the default, those are the tree's files on the tree's branch, `enso/<thread-id>`, not your checkout's. See [Thread trees](./thread-trees.md).",
    "It reads git, not pi's tool calls. So a change shows up however it was made: an `edit`, a `write`, a `sed -i` or a formatter run through `bash`, or your own editor. Commits you have not pushed yet count, and so do staged and unstaged edits, deletions, renames and new files.",
  ],
  opens: [
    '{steps}.',
    'It reads again whenever a tool call finishes and when a run ends, so you can leave it open while pi works.',
  ],
  shots: [
    {
      image: 'diff',
      alt: 'The Diff tab',
      go: async (ui) => {
        await ui.openThread()
        await ui.tab('Diff')
        await ui.page.getByRole('tabpanel', { name: 'Diff' }).getByText(EDITED_LINE).first().waitFor()
      },
      marks: [
        {
          target: { text: 'no remote to compare with', within: PANEL },
          says: 'What the files are compared with. Here, `{shown}`, because the demo project has no remote.',
        },
        {
          target: { role: 'navigation', name: 'changed files', within: PANEL },
          says: `The tree of changed files. Each file shows its status letter (${LEGEND}) and the lines added and removed. A folder shows the total for the files under it, and folds away when clicked.`,
        },
        {
          target: { role: 'heading', name: 'src/config.ts', within: PANEL },
          says: 'The file on screen, with its status and counts.',
        },
        {
          target: { text: EDITED_LINE, within: PANEL },
          says: 'The change itself: the removed line on the left, the added line on the right, each with its line number.',
        },
      ],
      measure: {
        unchangedLines: (page) =>
          page
            .getByRole('tabpanel', { name: 'Diff' })
            .getByText(/unchanged lines?$/)
            .first(),
        // The status bar's git readout: its hover names the repository it reads.
        gitReadout: (page) =>
          page
            .getByLabel('thread status')
            .getByTitle(/(^|\n)repository \//)
            .first(),
      },
    },
  ],
  lookFor: [
    `pi changed one line of \`src/config.ts\`: \`Bun.env.DATABASE_URL\` became \`${EDITED_LINE}\`. The tree has that one file, and the diff pairs the old line with the new one, so an edit reads as one row, not a deletion and an addition.`,
    "The row above the lines, `{unchangedLines}`, is git's summary of what it left out before this part of the file. git sends three lines of context around each change. The tab shows those and counts the rest, rather than reading the whole file.",
    'Hover the comparison line at the top to see that it is what this copy of the repository last saw of the remote. The status bar says the same in short: `{gitReadout}`.',
  ],
  limits: [
    'It never fetches, pushes or changes anything in git. "The last push" is what this copy last saw of the remote; run `git fetch` yourself to update it. How the baseline is chosen is in [Sessions and projects](./sessions-and-projects.md).',
    "It shows what differs, not who changed it. An edit you made before the session appears beside pi's.",
    `A binary file, one too large to send to the page, or one git did not produce a diff for is listed without a diff, and says why. Past ${MAX_CHANGED_FILES} files the list stops and says so.`,
    "It can't expand the unchanged lines between two parts of a file. Run `git diff` for the whole file.",
  ],
  see: [
    {
      path: 'docs/reference/routes.md',
      label: 'Routes',
      why: '`GET /api/threads/:threadId/changes`, and `GET /api/threads/:threadId/git` for the state the status bar shows',
    },
    {
      path: 'docs/features/sessions-and-projects.md',
      label: 'Sessions and projects',
      why: 'the git readout in the status bar, and what "last push" means',
    },
  ],
}
