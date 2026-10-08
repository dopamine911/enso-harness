import { afterAll, expect, test } from 'bun:test'
import type { EnsoProject, EnsoProjectSettings, EnsoTreeSetupOutcome } from '@enso/core'
import { act } from 'react'
import type { createRoot as CreateRoot, Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import type * as DialogModule from '../project-settings-dialog.tsx'
import type * as RailModule from '../threads-rail.tsx'
import type * as ReportModule from '../tree-setup-report.tsx'
import { ensureDom, releaseDom } from './dom-environment.ts'

// ⚠ A DOM before react-dom/client and Radix evaluate — `command-palette.test.tsx` has the
// measurement. The menu and the dialog are Radix portals; hence the imports below are dynamic.
ensureDom()
const { createRoot }: { createRoot: typeof CreateRoot } = await import('react-dom/client')
const { ProjectSettingsDialog }: typeof DialogModule = await import('../project-settings-dialog.tsx')
const { ThreadsRail }: typeof RailModule = await import('../threads-rail.tsx')
const { TreeSetupReport }: typeof ReportModule = await import('../tree-setup-report.tsx')

/**
 * A project's page (#754), MOUNTED over a fetch seam: the rail's menu opens it for every project,
 * it shows each tiered value with the file it comes from, and it writes only what the person
 * changed, to the tier they chose — the server's refusal said in its words.
 */

afterAll(releaseDom)

const tick = (): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, 20)
  return promise
}
const flush = (work: () => Promise<void>): Promise<void> => act(work)

async function eventually<T>(probe: () => T): Promise<T> {
  const deadline = Date.now() + 2000
  for (;;) {
    try {
      return probe()
    } catch (error) {
      if (Date.now() >= deadline) throw error
      await flush(tick)
    }
  }
}

const noop = (): void => {
  // The rail's other callbacks are not what these tests exercise.
}

const LAUNCH: EnsoProject = { projectId: 'p-launch', title: 'enso', path: '/code/enso', status: 'ok', launch: true }
const APP: EnsoProject = { projectId: 'p-app', title: 'app', path: '/code/app', status: 'ok', launch: false }

const FILES: EnsoProjectSettings['files'] = {
  user: '/home/me/.enso/config.json',
  shared: '/code/app/.enso/config.json',
  local: '/code/app/.enso/config.local.json',
}

/** The tree mode from the shared file, the commands from the user's, the files to copy from the local one. */
const SETTINGS: EnsoProjectSettings = {
  projectId: 'p-app',
  path: '/code/app',
  trusted: true,
  threads: {
    tree: { value: 'copy', tier: 'shared' },
    setup: { value: ['bun install'], tier: 'user' },
    copy: { value: ['.env'], tier: 'local' },
  },
  files: FILES,
  unreadable: [],
}

async function mount(node: React.ReactNode): Promise<{ readonly unmount: () => Promise<void> }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  await flush(async () => {
    root.render(node)
    await tick()
  })
  return {
    unmount: async () => {
      await flush(async () => root.unmount())
      container.remove()
    },
  }
}

/** The rail with both projects; what Project settings was chosen for. */
async function mountRail(): Promise<{ readonly opened: string[]; readonly unmount: () => Promise<void> }> {
  const opened: string[] = []
  const mounted = await mount(
    <ThreadsRail
      projects={[LAUNCH, APP]}
      threads={[]}
      activeThreadId={undefined}
      earlier={[]}
      earlierError={undefined}
      onSelect={noop}
      onResume={noop}
      onNew={noop}
      onAddProject={noop}
      onRemoveProject={noop}
      onProjectSettings={(projectId: string) => opened.push(projectId)}
      projectNotice={undefined}
    />,
  )
  return { opened, unmount: mounted.unmount }
}

/** Open a section's `⋯` menu and answer the names of its items. */
async function openMenu(name: string): Promise<string[]> {
  const trigger = document.querySelector<HTMLElement>(`button[aria-label="more for ${name}"]`)
  if (trigger === null) throw new Error(`expected the menu of ${name}`)
  await flush(async () => {
    // Radix opens a menu on a primary-button pointerdown.
    trigger.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, pointerType: 'mouse' }))
    await tick()
  })
  return eventually(() => {
    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((item) => item.textContent ?? '')
    expect(items.length).toBeGreaterThan(0)
    return items
  })
}

async function closeMenu(): Promise<void> {
  await flush(async () => {
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await tick()
  })
  await eventually(() => expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(0))
}

test('every project’s menu offers Project settings — the launch one too — and only a registered one offers Remove (#754)', async () => {
  const rail = await mountRail()
  expect(await openMenu('enso')).toEqual(['Project settings…'])
  await closeMenu()
  expect(await openMenu('app')).toEqual(['Project settings…', 'Remove project — its threads stay on disk'])
  const settingsItem = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (item) => item.textContent === 'Project settings…',
  )
  await flush(async () => {
    settingsItem?.click()
    await tick()
  })
  expect(rail.opened).toEqual(['p-app'])
  await rail.unmount()
})

