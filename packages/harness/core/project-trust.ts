import { dirname } from 'node:path'
import { realpathOrSelf } from '@enso/core/paths'
import { resolvePathLikePi } from './paths.ts'

/**
 * The terminal's project-trust question (#421), in pi's words, over pi's OWN store (#509).
 *
 * A project's own `.enso/config.json` is read only once the project is trusted, and the decision
 * is pi's — the SAME `trust.json` in the agent dir that gates a project's `.pi/` — so one answer
 * covers both and a decision made in either place holds in the other. pi exports the store
 * (`ProjectTrustStore`) and the default (`SettingsManager#getDefaultProjectTrust`) since 0.87.1, so
 * both are pi's own, and they reach this package by injection ({@link ProjectTrustRuntime}):
 * `harness/core` may not import pi (#145), the extensions that resolve a session's config may.
 *
 * ⚠ What stays copied is only {@link projectTrustOptions}: pi's `getProjectTrustOptions` is not on
 * its package index (re-checked at 1.1.0), and the terminal's question must offer pi's answers in
 * pi's wording. It writes nothing; every write goes through pi's store, under pi's lock.
 */

/**
 * One saved answer: `true` trusted, `false` not, `null` removes the entry.
 *
 * @group Project trust
 */
export interface ProjectTrustUpdate {
  readonly path: string
  readonly decision: boolean | null
}

/**
 * One answer to the trust question, as pi offers it.
 *
 * @group Project trust
 */
export interface ProjectTrustOption {
  readonly label: string
  readonly trusted: boolean
  /** What saving this answer writes; empty for a this-session-only answer. */
  readonly updates: readonly ProjectTrustUpdate[]
  /** Where the decision lands, when one is saved. */
  readonly savedPath?: string
}

/** The key pi stores a directory's decision under: its resolved, canonical path. */
function trustKey(directory: string): string {
  return realpathOrSelf(resolvePathLikePi(directory))
}

/**
 * The answers pi offers for `directory` — Trust, Trust parent folder (when there is a parent), and
 * Do not trust, each with a this-session-only variant — in pi's order and wording, since the
 * decision is written to pi's store and read back by pi.
 *
 * @group Project trust
 */
export function projectTrustOptions(directory: string): ProjectTrustOption[] {
  const path = trustKey(directory)
  const parent = dirname(path)
  return [
    { label: 'Trust', trusted: true, updates: [{ path, decision: true }], savedPath: path },
    ...(parent === path
      ? []
      : [
          {
            label: `Trust parent folder (${parent})`,
            trusted: true,
            updates: [
              { path: parent, decision: true },
              { path, decision: null },
            ],
            savedPath: parent,
          },
        ]),
    { label: 'Trust (this session only)', trusted: true, updates: [] },
    { label: 'Do not trust', trusted: false, updates: [{ path, decision: false }], savedPath: path },
    { label: 'Do not trust (this session only)', trusted: false, updates: [] },
  ]
}

/**
 * pi's two trust readers, handed in by an extension (#509): `harness/core` may not import pi (#145),
 * so it names the shapes it uses and the extension passes pi's own classes — the store, with its
 * lock, and the settings whose `defaultProjectTrust` pi reads from the agent dir only.
 *
 * @group Project trust
 */
export interface ProjectTrustRuntime {
  readonly ProjectTrustStore: new (agentDir: string) => {
    /** The decision for `directory` or its nearest ancestor that has one; `null` when none does. */
    get(directory: string): boolean | null
    /** Apply updates under pi's lock, as one read-modify-write. */
    setMany(updates: ProjectTrustUpdate[]): void
  }
  readonly SettingsManager: {
    create(
      cwd: string,
      agentDir: string,
      options: { readonly projectTrusted: boolean },
    ): { getDefaultProjectTrust(): 'ask' | 'always' | 'never' }
  }
}
