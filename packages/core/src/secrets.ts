/**
 * Secrets stay OUT of the environment the model's tools inherit (#89).
 *
 * What happened: `.env` is read-gate-protected as a FILE (`guard.ts`, the secret-basename
 * rule), but bun auto-loads it into `process.env`, in-process pi inherits that, and every
 * `bash` child inherits it from there. A `bash env` printed `TAVILY_API_KEY` into a
 * transcript and a session file. Nothing was wrong with any gate; the secret was not
 * behind one. Redaction would be cosmetic — the model has already seen the value by the
 * time anything could scrub output — so the fix is at the source:
 *
 *   1. `quarantineSecrets` — at startup, before any session or child process exists,
 *      DELETE every secret-shaped variable and every name the secrets files define from
 *      `process.env`. bun's autoload into THIS process is thereby undone; the spawn spread
 *      in `enso.ts` and the in-process host both start from an environment that carries
 *      none.
 *   2. The secrets file is `ENSO_HOME/secrets.env`, NOT the root `.env` (`ensoSecretsPath`).
 *      Scrubbing the parent is not enough: bun auto-loads `.env*` from the cwd into EVERY
 *      bun process, so a `bun -e` the model runs from the repo root re-reads a root `.env`
 *      itself — verified with `env -i`, the receipt in PR #98. `.enso/` is a path bun never
 *      loads from; a root `.env` that still defines a secret is reported as MISPLACED.
 *   3. `readSecret` — the extensions that need a key (web_search's Tavily and DeepSeek
 *      providers) read the gated file DIRECTLY, at call time. Extension code is trusted;
 *      the read gate is for the model's `read` tool. The file is the one source on both
 *      surfaces — the web host runs pi in-process, the TUI runs it as a child, and a
 *      private in-memory map could never serve the second.
 *
 * ⚠ Provider auth (`ANTHROPIC_API_KEY` and kin) is NOT served from the secrets file. It
 * lives in pi's own `auth.json` (`/login`, pi-multi-account — #7); an env-only provider
 * key would be scrubbed here and pi would say so. The file is for the harness extensions'
 * keys.
 *
 * ⚠ The name shape is the boundary, on purpose: `*_API_KEY`, `*_TOKEN`, `*_SECRET`,
 * `*_PASSWORD`, and their plurals (as whole underscore-delimited words, so `TOKENIZER_PATH`
 * is untouched).
 * A tool that needs a token in a `bash` child must get it another way — `gh` has its
 * keyring — because the environment is exactly the channel this closes.
 *
 * @module
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { ensoSecretsPath, rootDotenvPath } from './paths.ts'

/**
 * The words a secret-shaped name carries (whole, underscore-delimited, singular or plural), named
 * so the docs can list the same words the quarantine matches.
 *
 * @group Secrets
 */
export const SECRET_NAME_WORDS = ['API_KEY', 'TOKEN', 'SECRET', 'PASSWORD'] as const

const SECRET_SHAPED_NAME = new RegExp(`(?:^|_)(?:${SECRET_NAME_WORDS.join('|')})S?(?:$|_)`)

/**
 * Whether an environment variable NAME looks like it carries a secret. Case-sensitive: env names are.
 *
 * @group Secrets
 */
export function isSecretShapedName(name: string): boolean {
  return SECRET_SHAPED_NAME.test(name)
}

/**
 * One alternation over every known secret VALUE, for a single regex pass per string however many
 * there are; `undefined` when there is none to scan for, so a caller with no secret store pays
 * nothing. Global: made for `replace`. The log's value pass and the judge's redaction both build
 * theirs here.
 *
 * ⚠ LONGEST FIRST. A JS alternation takes the first branch that matches at a position, not the
 * longest, so with `sk-live-abc` listed before `sk-live-abcdef99` the longer secret is redacted
 * down to its prefix and its tail stays in the text — silent under-redaction, in exactly the case
 * that matters most: two live keys from one provider, or a key and its rotation.
 *
 * @group Secrets
 */
