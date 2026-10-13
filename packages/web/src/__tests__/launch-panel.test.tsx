import { afterAll, afterEach, expect, test } from 'bun:test'
import {
  type EnsoLibraryPrompt,
  type EnsoLibraryPromptListing,
  type EnsoProject,
  type EnsoProjectPromptLibrary,
  type EnsoStoredThread,
  type RuntimeCommand,
  summarizeLibraryPrompt,
} from '@enso/core'
import { act } from 'react'
import type { createRoot as CreateRoot, Root } from 'react-dom/client'
import { projectList, storedThreads } from '../page-listings.ts'
import type { LaunchActions } from '../pane-context.ts'
import { ThreadPane } from '../thread-pane.tsx'
import { clearThreadsForTest, mintThread, type ThreadStores } from '../thread-stores.ts'
import { ensureDom, releaseDom } from './dom-environment.ts'
import {
  createScriptedFetch,
  requestedUrl,
  type ScriptedFetch,
  type ScriptedFetchOptions,
  SNAPSHOT_IDLE,
} from './scripted-server.ts'

// ⚠ A DOM before react-dom/client evaluates — `thread-pane.test.tsx` has the measurement. The model
// picker and the chips' lists are Radix portals, rendered into `document.body`.
ensureDom()
const { createRoot }: { createRoot: typeof CreateRoot } = await import('react-dom/client')

/**
 * A new thread's launch panel (#877, formerly the Start-a-session dialog of #391), MOUNTED in the
 * real pane over the scripted server: what Start sends is the contract — every setting in ONE
 * configure call, the effort the session will really run at (#852), then the prompt through the
 * composer's own send — and a refused step keeps the panel, names the step, and keeps the prompt
 * and its attachments.
 */

afterAll(releaseDom)

/** Every panel a test mounted and did not unmount — a failed test's, so it cannot answer the next one's queries. */
const leftOpen = new Set<Mounted>()
afterEach(async () => {
  for (const mounted of leftOpen) await mounted.unmount()
  clearThreadsForTest()
})

const tick = (): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, 20)
  return promise
}
const flush = (work: () => Promise<void>): Promise<void> => act(work)

const EVENTUALLY_DEADLINE_MS = 2000
async function eventually<T>(probe: () => T): Promise<T> {
  const deadline = Date.now() + EVENTUALLY_DEADLINE_MS
  for (;;) {
    try {
      return probe()
    } catch (error) {
      if (Date.now() >= deadline) throw error
      await flush(tick)
    }
  }
}

/**
 * The host's catalogue for a thread with no session (#484): a reasoning model, the configured
 * default, listed after one that cannot reason — the chosen model is not the list's first row, as in
 * the run that found #846. Each option carries the level pi runs it at once chosen (#852); the
 * catalogue has no `/thinking` row, the case where the effort box was empty.
 */
const PLAIN = {
  id: 'fake/plain',
  label: 'Plain',
  detail: 'fake',
  thinkingLevels: ['off'],
  defaultThinkingLevel: 'off',
}
const DEEP = {
  id: 'fake/deep',
  label: 'Deep',
  detail: 'fake',
  thinkingLevels: ['off', 'low', 'medium', 'high'],
  defaultThinkingLevel: 'medium',
}
function modelRow(
  value: string,
  options: readonly (typeof PLAIN | Omit<typeof DEEP, 'defaultThinkingLevel'>)[],
): RuntimeCommand {
  return { name: 'model', source: 'host', kind: 'select', value, options: [...options] }
}
const CATALOGUE: readonly RuntimeCommand[] = [modelRow('fake/deep', [PLAIN, DEEP])]

/** A saved session prompt, body included — what `GET /api/prompts/triage` answers. */
const TRIAGE: EnsoLibraryPrompt = {
  id: 'triage',
  name: 'Triage',
  description: '',
  category: 'session',
  bytes: 60,
  tokens: 12,
  body: 'Triage the open issues.',
}

/**
 * The library (#443): a system prompt, an append prompt, a session prompt, one refused file — and a
 * system prompt saved under the id `pi-default`, which the panel must never take for pi's own.
 */
