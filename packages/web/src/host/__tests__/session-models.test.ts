import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentDirModelRuntime, type HostModelRuntime, sessionModels } from '../session-models.ts'

/**
 * #904: which runtime Settings reads and logs in through once threads come and go. Real pi
 * runtimes over an empty agent dir stand in for the bound sessions'; the probe is never reached —
 * a live session is always bound — so its session store refuses to be made.
 */

/** A runtime whose `refresh` calls are recorded in `refreshed`. */
async function countedRuntime(agentDir: string, refreshed: HostModelRuntime[]): Promise<HostModelRuntime> {
  const runtime = await agentDirModelRuntime(agentDir)
  const refresh = runtime.refresh.bind(runtime)
  runtime.refresh = (options) => {
    refreshed.push(runtime)
    return refresh(options)
  }
  return runtime
}

// A disposed session's extensions have had `session_shutdown`: a login through its runtime could
// run an account slot's flow on an extension that has stopped. The list falls back to the latest
// session still live, and a released runtime is refreshed no more.
test("a released session's runtime is neither the list nor refreshed: the latest live one is (#904)", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'enso-session-models-'))
  const models = sessionModels({
    agentDir,
    harnessPackageDir: agentDir,
    extensionFactories: [],
    inMemorySession: () => {
      throw new Error('no probe: a live session is bound')
    },
  })
  const refreshed: HostModelRuntime[] = []
  const first = await countedRuntime(agentDir, refreshed)
  const second = await countedRuntime(agentDir, refreshed)
  models.adopt(first)
  models.adopt(second)
  expect(await models.runtime()).toBe(second)

  models.release(second)
  expect(await models.runtime()).toBe(first)
  await models.refreshAll()
  expect(refreshed).toEqual([first])
})
