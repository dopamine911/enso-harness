import { afterAll, afterEach, expect, test } from 'bun:test'
import {
  type EnsoLibraryPrompt,
  type EnsoLibraryPromptListing,
  type EnsoProjectPromptLibrary,
  type EnsoSessionConfiguration,
  type EnsoThreadCommands,
  summarizeLibraryPrompt,
} from '@enso/core'
import { act } from 'react'
import type { createRoot as CreateRoot, Root } from 'react-dom/client'
import type { ConfigureOutcome } from '../follow-connection.ts'
import type * as StartSessionModule from '../start-session.tsx'
import { ensureDom, releaseDom } from './dom-environment.ts'

// ⚠ A DOM before react-dom/client and Radix evaluate — `command-palette.test.tsx` has the
// measurement. The dialog is a Radix portal.
ensureDom()
const { createRoot }: { createRoot: typeof CreateRoot } = await import('react-dom/client')
const { draftWithKeptPrompt, StartSessionDialog }: typeof StartSessionModule = await import('../start-session.tsx')

/**
 * The Start-a-session dialog (#391), MOUNTED under happy-dom over a fetch seam: what Start sends is
 * the contract — the four settings in ONE configure call, the effort the CHOSEN model offers,
 * then the prompt through the chat's send — and a refused step keeps the dialog open and says which.
 */

afterAll(releaseDom)