const LIBRARY: EnsoLibraryPromptListing = {
  prompts: [
    { id: 'reviewer', name: 'Reviewer', description: '', category: 'system', bytes: 900, tokens: 1234 },
    { id: 'haiku', name: 'Haiku', description: '', category: 'append', bytes: 40, tokens: 9 },
    { id: 'pi-default', name: 'Shadow', description: '', category: 'system', bytes: 30, tokens: 5 },
    summarizeLibraryPrompt(TRIAGE),
  ],
  refused: [{ file: 'broken.md', reason: 'broken.md: frontmatter category must be system, append or session' }],
}

/** Where the project's own prompts are (#470) — named whether or not they are read. */
const PROJECT_PROMPTS_DIR = '/work/repo/.enso/prompts'

/** A project prompt sharing the user's `reviewer` id (#470), and a session one, body included. */
const KICKOFF: EnsoLibraryPrompt = {
  id: 'kickoff',
  name: 'Kickoff',
  description: '',
  category: 'session',
  bytes: 50,
  tokens: 6,
  body: 'Read the README first.',
}
const TRUSTED_PROJECT: EnsoProjectPromptLibrary = {
  kind: 'listed',
  directory: PROJECT_PROMPTS_DIR,
  listing: {
    prompts: [
      { id: 'reviewer', name: 'Team reviewer', description: '', category: 'system', bytes: 80, tokens: 20 },
      summarizeLibraryPrompt(KICKOFF),
    ],
    refused: [{ file: 'odd.md', reason: 'odd.md: frontmatter has no name' }],
  },
}
/** A project with no prompts of its own: what the panel sees in most projects. */
const EMPTY_PROJECT: EnsoProjectPromptLibrary = {
  kind: 'listed',
  directory: PROJECT_PROMPTS_DIR,
  listing: { prompts: [], refused: [] },
}

const LAUNCH_PROJECT: EnsoProject = {
  projectId: 'p-launch',
  title: 'launch',
  path: '/scripted/launch',
  status: 'ok',
  launch: true,
}
const OTHER_PROJECT: EnsoProject = { projectId: 'p-other', title: 'other', path: '/other', status: 'ok', launch: false }

/** A 422 naming the step pi refused, as the configure route words it. */
const refusedAt = (step: string, reason: string): { status: number; body: unknown } => ({
  status: 422,
  body: { step, reason },
})

interface Mounted {
  readonly stores: ThreadStores
  readonly server: ScriptedFetch
  readonly container: HTMLElement
  /** What the panel's page actions were asked: the recent threads opened, and Manage projects. */
  readonly opened: string[]
  readonly managed: number[]
  readonly composer: () => HTMLTextAreaElement
  readonly startButton: () => HTMLButtonElement
  /** The chip named `label`, by its accessible name `Label: value`. */
  readonly chip: (label: string) => HTMLElement
  readonly unmount: () => Promise<void>
}

interface MountOptions {
  readonly server?: ScriptedFetchOptions
  readonly library?: 'present' | 'absent'
  readonly projectPrompts?: EnsoProjectPromptLibrary
  readonly projectId?: string
  /** The draft's own id — one a stored listing may name too (#479). */
  readonly threadId?: string
}

/** The server's prompt routes (#443, #470) over the scripted server, which has none. */
function withPromptRoutes(server: ScriptedFetch, options: MountOptions): typeof fetch {
  const project = options.projectPrompts ?? EMPTY_PROJECT
  return ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const path = new URL(requestedUrl(input), 'http://localhost').pathname
    if (path === '/api/prompts') {
      return Promise.resolve(
        options.library === 'absent'
          ? new Response('this server has no prompt library', { status: 404 })
          : Response.json(LIBRARY),
      )
    }
    if (path === '/api/prompts/triage') {
      return Promise.resolve(Response.json(TRIAGE, { headers: { ETag: `"${'c'.repeat(64)}"` } }))
    }
    if (/^\/api\/threads\/[^/]+\/project-prompts$/.test(path)) return Promise.resolve(Response.json(project))
    if (/^\/api\/threads\/[^/]+\/project-prompts\/kickoff$/.test(path)) {
      return Promise.resolve(Response.json(KICKOFF, { headers: { ETag: `"${'d'.repeat(64)}"` } }))
    }
    return server.fetch(input, init)
  }) as typeof fetch
}

