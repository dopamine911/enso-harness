import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensoAgentDir, ensoSecretsPath, harnessPackageDir } from '../../../packages/core/src/paths.ts'
import { declaredResources } from '../../../packages/core/src/pi-manifest.ts'
import { isSecretShapedName, SECRET_NAME_WORDS } from '../../../packages/core/src/secrets.ts'
import {
  PRINT_VARIANT_NOTE,
  piArguments,
  piVersionText,
  SUPPORTED_PI_VERSIONS,
  secretsKeptOutLine,
  vanillaPiLine,
} from '../../enso-launch.ts'
import { ROOT } from '../flow-tags.ts'
import { stringIn } from '../source-constants.ts'
import type { FeatureSpec } from './spec.ts'

/**
 * The isolation triple's environment leg. ⚠ Named here, not imported: `scripts/enso.ts` writes it
 * as a LITERAL key in pi's spawn, which is how the environment reference (`env-and-config.ts`)
 * finds and lists that write. A shared constant as a computed key would hide it from that page.
 */
const AGENT_DIR_VARIABLE = 'PI_CODING_AGENT_DIR'

/** `ENSO_HOME`'s directory name under the user's home when it is not set (`paths.ts#ensoHome`). */
const HOME_DIRECTORY = stringIn('packages/core/src/paths.ts', 'ENSO_RUNTIME_DIRECTORY')

/** The flags `piArguments` puts before the user's own: the isolation triple's argument legs. */
const ISOLATION_FLAGS = piArguments('', []).filter((argument) => argument.startsWith('--no-'))

/**
 * What each isolation setting stops, in a reader's words, keyed by the setting as the launcher
 * applies it. Checked against the launcher below, so a flag added to `piArguments` or a renamed
 * variable fails at load until it has its row.
 */
const STOPS: Readonly<Record<string, string>> = {
  [AGENT_DIR_VARIABLE]: 'Your global pi packages, settings and login. This run cannot see them.',
  '--no-extensions': "pi's own discovery, which would load Enso's package a second time.",
  '--no-skills': 'Skills in `~/.agents/skills/`, which the agent directory does not cover.',
}

const SETTINGS = [AGENT_DIR_VARIABLE, ...ISOLATION_FLAGS]
const unexplained = SETTINGS.filter((setting) => STOPS[setting] === undefined)
const stale = Object.keys(STOPS).filter((setting) => !SETTINGS.includes(setting))
if (unexplained.length > 0 || stale.length > 0)
  throw new Error(
    `terminal: the isolation table and the launcher disagree: no row for ${unexplained.join(', ') || 'nothing'}, a row for no setting ${stale.join(', ') || 'nothing'}`,
  )

function stopsOf(setting: string): string {
  const words = STOPS[setting]
  if (words === undefined) throw new Error(`terminal: no row for ${setting}`)
  return words
}

/** How a setting reads in the table: the variable with the value the launcher gives it, or the flag. */
const settingText = (setting: string): string =>
  setting === AGENT_DIR_VARIABLE ? `${setting}=${ensoAgentDir(`~/${HOME_DIRECTORY}`)}` : setting

const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five'] as const
const settingCount = NUMBER_WORDS[SETTINGS.length] ?? String(SETTINGS.length)

const ISOLATION_TABLE = [
  '| Setting | What it stops |',
  '|---|---|',
  ...SETTINGS.map((setting) => `| \`${settingText(setting)}\` | ${stopsOf(setting)} |`),
].join('\n')

/** The variables the example launch removed: names a reader has exported, both secret-shaped. */
const EXAMPLE_SECRETS = ['ANTHROPIC_API_KEY', 'GITHUB_TOKEN'] as const
for (const variableName of EXAMPLE_SECRETS)
  if (!isSecretShapedName(variableName))
    throw new Error(`terminal: the example removes ${variableName}, which is not secret-shaped`)

const harnessManifest: unknown = JSON.parse(readFileSync(join(harnessPackageDir(ROOT), 'package.json'), 'utf8'))

/** The two lines an interactive launch prints, from the launcher's own formatters, on example values. */
const EXAMPLE_LAUNCH = [
  '```text',
  secretsKeptOutLine(EXAMPLE_SECRETS),
  vanillaPiLine({
    piVersion: piVersionText(SUPPORTED_PI_VERSIONS.minimum),
    agentDir: ensoAgentDir(join('/home/you', HOME_DIRECTORY)),
    packageToLoad: harnessPackageDir('…'),
    printRun: false,
    declaredResourceCount: declaredResources(harnessManifest).length,
  }),
  '```',
].join('\n')

const SECRET_SUFFIXES = SECRET_NAME_WORDS.map((word) => `\`…_${word}\``).join(', ')

/** Terminal (#482): `bun run enso`, shown by its launch output, not a screenshot. */
export const TERMINAL: FeatureSpec = {
  id: 'terminal',
  title: 'Terminal',
  shows: [
    "`bun run enso` starts pi in your terminal with Enso loaded: the same guards, `web_fetch`, `web_search`, permission modes and logging as the web app. It is plain pi otherwise. You use pi's own interface, keys and commands.",
    'The run is isolated from any other pi you have installed, and your secrets stay out of it.',
  ],
  opens: [
    [
      'From the checkout:',
      '',
      '```bash',
      'bun run enso                 # interactive',
      'bun run enso -p "hello"      # print mode: one prompt, the answer, then exit',
      '```',
    ].join('\n'),
    `Log in once, with \`/login\` in pi. The login is stored in \`${ensoAgentDir('ENSO_HOME')}\`, which the web app uses too, so one login serves both.`,
  ],
  looksLike: [
    "The launch prints what it removed and what it started, before pi's own screen. For example:",
    EXAMPLE_LAUNCH,
    [
      "- The first line names every variable removed from pi's environment. It is printed only when there was something to remove.",
      `- The second line names the pi version, the agent directory, the Enso package loaded, and how many resource paths that package declares. A print run adds \`${PRINT_VARIANT_NOTE}\` after the package.`,
    ].join('\n'),
    "This page shows the launch output instead of a screenshot: after these two lines, the terminal is pi's own interface, which pi's documentation covers.",
  ],
  shots: [],
  lookFor: [
    `Isolation is ${settingCount} separate settings, each closing a different gap:`,
    ISOLATION_TABLE,
    `Check the first line when a provider says you are not logged in. An exported \`${EXAMPLE_SECRETS[0]}\` does not reach pi: every variable whose name looks like a secret (${SECRET_SUFFIXES}), and every name in \`${ensoSecretsPath('ENSO_HOME')}\`, is removed. Provider logins belong in pi's own store, through \`/login\`.`,
  ],
  limits: [
    "Print mode has no permission modes, because there is nobody to ask. Only Enso's guards apply, and `bash` is not confined.",
    'It does not install pi. `pi` must be on your `PATH`, at a version Enso supports, or the launch stops and says why.',
    'The login here is separate from your global pi login, and expires on its own schedule.',
  ],
  see: [
    { path: 'docs/flows/boot-and-launchers.md', label: 'Boot and launchers', why: 'what each launcher does, in order' },
    {
      path: 'docs/concepts/provider-auth-and-client-identity.md',
      label: 'Provider auth and client identity',
      why: 'where logins live',
    },
    {
      path: 'docs/reference/env-and-config.md',
      label: 'Environment and configuration',
      why: '`ENSO_HOME`, `secrets.env` and the agent directory',
    },
    { path: 'docs/features/permission-modes.md', label: 'Permission modes', why: 'why print mode leaves them out' },
  ],
}
