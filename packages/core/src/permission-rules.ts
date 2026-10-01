/**
 * The permission policy pi runs under (#446, #496): `ENSO_HOME/permissions.json`, in
 * `@gotgenes/pi-permission-system`'s format, never a copy of another tool's settings.
 *
 * gotgenes reads its policy from one place only, `<agentDir>/extensions/pi-permission-system/
 * config.json`, and there is no setting to point it elsewhere. So `preparePermissionPolicy`
 * makes that path a symlink to the user's file. The file stays where #446 put it, and gotgenes'
 * reload on change still works, since it follows the link and stats the target.
 *
 * It also writes the mode agent files (`permission-modes.ts`) beside pi's other agent
 * files, because gotgenes reads a mode's preset from there.
 *
 * ⚠ gotgenes reads a file it cannot parse as an EMPTY policy, and an empty policy has no deny
 * rules at all: every call asks. That is why an unreadable file refuses the launch here rather
 * than being passed on. A file the user breaks while a session runs still reaches gotgenes that
 * way; nothing here can stop that.
 *
 * Only plain JSON is accepted. gotgenes also strips JavaScript-style comments before it parses,
 * so every file this module accepts, it reads the same way. A commented file is refused here
 * even though gotgenes would read it; that is the safe direction.
 *
 * @module
 */
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { ENSO_INCIDENT_REPORT_TOOL_NAME } from './incident-report.ts'
import {
  ENSO_AUTO_AUTHORIZER,
  ENSO_CATCH_ALL,
  ENSO_MODE_PRESETS,
  ENSO_PERMISSION_MODES,
  modeAgentFile,
  modeAgentName,
} from './permission-modes.ts'

/** `.env` files are denied everywhere; the example template stays readable. */
const ENV_FILES_DENIED = { '*.env': 'deny', '*.env.*': 'deny' } as const

/**
 * The policy a fresh `ENSO_HOME` starts with.
 *
 * - **Tools:** reads and searches run, as do Enso's `ask_user` and `web_search`; edits and writes
 *   ask; anything unnamed asks (`"*"`), `web_fetch` included.
 * - **Catch-alls:** every map starts with Enso's catch-all, `**` (`ENSO_CATCH_ALL`): the one key a
 *   mode changes, and the pattern `auto` may answer. A rule a user adds after it is theirs, and
 *   beats every mode (#498, #499).
 * - **Bash:** asks, except gotgenes' documented read-only allowlist (its "Read-Only Bash Command
 *   Allowlist" recipe, trimmed of `less`/`more`, which can escape to a shell). The allowlist is
 *   safe to seed because gotgenes resolves a chain to its most restrictive part and floors
 *   wrappers (`sh -c`, `sudo`, `xargs`) to ask.
 * - **Git:** the escapes Enso's guards do not already refuse are denied (force-push is
 *   `cc-safety-net`'s `git.push-force`).
 * - **`.env` files:** denied for every tool and every bash command, through symlinks too.
 * - **Outside the project:** asks.
 * - **`auto` mode:** `authorizerChain` names Enso's classifier link. The link defers in every
 *   other mode, and a user who removes the name gets prompts in `auto`, never fewer.
 *
 * ⚠ `path_write` is `allow` inside the project on purpose. gotgenes checks a bash path argument
 * against BOTH directions unless the command is one of its pure readers, so `ask` here made
 * `git diff src/a.ts` ask (probed). The cost: an allowlisted command's redirect (`cat a > b`)
 * writes inside the project without asking. Writes outside still ask through
 * `external_directory`.
 *
 * ⚠ `git commit * -n*` is deliberately absent: it would also deny a commit whose MESSAGE contains
 * ` -n`. `-n` right after `commit` is still denied.
 *
 * @group Permission mode
 */
