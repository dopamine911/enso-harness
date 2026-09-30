import { ENSO_DEFAULT_DENY_RULES } from '../../../packages/core/src/permission-rules.ts'
import { stringIn, stringsIn } from '../source-constants.ts'
import type { FeatureSpec, MarkTarget } from './spec.ts'

const ADAPTER = 'packages/web/src/host/permission-mode-adapter.ts'
/** Every mode picc registers, in picc's order (`permission-mode-adapter.ts`). */
const MODES = stringsIn(ADAPTER, 'PICC_PERMISSION_MODES')
/** The mode a thread is in before anything changed it: picc's own starting mode, as the adapter restores it. */
const STARTING_MODE = stringIn(ADAPTER, 'PICC_DEFAULT_PERMISSION_MODE')

/** What each mode lets pi do without asking, in a reader's words. */
const MAY: Readonly<Record<string, string>> = {
  default: 'Read inside the project, and run read-only shell commands. Edits and writes ask first.',
  acceptEdits:
    'Also edit inside the project, and run `mkdir`, `touch`, `rm`, `rmdir`, `mv`, `cp` and `sed`. Anything else asks.',
  plan: 'Write its plan file. Other edits ask, as in `default`.',
  bypassPermissions:
    'Everything, except a list of dangerous paths such as `.gitconfig`, `.bashrc`, `.git/` and `.claude/`.',
  auto: 'Reads, and edits inside the project. Anything else is judged by a model, and asks you when that model is unavailable.',
}

// picc's list is not a type core owns, so a mode added or renamed there stops the build here.
const described = Object.keys(MAY)
if (described.length !== MODES.length || MODES.some((mode) => !described.includes(mode)))
  throw new Error(`permission-modes: picc's modes are ${MODES.join(', ')}; the spec describes ${described.join(', ')}`)

const MODE_TABLE = [
  '| Mode | pi may, without asking |',
  '|---|---|',
  ...MODES.map((mode) => `| \`${mode}\` | ${MAY[mode]} |`),
].join('\n')

/** `a`, `a and b`, `a, b and c`. */
function listed(words: readonly string[]): string {
  return words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`
}

const SLASH_COMMANDS = listed(MODES.map((mode) => `\`/${mode}\``))

/** The commands the seeded deny rules stop, as a reader would type them: `Bash(git commit * --no-verify*)` is `git commit --no-verify`. */
const DENIED_COMMANDS = [
  ...new Set(
    ENSO_DEFAULT_DENY_RULES.map((rule) =>
      rule
        .replace(/^Bash\((.*)\)$/, '$1')
        .replaceAll(' * ', ' ')
        .replace(/ ?\*$/, ''),
    ),
  ),
].map((command) => `no \`${command}\``)

const MODE_LINE: MarkTarget = { text: 'Mode: default', exact: true }
const SELECTOR: MarkTarget = { role: 'combobox', name: 'permission mode' }

/** Permission modes (#482): the demo thread's mode line and the mode selector. */
export const PERMISSION_MODES: FeatureSpec = {
  id: 'permission-modes',
  title: 'Permission modes',
  shows: [
    'A permission mode says how much pi may do before it asks you. Each thread has one mode at a time, and you can change it while the thread is open. The modes come from the permission-modes extension Enso loads, not from Enso itself:',
    MODE_TABLE,
    'When pi needs to ask, the question appears in the chat. See [Questions and dialogs](./questions-and-dialogs.md).',
    `Within a mode, your permission rules decide what else runs without asking, what always asks, and what is refused. They live in \`~/.enso/permissions.json\` (\`ENSO_HOME/permissions.json\`), in the extension's \`allow\`, \`deny\` and \`ask\` lists, for example \`"deny": ["Bash(npm publish*)"]\`. A new \`ENSO_HOME\` starts with Enso's deny rules only: ${listed(DENIED_COMMANDS)}. The launch log says which file was used, and how many rules of each kind it holds.`,
  ],
  opens: [
    'The **mode** selector sits above the composer. Pick a mode to change it.',
    `Or type \`/mode\` in the chat to choose from a list, or \`/mode <name>\`. ${SLASH_COMMANDS} switch directly.`,
    "A new thread's mode is picked in **Start a session**.",
  ],
  shots: [
    {
      image: 'permission-modes',
      alt: 'The mode line and the mode selector',
      go: async (ui) => {
        await ui.openThread()
        await ui.scrollTo(MODE_LINE)
      },
      region: [MODE_LINE, SELECTOR, { placeholder: 'ask pi something' }],
      marks: [
        {
          target: MODE_LINE,
          says: 'The mode, as a line in the chat. Every change adds one, so the transcript shows when each mode started.',
        },
        { target: SELECTOR, says: 'The **mode** selector. It lists the modes this thread offers.' },
      ],
    },
  ],
  lookFor: [
    'Read the mode lines with the tool calls around them. A run of edits that went through without a question is expected under `acceptEdits`, and worth a look under `default`.',
    "A change you make is not applied by the click. The server asks the thread to change, and the new mode arrives back on the thread's feed like any other event. So the selector always shows the mode pi is actually in, and a change refused because the thread is busy leaves it as it was.",
    `A new thread shows the mode as \`unknown\` until its first prompt has run. It starts in \`${STARTING_MODE}\`.`,
  ],
  limits: [
    'A mode is not a guard. The guards apply in every mode, `bypassPermissions` included. See [Guards and receipts](./guards-and-receipts.md).',
    'The terminal\'s print variant (`bun run enso -p "…"`) has no permission modes. There is nobody to ask, so the extension would refuse every edit. Only Enso\'s guards apply there, and `bash` is not confined.',
    "Enso does not read Claude Code's permission rules (`~/.claude/settings.json`). Copy the ones you want into `permissions.json` yourself.",
    "A file with no rules left in it is filled with Enso's deny rules again at the next launch. Otherwise the extension would import Claude Code's rules into it.",
    'An edit to `permissions.json` applies to sessions started after it. A running thread keeps the rules it started with.',
    'A file that is not plain JSON stops the launch, and the error names the file. Comments are not allowed.',
    'A mode the thread does not offer is refused, and so is a change while the thread is running.',
  ],
  see: [
    {
      path: 'docs/seams/permission-mode.md',
      label: 'Permission mode seam',
      why: 'how a mode change travels, and why the selector follows the feed',
    },
    { path: 'docs/flows/boot-and-launchers.md', label: 'Boot and launchers', why: 'the print variant' },
    { path: 'docs/features/terminal.md', label: 'Terminal' },
  ],
}
