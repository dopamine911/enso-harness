import { afterAll, afterEach, expect, test } from 'bun:test'
import type { EnsoPermissionPolicyRead, EnsoPermissionPolicyWrite } from '@enso/core'
import { act } from 'react'
import type { createRoot as CreateRoot, Root } from 'react-dom/client'
import type * as SettingsDialogModule from '../settings-dialog.tsx'
import { ensureDom, releaseDom } from './dom-environment.ts'

// ⚠ A DOM before react-dom/client and Radix evaluate — `dom-environment.ts` has the measurement.
ensureDom()
const { createRoot }: { createRoot: typeof CreateRoot } = await import('react-dom/client')
const { SettingsDialog }: typeof SettingsDialogModule = await import('../settings-dialog.tsx')

/**
 * Settings' Permissions tab (#474), MOUNTED under happy-dom over a scripted server: a save names
 * the version read and sends the whole file, a 412 keeps the draft until the person reloads, a 422
 * lists the schema's problems, the yolo banner follows the file, Enso's `**` takes an action change
 * only, and "Try a command" never guesses without a live thread.
 */

afterAll(releaseDom)

/** Let React, Radix and the scripted fetches settle: microtasks only, no clock. */
const settle = (): Promise<void> =>
  act(async () => {
    for (let round = 0; round < 10; round += 1) await Promise.resolve()
  })

const SETTLE_ROUNDS = 50
async function eventually<T>(probe: () => T): Promise<T> {
  for (let round = 0; ; round += 1) {
    try {
      return probe()
    } catch (failure) {
      if (round >= SETTLE_ROUNDS) throw failure
      await settle()
    }
  }
}

const FILE = {
  authorizerChain: ['enso-auto'],
  permission: {
    '*': 'ask',
    read: 'allow',
    edit: { '**': 'ask' },
    bash: {
      '**': 'ask',
      'git status': 'allow',
      'npm run *': 'allow',
      'rm -rf *': { action: 'deny', reason: 'never delete the tree' },
    },
  },
}

const ENSO_DEFAULT = { authorizerChain: ['enso-auto'], permission: { '*': 'ask', bash: { '**': 'ask' } } }

const policyOf = (file: Record<string, unknown>, etag: string): EnsoPermissionPolicyRead => ({
  kind: 'ok',
  path: '/home/person/.enso/permissions.json',
  etag,
  file,
  reviewLogDirectory: '/home/person/.enso/logs',
  ensoDefault: ENSO_DEFAULT,
})

interface Sent {
  readonly request: string
  readonly ifMatch: string | null
  readonly ifNoneMatch: string | null
  readonly body: unknown
}

interface Mounted {
  readonly sent: Sent[]
  readonly dialog: () => HTMLElement
  readonly unmount: () => Promise<void>
}
const leftOpen = new Set<Mounted>()
afterEach(async () => {
  for (const mounted of leftOpen) await mounted.unmount()
})

/** A request the test answers itself — a 412 or a 422 the server would give — instead of the script. */
type Override = (request: string) => Response | undefined

/** The scripted server: the file as read, a write read back under a new version, a reset, a verdict. */
function answer(request: string, body: unknown, file: Record<string, unknown>, writes: number): Response {
  if (request === 'GET /api/permissions') {
    return Response.json(policyOf(file, '"v1"'), { headers: { ETag: '"v1"' } })
  }
  if (request === 'PUT /api/permissions') {
    const written = (body as EnsoPermissionPolicyWrite).file
    return Response.json(policyOf(written, `"v${writes + 1}"`))
  }
  if (request === 'POST /api/permissions/reset') {
    return Response.json({ backup: '/home/person/.enso/permissions.json.bak', policy: policyOf(ENSO_DEFAULT, '"v9"') })
  }
  if (request === 'POST /api/threads/t1/permissions/check') {
    return Response.json({ mode: 'default', state: 'ask', matchedPattern: '**', origin: 'global' })
  }
  return new Response('not scripted', { status: 404 })
}

