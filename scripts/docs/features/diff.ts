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
/** The largest file the Diff view reads whole to expand, either side, in KiB (`git.ts`). */
const MAX_FILE_TEXT_KIB = numberIn('packages/core/src/git.ts', 'MAX_FILE_TEXT_BYTES') / 1024
/** The longest line the Diff view colours, in characters (`diff-highlight.ts`). */
const MAX_TOKENIZED_LINE = numberIn('packages/web/src/diff-highlight.ts', 'MAX_TOKENIZED_LINE')

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
    "A thread whose tree is a copy of the project, as a project with no commit yet always gets, has no git of its own. There the tab shows the files changed in the thread's copy since the copy was made, read from the thread's snapshots, under a header that names the project's folder. A copy has no branch and no last push, so the header says nothing about either, and files the project's repository ignores are not listed.",
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
    "The row above the lines, `{unchangedLines}`, is git's summary of what it left out before this part of the file. git sends three lines of context around each change, and the tab counts the rest. Click the count to show those lines, numbered on both sides, and click it again to hide them. The lines after the last change get a count of their own. The code is coloured by its language, in the theme's own colours.",
    'Hover the comparison line at the top to see that it is what this copy of the repository last saw of the remote. The status bar says the same in short: `{gitReadout}`.',
  ],
  limits: [
    'It never fetches, pushes or changes anything in git. "The last push" is what this copy last saw of the remote; run `git fetch` yourself to update it. How the baseline is chosen is in [Sessions and projects](./sessions-and-projects.md).',
    "It shows what differs, not who changed it. An edit you made before the session appears beside pi's.",
    `A binary file, one too large to send to the page, or one git did not produce a diff for is listed without a diff, and says why. Past ${MAX_CHANGED_FILES} files the list stops and says so.`,
    `When both the old and the new version of a file are larger than ${MAX_FILE_TEXT_KIB} KiB, its unchanged lines stay as counts, marked \`too large to expand\`. A file that changed again after its diff was read is marked \`changed since this diff\` until the tab reads again. Run \`git diff\` on the file to see it whole.`,
    'Only a file inside the project is read whole. A project inside a larger repository never reads a file outside its own folder.',
    `Syntax colours cover common languages, such as TypeScript, JavaScript, Python, Go, Rust, shell, JSON, YAML, CSS, HTML and Markdown. A file in any other language is shown uncoloured, and so is a line longer than ${MAX_TOKENIZED_LINE} characters.`,
  ],
  see: [
    {
      path: 'docs/reference/routes.md',
      label: 'Routes',
      why: '`GET /api/threads/:threadId/changes`, `GET /api/threads/:threadId/changes/file` for one file whole, and `GET /api/threads/:threadId/git` for the state the status bar shows',
    },
    {
      path: 'docs/features/sessions-and-projects.md',
      label: 'Sessions and projects',
      why: 'the git readout in the status bar, and what "last push" means',
    },
  ],
}