/** A minted thread on its launch panel, in the real pane, the page's listings read and its follow connected. */
async function mountLaunch(options: MountOptions = {}): Promise<Mounted> {
  const server = createScriptedFetch({ commands: CATALOGUE, ...options.server })
  const fetchImpl = withPromptRoutes(server, options)
  globalThis.fetch = fetchImpl
  await flush(async () => {
    await Promise.all([projectList.refresh(), storedThreads.refresh()])
  })
  const stores = mintThread(fetchImpl, options.projectId ?? 'p-launch', options.threadId)
  const opened: string[] = []
  const managed: number[] = []
  const actions: LaunchActions = {
    openThread: (thread): void => void opened.push(thread.threadId),
    manageProjects: (): void => void managed.push(1),
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  await flush(async () => {
    root.render(<ThreadPane threadId={stores.threadId} active={true} debugOpen={false} launchActions={actions} />)
    await tick()
  })
  await flush(async () => {
    server.frame(SNAPSHOT_IDLE)
    await tick()
  })
  const one = <T extends Element>(selector: string): T => {
    const found = container.querySelector<T>(selector)
    if (found === null) throw new Error(`expected ${selector} in the pane`)
    return found
  }
  const mounted: Mounted = {
    stores,
    server,
    container,
    opened,
    managed,
    composer: () => one<HTMLTextAreaElement>('textarea[name="message"]'),
    startButton: () => {
      const found = [...container.querySelectorAll<HTMLButtonElement>('button[type="submit"]')].find((button) =>
        button.textContent?.startsWith('Start'),
      )
      if (found === undefined) throw new Error('expected the Start session button')
      return found
    },
    chip: (label: string) => {
      const found = [...container.querySelectorAll<HTMLElement>('[aria-label]')].find((element) =>
        element.getAttribute('aria-label')?.startsWith(`${label}: `),
      )
      if (found === undefined) throw new Error(`expected the ${label} chip`)
      return found
    },
    unmount: async (): Promise<void> => {
      if (!leftOpen.delete(mounted)) return
      await flush(async () => root.unmount())
      container.remove()
    },
  }
  leftOpen.add(mounted)
  return mounted
}

/** The launch panel's question, or undefined once the pane shows its transcript. */
const panelTitle = (mounted: Mounted): string | undefined =>
  mounted.container.querySelector('[role="region"] h2')?.textContent ?? undefined

/** Set a field's value the way typing does, so React's controlled value sees it. */
async function typeInto(field: HTMLInputElement | HTMLTextAreaElement, text: string): Promise<void> {
  const prototype = field instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
  await flush(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(field, text)
    field.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
  })
}

async function press(target: HTMLElement, key: string): Promise<void> {
  await flush(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    await tick()
  })
}

async function click(target: HTMLElement): Promise<void> {
  await flush(async () => {
    target.click()
    await tick()
  })
}

/** Type the prompt into the panel's composer and press Start, once the settings are read. */
async function typeAndStart(mounted: Mounted, prompt: string): Promise<void> {
  await typeInto(mounted.composer(), prompt)
  await eventually(() => expect(mounted.startButton().disabled).toBe(false))
  await click(mounted.startButton())
}

/** The model picker, opened from its chip: a Radix dialog in `document.body`. */
async function openModelPicker(mounted: Mounted): Promise<HTMLElement> {
  await eventually(() => expect(mounted.chip('Model').hasAttribute('disabled')).toBe(false))
  await click(mounted.chip('Model'))
  return eventually(() => {
    const found = document.querySelector<HTMLElement>('[role="dialog"]')
    if (found === null) throw new Error('expected the model picker')
    return found
  })
}

const picker = (): HTMLElement | null => document.querySelector<HTMLElement>('[role="dialog"]')

/** Choose a model in its picker by clicking its row. */
async function chooseModel(mounted: Mounted, modelId: string): Promise<void> {
  const dialog = await openModelPicker(mounted)
  const row = dialog.querySelector<HTMLElement>(`[cmdk-item][data-value="${modelId}"]`)
  if (row === null) throw new Error(`expected the ${modelId} row`)
  await click(row)
  await eventually(() => expect(picker()).toBeNull())
}

/** The picker's filter. */
function modelFilter(dialog: HTMLElement): HTMLInputElement {
  const found = dialog.querySelector<HTMLInputElement>('input[cmdk-input]')
  if (found === null) throw new Error('expected the model filter')
  return found
}