/** A PUT the page sent: its body, parsed. */
type Sent = { readonly tier: string; readonly threads: Record<string, unknown> }

/** The page over a scripted server: GET answers `settings`; each PUT answers the next of `answers`. */
async function mountPage(
  settings: EnsoProjectSettings,
  answers: readonly Response[] = [],
): Promise<{ readonly sent: Sent[]; readonly dialog: () => HTMLElement; readonly unmount: () => Promise<void> }> {
  const sent: Sent[] = []
  const reads: string[] = []
  const fetchImpl = (input: string, init?: RequestInit): Promise<Response> => {
    if (init?.method === 'PUT') {
      if (typeof init.body !== 'string') throw new Error(`expected a JSON text body, got ${typeof init.body}`)
      sent.push(JSON.parse(init.body) as Sent)
      const answer = answers[sent.length - 1]
      if (answer === undefined) throw new Error(`no answer scripted for PUT ${sent.length}`)
      return Promise.resolve(answer)
    }
    reads.push(input)
    return Promise.resolve(Response.json(settings))
  }
  const mounted = await mount(<ProjectSettingsDialog project={APP} onClose={noop} fetch={fetchImpl} />)
  const dialog = (): HTMLElement => {
    const found = document.querySelector<HTMLElement>('[role="dialog"]')
    if (found === null) throw new Error('no dialog')
    return found
  }
  await eventually(() => expect(dialog().textContent).toContain('Setup commands'))
  expect(reads).toEqual(['/api/projects/p-app/settings'])
  return { sent, dialog, unmount: mounted.unmount }
}

/** The control a visible label names, as a screen reader finds it. */
function labelled<Control extends HTMLElement>(dialog: HTMLElement, label: string): Control {
  const found = [...dialog.querySelectorAll('label')].find((candidate) => candidate.textContent === label)
  const control = found === undefined ? null : document.getElementById(found.htmlFor)
  if (control === null) throw new Error(`no control labelled ${label}`)
  return control as Control
}

function buttonNamed(dialog: HTMLElement, name: string): HTMLButtonElement {
  const found = [...dialog.querySelectorAll('button')].find(
    (button) => (button.getAttribute('aria-label') ?? button.textContent?.trim()) === name,
  )
  if (found === undefined) throw new Error(`no ${name} button`)
  return found
}

async function press(button: HTMLElement): Promise<void> {
  await flush(async () => {
    button.click()
    await tick()
  })
}

/** Type into a controlled textarea the way a browser does: the prototype's setter, then `input`. */
async function typeInto(field: HTMLTextAreaElement, text: string): Promise<void> {
  await flush(async () => {
    Reflect.set(HTMLTextAreaElement.prototype, 'value', text, field)
    field.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
  })
}

/** The words under a field: the tier its value comes from. */
function tierOf(dialog: HTMLElement, label: string): string {
  const field = [...dialog.querySelectorAll('label')]
    .find((candidate) => candidate.textContent === label)
    ?.closest('[data-slot="field"]')
  const line = [...(field?.querySelectorAll('p') ?? [])].find((paragraph) => paragraph.textContent?.startsWith('from '))
  return line?.textContent ?? `no tier under ${label}`
}

test('the page is named by its project and shows each value with the tier and the file it comes from (#754)', async () => {
  const page = await mountPage(SETTINGS)
  const dialog = page.dialog()
  const title = document.getElementById(dialog.getAttribute('aria-labelledby') ?? '')
  expect(title?.textContent).toBe('app')
  expect(dialog.textContent).toContain('/code/app')
  expect(labelled<HTMLSelectElement>(dialog, 'New threads run in').value).toBe('copy')
  expect(labelled<HTMLTextAreaElement>(dialog, 'Files to copy into a new tree').value).toBe('.env')
  expect(labelled<HTMLTextAreaElement>(dialog, 'Setup commands').value).toBe('bun install')
  expect(tierOf(dialog, 'New threads run in')).toBe('from shared with the project (/code/app/.enso/config.json)')
  expect(tierOf(dialog, 'Setup commands')).toBe('from your settings (/home/me/.enso/config.json)')
  expect(tierOf(dialog, 'Files to copy into a new tree')).toBe(
    'from only you, this project (/code/app/.enso/config.local.json)',
  )
  // ⚠ The commands run on this machine: said beside them.
  expect(dialog.textContent).toContain("These run on your machine, in the new tree, each time a thread's tree is made.")
  // Only a value from the project's own files can be reset here; the user's is edited where it always was.
  expect(() => buttonNamed(dialog, 'Reset Setup commands')).toThrow()
  const saveTo = dialog.querySelector<HTMLElement>('[role="radiogroup"]')
  expect(document.getElementById(saveTo?.getAttribute('aria-labelledby') ?? '')?.textContent).toBe('Save to')
  expect(saveTo?.querySelector('[role="radio"][aria-checked="true"]')?.getAttribute('value')).toBe('local')
  expect(dialog.textContent).not.toContain('not trusted')
  await page.unmount()
})

