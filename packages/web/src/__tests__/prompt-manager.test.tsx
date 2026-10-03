import { afterAll, afterEach, expect, test } from 'bun:test'
import {
  type EnsoLibraryPrompt,
  type EnsoLibraryPromptListing,
  type EnsoLibraryPromptWrite,
  type EnsoProjectPromptLibrary,
  type EnsoSystemPromptDraft,
  type EnsoSystemPromptPreview,
  estimateTextTokens,
  serializeLibraryPrompt,
  summarizeLibraryPrompt,
  utf8Bytes,
} from '@enso/core'
import { act } from 'react'
import type { createRoot as CreateRoot, Root } from 'react-dom/client'
import type * as PromptManagerModule from '../prompt-manager.tsx'
import { ensureDom, releaseDom } from './dom-environment.ts'

// ⚠ A DOM before react-dom/client and Radix evaluate — `dom-environment.ts` has the measurement.
ensureDom()
const { createRoot }: { createRoot: typeof CreateRoot } = await import('react-dom/client')
const { PromptManagerDialog }: typeof PromptManagerModule = await import('../prompt-manager.tsx')

/**
 * The prompt manager (#443), MOUNTED under happy-dom over a scripted server: pi's default read-only
 * with its breakdown, the library by category and its refused files by name, a new prompt written
 * and saved, the size bar exact on every edit, the breakdown of an unsaved draft as pi renders it,
 * the unsaved marker and the guard in front of it, and delete asked twice.
 */

afterAll(releaseDom)

const tick = (): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, 20)
  return promise
}
const flush = (work: () => Promise<void>): Promise<void> => act(work)

const EVENTUALLY_DEADLINE_MS = 3000
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

const REVIEWER: EnsoLibraryPrompt = {
  id: 'reviewer',
  name: 'Reviewer',
  description: 'reads diffs',
  category: 'system',
  body: 'Say what breaks.',
  bytes: 90,
  tokens: 4,
}
const HAIKU: EnsoLibraryPrompt = {
  id: 'haiku',
  name: 'Haiku',
  description: '',
  category: 'append',
  body: 'Always answer in haiku.',
  bytes: 40,
  tokens: 6,
}
const LISTING: EnsoLibraryPromptListing = {
  prompts: [
    summarizeLibraryPrompt(REVIEWER),
    summarizeLibraryPrompt(HAIKU),
    { id: 'triage', name: 'Triage', description: '', category: 'session', bytes: 50, tokens: 9 },
  ],
  refused: [{ file: 'broken.md', reason: 'broken.md: it does not open with a --- frontmatter block' }],
}

/** The project's own library (#470): a prompt sharing the user's `reviewer` id, and one the user has not. */
const HOUSE_STYLE: EnsoLibraryPrompt = {
  id: 'house-style',
  name: 'House style',
  description: 'How this repo writes',
  category: 'append',
  body: 'Name what it walks.',
  bytes: 70,
  tokens: 5,
}
const PROJECT: EnsoProjectPromptLibrary = {
  kind: 'listed',
  directory: '/work/repo/.enso/prompts',
  listing: {
    prompts: [
      summarizeLibraryPrompt(HOUSE_STYLE),
      { id: 'reviewer', name: 'Team reviewer', description: '', category: 'system', bytes: 80, tokens: 20 },
    ],
    refused: [],
  },
}

const section = (name: string, text: string, library = false): EnsoSystemPromptPreview['sections'][number] => ({
  name,
  origin: library ? 'library' : 'pi',
  text,
  tokens: estimateTextTokens(text),
})
const TOOLS = [{ name: 'read', tokens: 300 }]
const PI_DEFAULT: EnsoSystemPromptPreview = {
  prompt: null,
  sections: [
    section('preamble', 'You are pi.'),
    section('tools', '<tools>\n- read\n</tools>'),
    section('cwd', '<cwd>\n/r\n</cwd>'),
  ],
  tools: TOOLS,
  totalTokens: 0,
  contextWindow: 200_000,
}