/** The model rows cmdk marks highlighted (`aria-selected`): the row Enter in the filter commits. */
function highlightedRows(dialog: HTMLElement): (string | null)[] {
  return [...dialog.querySelectorAll('[cmdk-item][aria-selected="true"]')].map((row) => row.getAttribute('data-value'))
}

/** The model row the filter names as its active descendant — what a screen reader announces — if any. */
function activeRow(filter: HTMLInputElement): string | undefined {
  const rowId = filter.getAttribute('aria-activedescendant')
  return (rowId === null ? undefined : document.getElementById(rowId)?.getAttribute('data-value')) ?? undefined
}

/** The model row the accessibility tree says is chosen. */
function chosenRow(dialog: HTMLElement): string | null | undefined {
  return [...dialog.querySelectorAll('[cmdk-item]')]
    .find((row) => row.textContent?.endsWith(', chosen'))
    ?.getAttribute('data-value')
}

/** Open a chip's Radix select, choose the option whose text starts with `label`; answers what it offered. */
async function choose(mounted: Mounted, chipLabel: string, label: string): Promise<string[]> {
  const trigger = await eventually(() => mounted.chip(chipLabel))
  await flush(async () => {
    // Radix opens a select on a primary-button pointerdown, as it does the palette's trigger.
    trigger.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, pointerType: 'mouse' }))
    await tick()
  })
  const option = await eventually(() => {
    const found = [...document.querySelectorAll<HTMLElement>('[data-slot="select-item"]')].find((candidate) =>
      candidate.textContent?.startsWith(label),
    )
    if (found === undefined) throw new Error(`expected the ${label} option`)
    return found
  })
  const offered = [...document.querySelectorAll('[data-slot="select-item"]')].map(
    (candidate) => candidate.textContent ?? '',
  )
  await flush(async () => {
    option.dispatchEvent(new PointerEvent('pointerup', { button: 0, bubbles: true, pointerType: 'mouse' }))
    option.click()
    await tick()
  })
  return offered
}

test('Start sends every setting in ONE configure call — the effort the CHOSEN model runs at — then the prompt, and the panel gives way to the transcript', async () => {
  const mounted = await mountLaunch()
  expect(panelTitle(mounted)).toBe('What should pi work on?')
  // The session would run Deep; Plain cannot reason, so choosing it takes the effort to `off`.
  await chooseModel(mounted, 'fake/plain')
  await typeAndStart(mounted, 'hello there')
  await eventually(() => expect(mounted.server.prompts.map((prompt) => prompt.message)).toEqual(['hello there']))
  // pi's default system prompt is said as `null` (#443): a retry must be able to take back a prompt
  // an earlier, refused Start already applied.
  expect(mounted.server.configures.map((configure) => configure.body)).toEqual([
    { model: 'fake/plain', thinking: 'off', mode: 'default', systemPrompt: null },
  ])
  await eventually(() => expect(panelTitle(mounted)).toBeUndefined())
  expect(mounted.stores.launch.get()).toBe(false)
  expect(mounted.composer().value).toBe('')
})

// ⚠ #852, found by Dogfood Arena runs: a thread with no session has no `/thinking` row (#484), so the
// effort box read empty while the session then ran at pi's default. The chip says the level the
// session will run at — the host's, never a guess — or plainly that pi's default applies.
test('⚠ the Effort chip shows the level the session will run at, never an empty box, and Start sends it (#852)', async () => {
  const mounted = await mountLaunch()
  await eventually(() => expect(mounted.chip('Effort').getAttribute('aria-label')).toBe('Effort: medium'))
  expect(mounted.chip('Effort').textContent).toBe('Effortmedium')
  await typeAndStart(mounted, 'go')
  await eventually(() =>
    expect(mounted.server.configures.map((configure) => configure.body)).toEqual([
      { model: 'fake/deep', thinking: 'medium', mode: 'default', systemPrompt: null },
    ]),
  )
  await mounted.unmount()

  // A host that names no level for the model: the chip says pi's default applies, and Start sends no effort.
  const { defaultThinkingLevel: _unnamed, ...unnamed } = DEEP
  const bare = await mountLaunch({ server: { commands: [modelRow('fake/deep', [unnamed])] } })
  await eventually(() => expect(bare.chip('Effort').getAttribute('aria-label')).toBe("Effort: pi's default"))
  await typeAndStart(bare, 'go')
  await eventually(() =>
    expect(bare.server.configures.map((configure) => configure.body)).toEqual([
      { model: 'fake/deep', mode: 'default', systemPrompt: null },
    ]),
  )
})

