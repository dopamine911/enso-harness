import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { DEFAULT_GUARD_POLICY } from '@enso/core'
import { containsPathFragment, ensoAgentDir, ensoSecretsPath } from '@enso/core/paths'
import { knownSecretValues } from '@enso/core/secrets'

/**
 * Where an arena run lives, and the Enso home it runs over (#584 A4, #610).
 *
 * ⚠ THE RUN HOME IS THE RUN'S. Over the operator's own `ENSO_HOME`, the agent under test saw every
 * other project and thread in the UI, the evidence copied the whole home's stored threads and Stats
 * into an artifact meant to be shared, and the run's activity landed in the operator's own Stats.
 * So a run gets `<run>/.enso`: its own projects, threads, logs and Stats. What it borrows from the
 * operator is only what a model call needs.
 *
 * ⚠ CREDENTIALS ARE LINKED, NEVER COPIED. `pi-agent/auth.json` holds OAuth refresh tokens, and a
 * provider that rotates them on refresh would leave a copied original holding a dead token: the run
 * refreshing its copy would log the operator out. pi writes the file with `writeFileSync` on its
 * path (`FileAuthStorageBackend.withLock`), which follows a symlink, so a refresh lands in the
 * operator's own file and there is one login. Linking also keeps the credential bytes out of the run
 * directory. ⚠ What the link does not cover: pi's lock is taken beside the link (`realpath: false`),
 * not beside the operator's file, so the operator's own pi refreshing the same provider at the same
 * instant is not serialized with the run.
 *
 * ⚠⚠ A LINK CAN BE REPLACED, AND THEN THE OPERATOR IS LOGGED OUT (#639). A rename onto a symlink
 * replaces the link with a regular file. pi-multi-account wrote `auth.json` and `models.json` that
 * way (a temp file renamed onto the path), and measured: a refresh in one run rotated the Anthropic
 * token into that run's home, the operator's file kept the old refresh token, the provider revoked
 * it, and the next run's first model call failed with `invalid_grant`. #758 patches the extension
 * (`patches/pi-multi-account@1.24.0.patch`) to rename onto the file behind the link. For any other
 * writer the recorder still reconciles the links while the run lives and at its stop
 * (`reconcileLinkedFiles`): a link found replaced has its content returned to the operator's file,
 * and is linked again.
 *
 * ⚠ NAMED `.enso`, ON PURPOSE. `/.enso/` is the guard's credential fragment (`DEFAULT_GUARD_POLICY`):
 * Enso's own agent can neither read nor write under it, so the links are out of its reach. The same
 * fragment is why the RUN must not live under one: a project under `~/.enso/arena/…` is a path the
 * guard refuses every read and write in, and the agent could not touch its own work.
 */

/** The run home's directory name inside a run directory. */
export const ARENA_RUN_HOME = '.enso'

/** Under `pi-agent/`: linked to the operator's (credentials — one copy, written through). */
const LINKED_AGENT_FILES = ['auth.json', 'models.json'] as const
/** Under `pi-agent/`: copied (the default model and such — the run may change its own). */
const COPIED_AGENT_FILES = ['settings.json'] as const

/**
 * Where runs go by default: `$XDG_DATA_HOME/enso/arena`, else `~/.local/share/enso/arena`. Not under
 * `ENSO_HOME`: see the module header.
 */
export function defaultArenaOut(environment: Readonly<Record<string, string | undefined>>): string {
  const dataHome = environment.XDG_DATA_HOME ?? join(homedir(), '.local', 'share')
  return join(dataHome, 'enso', 'arena')
}

/** True when the guard keeps Enso's agent out of `directory` — no run's project can live there. */
export function isGuardedForAgent(directory: string): boolean {
  return containsPathFragment(resolve(directory), DEFAULT_GUARD_POLICY.secretPathFragments)
}

/** Every file the run home links to the operator's: `[the run home's path, the operator's]`. */
function linkedPairs(runHome: string, operatorHome: string): Array<readonly [linked: string, source: string]> {
  return [
    [ensoSecretsPath(runHome), ensoSecretsPath(operatorHome)],
    ...LINKED_AGENT_FILES.map(
      (fileName) => [join(ensoAgentDir(runHome), fileName), join(ensoAgentDir(operatorHome), fileName)] as const,
    ),
  ]
}

/**
 * Make `<run>/.enso` from the operator's home: the credential files linked, the settings copied,
 * nothing else. A file the operator's home does not have is left out, never created. Returns the run home.
 */
export function prepareRunHome(runDirectory: string, operatorHome: string): string {
  const home = join(runDirectory, ARENA_RUN_HOME)
  mkdirSync(ensoAgentDir(home), { recursive: true, mode: 0o700 })
  for (const [linked, source] of linkedPairs(home, operatorHome)) {
    if (existsSync(source)) symlinkSync(source, linked)
  }
  for (const fileName of COPIED_AGENT_FILES) {
    const source = join(ensoAgentDir(operatorHome), fileName)
    if (existsSync(source)) copyFileSync(source, join(ensoAgentDir(home), fileName))
  }
  return home
}

/** A model as pi's settings name it: its provider and its id. */
export interface EnsoModelSetting {
  readonly provider: string
  readonly id: string
}

/** `provider/id` as its two parts — the id may itself hold a `/` — or throws saying what was wrong. */
export function parseEnsoModel(model: string): EnsoModelSetting {
  const split = model.indexOf('/')
  if (split <= 0 || split === model.length - 1) throw new Error(`an Enso model is provider/id, not "${model}"`)
  return { provider: model.slice(0, split), id: model.slice(split + 1) }
}

/**
 * Set the model Enso's sessions start on, in the run home's own copy of the settings (#674):
 * `defaultProvider` and `defaultModel`, which pi starts a session on and the Start dialog
 * preselects. Every other setting is kept; a run home with no settings gets a file of these two.
 */