export function secretValuePattern(values: readonly string[]): RegExp | undefined {
  const scannable = values.filter((secret) => secret.length > 0).toSorted((left, right) => right.length - left.length)
  if (scannable.length === 0) return undefined
  return new RegExp(scannable.map((secret) => secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g')
}

/**
 * The subset of dotenv this harness needs: `NAME=value` and `export NAME=value` lines,
 * `#` comments, blank lines, single- or double-quoted values (quotes stripped, `\n` in
 * double quotes expanded), unquoted values trimmed.
 *
 * No interpolation, no multi-line values — a secrets file is one key per line, and anything
 * fancier is a smell.
 *
 * @group Secrets
 */
export function parseDotenv(text: string): Map<string, string> {
  const values = new Map<string, string>()
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (match === null) continue
    const name = match[1] ?? ''
    let value = match[2] ?? ''
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\n/g, '\n')
    } else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1)
    } else {
      // An unquoted value ends at a ` #` comment, like a shell would read it.
      value = value.replace(/\s+#.*$/, '').trim()
    }
    values.set(name, value)
  }
  return values
}

/**
 * Every name/value in a dotenv-shaped file, or an empty map when there is no file. Read fresh each call.
 *
 * @group Secrets
 */
export function readDotenvFile(path: string): Map<string, string> {
  if (!existsSync(path)) return new Map()
  return parseDotenv(readFileSync(path, 'utf8'))
}

/**
 * One secret by name from `ENSO_HOME/secrets.env` — the extensions' read path. Per call, so a rotation needs no restart.
 *
 * @group Secrets
 */
export function readSecret(home: string, name: string): string | undefined {
  return readDotenvFile(ensoSecretsPath(home)).get(name)
}

/**
 * A value shorter than this is not treated as a secret to scan for. A two-character value in
 * the secrets file (a flag, a placeholder someone left) would otherwise redact half the log.
 */
const SHORTEST_SCANNABLE_SECRET = 8

/**
 * The secret VALUES this harness knows, for the logger's value pass (#139).
 *
 * Redaction by field name cannot see a token quoted inside a message, a guard's `reason`, or a
 * `trace` payload; this is the set those passes scan for.
 *
 * Two sources, both ours: `ENSO_HOME/secrets.env` — everything in it is a secret by definition —
 * and the environment's own secret-shaped names, for a process configured before
 * `quarantineSecrets` has run. After quarantine the environment half is empty by design,
 * and the file half is what still matters: it is where the provider key a tool might echo
 * actually lives.
 *
 * ⚠ Known values only, never a shape heuristic. "Looks like a secret" over model output
 * redacts a user's own text on a guess; an exact value redacts exactly what leaked.
 *
 * @group Secrets
 */
export function knownSecretValues(
  home: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): readonly string[] {
  const values = new Set<string>()
  for (const secretValue of readDotenvFile(ensoSecretsPath(home)).values()) {
    if (secretValue.length >= SHORTEST_SCANNABLE_SECRET) values.add(secretValue)
  }
  for (const [variableName, variableValue] of Object.entries(environment)) {
    if (variableValue === undefined || variableValue.length < SHORTEST_SCANNABLE_SECRET) continue
    if (isSecretShapedName(variableName)) values.add(variableValue)
  }
  return [...values]
}