/** What the server renders a draft as: its text as the preamble, pi's cwd, the one tool. */
function draftPreview(draft: EnsoSystemPromptDraft): EnsoSystemPromptPreview {
  const sections = [section('preamble', draft.text, true), section('cwd', '<cwd>\n/r\n</cwd>')]
  const totalTokens = [...sections, ...TOOLS].reduce((sum, item) => sum + item.tokens, 0)
  return {
    prompt: { id: 'draft', name: draft.name, mode: draft.mode },
    sections,
    tools: TOOLS,
    totalTokens,
    contextWindow: 200_000,
  }
}

interface Mounted {
  readonly asked: string[]
  readonly written: Array<{ readonly id: string; readonly fields: EnsoLibraryPromptWrite }>
  /** Every PUT and DELETE with the precondition it sent. */
  readonly preconditions: string[]
  readonly dialog: () => HTMLElement
  readonly unmount: () => Promise<void>
}
const leftOpen = new Set<Mounted>()
afterEach(async () => {
  for (const mounted of leftOpen) await mounted.unmount()
})

/** The body a request carried: every body these reads send is a JSON string. */
function bodyOf(init: RequestInit | undefined): unknown {
  return typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
}

/** The ETag the scripted server answers a file's version with: its fields, so any change is a new one. */
const etagOf = (fields: unknown): { readonly ETag: string } => ({
  ETag: `"${new Bun.CryptoHasher('sha256').update(JSON.stringify(fields)).digest('hex')}"`,
})

function answer(
  input: string,
  init: RequestInit | undefined,
  written: Mounted['written'],
  project: EnsoProjectPromptLibrary = PROJECT,
): Response {
  const method = init?.method ?? 'GET'
  if (input === '/api/prompts') return Response.json(LISTING)
  if (input === '/api/prompts/reviewer' && method === 'GET')
    return Response.json(REVIEWER, { headers: etagOf(REVIEWER) })
  if (input === '/api/prompts/haiku' && method === 'GET') return Response.json(HAIKU, { headers: etagOf(HAIKU) })
  if (input === '/api/threads/t1/project-prompts') return Response.json(project)
  if (input === '/api/threads/t1/project-prompts/house-style' && method === 'GET') {
    return Response.json(HOUSE_STYLE, { headers: etagOf(HOUSE_STYLE) })
  }
  if (input.startsWith('/api/threads/t1/system-prompt')) {
    return Response.json(method === 'POST' ? draftPreview(bodyOf(init) as EnsoSystemPromptDraft) : PI_DEFAULT)
  }
  const id = decodeURIComponent(input.slice('/api/prompts/'.length))
  if (method === 'PUT') {
    const fields = bodyOf(init) as EnsoLibraryPromptWrite
    written.push({ id, fields })
    return Response.json(
      { id, ...fields, bytes: utf8Bytes(serializeLibraryPrompt(fields)), tokens: estimateTextTokens(fields.body) },
      { headers: etagOf(fields) },
    )
  }
  if (method === 'DELETE') return new Response(null, { status: 204 })
  return new Response('not scripted', { status: 404 })
}

/** A request the test answers late: its response waits on the promise `hold` returns for it. */
type Hold = (request: string) => Promise<void> | undefined

/** A request the test answers itself — a 412 the disk would give — instead of the scripted server. */
type Override = (request: string) => Response | undefined

/** A write's or delete's precondition as it was sent: `If-None-Match: *`, `If-Match: …`, or none. */
function preconditionOf(init: RequestInit | undefined): string {
  const headers = new Headers(init?.headers)
  for (const name of ['If-None-Match', 'If-Match']) {
    const value = headers.get(name)
    if (value !== null) return `${name}: ${value}`
  }
  return 'none'
}