export function setRunHomeModel(home: string, model: EnsoModelSetting): void {
  const path = join(ensoAgentDir(home), 'settings.json')
  const settings: unknown = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
    throw new Error(`${path} is not a settings object`)
  }
  const updated = { ...settings, defaultProvider: model.provider, defaultModel: model.id }
  writeFileSync(path, `${JSON.stringify(updated, null, 2)}\n`)
}

/**
 * What reconciling found for one linked file that was no longer a link: its content went back to
 * the operator's file, or the operator's had changed after it and stood.
 */
export interface ArenaRelink {
  /** The run home's path that had been a link. */
  readonly path: string
  readonly outcome: 'returned' | 'operator-newer'
}

/**
 * Put every replaced link back (#639). A linked file that is a regular file now was written by an
 * atomic rename: its content goes back to the operator's file when it is the newer of the two (a
 * refresh's rotated token), and the link is restored either way. An operator file changed after it
 * is left alone — overwriting it could revoke the login another process just refreshed — and the
 * caller says so. A link still in place, and a file neither side has, are untouched.
 */
export function reconcileLinkedFiles(runHome: string, operatorHome: string): ArenaRelink[] {
  const relinked: ArenaRelink[] = []
  for (const [linked, source] of linkedPairs(runHome, operatorHome)) {
    const stats = lstatSync(linked, { throwIfNoEntry: false })
    if (stats === undefined || stats.isSymbolicLink()) continue
    const operatorStats = statSync(source, { throwIfNoEntry: false })
    const newer = operatorStats === undefined || stats.mtimeMs >= operatorStats.mtimeMs
    if (newer) writeFileSync(source, readFileSync(linked), { mode: 0o600 })
    // ⚠ The link goes back by RENAME (PR #642 review): removing the file and then linking left a
    // moment with no file, in which a credential write of pi-multi-account's own could land and make
    // the link throw. A rename onto the path replaces whatever is there, at once.
    const pendingLink = `${linked}.relink-${process.pid}`
    symlinkSync(source, pendingLink)
    try {
      renameSync(pendingLink, linked)
    } catch (error) {
      // A rename that fails leaves no stray link behind; the caller hears why (PR #642 review).
      rmSync(pendingLink, { force: true })
      throw error
    }
    relinked.push({ path: linked, outcome: newer ? 'returned' : 'operator-newer' })
  }
  return relinked
}

/**
 * The home a run ran over: the one its `run-start` line `recorded` (#610), else its own `.enso` when it
 * has one, else `fallback` — only for a run from before either existed.
 */
export function runHomeOf(runDirectory: string, fallback: string, recorded?: string): string {
  if (recorded !== undefined) return recorded
  const home = join(runDirectory, ARENA_RUN_HOME)
  return existsSync(home) ? home : fallback
}

/** Values shorter than this are not scanned for: they match too much to mean anything. */
const SHORTEST_CREDENTIAL = 8
/** The fields of a pi credential that hold a secret: an OAuth pair, or an API key. */
const CREDENTIAL_FIELDS = ['access', 'refresh', 'key'] as const

/**
 * Every secret value the arena redacts with and scans for: core's known values (`secrets.env` and
 * the environment's secret-shaped names) and the credentials in `pi-agent/auth.json`, which core's
 * set does not hold. The values, never where they came from: the scan reports a file, not a key.
 */
export function arenaSecretValues(home: string): readonly string[] {
  const values = new Set(knownSecretValues(home))
  for (const credential of credentialValues(join(ensoAgentDir(home), 'auth.json'))) values.add(credential)
  return [...values]
}

/**
 * The run's secret values as they GROW (PR #613 review): `arenaSecretValues`, read again whenever
 * `secrets.env` or `auth.json` changes, and added to what was already known — never replaced.
 *
 * ⚠ Why a source and not a snapshot: the login is linked (`prepareRunHome`), so an OAuth refresh during
 * the run rewrites `auth.json` with a new token. A snapshot taken at the start never knew it, and a
 * set replaced at the stop would forget the token it replaced; either may be in a file the run wrote.
 * A changed file is noticed by its size and mtime, read on every call, which is two `stat`s.
 *
 * Not core's `knownSecretValuesTracking`, on purpose: that thunk watches `secrets.env` alone and
 * REPLACES its set on a change, which is right for redaction going forward and wrong here, where a
 * value that rotated away may already be in a file the run kept.
 */
export function arenaSecretSource(home: string): () => readonly string[] {
  const watched = [ensoSecretsPath(home), join(ensoAgentDir(home), 'auth.json')]
  const known = new Set<string>()
  let stamp: string | undefined
  let values: readonly string[] = []
  return () => {
    const now = watched.map(fileStamp).join('|')
    if (now !== stamp) {
      stamp = now
      for (const secretValue of arenaSecretValues(home)) known.add(secretValue)
      values = [...known]
    }
    return values
  }
}

function fileStamp(path: string): string {
  try {
    const stats = statSync(path)
    return `${stats.mtimeMs}:${stats.size}`
  } catch {
    return 'absent'
  }
}

function credentialValues(authPath: string): string[] {
  if (!existsSync(authPath)) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(authPath, 'utf8'))
  } catch {
    return []
  }
  if (typeof parsed !== 'object' || parsed === null) return []
  return Object.values(parsed).flatMap((credential: unknown) =>
    typeof credential === 'object' && credential !== null
      ? CREDENTIAL_FIELDS.flatMap((field) => {
          const value: unknown = field in credential ? Reflect.get(credential, field) : undefined
          return typeof value === 'string' && value.length >= SHORTEST_CREDENTIAL ? [value] : []
        })
      : [],
  )
}
