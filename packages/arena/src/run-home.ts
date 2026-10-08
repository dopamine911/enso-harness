import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { DEFAULT_GUARD_POLICY } from '@enso/core'
import { containsPathFragment, ensoAgentDir, ensoSecretsPath, realpathOrSelf } from '@enso/core/paths'
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
 * ⚠ THE LOGIN IS THE ARENA'S OWN, REACHED BY A DIRECTORY LINK (#763). `<run>/.enso/pi-agent` is a
 * symlink to one arena login directory (`arenaLoginDir`), logged in once with `bun run arena login`.
 * It holds its own OAuth grant: never a COPY of the operator's (a refresh rotates a single-use token,
 * so the copy would revoke the operator's, #610), never a link to the operator's FILES (a rename
 * onto a linked file replaces the link, and the rotated token stayed in the run, #639). A rename
 * onto `pi-agent/auth.json` resolves the DIRECTORY link and replaces the real file, so no writer can
 * break the link, and pi's lock file lands in the one real directory for every run.
 *
 * ⚠ RUNS SHARE THAT DIRECTORY, ONE AT A TIME. `prepareLaunch` refuses while the stack's ports are
 * taken, so no two runs are alive at once: `setRunHomeModel` sets a run's model at its start, and each
 * launch re-points the permission engine's link to its own home's policy (`linkEngineConfig`). From the
 * operator a run takes `secrets.env`, linked (only a human writes it), and the settings (default model,
 * theme), copied into the login directory at each run's start.
 *
 * ⚠ NAMED `.enso`, ON PURPOSE. `/.enso/` is the guard's credential fragment (`DEFAULT_GUARD_POLICY`):
 * Enso's own agent can neither read nor write under it, so the links are out of its reach, and so is
 * the arena login directory, under a `.enso` of its own. The same fragment is why the RUN must not
 * live under one: a project under `~/.enso/arena/…` is a path the guard refuses every read and write
 * in, and the agent could not touch its own work.
 */

/** The run home's directory name inside a run directory. */
export const ARENA_RUN_HOME = '.enso'

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

/**
 * The arena's own login directory, which every host run's `pi-agent` links to (#763):
 * `$XDG_DATA_HOME/enso/arena-login/.enso/pi-agent`, else under `~/.local/share`. Under a `.enso`, so
 * the guard keeps Enso's agent out of it (see the module header).
 */
export function arenaLoginDir(environment: Readonly<Record<string, string | undefined>>): string {
  const dataHome = environment.XDG_DATA_HOME ?? join(homedir(), '.local', 'share')
  return ensoAgentDir(join(dataHome, 'enso', 'arena-login', ARENA_RUN_HOME))
}

/** The providers the arena login holds a credential for: none until `bun run arena login`. */
export function arenaLoginProviders(loginAgentDir: string): string[] {
  const authPath = join(loginAgentDir, 'auth.json')
  if (!existsSync(authPath)) return []
  const credentials: unknown = JSON.parse(readFileSync(authPath, 'utf8'))
  return typeof credentials === 'object' && credentials !== null && !Array.isArray(credentials)
    ? Object.keys(credentials)
    : []
}

/**
 * Make `<run>/.enso`: `pi-agent` a link to the arena login directory, `secrets.env` a link to the
 * operator's, and the operator's settings copied into the login directory, so a run starts on the
 * operator's default model unless it sets its own. A file the operator's home does not have is left
 * out, never created. Returns the run home.
 */
export function prepareRunHome(runDirectory: string, operatorHome: string, loginAgentDir: string): string {
  const home = join(runDirectory, ARENA_RUN_HOME)
  mkdirSync(home, { recursive: true, mode: 0o700 })
  mkdirSync(loginAgentDir, { recursive: true, mode: 0o700 })
  symlinkSync(loginAgentDir, ensoAgentDir(home))
  if (existsSync(ensoSecretsPath(operatorHome))) symlinkSync(ensoSecretsPath(operatorHome), ensoSecretsPath(home))
  // Every run starts from the operator's settings, or from none: never from the last run's model.
  // In the container the operator's agent dir IS the login (its `~/.enso/pi-agent` links there): one
  // file, nothing to copy, and a copy onto itself would empty it.
  const operatorSettings = join(ensoAgentDir(operatorHome), 'settings.json')
  const loginSettings = join(loginAgentDir, 'settings.json')
  if (realpathOrSelf(ensoAgentDir(operatorHome)) === realpathOrSelf(loginAgentDir)) return home
  if (existsSync(operatorSettings)) copyFileSync(operatorSettings, loginSettings)
  else writeFileSync(loginSettings, '{}\n')
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
 * Set the model Enso's sessions start on, in the settings the run home reaches (#674; the arena
 * login's, #763): `defaultProvider` and `defaultModel`, which pi starts a session on and the Start
 * dialog preselects. Every other setting is kept; a home with no settings gets a file of these two.
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
