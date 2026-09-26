import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverAndLoadExtensions } from '@earendil-works/pi-coding-agent'
import { attributeNotices, extensionSender } from '../notice-sender.ts'

/**
 * #387 gap 2: who said a notice. pi hands every extension the same `ctx.ui`; the host tags each
 * extension's registrations with the extension pi loaded. These load a probe through pi's REAL
 * loader — the Extension objects, the `on` and the unsubscribe it returns are pi's — and pin
 * what the tag must do and what it must not break.
 */

const harnessPackageDir = '/repo/packages/harness'

test('an extension is named by the path pi loaded it from: its package, the harness’s own, or nothing inline', () => {
  expect(extensionSender('/repo/node_modules/pi-multi-account/index.ts', harnessPackageDir)).toBe('pi-multi-account')
  expect(extensionSender('/repo/node_modules/@scope/some-extension/index.ts', harnessPackageDir)).toBe('some-extension')
  // A package manager's store nests node_modules; the innermost package is the extension.
  expect(
    extensionSender('/repo/node_modules/.store/pkg@1/node_modules/pi-multi-account/index.ts', harnessPackageDir),
  ).toBe('pi-multi-account')
  expect(extensionSender('/repo/packages/harness/extensions/web-search/index.ts', harnessPackageDir)).toBe(
    'Enso web-search',
  )
  expect(extensionSender('<inline:enso-host-model-watch>', harnessPackageDir)).toBeUndefined()
  // Anywhere else: the extension's own directory.
  expect(extensionSender('/elsewhere/probe/index.ts', harnessPackageDir)).toBe('probe')
})

// The probe keeps its unsubscribe on globalThis so the test can call it — the way an extension
// that stops listening would.
const scratch = mkdtempSync(join(tmpdir(), 'enso-notice-sender-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
const probeDir = join(scratch, 'node_modules', 'probe-extension')
mkdirSync(probeDir, { recursive: true })
writeFileSync(
  join(probeDir, 'index.ts'),
  `export default function probe(pi) {
  globalThis.__ensoProbeUnsubscribe = pi.on('session_start', (_event, ctx) => ctx.ui.notify('started', 'info'))
  pi.registerCommand('probe', { description: 'probe', handler: async (_args, ctx) => ctx.ui.notify('ran', 'warning') })
}
`,
)

type Said = { sender?: string; message: string; type?: string | undefined }

/** An extension context the way pi hands one over: a `ui`, a `sessionManager`, and more. */
function contextOn(said: Said[], withSender: boolean): { ui: object; sessionManager: object; cwd: string } {
  const ui = {
    notify: (message: string, type?: string) => void said.push({ message, type }),
    ...(withSender
      ? { notifyFrom: (sender: string, message: string, type?: string) => void said.push({ sender, message, type }) }
      : {}),
  }
  return { ui, sessionManager: {}, cwd: '/somewhere' }
}

async function loadProbe(): Promise<Awaited<ReturnType<typeof discoverAndLoadExtensions>>['extensions'][number]> {
  const loaded = await discoverAndLoadExtensions([join(probeDir, 'index.ts')], scratch, join(scratch, 'agent'))
  expect(loaded.errors).toEqual([])
  attributeNotices(loaded, harnessPackageDir)
  const [extension] = loaded.extensions
  if (extension === undefined) throw new Error('the probe did not load')
  return extension
}

test('⚠ a handler and a command speak as their extension; a UI that cannot be told falls back to plain notify', async () => {
  const extension = await loadProbe()
  const said: Said[] = []
  const [onStart] = extension.handlers.get('session_start') ?? []
  await onStart?.({ type: 'session_start' }, contextOn(said, true))
  await extension.commands.get('probe')?.handler('', contextOn(said, true) as never)
  // pi's own terminal UI has no `notifyFrom`: the notice still goes out, untagged.
  await onStart?.({ type: 'session_start' }, contextOn(said, false))
  expect(said).toEqual([
    { sender: 'probe-extension', message: 'started', type: 'info' },
    { sender: 'probe-extension', message: 'ran', type: 'warning' },
    { message: 'started', type: 'info' },
  ])
})

// pi's unsubscribe finds its handler with `list.indexOf(registeredHandler)`. A wrapper swapped into
// the list without care makes that a silent no-op — the listener could never be removed.
test('⚠ the unsubscribe pi returned still removes the handler once it is wrapped', async () => {
  const extension = await loadProbe()
  expect(extension.handlers.get('session_start')).toHaveLength(1)
  ;(globalThis as { __ensoProbeUnsubscribe?: () => void }).__ensoProbeUnsubscribe?.()
  expect(extension.handlers.has('session_start')).toBe(false)
})
