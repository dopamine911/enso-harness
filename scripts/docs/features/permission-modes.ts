import {
  ENSO_DEFAULT_PERMISSION_MODE,
  ENSO_MODE_PRESETS,
  ENSO_PERMISSION_MODES,
} from '../../../packages/core/src/permission-modes.ts'
import { ENSO_DEFAULT_PERMISSION_POLICY } from '../../../packages/core/src/permission-rules.ts'
import { numberIn } from '../source-constants.ts'
import type { FeatureSpec, MarkTarget } from './spec.ts'

/** The extension that sets the mode and answers `auto`'s asks (#496). */
const MODES_EXTENSION = 'packages/harness/extensions/permission-modes/index.ts'
const CLASSIFIER_SECONDS = numberIn(MODES_EXTENSION, 'ENSO_AUTO_CLASSIFIER_TIMEOUT_MS') / 1000

/** A preset's summary as a table cell: a sentence. */
function sentence(fragment: string): string {
  return `${fragment.charAt(0).toUpperCase()}${fragment.slice(1)}.`
}

const MODE_TABLE = [
  '| Mode | What changes |',
  '|---|---|',
  ...ENSO_PERMISSION_MODES.map((mode) => `| \`${mode}\` | ${sentence(ENSO_MODE_PRESETS[mode].summary)} |`),
].join('\n')

/** `a`, `a and b`, `a, b and c`. */
function listed(words: readonly string[]): string {
  return words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`
}

const SLASH_COMMANDS = listed(ENSO_PERMISSION_MODES.map((mode) => `\`/${mode}\``))

const SEED = ENSO_DEFAULT_PERMISSION_POLICY.permission

/** The tools the seed lets run without asking, by name. */
const ALLOWED_TOOLS = Object.entries(SEED)
  .filter(([, rule]) => rule === 'allow')
  .map(([tool]) => `\`${tool}\``)

/** The patterns of one of the seed's pattern maps that carry `action`. */
function patternsWith(rules: Readonly<Record<string, string>>, action: string): string[] {
  return Object.entries(rules)
    .filter(([, rule]) => rule === action)
    .map(([pattern]) => pattern)
}

/** The commands the seed denies, as a reader would type them: `git commit * --no-verify*` is `git commit --no-verify`. */
const DENIED_COMMANDS = [
  ...new Set(patternsWith(SEED.bash, 'deny').map((pattern) => pattern.replaceAll(' * ', ' ').replace(/ ?\*$/, ''))),
].map((command) => `no \`${command}\``)

/** The read-only commands the seed allows, one per command: `git diff` and `git diff *` are one. */
const READ_ONLY_COMMANDS = new Set(patternsWith(SEED.bash, 'allow').map((pattern) => pattern.replace(/ \*$/, ''))).size

const ENV_PATTERNS = patternsWith(SEED.path_read, 'deny').map((pattern) => `\`${pattern}\``)

const MODE_LINE: MarkTarget = { text: 'Mode: default', exact: true }
const SELECTOR: MarkTarget = { role: 'combobox', name: 'permission mode' }

/** Permission modes (#482, #496): the demo thread's mode line and the mode selector. */
export const PERMISSION_MODES: FeatureSpec = {
  id: 'permission-modes',
  title: 'Permission modes',
  landingTagline: 'how much pi may do before asking',
  shows: [
    "A permission mode says how much pi may do before it asks you. Each thread has one mode at a time, and you can change it while the thread is open. Every mode is a preset Enso lays over your permission policy for that thread (`default`'s only refuses MCP servers you have not approved); the modes follow [Claude Code's](https://code.claude.com/docs/en/permission-modes):",
    MODE_TABLE,
    'When pi needs to ask, the question appears in the chat. See [Questions and dialogs](./questions-and-dialogs.md).',
    `Your permission policy lives in \`~/.enso/permissions.json\` (\`ENSO_HOME/permissions.json\`). Its \`permission\` block names each tool or surface and what happens to it: \`allow\`, \`ask\` or \`deny\`, or a map from pattern to one of those in which the last matching pattern wins, for example \`"bash": { "*": "ask", "npm publish*": "deny" }\`. A deny rule denies in every mode. A new \`ENSO_HOME\` starts with Enso's default policy: ${listed(ALLOWED_TOOLS)} run without asking; edits and writes ask; shell commands ask, except ${READ_ONLY_COMMANDS} read-only ones such as \`git status\` and \`ls\`; ${listed(DENIED_COMMANDS)}; ${listed(ENV_PATTERNS)} files are denied to every tool; anything outside the project asks. The launch log says which file was used.`,
    `In \`auto\`, a question pi would ask you goes first to a classifier: the thread's own model, asked whether the action stays within what you asked for. It allows the action or refuses it with a reason pi reads. When it cannot answer (no model, no credentials, no reply within ${CLASSIFIER_SECONDS} seconds, a reply it cannot read) you are asked instead. A rule you wrote to ask, such as \`"git push*": "ask"\`, always reaches you, and so does a file path or a directory outside the project that the classifier would allow.`,
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
    `A new thread shows the mode as \`unknown\` until its first prompt has run. It starts in \`${ENSO_DEFAULT_PERMISSION_MODE}\`.`,
  ],
  limits: [
    'A mode is not a guard. The guards apply in every mode, `bypassPermissions` included. See [Guards and receipts](./guards-and-receipts.md).',
    '`bypassPermissions` still asks for a command run through a wrapper (`bash -c`, `sudo`, `eval`) and for one the permission engine cannot parse.',
    'A shell command the policy allows may redirect its output into a file inside the project (`cat a > b`) without asking. Writes outside the project still ask.',
    'The terminal\'s print variant (`bun run enso -p "…"`) has no permission modes. There is nobody to ask, so the permission engine would refuse every ask. Only Enso\'s guards apply there, and `bash` is not confined.',
    "Enso does not read Claude Code's permission rules (`~/.claude/settings.json`). Copy the ones you want into `permissions.json` yourself.",
    'An `ENSO_HOME` from before #496 held its rules as `allow`, `deny` and `ask` lists. The first launch after moves that file aside as `permissions.json.picc-backup` and seeds the default policy; the old rules are not carried over.',
    'An edit to `permissions.json` applies at the next tool call, in running threads too. A file that is not plain JSON stops the launch, and the error names the file; comments are not allowed. Break it while a thread runs and that thread reads an empty policy: every call asks, and the deny rules are gone until the file is fixed.',
    "A trusted project's own `.pi/` settings for the permission engine, and its `.pi/agents/` files, are read over your policy and can loosen it. In the web app every project counts as trusted; in the terminal, pi's own trust question decides.",
    'A mode the thread does not offer is refused, and so is a change while the thread is running.',
    'Enso loads no MCP tools yet. Every mode refuses an MCP server\'s tools by default; a server your policy names after Enso\'s catch-all, as in `"mcp": { "**": "ask", "github": "allow" }`, keeps its own rule in every mode.',
  ],
  see: [
    {
      path: 'docs/seams/permission-mode.md',
      label: 'Permission mode seam',
      why: 'how a mode is set and read, the policy file, `auto`, and the known gaps',
    },
    { path: 'docs/flows/boot-and-launchers.md', label: 'Boot and launchers', why: 'the print variant' },
    { path: 'docs/features/terminal.md', label: 'Terminal' },
  ],
}