async function mountSettings(
  options: { threadId?: string; file?: Record<string, unknown>; override?: Override } = {},
): Promise<Mounted> {
  const sent: Sent[] = []
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  const fetch = (input: string, init?: RequestInit): Promise<Response> => {
    const request = `${init?.method ?? 'GET'} ${input}`
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    const headers = new Headers(init?.headers)
    sent.push({ request, ifMatch: headers.get('If-Match'), ifNoneMatch: headers.get('If-None-Match'), body })
    const writes = sent.filter((entry) => entry.request === 'PUT /api/permissions').length
    return Promise.resolve(options.override?.(request) ?? answer(request, body, options.file ?? FILE, writes))
  }
  await act(async () => {
    root.render(
      <SettingsDialog
        threadId={options.threadId}
        fetch={fetch}
        projects={[]}
        stored={[]}
        onDeleted={(threadId): void => {
          throw new Error(`the Permissions tests delete no thread, yet ${threadId} was`)
        }}
      />,
    )
  })
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="settings"]')
  if (trigger === null) throw new Error('expected the settings button')
  await act(async () => trigger.click())
  const mounted: Mounted = {
    sent,
    dialog: (): HTMLElement => {
      const found = document.querySelector<HTMLElement>('[role="dialog"]')
      if (found === null) throw new Error('expected Settings to be open')
      return found
    },
    unmount: async (): Promise<void> => {
      if (!leftOpen.delete(mounted)) return
      await act(async () => root.unmount())
      container.remove()
    },
  }
  leftOpen.add(mounted)
  const tab = await eventually(() => {
    const found = [...mounted.dialog().querySelectorAll<HTMLElement>('[role="tab"]')].find(
      (candidate) => candidate.textContent === 'Permissions',
    )
    if (found === undefined) throw new Error('expected the Permissions tab')
    return found
  })
  // Radix activates a tab on mousedown, as a pointer does; a bare click event would not.
  await act(async () => {
    tab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
  })
  await eventually(() => expect(mounted.dialog().textContent).toContain('/home/person/.enso/permissions.json'))
  return mounted
}

function find<Found extends Element>(mounted: Mounted, selector: string): Found {
  const found = mounted.dialog().querySelector<Found>(selector)
  if (found === null) throw new Error(`expected ${selector}`)
  return found
}

function buttonNamed(mounted: Mounted, name: string): HTMLButtonElement {
  const found = [...mounted.dialog().querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent?.trim() === name || button.getAttribute('aria-label') === name,
  )
  if (found === undefined) throw new Error(`expected the ${name} button`)
  return found
}

async function click(mounted: Mounted, name: string): Promise<void> {
  const button = await eventually(() => buttonNamed(mounted, name))
  await act(async () => button.click())
  await settle()
}