export const ENSO_DEFAULT_PERMISSION_POLICY = {
  authorizerChain: [ENSO_AUTO_AUTHORIZER],
  permission: {
    '*': 'ask',
    read: 'allow',
    grep: 'allow',
    find: 'allow',
    ls: 'allow',
    edit: { [ENSO_CATCH_ALL]: 'ask' },
    write: { [ENSO_CATCH_ALL]: 'ask' },
    // Enso's own tools. Asking the user is itself the check; a search sends only a query through
    // the session's own provider. `web_fetch` reaches any URL, so it stays on the `*` ask.
    ask_user: 'allow',
    web_search: 'allow',
    // The incident report (#467): the harness's own bounded step after a halt, not an agent
    // capability — the guard lets it through only while a report is owed, and refuses everything
    // else then. Asking for it would put a permission prompt between a halt and its card.
    [ENSO_INCIDENT_REPORT_TOOL_NAME]: 'allow',
    path_read: { [ENSO_CATCH_ALL]: 'allow', ...ENV_FILES_DENIED, '*.env.example': 'allow' },
    path_write: { [ENSO_CATCH_ALL]: 'allow', ...ENV_FILES_DENIED },
    external_directory: { [ENSO_CATCH_ALL]: 'ask' },
    bash: {
      [ENSO_CATCH_ALL]: 'ask',
      'cat *': 'allow',
      'head *': 'allow',
      'tail *': 'allow',
      ls: 'allow',
      'ls *': 'allow',
      'tree *': 'allow',
      'stat *': 'allow',
      'wc *': 'allow',
      'du *': 'allow',
      'df *': 'allow',
      'grep *': 'allow',
      'rg *': 'allow',
      'find *': 'allow',
      'fd *': 'allow',
      'diff *': 'allow',
      'cmp *': 'allow',
      'sha256sum *': 'allow',
      pwd: 'allow',
      whoami: 'allow',
      'uname *': 'allow',
      date: 'allow',
      'which *': 'allow',
      'git status': 'allow',
      'git status *': 'allow',
      'git diff': 'allow',
      'git diff *': 'allow',
      'git log': 'allow',
      'git log *': 'allow',
      'git show *': 'allow',
      'git blame *': 'allow',
      'git ls-files *': 'allow',
      'git branch': 'allow',
      'git remote -v': 'allow',
      'git commit --no-verify*': 'deny',
      'git commit * --no-verify*': 'deny',
      'git commit -n*': 'deny',
      'git push --delete *': 'deny',
      'git push * --delete *': 'deny',
    },
  },
} as const

/**
 * Where gotgenes reads its policy, under pi's agent directory.
 *
 * @group Permission mode
 */
export function permissionEngineConfigPath(agentDir: string): string {
  return join(agentDir, 'extensions', 'pi-permission-system', 'config.json')
}

/**
 * What `preparePermissionPolicy` found and did with the user's file.
 *
 * - `kept`: the file holds a `permission` block; it is used as it is.
 * - `seeded`: the file now holds `ENSO_DEFAULT_PERMISSION_POLICY`. It was absent, held no
 *   `permission` block, or was a picc rules file (#496; that file is kept beside it, at
 *   `piccBackup`, and its rules are not carried over).
 * - `unreadable`: the file is there but is not a JSON object (or is a link to nothing); nothing
 *   was written, and the caller refuses to start.
 *
 * `movedAside` names where a regular file found at the engine's config path was moved to (see
 * `linkEngineConfig`), so the launch log says so. `catchAllAdded` names the surfaces of a kept
 * file that got Enso's catch-all put first (`withCatchAllFirst`), so the log says that too;
 * `reportToolAdded` says the file had no rule for the incident report tool and got `allow` (#467).
 *
 * @group Permission mode
 */
export type PermissionPolicyPreparation =
  | {
      readonly kind: 'kept'
      readonly path: string
      readonly surfaces: number
      readonly catchAllAdded: readonly string[]
      readonly reportToolAdded: boolean
      readonly movedAside?: string
    }
  | {
      readonly kind: 'seeded'
      readonly path: string
      readonly was: 'absent' | 'without a permission block' | 'a picc rules file'
      readonly piccBackup?: string
      readonly movedAside?: string
    }
  | { readonly kind: 'unreadable'; readonly path: string; readonly reason: string }

type ReadPolicy =
  | { readonly kind: 'absent' }
  | { readonly kind: 'object'; readonly value: Readonly<Record<string, unknown>> }
  | { readonly kind: 'unreadable'; readonly reason: string }