test('the chosen model is named as chosen in the accessibility tree, and the mark follows a new choice', async () => {
  const mounted = await mountLaunch()
  const dialog = await openModelPicker(mounted)
  const rowText = (modelId: string): string =>
    dialog.querySelector<HTMLElement>(`[cmdk-item][data-value="${modelId}"]`)?.textContent ?? 'no row'
  // The session would run Deep: it is the chosen one, Plain is not.
  expect(rowText('fake/deep')).toBe('Deepfake, chosen')
  expect(rowText('fake/plain')).toBe('Plainfake')
  await chooseModel(mounted, 'fake/plain')
  expect(mounted.chip('Model').getAttribute('aria-label')).toBe('Model: Plain')
  const reopened = await openModelPicker(mounted)
  expect(reopened.querySelector('[cmdk-item][data-value="fake/plain"]')?.textContent).toBe('Plainfake, chosen')
  expect(reopened.querySelector('[cmdk-item][data-value="fake/deep"]')?.textContent).toBe('Deepfake')
})

// ⚠ #846, found by a Dogfood Arena run: cmdk highlights its first row unless told which, so the
// list read `[selected]` on the first model while another was the chosen one — and Enter in the
// filter commits the highlighted row, so it swapped the chosen model for the first.
test('⚠ the model list opens highlighting the chosen model; the arrows and the filter move the highlight, and Enter commits it (#846)', async () => {
  const mounted = await mountLaunch()
  let dialog = await openModelPicker(mounted)
  let filter = modelFilter(dialog)
  // The filter is named: cmdk's label, wired to the input it ids itself.
  const labelId = filter.getAttribute('aria-labelledby')
  expect(labelId === null ? undefined : document.getElementById(labelId)?.textContent).toBe('Model')
  // Deep is chosen and the second row: it is the one highlighted, not Plain above it — and the
  // filter names no other row as active (cmdk names none until a key moves the highlight).
  await eventually(() => expect(highlightedRows(dialog)).toEqual(['fake/deep']))
  expect([undefined, 'fake/deep']).toContain(activeRow(filter))

  await press(filter, 'ArrowUp')
  expect(highlightedRows(dialog)).toEqual(['fake/plain'])
  expect(activeRow(filter)).toBe('fake/plain')
  await press(filter, 'ArrowDown')
  expect(highlightedRows(dialog)).toEqual(['fake/deep'])
  expect(activeRow(filter)).toBe('fake/deep')
  // Enter commits the highlight — Deep, still the chosen one — and closes the picker.
  await press(filter, 'Enter')
  await eventually(() => expect(picker()).toBeNull())
  expect(mounted.chip('Model').getAttribute('aria-label')).toBe('Model: Deep')

  // A filter that hides the chosen model highlights its first match; Enter takes it, and Start sends it.
  dialog = await openModelPicker(mounted)
  filter = modelFilter(dialog)
  await typeInto(filter, 'plain')
  await eventually(() => expect(highlightedRows(dialog)).toEqual(['fake/plain']))
  await press(filter, 'Enter')
  await eventually(() => expect(picker()).toBeNull())
  expect(mounted.chip('Model').getAttribute('aria-label')).toBe('Model: Plain')
  await typeAndStart(mounted, 'hello there')
  await eventually(() =>
    expect(mounted.server.configures.map((configure) => configure.body)).toEqual([
      { model: 'fake/plain', thinking: 'off', mode: 'default', systemPrompt: null },
    ]),
  )
})

test('#846: a session model the list does not offer leaves the first row highlighted, and Enter in the filter chooses it', async () => {
  const mounted = await mountLaunch({ server: { commands: [modelRow('fake/gone', [PLAIN, DEEP])] } })
  const dialog = await openModelPicker(mounted)
  const filter = modelFilter(dialog)
  await eventually(() => expect(highlightedRows(dialog)).toEqual(['fake/plain']))
  expect([undefined, 'fake/plain']).toContain(activeRow(filter))
  expect(chosenRow(dialog)).toBeUndefined()
  await press(filter, 'Enter')
  await eventually(() => expect(picker()).toBeNull())
  expect(mounted.chip('Model').getAttribute('aria-label')).toBe('Model: Plain')
})