async function mountManager(
  hold?: Hold,
  override?: Override,
  project: EnsoProjectPromptLibrary = PROJECT,
): Promise<Mounted> {
  const asked: string[] = []
  const written: Mounted['written'] = []
  const preconditions: string[] = []
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  const fetch = (input: string, init?: RequestInit): Promise<Response> => {
    const request = `${init?.method ?? 'GET'} ${input}`
    asked.push(request)
    if (init?.method === 'PUT' || init?.method === 'DELETE') preconditions.push(`${request} ${preconditionOf(init)}`)
    const answered = (): Response => override?.(request) ?? answer(input, init, written, project)
    const late = hold?.(request)
    return late === undefined ? Promise.resolve(answered()) : late.then(answered)
  }
  await flush(async () => {
    root.render(<PromptManagerDialog threadId="t1" fetch={fetch} />)
  })
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="prompts"]')
  if (trigger === null) throw new Error('expected the prompts button')
  await flush(async () => {
    trigger.click()
    await tick()
  })
  const mounted: Mounted = {
    asked,
    written,
    preconditions,
    dialog: (): HTMLElement => {
      const found = document.querySelector<HTMLElement>('[role="dialog"]')
      if (found === null) throw new Error('expected the prompt manager to be open')
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

function buttonNamed(mounted: Mounted, name: string): HTMLButtonElement {
  const found = [...mounted.dialog().querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent?.trim() === name || button.getAttribute('aria-label') === name,
  )
  if (found === undefined) throw new Error(`expected the ${name} button`)
  return found
}

async function click(mounted: Mounted, name: string): Promise<void> {
  const button = await eventually(() => buttonNamed(mounted, name))
  await flush(async () => {
    button.click()
    await tick()
  })
}

/** Type into a field the way a person would — React's controlled value, then the input event. */
async function typeInto(mounted: Mounted, selector: string, text: string): Promise<void> {
  const field = await eventually(() => {
    const found = mounted.dialog().querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)
    if (found === null) throw new Error(`expected ${selector}`)
    return found
  })
  const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  await flush(async () => {
    Reflect.set(prototype, 'value', text, field)
    field.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
  })
}

/** Open a list entry by the name it starts with — its size or `read-only` follows the name. */
async function openListed(mounted: Mounted, name: string): Promise<void> {
  const entry = await eventually(() => {
    const found = [...mounted.dialog().querySelectorAll<HTMLButtonElement>('nav[aria-label="prompts"] button')].find(
      (button) => button.textContent?.startsWith(name),
    )
    if (found === undefined) throw new Error(`expected ${name} in the list`)
    return found
  })
  await flush(async () => {
    entry.click()
    await tick()
  })
}

const textOf = (mounted: Mounted, label: string): string =>
  mounted.dialog().querySelector(`[aria-label="${label}"]`)?.textContent ?? ''

test("the manager opens on pi's default, read-only, with pi's breakdown; the library is listed by category and a refused file by name", async () => {
  const mounted = await mountManager()
  await eventually(() => expect(mounted.dialog().textContent).toContain('what pi builds for this thread'))
  await eventually(() => expect(textOf(mounted, 'what the model receives')).toContain('tool definitions'))
  const body = mounted.dialog().querySelector<HTMLTextAreaElement>('#prompt-body')
  expect(body?.readOnly).toBe(true)
  expect(body?.value).toBe('You are pi.\n\n<tools>\n- read\n</tools>\n\n<cwd>\n/r\n</cwd>')
  const list = textOf(mounted, 'prompts')
  for (const heading of ['System prompts', 'Reviewer', 'Append prompts', 'Haiku', 'Session prompts', 'Triage']) {
    expect(list).toContain(heading)
  }
  expect(list).toContain('refused broken.md: it does not open with a --- frontmatter block')
  await mounted.unmount()
})

test('⚠ a new prompt: the size bar is exact on every edit, the unsaved draft is broken down as pi renders it, and Save writes the file', async () => {
  const mounted = await mountManager()
  await click(mounted, 'New')
  await typeInto(mounted, '#prompt-name', 'Terse')
  await typeInto(mounted, '#prompt-id', 'terse')
  await typeInto(mounted, '#prompt-body', '# Terse\n\nOne sentence.')
  const fields = { name: 'Terse', description: '', category: 'system' as const, body: '# Terse\n\nOne sentence.' }
  const size = textOf(mounted, 'prompt size')
  expect(size).toContain(`${utf8Bytes(serializeLibraryPrompt(fields))} bytes`)
  expect(size).toContain(`≈${estimateTextTokens(fields.body)} tokens`)
  expect(textOf(mounted, 'unsaved changes')).toContain('unsaved')
  // The breakdown is the server's rendering of the DRAFT, asked once the typing rests.
  const expected = draftPreview({ mode: 'system', text: fields.body, name: 'Terse' })
  await eventually(() => expect(textOf(mounted, 'what the model receives')).toContain('this prompt'))
  expect(textOf(mounted, 'what the model receives')).toContain(`≈${expected.totalTokens}`)
  expect(textOf(mounted, 'prompt size')).toContain(`whole system prompt ≈${expected.totalTokens} tokens`)
  expect(textOf(mounted, 'prompt size')).toContain(
    `${((expected.totalTokens / 200_000) * 100).toFixed(1)}% of the model’s 200,000-token window`,
  )
  expect(mounted.asked.filter((request) => request.startsWith('POST'))).not.toHaveLength(0)

  await click(mounted, 'Save')
  await eventually(() => expect(mounted.written).toEqual([{ id: 'terse', fields }]))
  await eventually(() => expect(mounted.dialog().textContent).toContain('terse.md'))
  expect(mounted.dialog().querySelector('[aria-label="unsaved changes"]')).toBeNull()
  await mounted.unmount()
})

test('a save refused on this side says why and writes nothing: a name the library already has, refused files included', async () => {
  const mounted = await mountManager()
  await click(mounted, 'New')
  await typeInto(mounted, '#prompt-name', 'Other reviewer')
  await typeInto(mounted, '#prompt-id', 'reviewer')
  await click(mounted, 'Save')
  await eventually(() => expect(mounted.dialog().textContent).toContain('reviewer.md is already in the library'))
  // A file the library refused is still on disk: saving over it would destroy it unread.
  await typeInto(mounted, '#prompt-id', 'broken')
  await click(mounted, 'Save')
  await eventually(() => expect(mounted.dialog().textContent).toContain('broken.md is already in the library'))
  expect(mounted.written).toEqual([])
  await mounted.unmount()
})

test('⚠ moving away from unsaved changes asks first: Keep editing stays, Discard goes', async () => {
  const mounted = await mountManager()
  await openListed(mounted, 'Reviewer')
  await eventually(() =>
    expect(mounted.dialog().querySelector<HTMLInputElement>('#prompt-name')?.value).toBe('Reviewer'),
  )
  await typeInto(mounted, '#prompt-name', 'Reviewer, sharper')
  await openListed(mounted, 'pi default')
  await eventually(() => expect(mounted.dialog().textContent).toContain('This prompt has unsaved changes.'))
  await click(mounted, 'Keep editing')
  expect(mounted.dialog().querySelector<HTMLInputElement>('#prompt-name')?.value).toBe('Reviewer, sharper')
  await openListed(mounted, 'pi default')
  await click(mounted, 'Discard them')
  await eventually(() => expect(mounted.dialog().textContent).toContain('what pi builds for this thread'))
  await mounted.unmount()
})

test('⚠ closing the manager with unsaved changes asks first — Escape included — and Discard closes it', async () => {
  const mounted = await mountManager()
  await click(mounted, 'New')
  await typeInto(mounted, '#prompt-name', 'Unsaved')
  const escape = (): Promise<void> =>
    flush(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await tick()
    })
  await escape()
  await eventually(() => expect(mounted.dialog().textContent).toContain('This prompt has unsaved changes.'))
  await click(mounted, 'Keep editing')
  expect(mounted.dialog().querySelector<HTMLInputElement>('#prompt-name')?.value).toBe('Unsaved')
  await escape()
  await click(mounted, 'Discard them')
  await eventually(() => expect(document.querySelector('[role="dialog"]')).toBeNull())
  await mounted.unmount()
})

