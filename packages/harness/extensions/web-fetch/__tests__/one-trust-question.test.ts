import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensoAgentDir, projectConfigPath } from '@enso/core/paths'
import { sessionEnsoConfig } from '../../../core/index.ts'
import { createWebSearch, type WebSearchDependencies } from '../../web-search/index.ts'
import { createWebFetch } from '../index.ts'

/**
 * #421, found live: the trust question for a project's `.enso/config.json` must be asked ONCE per
 * session, though two tools (web_fetch, web_search) read the config. pi hands each EXTENSION its own
 * `events` object and every extension of a session the SAME `sessionManager` on its context — so a
 * resolution keyed on `events` asked twice. Both real tools, the real resolver, a real ENSO_HOME and
 * project; only pi's two per-extension objects and the UI are stand-ins.
 */

type SessionStart = (event: unknown, context: unknown) => void | Promise<void>

/** Load one extension as pi does: its own API object, its own `events`, its session_start handler returned. */
function load(factory: (pi: never) => void): SessionStart {
  let sessionStart: SessionStart | undefined
  factory({
    registerTool: () => undefined,
    on: (event: string, handler: SessionStart) => {
      if (event === 'session_start') sessionStart = handler
    },
    events: {},
  } as never)
  if (sessionStart === undefined) throw new Error('the extension registered no session_start')
  return sessionStart
}

test('⚠ two tools, one session: the trust question is asked once (#421)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'enso-one-question-'))
  const home = join(root, 'home', '.enso')
  const cwd = join(root, 'project')
  mkdirSync(ensoAgentDir(home), { recursive: true })
  mkdirSync(join(cwd, '.enso'), { recursive: true })
  writeFileSync(projectConfigPath(cwd), JSON.stringify({ webFetch: { allowedHosts: ['docs.project.example'] } }))

  const resolveSessionConfig: WebSearchDependencies['resolveSessionConfig'] = (session, context) =>
    sessionEnsoConfig(session, { ...context, home, hostOwnsTrust: false })
  const neverRead = (): undefined => undefined
  const startFetch = load(
    createWebFetch({
      locateConfigFile: () => join(home, 'config.json'),
      readConfigText: neverRead,
      resolveSessionConfig,
      fetchUrl: () => Promise.reject(new Error('no network')),
      resolveHostAddresses: () => Promise.reject(new Error('no DNS')),
    }),
  )
  const startSearch = load(
    createWebSearch({
      locateConfigFile: () => join(home, 'config.json'),
      readConfigText: neverRead,
      resolveSessionConfig,
      readEnvironmentVariable: neverRead,
      runProviders: {} as WebSearchDependencies['runProviders'],
      fetchUrl: () => Promise.reject(new Error('no network')),
    }),
  )

  const asked: string[] = []
  const answer = Promise.withResolvers<string | undefined>()
  // One session: one sessionManager, one UI — handed to every extension's context, as pi's runner does.
  const context = {
    cwd,
    hasUI: true,
    sessionManager: {},
    ui: {
      select: (title: string) => {
        asked.push(title)
        return answer.promise
      },
      notify: () => undefined,
    },
  }
  await startFetch({ type: 'session_start' }, context)
  await startSearch({ type: 'session_start' }, context)
  answer.resolve('Trust (this session only)')
  await answer.promise
  expect(asked).toHaveLength(1)
})