// ⚠ #638, reproduced live: Escape in the model filter closed the whole dialog it sat in, and the
// typed prompt went with it. Escape there clears the filter; with nothing left to clear it closes
// the picker — and the prompt is the composer's, untouched either way.
test('⚠ Escape in the model filter clears the filter and keeps the picker; Escape again closes it, the prompt kept (#638)', async () => {
  const mounted = await mountLaunch()
  await typeInto(mounted.composer(), 'a prompt I typed')
  const dialog = await openModelPicker(mounted)
  const filter = modelFilter(dialog)
  await typeInto(filter, 'plain')
  expect(dialog.querySelectorAll('[cmdk-item]')).toHaveLength(1)

  await press(filter, 'Escape')
  expect(picker()).not.toBeNull()
  expect(filter.value).toBe('')
  expect(dialog.querySelectorAll('[cmdk-item]').length).toBeGreaterThan(1)

  await press(filter, 'Escape')
  await eventually(() => expect(picker()).toBeNull())
  expect(mounted.composer().value).toBe('a prompt I typed')
  expect(panelTitle(mounted)).toBe('What should pi work on?')
  // A draft holding words only on its launch panel is kept when the page leaves it (#875).
  expect(mounted.stores.typed.get()).toBe(true)
})

test('a refused step keeps the panel, names the step and why, marks its chip, sends no prompt, and keeps the prompt and its attachments', async () => {
  const mounted = await mountLaunch({
    server: { configureAnswers: [refusedAt('model', 'No API key for fake/plain'), { status: 204 }] },
  })
  await chooseModel(mounted, 'fake/plain')
  // An image attached, as the file picker attaches it.
  const input = mounted.container.querySelector<HTMLInputElement>('input[type="file"]')
  if (input === null) throw new Error('expected the attach input')
  const image = new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' })
  await flush(async () => {
    Object.defineProperty(input, 'files', { configurable: true, value: [image] })
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await tick()
  })
  const attached = (): number =>
    mounted.container.querySelectorAll('[aria-label="attached images"] [data-slot], [aria-label="attached images"] img')
      .length
  await eventually(() => expect(attached()).toBeGreaterThan(0))
  const attachedBefore = attached()

  await typeAndStart(mounted, 'hello there')
  await eventually(() =>
    expect(mounted.container.textContent).toContain('the model was refused: No API key for fake/plain'),
  )
  expect(mounted.server.prompts).toEqual([])
  expect(panelTitle(mounted)).toBe('What should pi work on?')
  expect(mounted.chip('Model').getAttribute('aria-label')).toBe('Model: Plain, refused')
  expect(mounted.chip('Effort').getAttribute('aria-invalid')).toBeNull()
  expect(mounted.composer().value).toBe('hello there')
  expect(attached()).toBe(attachedBefore)

  // A retry goes through: the settings again, then the prompt. (The composer reads the image's bytes
  // back from its object URL through `fetch`, which here is the scripted server: that the image goes
  // with the prompt is the live check's.)
  await click(mounted.startButton())
  await eventually(() => expect(mounted.server.prompts.map((prompt) => prompt.message)).toEqual(['hello there']))
  expect(mounted.server.configures).toHaveLength(2)
  await eventually(() => expect(panelTitle(mounted)).toBeUndefined())
})

// ⚠ #484: the slash commands belong to a running session — pi registers them when one is built —
// so a prompt beginning with `/` cannot be the one that starts it. Start is disabled and the
// panel says why; the words stay, and the same words without the slash start as usual.
test('a prompt beginning with / cannot start: Start is disabled and the reason is shown; without the slash it starts', async () => {
  const mounted = await mountLaunch()
  await eventually(() => expect(mounted.chip('Model').getAttribute('aria-label')).toBe('Model: Deep'))
  await typeInto(mounted.composer(), '  /mode plan')
  await eventually(() => expect(mounted.container.textContent).toContain('a / command needs a running session'))
  expect(mounted.startButton().disabled).toBe(true)
  await press(mounted.composer(), 'Enter')
  expect(mounted.server.configures).toEqual([])
  expect(mounted.server.prompts).toEqual([])
  expect(mounted.composer().value).toBe('  /mode plan')
  // The same words, no longer a command.
  await typeAndStart(mounted, 'mode plan')
  await eventually(() => expect(mounted.server.prompts.map((prompt) => prompt.message)).toEqual(['mode plan']))
})