test('a save that lands clears a move the guard was holding: nothing is left to discard', async () => {
  const mounted = await mountManager()
  await openListed(mounted, 'Reviewer')
  await eventually(() =>
    expect(mounted.dialog().querySelector<HTMLInputElement>('#prompt-name')?.value).toBe('Reviewer'),
  )
  await typeInto(mounted, '#prompt-name', 'Reviewer, sharper')
  await openListed(mounted, 'pi default')
  await eventually(() => expect(mounted.dialog().textContent).toContain('This prompt has unsaved changes.'))
  await click(mounted, 'Save')
  await eventually(() => expect(mounted.written).toHaveLength(1))
  await eventually(() => expect(mounted.dialog().textContent).not.toContain('This prompt has unsaved changes.'))
  await mounted.unmount()
})

test('delete asks, naming the file, before anything is removed', async () => {
  const mounted = await mountManager()
  await openListed(mounted, 'Reviewer')
  await eventually(() => expect(mounted.dialog().textContent).toContain('reviewer.md'))
  await click(mounted, 'Delete')
  expect(mounted.dialog().textContent).toContain('delete reviewer.md?')
  expect(mounted.asked.some((request) => request.startsWith('DELETE'))).toBe(false)
  const confirm = [...mounted.dialog().querySelectorAll<HTMLButtonElement>('[role="alert"] button')].find(
    (button) => button.textContent === 'Delete',
  )
  if (confirm === undefined) throw new Error('expected the confirming Delete')
  await flush(async () => {
    confirm.click()
    await tick()
  })
  await eventually(() => expect(mounted.asked).toContain('DELETE /api/prompts/reviewer'))
  await eventually(() => expect(mounted.dialog().textContent).toContain('what pi builds for this thread'))
  await mounted.unmount()
})

