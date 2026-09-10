import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startZenServer } from '../index.ts'

/**
 * ⚠ The precondition that was missing when a real run failed.
 *
 * A reinstall can destroy or omit the vendor links (npm did on every install; bun's
 * hoisted linker leaves the harness tree to our postinstall), pi skips a missing
 * manifest resource path
 * SILENTLY, and the visible symptom was an HTTP 400 from the provider several layers away.
 * `scripts/zen.mjs` already refused to launch on this; the server did not. These assert it
 * now does, at both launch points.
 */

function fakeHarness(manifestPi: Record<string, string[]>, createLinks: boolean): string {
  const directory = mkdtempSync(join(tmpdir(), 'zen-harness-fake-'))
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'zen-harness', pi: manifestPi }))
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

const cwd = tmpdir()

test('refuses to start when a vendor manifest path is missing', () => {
  const harness = fakeHarness(
    { extensions: ['./extensions/guards/index.ts', 'node_modules/pi-multi-account/index.ts'] },
    false,
  )
  expect(() => startZenServer({ cwd, harnessPackageDir: harness, agentDir: tmpdir(), logsDir: tmpdir() })).toThrow(
    /vendor package paths are missing/,
  )
})

test('the refusal NAMES the missing path and the fix', () => {
  const harness = fakeHarness({ extensions: ['node_modules/pi-multi-account/index.ts'] }, false)
  // Capture-then-assert keeps the assertions unconditional: no refusal leaves `thrown`
  // undefined, and the message assertions fail on `undefined` rather than being skipped.
  let thrown: unknown
  try {
    startZenServer({ cwd, harnessPackageDir: harness, agentDir: tmpdir(), logsDir: tmpdir() })
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
  const started = startZenServer({
    cwd,
    harnessPackageDir: harness,
    agentDir: tmpdir(),
    logsDir: mkdtempSync(join(tmpdir(), 'zen-logs-')),
    port: 0,
  })
  expect(started.url).toContain('127.0.0.1')
  await started.close()
})

test('a non-vendor manifest path is not required to exist', async () => {
  // `./extensions/...` is our own source; only `node_modules/` entries are link-dependent.
  const harness = fakeHarness({ extensions: ['./extensions/guards/index.ts'] }, false)
  const started = startZenServer({
    cwd,
    harnessPackageDir: harness,
    agentDir: tmpdir(),
    logsDir: mkdtempSync(join(tmpdir(), 'zen-logs-')),
    port: 0,
  })
  // It started: the URL is bound. (Was `expect(true).toBe(true)` — #53 S3.)
  expect(started.url).toContain('127.0.0.1')
  await started.close()
})

test('refuses when the harness package.json itself is absent', () => {
  expect(() =>
    startZenServer({
      cwd,
      harnessPackageDir: join(tmpdir(), 'definitely-not-here'),
      agentDir: tmpdir(),
      logsDir: tmpdir(),
    }),
  ).toThrow(/no package.json/)
})

test('refuses an empty cwd before touching the filesystem', () => {
  expect(() =>
    startZenServer({
      cwd: '',
      harnessPackageDir: fakeHarness({ extensions: [] }, true),
      agentDir: tmpdir(),
      logsDir: tmpdir(),
    }),
  ).toThrow(/cwd must not be empty/)
})