test("#443: the system prompt offers pi's default and the system and append prompts with their sizes, names a refused file, and a choice is sent with the settings", async () => {
  const mounted = await mountLaunch()
  await eventually(() => expect(mounted.container.textContent).toContain('refused broken.md: frontmatter category'))
  const offered = await choose(mounted, 'System prompt', 'Reviewer')
  expect(offered).toEqual([
    'pi default',
    "Reviewer≈1,234 tokens · replaces pi's prompt",
    "Haiku≈9 tokens · adds to pi's prompt",
    "Shadow≈5 tokens · replaces pi's prompt",
  ])
  await eventually(() =>
    expect(mounted.chip('System prompt').getAttribute('aria-label')).toBe('System prompt: Reviewer'),
  )
  await typeAndStart(mounted, 'review this')
  await eventually(() =>
    expect(mounted.server.configures.map((configure) => configure.body)).toEqual([
      { model: 'fake/deep', thinking: 'medium', mode: 'default', systemPrompt: 'reviewer' },
    ]),
  )
})

test("#443: ⚠ a library prompt saved as `pi-default` is sent by its id, never as pi's default", async () => {
  const mounted = await mountLaunch()
  await choose(mounted, 'System prompt', 'Shadow')
  await typeAndStart(mounted, 'go')
  await eventually(() =>
    expect(mounted.server.configures.map((configure) => configure.body)).toEqual([
      { model: 'fake/deep', thinking: 'medium', mode: 'default', systemPrompt: 'pi-default' },
    ]),
  )
})

test('#443: a saved session prompt fills the prompt box with its text', async () => {
  const mounted = await mountLaunch()
  await choose(mounted, 'Saved prompt', 'Triage')
  await eventually(() => expect(mounted.composer().value).toBe(TRIAGE.body))
})

test("#443: a refused system prompt keeps the panel and says so; a missing library is said, and pi's default still starts", async () => {
  const refused = await mountLaunch({
    server: { configureAnswers: [refusedAt('systemPrompt', 'Opener is a session prompt')] },
  })
  await typeAndStart(refused, 'go')
  await eventually(() =>
    expect(refused.container.textContent).toContain('the system prompt was refused: Opener is a session prompt'),
  )
  expect(refused.chip('System prompt').getAttribute('aria-invalid')).toBe('true')
  expect(refused.server.prompts).toEqual([])
  expect(refused.composer().value).toBe('go')
  await refused.unmount()
  clearThreadsForTest()

  const bare = await mountLaunch({ library: 'absent' })
  await eventually(() =>
    expect(bare.container.textContent).toContain('prompt library: this server has no prompt library'),
  )
  expect(() => bare.chip('Saved prompt')).toThrow()
  await typeAndStart(bare, 'go')
  await eventually(() =>
    expect(bare.server.configures.map((configure) => configure.body)).toEqual([
      { model: 'fake/deep', thinking: 'medium', mode: 'default', systemPrompt: null },
    ]),
  )
})

test("#470: a trusted project's own prompts are offered apart from the user's, chosen by `project:<id>` — the user's prompt of the same id stays its own", async () => {
  const mounted = await mountLaunch({ projectPrompts: TRUSTED_PROJECT })
  await eventually(() =>
    expect(mounted.container.textContent).toContain('refused project odd.md: frontmatter has no name'),
  )
  const offered = await choose(mounted, 'System prompt', 'Team reviewer')
  expect(offered).toEqual([
    'pi default',
    "Reviewer≈1,234 tokens · replaces pi's prompt",
    "Haiku≈9 tokens · adds to pi's prompt",
    "Shadow≈5 tokens · replaces pi's prompt",
    "Team reviewer≈20 tokens · replaces pi's prompt",
  ])
  await typeAndStart(mounted, 'review this')
  await eventually(() =>
    expect(mounted.server.configures.map((configure) => configure.body)).toEqual([
      { model: 'fake/deep', thinking: 'medium', mode: 'default', systemPrompt: 'project:reviewer' },
    ]),
  )
})

