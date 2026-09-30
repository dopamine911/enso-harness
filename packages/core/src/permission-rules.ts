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
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { ENSO_AUTO_AUTHORIZER, ENSO_PERMISSION_MODES, modeAgentFile, modeAgentName } from './permission-modes.ts'

/** `.env` files are denied everywhere; the example template stays readable. */
const ENV_FILES_DENIED = { '*.env': 'deny', '*.env.*': 'deny' } as const

/**
 * The policy a fresh `ENSO_HOME` starts with.
 *
 * - **Tools:** reads and searches run, as do Enso's `ask_user` and `web_search`; edits and writes
 *   ask; anything unnamed asks (`"*"`), `web_fetch` included.
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
    edit: 'ask',
    write: 'ask',
    // Enso's own tools. Asking the user is itself the check; a search sends only a query through
    // the session's own provider. `web_fetch` reaches any URL, so it stays on the `*` ask.
    ask_user: 'allow',
    web_search: 'allow',
    path_read: { '*': 'allow', ...ENV_FILES_DENIED, '*.env.example': 'allow' },
    path_write: { '*': 'allow', ...ENV_FILES_DENIED },
    external_directory: 'ask',
    bash: {
      '*': 'ask',
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
 * `linkEngineConfig`), so the launch log says so.
 *
 * @group Permission mode
 */
export type PermissionPolicyPreparation =
  | { readonly kind: 'kept'; readonly path: string; readonly surfaces: number; readonly movedAside?: string }
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

/** The first free name beside `path` for a backup: `.<kind>`, then `.<kind>.1` … Never overwrites. */
function freeBackupPath(path: string, kind: string): string {
  let candidate = `${path}.${kind}`
  for (let attempt = 1; lstatSync(candidate, { throwIfNoEntry: false }) !== undefined; attempt += 1) {
    candidate = `${path}.${kind}.${attempt}`
  }
  return candidate
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

/**
 * Move a picc rules file aside and write the seed in its place, returning the backup's path, or
 * `undefined` when the file was already gone.
 *
 * ⚠ TWO LAUNCHES MAY BOTH DECIDE TO MIGRATE (#497 review): the web host and the terminal, on a home
 * not yet migrated, each read the picc file before either moved it. So this step runs with a
 * decision that may be stale:
 * - the other launch already moved the file and wrote the seed: this move takes the SEED, so the
 *   backup name never overwrites (`.picc-backup.1`), and the user's rules stay in `.picc-backup`;
 * - the other launch moved it and has not written yet: the move finds nothing, and the caller
 *   reads the file again rather than failing the launch.
 *
 * @group Permission mode
 */
export function replacePiccRulesFile(policyPath: string): string | undefined {
  const backup = freeBackupPath(policyPath, 'picc-backup')
  try {
    renameSync(policyPath, backup)
  } catch (error: unknown) {
    if (isMissingFile(error)) return undefined
    throw error
  }
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
    movedAside = freeBackupPath(linkPath, 'bak')
    renameSync(linkPath, movedAside)
  }
  try {
    symlinkSync(target, linkPath)
  } catch (error: unknown) {
    const raced = error instanceof Error && 'code' in error && error.code === 'EEXIST'
    if (!raced || readlinkSync(linkPath) !== target) throw error
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
  let preparation: PermissionPolicyPreparation
  const permission = read.kind === 'object' ? read.value.permission : undefined
  if (read.kind === 'object' && typeof permission === 'object' && permission !== null) {
    preparation = { kind: 'kept', path: policyPath, surfaces: Object.keys(permission).length }
  } else if (read.kind === 'object' && typeof read.value.permissions === 'object' && read.value.permissions !== null) {
    const piccBackup = replacePiccRulesFile(policyPath)
    // Another launch moved it first: read what is there now.
    if (piccBackup === undefined) return preparePermissionPolicy(policyPath, agentDir)
    preparation = { kind: 'seeded', path: policyPath, was: 'a picc rules file', piccBackup }
  } else {
    const existing = read.kind === 'object' ? read.value : {}
    writeJson(policyPath, { ...existing, ...ENSO_DEFAULT_PERMISSION_POLICY })
    preparation = {
      kind: 'seeded',
      path: policyPath,
      was: read.kind === 'absent' ? 'absent' : 'without a permission block',
    }
  }
  const movedAside = linkEngineConfig(agentDir, policyPath)
  writeModeAgentFiles(agentDir)
  return movedAside === undefined ? preparation : { ...preparation, movedAside }
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
    return `permission policy: ${preparation.path}, ${preparation.surfaces} surfaces${moved}`
  }
  const backup = preparation.piccBackup === undefined ? '' : ` (the old file is kept as ${preparation.piccBackup})`
  return (
    `permission policy: ${preparation.path} was ${preparation.was}, so it now holds Enso's default ` +
    `policy${backup}; Claude Code's settings are not read (#446, #496)${moved}`
  )
}