function readPolicy(path: string): ReadPolicy {
  if (!existsSync(path)) {
    // `existsSync` follows links: a link to nothing reads as absent, and seeding would write through it.
    if (lstatSync(path, { throwIfNoEntry: false }) !== undefined)
      return { kind: 'unreadable', reason: 'a link to nothing' }
    return { kind: 'absent' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error: unknown) {
    return { kind: 'unreadable', reason: error instanceof Error ? error.message : String(error) }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { kind: 'unreadable', reason: 'not a JSON object' }
  }
  return { kind: 'object', value: parsed as Readonly<Record<string, unknown>> }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function errorCode(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined
}

/**
 * Move `path` aside under the first free backup name (`.<kind>`, then `.<kind>.1` …) and return
 * that name, or `undefined` when `path` was already gone.
 *
 * ⚠ NEVER OVERWRITES, UNDER A RACE TOO (#497 review, second round). Checking for a free name and
 * then renaming is two steps: another launch can create the backup in between, and `rename`
 * silently replaces its destination. A hard link is one step that fails with `EEXIST` when the
 * name is taken, so the name is reserved and filled at once; the original is unlinked after.
 */
function moveAside(path: string, kind: string): string | undefined {
  for (let attempt = 0; ; attempt += 1) {
    const candidate = attempt === 0 ? `${path}.${kind}` : `${path}.${kind}.${attempt}`
    const linked = linkUnlessTaken(path, candidate)
    if (linked === 'taken') continue
    if (linked === 'gone') return undefined
    unlinkUnlessGone(path)
    return candidate
  }
}

/** Hard-link `path` to `candidate`: `taken` when the name exists, `gone` when `path` does not. */
function linkUnlessTaken(path: string, candidate: string): 'linked' | 'taken' | 'gone' {
  try {
    linkSync(path, candidate)
    return 'linked'
  } catch (error: unknown) {
    if (errorCode(error) === 'EEXIST') return 'taken'
    if (errorCode(error) === 'ENOENT') return 'gone'
    throw error
  }
}

/** Unlink `path`; another launch that unlinked it first leaves the copy already made whole. */
function unlinkUnlessGone(path: string): void {
  try {
    unlinkSync(path)
  } catch (error: unknown) {
    if (errorCode(error) !== 'ENOENT') throw error
  }
}

/**
 * Move a picc rules file aside and write the seed in its place, returning the backup's path, or
 * `undefined` when the file was already gone.
 *
 * ⚠ TWO LAUNCHES MAY BOTH DECIDE TO MIGRATE (#497 review): the web host and the terminal, on a home
 * not yet migrated, each read the picc file before either moved it. So this step runs with a
 * decision that may be stale, and whatever it moves, `moveAside` never overwrites an earlier
 * backup: the user's rules stay in the first one (`.picc-backup`), and a late launch's copy of the
 * seed, or of the same rules, lands in `.picc-backup.1`. When the file is already gone (the other
 * launch moved it and has not written the seed yet), the caller reads again rather than failing.
 *
 * @group Permission mode
 */
export function replacePiccRulesFile(policyPath: string): string | undefined {
  const backup = moveAside(policyPath, 'picc-backup')
  if (backup === undefined) return undefined
  writeJson(policyPath, ENSO_DEFAULT_PERMISSION_POLICY)
  return backup
}

/**
 * Point gotgenes' config path at the user's file, and return where a regular file found there was
 * moved (gotgenes' own settings screen saves by rename, which replaces the link). That file is
 * kept under a backup name that never overwrites an earlier one.
 *
 * ⚠ Two launches may race on a fresh `ENSO_HOME` (the web host and the terminal): a link the
 * other one made first, to the same file, is the outcome both wanted.
 */
function linkEngineConfig(agentDir: string, policyPath: string): string | undefined {
  const linkPath = permissionEngineConfigPath(agentDir)
  const target = resolve(policyPath)
  mkdirSync(dirname(linkPath), { recursive: true })
  const existing = lstatSync(linkPath, { throwIfNoEntry: false })
  let movedAside: string | undefined
  if (existing?.isSymbolicLink() === true) {
    if (readlinkSync(linkPath) === target) return undefined
    rmSync(linkPath)
  } else if (existing !== undefined) {
    movedAside = moveAside(linkPath, 'bak')
  }
  try {
    symlinkSync(target, linkPath)
  } catch (error: unknown) {
    if (errorCode(error) !== 'EEXIST' || readlinkSync(linkPath) !== target) throw error
  }
  return movedAside
}

/** Write every mode's agent file. Enso owns them, so they are rewritten at every launch. */
function writeModeAgentFiles(agentDir: string): void {
  const agentsDir = join(agentDir, 'agents')
  mkdirSync(agentsDir, { recursive: true })
  for (const mode of ENSO_PERMISSION_MODES) {
    writeFileSync(join(agentsDir, `${modeAgentName(mode)}.md`), modeAgentFile(mode))
  }
}

/** The directional surfaces a bare `path` / `external_directory` key expands to, in the engine. */
const DIRECTIONAL_SURFACES: Readonly<Record<string, readonly string[]>> = {
  path: ['path_read', 'path_write'],
  external_directory: ['external_directory_read', 'external_directory_write'],
}

/** Every surface a mode preset changes with a map: where the preset's catch-all key has to go first. */
const PRESET_MAP_SURFACES: ReadonlySet<string> = new Set(
  Object.values(ENSO_MODE_PRESETS).flatMap((preset) =>
    Object.entries(preset.permission).flatMap(([surface, rule]) => (typeof rule === 'string' ? [] : [surface])),
  ),
)

/**
 * The keys of a user's `permission` block to put Enso's catch-all into. A bare `path` or
 * `external_directory` key stands for both of its directions, and the engine puts its entries
 * first when it expands them, so the catch-all goes into the bare key when there is one.
 */
function catchAllSurfaces(permission: Readonly<Record<string, unknown>>): string[] {
  const pending = new Set(PRESET_MAP_SURFACES)
  const surfaces: string[] = []
  for (const [bare, directions] of Object.entries(DIRECTIONAL_SURFACES)) {
    if (!directions.some((direction) => pending.has(direction))) continue
    if (bare in permission) surfaces.push(bare)
    else surfaces.push(...directions.filter((direction) => direction in permission))
    for (const direction of directions) pending.delete(direction)
  }
  surfaces.push(...[...pending].filter((surface) => surface in permission))
  return surfaces
}

/**
 * A user's `permission` block with Enso's catch-all FIRST in every surface a mode preset changes,
 * and the surfaces that needed it (#499).
 *
 * A mode's preset merges key by key, and a key the user's map lacks lands after all the user's
 * rules, beating them (`permission-modes.ts` says how). With the catch-all first, the preset
 * replaces only that key, and every rule the user wrote still comes after it.
 *
 * The catch-all takes the value the engine would fall back to anyway (the block's own `"*"`, or
 * `ask`), so the default mode decides exactly as before:
 * - a map without it gets it prepended;
 * - a string surface (`bash: 'ask'`) becomes `{ '**': fallback, '*': 'ask' }`, the user's rule
 *   still covering everything after it (a surface-wide rule the user wrote, which `auto` leaves
 *   to the user, #498);
 * - a map that already has it, anywhere, is left as the user ordered it.
 *
 * Exported for Settings' save (#474): a policy the page writes gets the same normalisation a
 * launch gives a hand-edited one, so a mode can never override a rule written there.
 *
 * @group Permission mode
 */
export function withCatchAllFirst(permission: Readonly<Record<string, unknown>>): {
  readonly permission: Readonly<Record<string, unknown>>
  readonly added: readonly string[]
} {
  const fallback = typeof permission['*'] === 'string' ? permission['*'] : 'ask'
  const updated: Record<string, unknown> = { ...permission }
  const added: string[] = []
  for (const surface of catchAllSurfaces(permission)) {
    const rule = permission[surface]
    if (typeof rule === 'string') {
      updated[surface] = { [ENSO_CATCH_ALL]: fallback, '*': rule }
    } else if (typeof rule === 'object' && rule !== null && !Array.isArray(rule) && !(ENSO_CATCH_ALL in rule)) {
      updated[surface] = { [ENSO_CATCH_ALL]: fallback, ...rule }
    } else {
      continue
    }
    added.push(surface)
  }
  return { permission: updated, added }
}

/**
 * Make `policyPath` a policy gotgenes will use as it is, and put it and the mode presets where
 * gotgenes reads them:
 * - keep a file that holds a `permission` block;
 * - seed one that is absent, holds none, or is a picc rules file;
 * - refuse one that is not a JSON object, touching nothing.
 *
 * Seeding keeps every other top-level key the file had, except a picc file, which is replaced
 * whole (its copy is kept beside it; `replacePiccRulesFile` names it).
 *
 * Call it before the extension loads, on both launch surfaces.
 *
 * @group Permission mode
 */
export function preparePermissionPolicy(policyPath: string, agentDir: string): PermissionPolicyPreparation {
  const read = readPolicy(policyPath)
  if (read.kind === 'unreadable') return { kind: 'unreadable', path: policyPath, reason: read.reason }
  const preparation = preparePolicyFile(policyPath, read)
  // Another launch moved a picc file away first: read what is there now.
  if (preparation === undefined) return preparePermissionPolicy(policyPath, agentDir)
  const movedAside = linkEngineConfig(agentDir, policyPath)
  writeModeAgentFiles(agentDir)
  return movedAside === undefined ? preparation : { ...preparation, movedAside }
}

type FilePreparation = Exclude<PermissionPolicyPreparation, { readonly kind: 'unreadable' }>

/** Keep, seed or migrate the user's file; `undefined` when a picc file was already moved away. */
function preparePolicyFile(
  policyPath: string,
  read: Exclude<ReadPolicy, { readonly kind: 'unreadable' }>,
): FilePreparation | undefined {
  const value = read.kind === 'object' ? read.value : {}
  const { permission, permissions } = value
  if (typeof permission === 'object' && permission !== null) {
    return keepPolicy(policyPath, value, permission as Readonly<Record<string, unknown>>)
  }
  if (typeof permissions === 'object' && permissions !== null) {
    const piccBackup = replacePiccRulesFile(policyPath)
    return piccBackup === undefined
      ? undefined
      : { kind: 'seeded', path: policyPath, was: 'a picc rules file', piccBackup }
  }
  writeJson(policyPath, { ...value, ...ENSO_DEFAULT_PERMISSION_POLICY })
  return { kind: 'seeded', path: policyPath, was: read.kind === 'absent' ? 'absent' : 'without a permission block' }
}

/**
 * Keep a user's policy, with Enso's catch-all put first where a mode needs it (#499), and the
 * incident report tool allowed when the file says nothing about it (#467) — never over a rule the
 * user wrote for it.
 */
function keepPolicy(
  policyPath: string,
  file: Readonly<Record<string, unknown>>,
  permission: Readonly<Record<string, unknown>>,
): FilePreparation {
  const normalized = withCatchAllFirst(permission)
  const reportToolAdded = !(ENSO_INCIDENT_REPORT_TOOL_NAME in permission)
  if (normalized.added.length > 0 || reportToolAdded) {
    const next = reportToolAdded
      ? { ...normalized.permission, [ENSO_INCIDENT_REPORT_TOOL_NAME]: 'allow' }
      : normalized.permission
    writeJson(policyPath, { ...file, permission: next })
  }
  return {
    kind: 'kept',
    path: policyPath,
    surfaces: Object.keys(permission).length,
    catchAllAdded: normalized.added,
    reportToolAdded,
  }
}

/**
 * The line both launch surfaces log for a preparation that did not refuse, in the same words on
 * the web host and the terminal launcher, so a reader finds one in the logs by the other.
 *
 * @group Permission mode
 */
export function describePermissionPolicy(
  preparation: Exclude<PermissionPolicyPreparation, { readonly kind: 'unreadable' }>,
): string {
  const moved =
    preparation.movedAside === undefined
      ? ''
      : `; the engine's config path held a regular file (its own settings screen saves one), kept as ${preparation.movedAside}`
  if (preparation.kind === 'kept') {
    const added =
      preparation.catchAllAdded.length === 0
        ? ''
        : `; Enso's catch-all (**) put first in ${preparation.catchAllAdded.join(', ')}, so no mode can override a rule written there (#499)`
    const report = preparation.reportToolAdded
      ? `; ${ENSO_INCIDENT_REPORT_TOOL_NAME} allowed, as the file had no rule for it (#467)`
      : ''
    return `permission policy: ${preparation.path}, ${preparation.surfaces} surfaces${added}${report}${moved}`
  }
  const backup = preparation.piccBackup === undefined ? '' : ` (the old file is kept as ${preparation.piccBackup})`
  return (
    `permission policy: ${preparation.path} was ${preparation.was}, so it now holds Enso's default ` +
    `policy${backup}; Claude Code's settings are not read (#446, #496)${moved}`
  )
}