// ⚠ Two opens in flight: the one answered last must not be the one shown. The earlier prompt's
// read, arriving after the later one's, is stale — the editor keeps what the list has selected.
test('⚠ a prompt read that answers after a later selection is dropped: the editor shows what is selected', async () => {
  const { promise: released, resolve: release } = Promise.withResolvers<void>()
  const mounted = await mountManager((request) => (request === 'GET /api/prompts/reviewer' ? released : undefined))
  await openListed(mounted, 'Reviewer')
  await openListed(mounted, 'Haiku')
  const name = (): string | undefined => mounted.dialog().querySelector<HTMLInputElement>('#prompt-name')?.value
  await eventually(() => expect(name()).toBe('Haiku'))
  await flush(async () => {
    release()
    await tick()
  })
  expect(name()).toBe('Haiku')
  expect(mounted.dialog().querySelector<HTMLTextAreaElement>('#prompt-body')?.value).toBe(HAIKU.body)
  await mounted.unmount()
})

/** A request held until the test releases it. */
function held(request: string): { readonly hold: Hold; readonly release: () => Promise<void> } {
  const { promise, resolve } = Promise.withResolvers<void>()
  return {
    hold: (asked) => (asked === request ? promise : undefined),
    release: () =>
      flush(async () => {
        resolve()
        await tick()
      }),
  }
}

// ⚠ Typing goes on while a save is in flight: the save's answer must not put back the text it sent.
test('⚠ edits made while a save is in flight survive its answer, and still read as unsaved', async () => {
  const put = held('PUT /api/prompts/terse')
  const mounted = await mountManager(put.hold)
  await click(mounted, 'New')
  await typeInto(mounted, '#prompt-name', 'Terse')
  await typeInto(mounted, '#prompt-id', 'terse')
  await typeInto(mounted, '#prompt-body', 'One sentence.')
  await click(mounted, 'Save')
  await typeInto(mounted, '#prompt-body', 'One sentence. Then a second.')
  await put.release()
  await eventually(() => expect(mounted.written).toHaveLength(1))
  expect(mounted.written[0]?.fields.body).toBe('One sentence.')
  await eventually(() => expect(mounted.dialog().textContent).toContain('terse.md'))
  expect(mounted.dialog().querySelector<HTMLTextAreaElement>('#prompt-body')?.value).toBe(
    'One sentence. Then a second.',
  )
  expect(textOf(mounted, 'unsaved changes')).toContain('unsaved')
  await mounted.unmount()
})