/** Choose in a native select the way a person would — its value, then the change event. */
async function choose(mounted: Mounted, label: string, value: string): Promise<void> {
  const select = await eventually(() => find<HTMLSelectElement>(mounted, `select[aria-label="${label}"]`))
  await act(async () => {
    Reflect.set(HTMLSelectElement.prototype, 'value', value, select)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

async function typeInto(mounted: Mounted, label: string, text: string): Promise<void> {
  const field = await eventually(() => find<HTMLInputElement>(mounted, `input[aria-label="${label}"]`))
  await act(async () => {
    Reflect.set(HTMLInputElement.prototype, 'value', text, field)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const actionOf = (mounted: Mounted, rule: string): string =>
  find<HTMLSelectElement>(mounted, `select[aria-label="action ${rule}"]`).value

const writes = (mounted: Mounted): Sent[] => mounted.sent.filter((entry) => entry.request === 'PUT /api/permissions')

/** The `permission` block the `position`th save sent. */
function writtenPermission(mounted: Mounted, position: number): Record<string, unknown> {
  const write = writes(mounted)[position]
  if (write === undefined) throw new Error(`expected save ${position}`)
  return (write.body as EnsoPermissionPolicyWrite).file.permission as Record<string, unknown>
}

test('⚠ Save sends the whole file under the ETag read, and the next save names the version it wrote', async () => {
  const mounted = await mountSettings()
  await choose(mounted, 'action bash git status', 'deny')
  await click(mounted, 'Save')
  await eventually(() => expect(writes(mounted)).toHaveLength(1))
  expect(writes(mounted)[0]?.ifMatch).toBe('"v1"')
  expect(writes(mounted)[0]?.body).toEqual({
    file: { ...FILE, permission: { ...FILE.permission, bash: { ...FILE.permission.bash, 'git status': 'deny' } } },
  })
  await eventually(() => expect(buttonNamed(mounted, 'Save').disabled).toBe(true))
  expect(actionOf(mounted, 'bash git status')).toBe('deny')
  await choose(mounted, 'action read *', 'ask')
  await click(mounted, 'Save')
  await eventually(() => expect(writes(mounted)).toHaveLength(2))
  expect(writes(mounted)[1]?.ifMatch).toBe('"v2"')
  // A surface written as one action stays one action.
  expect(writtenPermission(mounted, 1)).toMatchObject({ read: 'ask' })
})

test('⚠ a 412 keeps the draft and offers a reload, which takes the file as it is on disk', async () => {
  const mounted = await mountSettings({
    override: (request) =>
      request === 'PUT /api/permissions'
        ? Response.json({ reason: 'the file changed since it was read' }, { status: 412 })
        : undefined,
  })
  await choose(mounted, 'action bash git status', 'deny')
  await click(mounted, 'Save')
  await eventually(() => expect(find(mounted, '[aria-label="changed on disk"]').textContent).toContain('changed'))
  expect(actionOf(mounted, 'bash git status')).toBe('deny')
  expect(buttonNamed(mounted, 'Save').disabled).toBe(false)
  await click(mounted, 'Reload from disk')
  await eventually(() => expect(actionOf(mounted, 'bash git status')).toBe('allow'))
  expect(mounted.sent.filter((entry) => entry.request === 'GET /api/permissions')).toHaveLength(2)
  expect(mounted.dialog().querySelector('[aria-label="changed on disk"]')).toBeNull()
})

// #519 item 2: Overwrite with mine sent the file as FIRST read with `If-Match: *`, so a setting
// changed by hand in the meantime was silently reverted. It now re-reads the file on disk and puts
// only the draft's rules over it, under that read's version.
test('⚠ Overwrite with mine keeps a setting changed on disk since the read: only the rules are replaced, under the new version (#519)', async () => {
  let reads = 0
  let writes = 0
  const mounted = await mountSettings({
    override: (request) => {
      if (request === 'GET /api/permissions') {
        reads += 1
        if (reads === 1) return undefined
        const onDisk = { ...FILE, permissionReviewLog: false }
        return Response.json(policyOf(onDisk, '"v2"'), { headers: { ETag: '"v2"' } })
      }
      if (request === 'PUT /api/permissions') {
        writes += 1
        if (writes === 1) return Response.json({ reason: 'the file changed since it was read' }, { status: 412 })
      }
      return undefined
    },
  })
  await choose(mounted, 'action bash git status', 'deny')
  await click(mounted, 'Save')
  await eventually(() => find(mounted, '[aria-label="changed on disk"]'))
  await click(mounted, 'Overwrite with mine')
  await eventually(() =>
    expect(mounted.sent.filter((entry) => entry.request === 'PUT /api/permissions')).toHaveLength(2),
  )
  const overwrite = mounted.sent.findLast((entry) => entry.request === 'PUT /api/permissions')
  if (overwrite === undefined) throw new Error('no overwrite was sent')
  expect(overwrite.ifMatch).toBe('"v2"')
  const written = (overwrite.body as EnsoPermissionPolicyWrite).file
  expect(written.permissionReviewLog).toBe(false)
  expect((written.permission as typeof FILE.permission).bash['git status']).toBe('deny')
})

// The overwrite's one other branch (PR #791 review): a file that cannot be read when the overwrite
// re-reads it is overwritten as before, the file as first read under `If-Match: *`.
test('Overwrite with mine, when the file on disk cannot be read now, writes over it as read', async () => {
  let reads = 0
  let writes = 0
  const mounted = await mountSettings({
    override: (request) => {
      if (request === 'GET /api/permissions') {
        reads += 1
        return reads === 1 ? undefined : new Response('gone', { status: 503 })
      }
      if (request === 'PUT /api/permissions') {
        writes += 1
        if (writes === 1) return Response.json({ reason: 'the file changed since it was read' }, { status: 412 })
      }
      return undefined
    },
  })
  await choose(mounted, 'action bash git status', 'deny')
  await click(mounted, 'Save')
  await eventually(() => find(mounted, '[aria-label="changed on disk"]'))
  await click(mounted, 'Overwrite with mine')
  await eventually(() =>
    expect(mounted.sent.filter((entry) => entry.request === 'PUT /api/permissions')).toHaveLength(2),
  )
  const overwrite = mounted.sent.findLast((entry) => entry.request === 'PUT /api/permissions')
  if (overwrite === undefined) throw new Error('no overwrite was sent')
  expect(overwrite.ifMatch).toBe('*')
  const written = (overwrite.body as EnsoPermissionPolicyWrite).file
  expect(written.authorizerChain).toEqual(FILE.authorizerChain)
  expect((written.permission as typeof FILE.permission).bash['git status']).toBe('deny')
})

// #519 item 1: the reset's notice ("…kept at permissions.json.bak") stayed through later edits and saves.
test('a reset names its backup until the next edit', async () => {
  const mounted = await mountSettings()
  await click(mounted, "Reset to Enso's policy…")
  await click(mounted, 'Reset')
  await eventually(() => expect(mounted.dialog().textContent).toContain('/home/person/.enso/permissions.json.bak'))
  await choose(mounted, 'action bash **', 'deny')
  await eventually(() => expect(mounted.dialog().textContent).not.toContain('/home/person/.enso/permissions.json.bak'))
})

test('a 422 lists where the schema refused the file, and keeps the draft', async () => {
  const mounted = await mountSettings({
    override: (request) =>
      request === 'PUT /api/permissions'
        ? Response.json(
            {
              reason: 'the engine refused the file',
              problems: [{ at: '/permission/bash/git status', message: 'must be allow, ask or deny' }],
            },
            { status: 422 },
          )
        : undefined,
  })
  await choose(mounted, 'action bash git status', 'deny')
  await click(mounted, 'Save')
  const refusal = await eventually(() => find(mounted, '[aria-label="refused"]'))
  expect(refusal.textContent).toContain('/permission/bash/git status')
  expect(refusal.textContent).toContain('must be allow, ask or deny')
  expect(actionOf(mounted, 'bash git status')).toBe('deny')
})

test('the yolo banner shows only when the file sets yoloMode on', async () => {
  const off = await mountSettings({ file: { ...FILE, yoloMode: false } })
  expect(off.dialog().querySelector('[aria-label="yolo mode"]')).toBeNull()
  await off.unmount()
  const on = await mountSettings({ file: { ...FILE, yoloMode: true } })
  expect(on.dialog().querySelector('[aria-label="yolo mode"]')).not.toBeNull()
})

test("⚠ Enso's ** takes an action change only: it cannot be removed, moved, renamed, or passed by a move", async () => {
  const mounted = await mountSettings()
  const catchAll = find(mounted, '[aria-label="bash **"]')
  expect(catchAll.querySelectorAll('button')).toHaveLength(0)
  expect(catchAll.querySelector('input')).toBeNull()
  expect(catchAll.querySelector('select[aria-label="action bash **"]')).not.toBeNull()
  // The first rule after ** cannot move above it.
  expect(buttonNamed(mounted, 'move bash git status up').disabled).toBe(true)
  await click(mounted, 'move bash git status down')
  await click(mounted, 'remove bash rm -rf *')
  await click(mounted, 'Save')
  await eventually(() => expect(writes(mounted)).toHaveLength(1))
  expect(Object.keys(writtenPermission(mounted, 0).bash as object)).toEqual(['**', 'npm run *', 'git status'])
})

/** Rename a rule's pattern the way a person would: type it, then Enter. */
async function rename(mounted: Mounted, rule: string, to: string): Promise<void> {
  await typeInto(mounted, `pattern ${rule}`, to)
  const field = find<HTMLInputElement>(mounted, `input[aria-label="pattern ${rule}"]`)
  await act(async () => {
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
}

test('a pattern renamed in place keeps its place; a rename onto a pattern the surface has is refused', async () => {
  const mounted = await mountSettings()
  await rename(mounted, 'bash npm run *', 'git status')
  expect(mounted.dialog().textContent).toContain('bash already has git status')
  await rename(mounted, 'bash npm run *', 'npm test')
  await click(mounted, 'Save')
  await eventually(() => expect(writes(mounted)).toHaveLength(1))
  expect(Object.keys(writtenPermission(mounted, 0).bash as object)).toEqual([
    '**',
    'git status',
    'npm test',
    'rm -rf *',
  ])
})

test('a drafted group adds only the rules not already in force, after **', async () => {
  const file = { ...FILE, permission: { ...FILE.permission, bash: { ...FILE.permission.bash, 'git push *': 'ask' } } }
  const mounted = await mountSettings({ file })
  await click(mounted, 'add Remote writes')
  expect(buttonNamed(mounted, 'add Remote writes').disabled).toBe(true)
  await click(mounted, 'Save')
  await eventually(() => expect(writes(mounted)).toHaveLength(1))
  expect(Object.keys(writtenPermission(mounted, 0).bash as object)).toEqual([
    '**',
    'git status',
    'npm run *',
    'rm -rf *',
    'git push *',
    'gh pr create*',
    'curl * -X POST*',
  ])
})

test('reset shows what it would change before it asks the server, then names the backup', async () => {
  const mounted = await mountSettings()
  await click(mounted, "Reset to Enso's policy…")
  const diff = await eventually(() => find(mounted, '[aria-label="reset diff"]'))
  expect(diff.textContent).toContain('git status: removed allow')
  expect(diff.textContent).toContain('read')
  expect(mounted.sent.filter((entry) => entry.request === 'POST /api/permissions/reset')).toHaveLength(0)
  await click(mounted, 'Reset')
  await eventually(() => expect(mounted.dialog().textContent).toContain('/home/person/.enso/permissions.json.bak'))
  expect(mounted.sent.find((entry) => entry.request === 'POST /api/permissions/reset')?.ifMatch).toBe('"v1"')
})

test('a missing file is said to be an empty policy, with its reason, and its reset is a create', async () => {
  const mounted = await mountSettings({
    override: (request) =>
      request === 'GET /api/permissions'
        ? Response.json({
            kind: 'unreadable',
            path: '/home/person/.enso/permissions.json',
            reason: 'the file is missing: the next launch seeds Enso’s policy',
            reviewLogDirectory: '/logs',
            ensoDefault: ENSO_DEFAULT,
          })
        : undefined,
  })
  const warning = find(mounted, '[aria-label="unreadable policy"]')
  expect(warning.textContent).toContain('EMPTY policy')
  expect(warning.textContent).toContain('the file is missing')
  await click(mounted, "Reset to Enso's policy…")
  await click(mounted, 'Reset')
  await eventually(() => expect(mounted.sent.at(-1)?.request).toBe('POST /api/permissions/reset'))
  // No file, no version to name: `If-Match: *` would be refused, since there is nothing there.
  expect(mounted.sent.at(-1)).toMatchObject({ ifMatch: null, ifNoneMatch: '*' })
})

test('⚠ try a command with no thread open says so and asks nothing', async () => {
  const mounted = await mountSettings()
  expect(find(mounted, '[aria-label="try a command"]').textContent).toContain('Open a thread to ask its engine')
  await typeInto(mounted, 'check value', 'git push')
  await click(mounted, 'Ask the engine')
  expect(mounted.sent.filter((entry) => entry.request.includes('/check'))).toEqual([])
})

// ⚠ Review of #474: asked about `path` itself, the engine answers from the raw shorthand block — a
// verdict no call meets, since a read goes through `path_read`. A rule may still be ADDED on `path`.
test('try a command offers a shorthand surface as its directions; adding a rule still offers the shorthand', async () => {
  const file = { ...FILE, permission: { ...FILE.permission, external_directory: { '**': 'ask', '/etc/*': 'deny' } } }
  const mounted = await mountSettings({ file })
  const options = (label: string): string[] =>
    [...find(mounted, `select[aria-label="${label}"]`).querySelectorAll('option')].map((option) => option.value)
  expect(options('check surface')).not.toContain('external_directory')
  expect(options('check surface')).toEqual(
    expect.arrayContaining(['external_directory_read', 'external_directory_write']),
  )
  expect(options('new rule surface')).toContain('external_directory')
})

test("try a command shows the engine's verdict for the open thread, and a thread whose engine has not loaded says so", async () => {
  const mounted = await mountSettings({ threadId: 't1' })
  await typeInto(mounted, 'check value', 'git push origin main')
  await click(mounted, 'Ask the engine')
  const verdict = await eventually(() => find(mounted, '[aria-label="verdict"]'))
  expect(verdict.textContent).toContain('global — your file')
  expect(mounted.sent.at(-1)?.body).toEqual({ surface: 'bash', value: 'git push origin main' })
  await mounted.unmount()
  const idle = await mountSettings({
    threadId: 't1',
    override: (request) =>
      request.endsWith('/check')
        ? Response.json({ reason: 'no permission engine loaded' }, { status: 409 })
        : undefined,
  })
  await typeInto(idle, 'check value', 'ls')
  await click(idle, 'Ask the engine')
  await eventually(() =>
    expect(find(idle, '[aria-label="try a command"]').textContent).toContain('permission engine has not loaded'),
  )
})