test('Save sends one PUT to Only me with just the changed key; the answer is shown, from its new tier (#754)', async () => {
  const saved: EnsoProjectSettings = {
    ...SETTINGS,
    threads: {
      ...SETTINGS.threads,
      setup: { value: ['bun install --frozen-lockfile', 'bun run build'], tier: 'local' },
    },
  }
  const page = await mountPage(SETTINGS, [Response.json(saved)])
  const dialog = page.dialog()
  expect(buttonNamed(dialog, 'Save').disabled).toBe(true)
  await typeInto(
    labelled<HTMLTextAreaElement>(dialog, 'Setup commands'),
    '  bun install --frozen-lockfile\n\nbun run build\n',
  )
  await press(buttonNamed(dialog, 'Save'))
  await eventually(() =>
    expect(tierOf(page.dialog(), 'Setup commands')).toBe(
      'from only you, this project (/code/app/.enso/config.local.json)',
    ),
  )
  expect(page.sent).toEqual([{ tier: 'local', threads: { setup: ['bun install --frozen-lockfile', 'bun run build'] } }])
  expect(labelled<HTMLTextAreaElement>(page.dialog(), 'Setup commands').value).toBe(
    'bun install --frozen-lockfile\nbun run build',
  )
  await page.unmount()
})

test('Reset removes a key from the tier that set it, so the next tier shows through (#754)', async () => {
  const afterReset: EnsoProjectSettings = {
    ...SETTINGS,
    threads: { ...SETTINGS.threads, tree: { value: 'worktree', tier: 'default' } },
  }
  const page = await mountPage(SETTINGS, [Response.json(afterReset)])
  await press(buttonNamed(page.dialog(), 'Reset New threads run in'))
  await eventually(() => expect(tierOf(page.dialog(), 'New threads run in')).toBe('from default'))
  expect(page.sent).toEqual([{ tier: 'shared', threads: { tree: null } }])
  expect(labelled<HTMLSelectElement>(page.dialog(), 'New threads run in').value).toBe('worktree')
  await page.unmount()
})

test('Save to Shared writes the shared tier, an emptied list as []; a refusal is shown in the server’s words (#754)', async () => {
  const page = await mountPage(SETTINGS, [
    new Response('the project has a file named .enso, not a folder', { status: 422 }),
  ])
  const dialog = page.dialog()
  const shared = dialog.querySelector<HTMLElement>('[role="radio"][value="shared"]')
  if (shared === null) throw new Error('expected the Shared choice')
  await press(shared)
  await typeInto(labelled<HTMLTextAreaElement>(dialog, 'Files to copy into a new tree'), '')
  await press(buttonNamed(dialog, 'Save'))
  await eventually(() =>
    expect(page.dialog().querySelector('[role="alert"]')?.textContent).toBe(
      '422 the project has a file named .enso, not a folder',
    ),
  )
  expect(page.sent).toEqual([{ tier: 'shared', threads: { copy: [] } }])
  // The draft is kept, to fix and save again.
  expect(labelled<HTMLTextAreaElement>(page.dialog(), 'Files to copy into a new tree').value).toBe('')
  await page.unmount()
})

test('an untrusted project says its own files are not read, and that saving still writes them (#754)', async () => {
  const page = await mountPage({
    ...SETTINGS,
    trusted: false,
    threads: {
      tree: { value: 'worktree', tier: 'default' },
      setup: { value: [], tier: 'default' },
      copy: { value: [], tier: 'default' },
    },
  })
  const note = page.dialog().querySelector('[role="note"]')?.textContent ?? ''
  expect(note).toContain('not trusted')
  expect(note).toContain('only your settings apply')
  expect(note).toContain('Saving still writes the file')
  await page.unmount()
})

const SETUP_OK: EnsoTreeSetupOutcome = {
  ok: true,
  copied: ['.env'],
  missing: [],
  steps: [
    { command: 'bun install', exitCode: 0, durationMs: 1200, output: 'installed', truncated: false },
    { command: 'bun run build', exitCode: 0, durationMs: 300, output: '', truncated: false },
  ],
  tiers: { setup: 'local', copy: 'shared' },
}

test('a setup that went well says how many commands ran, and what was copied in (#754)', () => {
  const rendered = renderToStaticMarkup(<TreeSetupReport setup={SETUP_OK} />)
  expect(rendered).toContain('Setup: 2 commands ran (ok)')
  expect(rendered).toContain('.env')
  expect(rendered).not.toContain('role="alert"')
})