// ⚠ A double-click on Save: one write, and a rename removes the old file once — a second DELETE
// would answer 404 and report a rename that happened as half-done.
test('⚠ a second Save while one is in flight sends nothing: one PUT, one DELETE, no warning', async () => {
  const put = held('PUT /api/prompts/reviewer-v2')
  const mounted = await mountManager(put.hold)
  await openListed(mounted, 'Reviewer')
  await eventually(() => expect(mounted.dialog().querySelector<HTMLInputElement>('#prompt-id')?.value).toBe('reviewer'))
  await typeInto(mounted, '#prompt-id', 'reviewer-v2')
  const save = buttonNamed(mounted, 'Save')
  await flush(async () => {
    save.click()
    save.click()
    await tick()
  })
  await put.release()
  await eventually(() => expect(mounted.dialog().textContent).toContain('reviewer-v2.md'))
  expect(mounted.asked.filter((request) => request.startsWith('PUT'))).toEqual(['PUT /api/prompts/reviewer-v2'])
  expect(mounted.asked.filter((request) => request.startsWith('DELETE'))).toEqual(['DELETE /api/prompts/reviewer'])
  expect(mounted.dialog().textContent).not.toContain('was not removed')
  await mounted.unmount()
})

// ⚠ A delete answering after the person moved on must not pull them back to pi's default.
test('⚠ a delete that answers after another prompt was opened leaves that prompt open', async () => {
  const remove = held('DELETE /api/prompts/reviewer')
  const mounted = await mountManager(remove.hold)
  await openListed(mounted, 'Reviewer')
  await eventually(() => expect(mounted.dialog().textContent).toContain('reviewer.md'))
  await click(mounted, 'Delete')
  const confirm = [...mounted.dialog().querySelectorAll<HTMLButtonElement>('[role="alert"] button')].find(
    (button) => button.textContent === 'Delete',
  )
  if (confirm === undefined) throw new Error('expected the confirming Delete')
  await flush(async () => {
    confirm.click()
    await tick()
  })
  await openListed(mounted, 'Haiku')
  const name = (): string | undefined => mounted.dialog().querySelector<HTMLInputElement>('#prompt-name')?.value
  await eventually(() => expect(name()).toBe('Haiku'))
  await remove.release()
  expect(mounted.asked).toContain('DELETE /api/prompts/reviewer')
  expect(name()).toBe('Haiku')
  await mounted.unmount()
})

// ⚠ The file changed on disk since it was opened: nothing is written until the person chooses.
test('⚠ a save refused because the file changed on disk offers Reload and Overwrite: Overwrite sends If-Match: *', async () => {
  let refuse = true
  const mounted = await mountManager(undefined, (request) =>
    refuse && request === 'PUT /api/prompts/reviewer'
      ? new Response('reviewer.md changed on disk since it was opened', { status: 412 })
      : undefined,
  )
  await openListed(mounted, 'Reviewer')
  await eventually(() =>
    expect(mounted.dialog().querySelector<HTMLInputElement>('#prompt-name')?.value).toBe('Reviewer'),
  )
  await typeInto(mounted, '#prompt-name', 'Reviewer, mine')
  await click(mounted, 'Save')
  await eventually(() => expect(mounted.dialog().textContent).toContain('changed on disk since it was opened'))
  expect(mounted.preconditions).toEqual([`PUT /api/prompts/reviewer If-Match: ${etagOf(REVIEWER).ETag}`])
  expect(mounted.written).toEqual([])
  refuse = false
  await click(mounted, 'Overwrite with mine')
  await eventually(() => expect(mounted.written).toHaveLength(1))
  expect(mounted.preconditions.at(-1)).toBe('PUT /api/prompts/reviewer If-Match: *')
  await eventually(() => expect(mounted.dialog().querySelector('[aria-label="changed on disk"]')).toBeNull())
  await mounted.unmount()
})