test("#470: a project's session prompt fills the prompt box, read from the project's own route", async () => {
  const mounted = await mountLaunch({ projectPrompts: TRUSTED_PROJECT })
  await choose(mounted, 'Saved prompt', 'Kickoff')
  await eventually(() => expect(mounted.composer().value).toBe(KICKOFF.body))
})

test("#470: an untrusted project's prompts are not offered, and the panel says where they are and why", async () => {
  const mounted = await mountLaunch({ projectPrompts: { kind: 'untrusted', directory: PROJECT_PROMPTS_DIR } })
  await eventually(() =>
    expect(mounted.container.textContent).toContain(
      `project prompts in ${PROJECT_PROMPTS_DIR} are not read: the project is not trusted`,
    ),
  )
  const offered = await choose(mounted, 'System prompt', 'Reviewer')
  expect(offered.some((label) => label.startsWith('Team reviewer'))).toBe(false)
})

/** The blocked alert's words, or undefined when the panel has none. */
const blockedAlert = (mounted: Mounted): string | undefined =>
  [...mounted.container.querySelectorAll('[role="alert"]')]
    .map((alert) => alert.textContent ?? '')
    .find((text) => text.startsWith('A new thread can’t start here'))

test('a thread in no project the server lists, or in a project whose folder is gone, says so and why; Start waits and Manage projects opens Projects', async () => {
  const nowhere = await mountLaunch({ projectId: 'p-nowhere' })
  await eventually(() => expect(blockedAlert(nowhere)).toContain('isn’t in a project the server lists'))
  await typeInto(nowhere.composer(), 'go')
  await flush(tick)
  expect(nowhere.startButton().disabled).toBe(true)
  const manage = [...nowhere.container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Manage projects',
  )
  if (manage === undefined) throw new Error('expected Manage projects')
  await click(manage)
  expect(nowhere.managed).toEqual([1])
  await nowhere.unmount()
  clearThreadsForTest()

  const gone = await mountLaunch({
    server: { projects: [{ ...LAUNCH_PROJECT, status: 'missing-dir' }] },
  })
  await eventually(() => expect(blockedAlert(gone)).toContain('The folder /scripted/launch is gone'))
  await typeInto(gone.composer(), 'go')
  await flush(tick)
  expect(gone.startButton().disabled).toBe(true)
  expect(gone.server.configures).toEqual([])
  await gone.unmount()
  clearThreadsForTest()

  // A project the server lists, its folder there: no alert, and Start goes.
  const fine = await mountLaunch()
  await eventually(() => expect(fine.container.textContent).toContain('What should pi work on?'))
  expect(blockedAlert(fine)).toBeUndefined()
})

function stored(threadId: string, title: string, minutesAgo: number, projectId = 'p-launch'): EnsoStoredThread {
  return {
    threadId,
    projectId,
    title,
    lastActivityAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    messageCount: 2,
    busy: false,
    waiting: false,
  }
}

test("the recent list offers up to three of this project's threads, newest first — never this one, never another project's — and a row opens its thread", async () => {
  const mounted = await mountLaunch({
    threadId: 'current-draft',
    server: {
      projects: [LAUNCH_PROJECT, OTHER_PROJECT],
      storedThreads: [
        stored('current-draft', 'this very thread', 0),
        stored('t-old', 'the oldest', 50),
        stored('t-new', 'the newest', 5),
        stored('t-mid', 'the middle one', 20),
        stored('t-older', 'an older one', 40),
        stored('t-elsewhere', 'in the other project', 1, 'p-other'),
      ],
    },
  })
  const section = await eventually(() => {
    const found = [...mounted.container.querySelectorAll('section')].find((candidate) =>
      candidate.textContent?.startsWith('Or pick up where you left off'),
    )
    if (found === undefined) throw new Error('expected the recent list')
    return found
  })
  const rows = [...section.querySelectorAll<HTMLButtonElement>('li button')]
  expect(rows.map((row) => row.textContent?.replace(/\d+\s*\w+$/, '').trim())).toEqual([
    'the newest',
    'the middle one',
    'an older one',
  ])
  const first = rows[0]
  if (first === undefined) throw new Error('expected a row')
  await click(first)
  expect(mounted.opened).toEqual(['t-new'])
})