/** Every dialog a test mounted and did not unmount — a failed test's, so it cannot answer the next one's queries. */
const leftOpen = new Set<Mounted>()
afterEach(async () => {
  for (const mounted of leftOpen) await mounted.unmount()
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

/** A session on a reasoning model at `high`, beside one that cannot reason. */
const COMMANDS: EnsoThreadCommands = {
  threadId: 'thread-1',
  source: 'live',
  commands: [
    {
      name: 'model',
      source: 'host',
      kind: 'select',
      value: 'fake/deep',
      options: [
        { id: 'fake/deep', label: 'Deep', detail: 'fake', thinkingLevels: ['off', 'low', 'medium', 'high'] },
        { id: 'fake/plain', label: 'Plain', detail: 'fake', thinkingLevels: ['off'] },
      ],
    },
    {
      name: 'thinking',
      source: 'host',
      kind: 'level',
      value: 'high',
      options: ['off', 'low', 'medium', 'high'].map((level) => ({ id: level, label: level })),
    },
  ],
}

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
 * system prompt saved under the id `pi-default`, which the dialog must never take for pi's own.
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
/** A project with no prompts of its own: what the dialog sees in most projects. */
const EMPTY_PROJECT: EnsoProjectPromptLibrary = {
  kind: 'listed',
  directory: PROJECT_PROMPTS_DIR,
  listing: { prompts: [], refused: [] },
}

/** The server the dialog reads: the thread's commands, the library unless a test says it is gone, and the project's. */
function serverFetch(
  library: 'present' | 'absent',
  project: EnsoProjectPromptLibrary = EMPTY_PROJECT,
): (input: string) => Promise<Response> {
  return (input: string): Promise<Response> => {
    if (input === '/api/threads/thread-1/project-prompts') return Promise.resolve(Response.json(project))
    if (input === '/api/threads/thread-1/project-prompts/kickoff') {
      return Promise.resolve(Response.json(KICKOFF, { headers: { ETag: `"${'d'.repeat(64)}"` } }))
    }
    if (input === '/api/prompts') {
      return Promise.resolve(
        library === 'present'
          ? Response.json(LIBRARY)
          : new Response('this server has no prompt library', { status: 404 }),
      )
    }
    if (input === '/api/prompts/triage') {
      return Promise.resolve(Response.json(TRIAGE, { headers: { ETag: `"${'c'.repeat(64)}"` } }))
    }
    return Promise.resolve(Response.json(COMMANDS))
  }
}

interface Mounted {
  readonly configured: EnsoSessionConfiguration[]
  readonly sent: string[]
  readonly closes: number[]
  /** Prompts the dialog handed to the composer when dismissed (#638). */
  readonly kept: string[]
  readonly dialog: () => HTMLElement
  readonly unmount: () => Promise<void>
}

async function mountStart(
  answer: ConfigureOutcome,
  library: 'present' | 'absent' = 'present',
  project: EnsoProjectPromptLibrary = EMPTY_PROJECT,
): Promise<Mounted> {
  const configured: EnsoSessionConfiguration[] = []
  const sent: string[] = []
  const closes: number[] = []
  const kept: string[] = []
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  await flush(async () => {
    root.render(
      <StartSessionDialog
        threadId="thread-1"
        open={true}
        onClose={(): void => void closes.push(1)}
        keepPrompt={(text: string): void => void kept.push(text)}
        mode="default"
        modes={['default', 'plan']}
        configure={(configuration: EnsoSessionConfiguration): Promise<ConfigureOutcome> => {
          configured.push(configuration)
          return Promise.resolve(answer)
        }}
        send={(text: string): boolean => {
          sent.push(text)
          return true
        }}
        fetch={serverFetch(library, project)}
      />,
    )
  })
  const dialog = (): HTMLElement => {
    const found = document.querySelector<HTMLElement>('[role="dialog"]')
    if (found === null) throw new Error('expected the Start-a-session dialog to be open')
    return found
  }
  const mounted: Mounted = {
    configured,
    sent,
    closes,
    kept,
    dialog,
    unmount: async (): Promise<void> => {
      if (!leftOpen.delete(mounted)) return
      await flush(async () => root.unmount())
      container.remove()
    },
  }
  leftOpen.add(mounted)
  return mounted
}

/** Choose a model row, type a prompt the way a person would (React's controlled value), press Start. */
async function chooseTypeAndStart(mounted: Mounted, modelId: string, prompt: string): Promise<void> {
  const row = await eventually(() => {
    const found = mounted.dialog().querySelector<HTMLElement>(`[cmdk-item][data-value="${modelId}"]`)
    if (found === null) throw new Error(`expected the ${modelId} row`)
    return found
  })
  await flush(async () => {
    row.click()
    await tick()
  })
  const field = mounted.dialog().querySelector<HTMLTextAreaElement>('#start-session-prompt')
  if (field === null) throw new Error('expected the prompt field')
  await flush(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(field, prompt)
    field.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
  })
  const start = [...mounted.dialog().querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === 'Start session',
  )
  if (start === undefined) throw new Error('expected the Start session button')
  await flush(async () => {
    start.click()
    await tick()
  })
}

/** Set a field's value the way typing does, so React's controlled value sees it. */
async function typeInto(field: HTMLInputElement | HTMLTextAreaElement, text: string): Promise<void> {
  const prototype = field instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
  await flush(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(field, text)
    field.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
  })
}

async function pressEscape(target: HTMLElement): Promise<void> {
  await flush(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await tick()
  })
}

// ⚠ #638, reproduced live: Escape in the model filter closed the whole dialog — the always-open
// list had nothing to close, so Radix's dialog took it — and the typed prompt went with it.
test('⚠ Escape in the model filter clears the filter and keeps the dialog; Escape elsewhere closes it, the prompt kept (#638)', async () => {
  const mounted = await mountStart({ outcome: 'told' })
  const filter = await eventually(() => {
    const found = mounted.dialog().querySelector<HTMLInputElement>('input[cmdk-input]')
    if (found === null) throw new Error('expected the model filter')
    return found
  })
  // The filter is named: cmdk's label, wired to the input it ids itself.
  const labelId = filter.getAttribute('aria-labelledby')
  expect(labelId === null ? undefined : document.getElementById(labelId)?.textContent).toBe('Model')
  const prompt = mounted.dialog().querySelector<HTMLTextAreaElement>('#start-session-prompt')
  if (prompt === null) throw new Error('expected the prompt field')
  await typeInto(prompt, 'a prompt I typed')
  await typeInto(filter, 'plain')
  expect(mounted.dialog().querySelectorAll('[cmdk-item]')).toHaveLength(1)

  await pressEscape(filter)
  expect(mounted.closes).toEqual([])
  expect(filter.value).toBe('')
  expect(mounted.dialog().querySelectorAll('[cmdk-item]').length).toBeGreaterThan(1)
  expect(prompt.value).toBe('a prompt I typed')

  // Escape again, with nothing left to clear, closes from the filter too (PR #645 review) — and the
  // words are the composer's, not lost.
  await pressEscape(filter)
  expect(mounted.closes).toEqual([1])
  expect(mounted.kept).toEqual(['a prompt I typed'])
  await mounted.unmount()
})

