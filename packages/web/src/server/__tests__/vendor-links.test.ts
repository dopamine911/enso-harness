import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentHost } from '../../host/agent-host.ts'
import { startEnsoServer } from '../index.ts'
import { createFakeAgentHost } from './fake-hosted-thread.ts'

/**
 * ⚠ The precondition that was missing when a real run failed.
 *
 * A reinstall can destroy or omit the vendor links (npm did on every install; bun's
 * hoisted linker leaves the harness tree to our postinstall), pi skips a missing
 * manifest resource path
 * SILENTLY, and the visible symptom was an HTTP 400 from the provider several layers away.
 * `scripts/enso.ts` already refused to launch on this; the server did not. These assert the
 * server now does. Both launchers ask the same question, `@enso/core`'s `missingVendorPaths`, so
 * the two cannot drift; the terminal launcher's own refusal is not exercised here.
 *
 * ⚠ Every server here takes {@link NO_HOST}, never a real `AgentHost` (#160 §7): building one sets
 * `PI_CODING_AGENT_DIR` and quarantines secrets IN THIS PROCESS'S environment — the test runner's
 * (`agent-host.ts`). What is under test runs before the host is built.
 */

function fakeHarness(manifestPi: Record<string, string[]>, createLinks: boolean): string {
  const directory = mkdtempSync(join(tmpdir(), 'enso-fake-'))
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'Enso', pi: manifestPi }))
  if (createLinks) {
    for (const entry of Object.values(manifestPi).flat()) {
      if (!entry.startsWith('node_modules/')) continue
      const target = join(directory, entry)
      mkdirSync(join(target, '..'), { recursive: true })
      writeFileSync(target, '// present')
    }
  }
  return directory
}
/** A harness whose `pi` is whatever a future edit — or a typo — put there. */
function fakeHarnessWithPi(pi: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), 'enso-malformed-'))
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'Enso', pi }))
  return directory
}

const cwd = tmpdir()

/** A host no test here reaches — see the header's ⚠. */
const NO_HOST = (): AgentHost =>
  createFakeAgentHost(() => Promise.reject(new Error('the vendor-link tests build no session')))

test('refuses to start when a vendor manifest path is missing', () => {
  const harness = fakeHarness(
    { extensions: ['./extensions/guards/index.ts', 'node_modules/pi-multi-account/index.ts'] },
    false,
  )
  expect(() =>
    startEnsoServer({
      host: NO_HOST,
      cwd,
      harnessPackageDir: harness,
      agentDir: tmpdir(),
      permissionRulesPath: join(tmpdir(), 'enso-unread-permissions.json'),
      logsDir: tmpdir(),
    }),
  ).toThrow(/vendor package paths are missing/)
})

test('the refusal NAMES the missing path and the fix', () => {
  const harness = fakeHarness({ extensions: ['node_modules/pi-multi-account/index.ts'] }, false)
  // Capture-then-assert keeps the assertions unconditional: no refusal leaves `thrown`
  // undefined, and the message assertions fail on `undefined` rather than being skipped.
  let thrown: unknown
  try {
    startEnsoServer({
      host: NO_HOST,
      cwd,
      harnessPackageDir: harness,
      agentDir: tmpdir(),
      permissionRulesPath: join(tmpdir(), 'enso-unread-permissions.json'),
      logsDir: tmpdir(),
    })
  } catch (error) {
    thrown = error
  }
  const message = (thrown as Error | undefined)?.message ?? ''
  // Named, not counted — a count cannot say which link to recreate.
  expect(message).toContain('node_modules/pi-multi-account/index.ts')
  expect(message).toContain('bun install')
})

