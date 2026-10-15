import {
  ENSO_JUDGE_KEY_NAME,
  type EnsoSecurityConfig,
  type EnsoSecuritySettingsRead,
  localJudgeUrlProblem,
} from '@enso/core'
import { ensoSecretsPath, replaceFileText } from '@enso/core/paths'
import { parseDotenv, readSecret } from '@enso/core/secrets'
import { bytesOf, type WriteCondition } from './atomic-file.ts'
import { type ConfigSectionWrite, readConfigFile, writeConfigSections } from './config-file.ts'

/**
 * Settings › Security's files (#933): the `security` section of the user's `config.json`, and the
 * command judge's key in `secrets.env`.
 *
 * ⚠ `config.json` IS A POLICY FILE THAT FAILS CLOSED — the server will not launch, incidents halt,
 * the judge is off — so a save is the whole file, written as `config-file.ts` writes it.
 *
 * ⚠ THE KEY IS NEVER SENT BACK. The read says whether it is set; the write takes a value and
 * answers only that.
 */

/** The user's `security` and the key's presence, or why the config cannot be read. */
export function readSecuritySettings(home: string): EnsoSecuritySettingsRead {
  const { parsed, ...file } = readConfigFile(home)
  const common = {
    ...file,
    secretsPath: ensoSecretsPath(home),
    judgeKeySet: (readSecret(home, ENSO_JUDGE_KEY_NAME) ?? '').length > 0,
  }
  if (parsed.kind === 'unreadable') return { kind: 'unreadable', ...common, reason: parsed.reason }
  return { kind: 'ok', ...common, security: parsed.config.security ?? {} }
}

/** @group Security settings */
export type SecuritySettingsWrite = ConfigSectionWrite<EnsoSecuritySettingsRead>

/**
 * `security` with its empty objects dropped: a page that clears every field leaves no `{}` behind.
 * Every other key is kept, primitive or not, so one added to `EnsoSecurityConfig` is never lost
 * by a save.
 *
 * @group Security settings
 */
export function prunedSecurity(security: EnsoSecurityConfig): EnsoSecurityConfig | undefined {
  const kept = Object.entries(security).filter(
    ([, value]) =>
      value !== undefined && (value === null || typeof value !== 'object' || Object.keys(value).length > 0),
  )
  return kept.length === 0 ? undefined : Object.fromEntries(kept)
}

/**
 * Write `security` into the user's `config.json` under `condition`, every other key kept. A file
 * that is unreadable now, a result `parseEnsoConfig` refuses, or a `local` judge off this machine
 * (`localJudgeUrlProblem`: the guard would never ask it, so the page refuses it too) writes nothing.
 */
export function writeSecuritySettings(
  home: string,
  security: EnsoSecurityConfig,
  condition: WriteCondition,
): SecuritySettingsWrite {
  const judge = security.judge
  const offMachine =
    judge?.backend === 'local' && judge.local !== undefined ? localJudgeUrlProblem(judge.local.baseUrl) : undefined
  if (offMachine !== undefined) return { kind: 'refused', reason: `nothing was saved: ${offMachine}` }
  return writeConfigSections(
    home,
    condition,
    ({ security: _replaced, ...kept }) => {
      const section = prunedSecurity(security)
      return section === undefined ? kept : { ...kept, security: section }
    },
    () => readSecuritySettings(home),
  )
}

/** A value `parseDotenv` reads back exactly, unquoted: no whitespace, quote or `#`. */
const PLAIN_SECRET = /^[^\s'"#]+$/

/** `secrets.env`'s permission bits: read and written by its owner only. */
const OWNER_ONLY_FILE_MODE = 0o600

/** @group Security settings */
export type JudgeKeyWrite =
  | { readonly kind: 'written'; readonly judgeKeySet: boolean }
  | { readonly kind: 'refused'; readonly reason: string }

/**
 * Store the judge's key in `secrets.env` (`null` removes it), every other line kept as written; the
 * file is replaced atomically and stays `0600`. The value is never logged or answered.
 */
export function writeJudgeKey(home: string, value: string | null): JudgeKeyWrite {
  const secretsPath = ensoSecretsPath(home)
  if (value !== null && !PLAIN_SECRET.test(value)) {
    return { kind: 'refused', reason: 'a key is one token: no spaces, quotes or `#`' }
  }
  const text = bytesOf(secretsPath)?.toString('utf8') ?? ''
  const lines = text.split(/\r?\n/).filter((line) => !parseDotenv(line).has(ENSO_JUDGE_KEY_NAME))
  while (lines.length > 0 && lines.at(-1) === '') lines.pop()
  if (value !== null) lines.push(`${ENSO_JUDGE_KEY_NAME}=${value}`)
  replaceFileText(secretsPath, lines.length === 0 ? '' : `${lines.join('\n')}\n`, OWNER_ONLY_FILE_MODE)
  return { kind: 'written', judgeKeySet: (readSecret(home, ENSO_JUDGE_KEY_NAME) ?? '').length > 0 }
}