test('a delete refused because the file changed on disk offers Reload, which drops the draft for the file as it is', async () => {
  const mounted = await mountManager(undefined, (request) =>
    request === 'DELETE /api/prompts/reviewer'
      ? new Response('reviewer.md changed on disk since it was opened', { status: 412 })
      : undefined,
  )
  await openListed(mounted, 'Reviewer')
  await eventually(() => expect(mounted.dialog().textContent).toContain('reviewer.md'))
  await click(mounted, 'Delete')
  const confirm = [...mounted.dialog().querySelectorAll<HTMLButtonElement>('[role="alert"] button')].find(
    (button) => button.textContent === 'Delete',
  )
  if (confirm === undefined) throw new Error('expected the confirming Delete')
  await flush(async () => {
    confirm.click()
    await tick()
  })
  await eventually(() => expect(mounted.dialog().textContent).toContain('changed on disk since it was opened'))
  expect(mounted.preconditions).toEqual([`DELETE /api/prompts/reviewer If-Match: ${etagOf(REVIEWER).ETag}`])
  expect(buttonNamed(mounted, 'Reload from disk')).toBeDefined()
  expect(() => buttonNamed(mounted, 'Overwrite with mine')).toThrow()
  await click(mounted, 'Reload from disk')
  await eventually(() => expect(mounted.asked.filter((asked) => asked === 'GET /api/prompts/reviewer')).toHaveLength(2))
  await eventually(() => expect(mounted.dialog().querySelector('[aria-label="changed on disk"]')).toBeNull())
  await mounted.unmount()
})

test("#470: a trusted project's prompts are listed apart and open read-only — no Save, no Delete — with what the model receives", async () => {
  const mounted = await mountManager()
  await eventually(() => expect(textOf(mounted, 'Project prompts')).toContain('House style'))
  expect(textOf(mounted, 'Project prompts')).toContain('Team reviewer')
  await openListed(mounted, 'House style')
  await eventually(() => expect(mounted.dialog().textContent).toContain('.enso/prompts/house-style.md'))
  const body = mounted.dialog().querySelector<HTMLTextAreaElement>('#prompt-body')
  expect(body?.readOnly).toBe(true)
  expect(body?.value).toBe(HOUSE_STYLE.body)
  expect(mounted.dialog().textContent).toContain('How this repo writes')
  expect(() => buttonNamed(mounted, 'Save')).toThrow()
  expect(() => buttonNamed(mounted, 'Delete')).toThrow()
  await eventually(() => expect(textOf(mounted, 'what the model receives')).toContain('this prompt'))
  await mounted.unmount()
})

test("#470: ⚠ Copy to my library makes a new prompt in the user's library under the same name — a create, and nothing is ever written to the project", async () => {
  const mounted = await mountManager()
  await openListed(mounted, 'House style')
  await click(mounted, 'Copy to my library')
  expect(mounted.dialog().querySelector<HTMLInputElement>('#prompt-id')?.value).toBe('house-style')
  await click(mounted, 'Save')
  await eventually(() =>
    expect(mounted.written).toEqual([
      {
        id: 'house-style',
        fields: {
          name: 'House style',
          description: 'How this repo writes',
          category: 'append',
          body: HOUSE_STYLE.body,
        },
      },
    ]),
  )
  expect(mounted.preconditions).toEqual(['PUT /api/prompts/house-style If-None-Match: *'])
  expect(mounted.asked.filter((request) => request.includes('project-prompts') && !request.startsWith('GET'))).toEqual(
    [],
  )
  await mounted.unmount()
})

test("#470: an untrusted project's prompts are not listed; the manager says where they are and why", async () => {
  const mounted = await mountManager(undefined, undefined, { kind: 'untrusted', directory: '/work/repo/.enso/prompts' })
  await eventually(() =>
    expect(textOf(mounted, 'Project prompts')).toContain(
      'not read: the project is not trusted (/work/repo/.enso/prompts)',
    ),
  )
  expect(mounted.asked.some((request) => request.includes('project-prompts/'))).toBe(false)
  await mounted.unmount()
})