test('starts when every vendor path resolves', async () => {
  const harness = fakeHarness({ extensions: ['node_modules/pi-multi-account/index.ts'] }, true)
  const started = startEnsoServer({
    host: NO_HOST,
    cwd,
    harnessPackageDir: harness,
    agentDir: tmpdir(),
    permissionRulesPath: join(tmpdir(), 'enso-unread-permissions.json'),
    logsDir: mkdtempSync(join(tmpdir(), 'enso-logs-')),
    port: 0,
  })
  expect(started.url).toContain('127.0.0.1')
  await started.close()
})

test('a non-vendor manifest path is not required to exist', async () => {
  // `./extensions/...` is our own source; only `node_modules/` entries are link-dependent.
  const harness = fakeHarness({ extensions: ['./extensions/guards/index.ts'] }, false)
  const started = startEnsoServer({
    host: NO_HOST,
    cwd,
    harnessPackageDir: harness,
    agentDir: tmpdir(),
    permissionRulesPath: join(tmpdir(), 'enso-unread-permissions.json'),
    logsDir: mkdtempSync(join(tmpdir(), 'enso-logs-')),
    port: 0,
  })
  // It started: the URL is bound. (Was `expect(true).toBe(true)` — #53 S3.)
  expect(started.url).toContain('127.0.0.1')
  await started.close()
})

test('refuses when the harness package.json itself is absent', () => {
  expect(() =>
    startEnsoServer({
      host: NO_HOST,
      cwd,
      harnessPackageDir: join(tmpdir(), 'definitely-not-here'),
      agentDir: tmpdir(),
      permissionRulesPath: join(tmpdir(), 'enso-unread-permissions.json'),
      logsDir: tmpdir(),
    }),
  ).toThrow(/no package.json/)
})

test('refuses an empty cwd before touching the filesystem', () => {
  expect(() =>
    startEnsoServer({
      host: NO_HOST,
      cwd: '',
      harnessPackageDir: fakeHarness({ extensions: [] }, true),
      agentDir: tmpdir(),
      permissionRulesPath: join(tmpdir(), 'enso-unread-permissions.json'),
      logsDir: tmpdir(),
    }),
  ).toThrow(/cwd must not be empty/)
})

/**
 * ⚠ A MALFORMED MANIFEST MUST NOT MAKE THE GUARD PASS (#226). `assertVendorLinks` used to
 * assert `Record<string, string | string[]>` off `JSON.parse` and read `.startsWith` from
 * whatever arrived: a bare-string `pi` sent `Object.values` over its CHARACTERS, none of
 * which start with `node_modules/`, so nothing was missing and the server booted with the
 * vendor precondition unchecked — the exact silent absence this module exists to catch.
 * A red line here is that silence back.
 */
test('a `pi` that is not an object is refused by name, not walked character by character', () => {
  expect(() =>
    startEnsoServer({
      host: NO_HOST,
      cwd,
      harnessPackageDir: fakeHarnessWithPi('node_modules/pi-multi-account/index.ts'),
      agentDir: tmpdir(),
      permissionRulesPath: join(tmpdir(), 'enso-unread-permissions.json'),
      logsDir: tmpdir(),
    }),
  ).toThrow(/`pi` that is not an object/)
})

/**
 * The other half: a resource path that is neither a string nor a string array — the obvious
 * future edit is a nested object for a new resource kind — is DROPPED, as
 * `scripts/enso-launch.ts` drops it. It used to reach `.startsWith` and throw a `TypeError`
 * out of the boot path, so `bun run dev` died with an unrelated message while `bun run enso`
 * launched fine.
 */
test('a non-string resource path is skipped, not handed to `.startsWith`', async () => {
  const started = startEnsoServer({
    host: NO_HOST,
    cwd,
    harnessPackageDir: fakeHarnessWithPi({ extensions: [{ path: 'node_modules/whatever' }], skills: 42 }),
    agentDir: tmpdir(),
    permissionRulesPath: join(tmpdir(), 'enso-unread-permissions.json'),
    logsDir: mkdtempSync(join(tmpdir(), 'enso-logs-')),
    port: 0,
  })
  expect(started.url).toContain('127.0.0.1')
  await started.close()
})