test('a kept prompt fills an empty composer, and follows what a composer already holds (#638)', () => {
  expect(draftWithKeptPrompt('', 'the dialog’s prompt')).toBe('the dialog’s prompt')
  expect(draftWithKeptPrompt('  \n', 'the dialog’s prompt')).toBe('the dialog’s prompt')
  expect(draftWithKeptPrompt('already typed', 'the dialog’s prompt')).toBe('already typed\n\nthe dialog’s prompt')
})

test('Close with a prompt typed hands it to the composer; with none, or after a Start, nothing is handed (#638)', async () => {
  const closing = await mountStart({ outcome: 'told' })
  const closeButton = (): HTMLButtonElement | undefined =>
    [...closing.dialog().querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Close')
  await eventually(() => expect(closing.dialog().querySelector('#start-session-prompt')).not.toBeNull())
  await flush(async () => {
    closeButton()?.click()
    await tick()
  })
  expect(closing.closes).toEqual([1])
  expect(closing.kept).toEqual([])
  const prompt = closing.dialog().querySelector<HTMLTextAreaElement>('#start-session-prompt')
  if (prompt === null) throw new Error('expected the prompt field')
  await typeInto(prompt, 'keep me')
  await flush(async () => {
    closeButton()?.click()
    await tick()
  })
  expect(closing.kept).toEqual(['keep me'])
  await closing.unmount()

  const starting = await mountStart({ outcome: 'told' })
  await chooseTypeAndStart(starting, 'fake/plain', 'sent, not kept')
  await eventually(() => expect(starting.closes).toEqual([1]))
  expect(starting.sent).toEqual(['sent, not kept'])
  expect(starting.kept).toEqual([])
  await starting.unmount()
})

test('Start sends the four settings in one call — the effort the CHOSEN model offers — then the prompt, then closes', async () => {
  const mounted = await mountStart({ outcome: 'told' })
  // The session runs Deep at `high`; Plain cannot reason, so choosing it takes the effort to `off`.
  await chooseTypeAndStart(mounted, 'fake/plain', 'hello there')
  await eventually(() => expect(mounted.closes).toEqual([1]))
  // pi's default system prompt is said as `null` (#443): a retry must be able to take back a prompt
  // an earlier, refused Start already applied.
  expect(mounted.configured).toEqual([{ model: 'fake/plain', thinking: 'off', mode: 'default', systemPrompt: null }])
  expect(mounted.sent).toEqual(['hello there'])
  await mounted.unmount()
})

// Found by a Dogfood Arena run reading the dialog: the check beside the chosen model is drawn by
// CSS, and cmdk's `aria-selected` is its keyboard highlight, on the first row — so a reader was told
// the first model was selected whatever was chosen. The chosen row says so in words.
test('the chosen model is named as chosen in the accessibility tree, and the mark follows a new choice', async () => {
  const mounted = await mountStart({ outcome: 'told' })
  const rowText = (modelId: string): string =>
    mounted.dialog().querySelector<HTMLElement>(`[cmdk-item][data-value="${modelId}"]`)?.textContent ?? 'no row'
  // The session runs Deep: it is the chosen one, Plain is not.
  await eventually(() => expect(rowText('fake/deep')).toBe('Deepfake, chosen'))
  expect(rowText('fake/plain')).toBe('Plainfake')
  await flush(async () => {
    mounted.dialog().querySelector<HTMLElement>('[cmdk-item][data-value="fake/plain"]')?.click()
    await tick()
  })
  expect(rowText('fake/plain')).toBe('Plainfake, chosen')
  expect(rowText('fake/deep')).toBe('Deepfake')
  await mounted.unmount()
})

test('a refused step keeps the dialog open, says which step and why, and sends nothing', async () => {
  const mounted = await mountStart({ outcome: 'refused', step: 'model', reason: 'No API key for fake/plain' })
  await chooseTypeAndStart(mounted, 'fake/plain', 'hello there')
  await eventually(() =>
    expect(mounted.dialog().textContent).toContain('the model was refused: No API key for fake/plain'),
  )
  expect(mounted.sent).toEqual([])
  expect(mounted.closes).toEqual([])
  await mounted.unmount()
})

// ⚠ #484: the slash commands belong to a running session — pi registers them when one is built —
// so a prompt beginning with `/` cannot be the one that starts it. Start is disabled and the
// dialog says why; the words stay, and the same words without the slash start as usual.
test('a prompt beginning with / cannot start: Start is disabled and the reason is shown; without the slash it starts', async () => {
  const mounted = await mountStart({ outcome: 'told' })
  await chooseTypeAndStart(mounted, 'fake/plain', '  /mode plan')
  await eventually(() => expect(mounted.dialog().textContent).toContain('a / command needs a running session'))
  const start = [...mounted.dialog().querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === 'Start session',
  )
  expect(start?.disabled).toBe(true)
  expect(mounted.configured).toEqual([])
  expect(mounted.sent).toEqual([])
  // The same words, no longer a command.
  await chooseTypeAndStart(mounted, 'fake/plain', 'mode plan')
  await eventually(() => expect(mounted.closes).toEqual([1]))
  expect(mounted.sent).toEqual(['mode plan'])
  await mounted.unmount()
})

/** Open a Radix select by its trigger's id, choose the option whose text starts with `label`; answers what it offered. */
async function choose(mounted: Mounted, triggerId: string, label: string): Promise<string[]> {
  const trigger = await eventually(() => {
    const found = mounted.dialog().querySelector<HTMLElement>(`#${triggerId}`)
    if (found === null) throw new Error(`expected the ${triggerId} select`)
    return found
  })
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

test("#443: the system prompt offers pi's default and the system and append prompts with their sizes, names a refused file, and a choice is sent with the settings", async () => {
  const mounted = await mountStart({ outcome: 'told' })
  await eventually(() => expect(mounted.dialog().textContent).toContain('refused broken.md: frontmatter category'))
  const offered = await choose(mounted, 'start-session-system-prompt', 'Reviewer')
  expect(offered).toEqual([
    'pi default',
    "Reviewer≈1,234 tokens · replaces pi's prompt",
    "Haiku≈9 tokens · adds to pi's prompt",
    "Shadow≈5 tokens · replaces pi's prompt",
  ])
  expect(mounted.dialog().querySelector('#start-session-system-prompt')?.textContent).toContain('Reviewer')
  await chooseTypeAndStart(mounted, 'fake/deep', 'review this')
  await eventually(() => expect(mounted.closes).toEqual([1]))
  expect(mounted.configured).toEqual([
    { model: 'fake/deep', thinking: 'high', mode: 'default', systemPrompt: 'reviewer' },
  ])
  await mounted.unmount()
})

test("#443: ⚠ a library prompt saved as `pi-default` is sent by its id, never as pi's default", async () => {
  const mounted = await mountStart({ outcome: 'told' })
  await choose(mounted, 'start-session-system-prompt', 'Shadow')
  await chooseTypeAndStart(mounted, 'fake/deep', 'go')
  await eventually(() => expect(mounted.closes).toEqual([1]))
  expect(mounted.configured).toEqual([
    { model: 'fake/deep', thinking: 'high', mode: 'default', systemPrompt: 'pi-default' },
  ])
  await mounted.unmount()
})

test('#443: a saved session prompt fills the prompt box with its text', async () => {
  const mounted = await mountStart({ outcome: 'told' })
  await choose(mounted, 'start-session-saved-prompt', 'Triage')
  await eventually(() =>
    expect(mounted.dialog().querySelector<HTMLTextAreaElement>('#start-session-prompt')?.value).toBe(TRIAGE.body),
  )
  await mounted.unmount()
})

test("#443: a refused system prompt keeps the dialog open and says so; a missing library is said, and pi's default still starts", async () => {
  const refused = await mountStart({ outcome: 'refused', step: 'systemPrompt', reason: 'Opener is a session prompt' })
  await chooseTypeAndStart(refused, 'fake/deep', 'go')
  await eventually(() =>
    expect(refused.dialog().textContent).toContain('the system prompt was refused: Opener is a session prompt'),
  )
  expect(refused.sent).toEqual([])
  await refused.unmount()

  const bare = await mountStart({ outcome: 'told' }, 'absent')
  await eventually(() =>
    expect(bare.dialog().textContent).toContain('prompt library: this server has no prompt library'),
  )
  expect(bare.dialog().querySelector('#start-session-saved-prompt')).toBeNull()
  await chooseTypeAndStart(bare, 'fake/deep', 'go')
  await eventually(() => expect(bare.closes).toEqual([1]))
  expect(bare.configured).toEqual([{ model: 'fake/deep', thinking: 'high', mode: 'default', systemPrompt: null }])
  await bare.unmount()
})

test("#470: a trusted project's own prompts are offered apart from the user's, chosen by `project:<id>` — the user's prompt of the same id stays its own", async () => {
  const mounted = await mountStart({ outcome: 'told' }, 'present', TRUSTED_PROJECT)
  await eventually(() =>
    expect(mounted.dialog().textContent).toContain('refused project odd.md: frontmatter has no name'),
  )
  const offered = await choose(mounted, 'start-session-system-prompt', 'Team reviewer')
  expect(offered).toEqual([
    'pi default',
    "Reviewer≈1,234 tokens · replaces pi's prompt",
    "Haiku≈9 tokens · adds to pi's prompt",
    "Shadow≈5 tokens · replaces pi's prompt",
    "Team reviewer≈20 tokens · replaces pi's prompt",
  ])
  await chooseTypeAndStart(mounted, 'fake/deep', 'review this')
  await eventually(() => expect(mounted.closes).toEqual([1]))
  expect(mounted.configured).toEqual([
    { model: 'fake/deep', thinking: 'high', mode: 'default', systemPrompt: 'project:reviewer' },
  ])
  await mounted.unmount()
})

test("#470: a project's session prompt fills the prompt box, read from the project's own route", async () => {
  const mounted = await mountStart({ outcome: 'told' }, 'present', TRUSTED_PROJECT)
  await choose(mounted, 'start-session-saved-prompt', 'Kickoff')
  await eventually(() =>
    expect(mounted.dialog().querySelector<HTMLTextAreaElement>('#start-session-prompt')?.value).toBe(KICKOFF.body),
  )
  await mounted.unmount()
})

test("#470: an untrusted project's prompts are not offered, and the dialog says where they are and why", async () => {
  const mounted = await mountStart({ outcome: 'told' }, 'present', {
    kind: 'untrusted',
    directory: PROJECT_PROMPTS_DIR,
  })
  await eventually(() =>
    expect(mounted.dialog().textContent).toContain(
      `project prompts in ${PROJECT_PROMPTS_DIR} are not read: the project is not trusted`,
    ),
  )
  const offered = await choose(mounted, 'start-session-system-prompt', 'Reviewer')
  expect(offered.some((label) => label.startsWith('Team reviewer'))).toBe(false)
  await mounted.unmount()
})