/**
 * The same set as `knownSecretValues`, as a THUNK that re-reads `ENSO_HOME/secrets.env` when the
 * file changes (#207).
 *
 * The reader is per call — `readSecret` re-reads the file every time, so a rotated key is live
 * for the next web-search call and the refusal message says so — while the logger's value
 * alternation was compiled once, at configure. A key added or rotated while a launcher runs was
 * therefore readable and unredactable for the rest of that process's life, which is the one
 * window the design invites. Reproduced before this existed: a `warn` quoting the rotated value
 * landed in the day file verbatim.
 *
 * The identity of the returned array is the CHANGE SIGNAL, not just its contents: unchanged
 * file, same array, and `redactingKnownValues` keeps its compiled regex. Callers may rely on
 * that — it is why the redactor can ask per record without recompiling per record.
 *
 * The stamp is the file's mtime, size and inode, so a rotation is seen whether it was an
 * in-place write or a write-and-rename. `mtimeMs` is a double carrying the platform's
 * nanoseconds (≈0.2 µs of resolution here), so two rotations inside the same millisecond are
 * still two stamps — and the size and inode catch the rest.
 *
 * One `stat` per call is what this costs: measured 1.7 µs, against ~8 µs for the record write
 * it rides on (`.local` benchmark, #207). An event-driven watcher would be cheaper and is
 * deliberately not used — an inotify handle per process, lost across an atomic replace, is a
 * failure mode a redactor may not have.
 *
 * @group Secrets
 */
export function knownSecretValuesTracking(
  home: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): () => readonly string[] {
  const secretsPath = ensoSecretsPath(home)
  const ABSENT = -1
  let seenMtime = ABSENT
  let seenSize = ABSENT
  let seenInode = ABSENT
  let values: readonly string[] | undefined
  return (): readonly string[] => {
    const stat = statSync(secretsPath, { throwIfNoEntry: false })
    const mtime = stat === undefined ? ABSENT : stat.mtimeMs
    const size = stat === undefined ? ABSENT : stat.size
    const inode = stat === undefined ? ABSENT : stat.ino
    if (values !== undefined && mtime === seenMtime && size === seenSize && inode === seenInode) return values
    seenMtime = mtime
    seenSize = size
    seenInode = inode
    values = knownSecretValues(home, environment)
    return values
  }
}

/** @group Secrets */
export interface QuarantineReport {
  /** Names deleted from the environment, sorted. Never values — this is what a startup log line prints. */
  readonly removed: readonly string[]
  /** Secret-shaped names the ROOT `.env` defines: bun would autoload them into every bun child. Move them to `ENSO_HOME/secrets.env`. */
  readonly misplaced: readonly string[]
}

/**
 * Remove from `environment` every secret-shaped name and every name `ENSO_HOME/secrets.env`
 * defines (whatever its shape — everything in the secrets file is a secret by definition),
 * and report a root `.env` that still holds secret-shaped names.
 *
 * ⚠ The root `.env` is NOT ours, so it is judged by shape only: a project
 * may keep `PORT` or `PUBLIC_URL` there, and deleting those from the process would break
 * the very config bun loaded them for. Its secret-shaped names are already scrubbed by the
 * shape rule; they are additionally reported as misplaced so the operator moves them.
 *
 * ⚠ Call it before the first session and before the first child process; both inherit the
 * environment as it is at that moment, and nothing removes a variable from a child after
 * the fact. Idempotent: a second call finds nothing to remove.
 *
 * @group Secrets
 */
export function quarantineSecrets(
  environment: Record<string, string | undefined>,
  places: {
    /** The Enso checkout, whose root `.env` is judged; `undefined` when Enso is installed, not checked out (#950). */
    readonly repoRoot: string | undefined
    readonly home: string
  },
): QuarantineReport {
  // No checkout, no root `.env` of Enso's to report on: nothing is misplaced (#950).
  const rootDotenv =
    places.repoRoot === undefined ? new Map<string, string>() : readDotenvFile(rootDotenvPath(places.repoRoot))
  const doomed = new Set<string>(readDotenvFile(ensoSecretsPath(places.home)).keys())
  for (const variableName of Object.keys(environment)) if (isSecretShapedName(variableName)) doomed.add(variableName)
  const removed: string[] = []
  for (const doomedName of doomed) {
    if (!(doomedName in environment)) continue
    delete environment[doomedName]
    removed.push(doomedName)
  }
  const misplaced = [...rootDotenv.keys()].filter((definedName) => isSecretShapedName(definedName)).toSorted()
  return { removed: removed.toSorted(), misplaced }
}
