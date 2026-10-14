import { afterAll, afterEach, expect, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  ENSO_GUARD_DENIAL_ENTRY,
  ENSO_INCIDENT_OPENED_ENTRY,
  ENSO_INCIDENT_RESOLVED_ENTRY,
  ENSO_PROVIDER_REFUSAL_KEY,
  ENSO_SESSION_RISK_ENTRY,
  ENSO_SYSTEM_PROMPT_ENTRY,
  ENSO_UI_EVENTS,
  type EnsoFollowFrame,
  type EnsoForkReceipt,
  type EnsoIncidentOpened,
  type EnsoIncidentRecord,
  type EnsoSessionIncidents,
  type EnsoGitFileChange,
  type EnsoGitRepository,
  type EnsoProject,
  type EnsoStoredThread,
  type EnsoThreadDeletePreview,
  type EnsoThreadStatusEvent,
  type EnsoTranscriptEntry,
  type EnsoTreeOnDisk,
  type EnsoTreesListing,
  type EnsoThreadHistory,
  type EnsoThreadStats,
  NO_SESSION_INCIDENTS,
  sessionEvalOf,
} from '@enso/core'
import type { UIMessage } from '@tanstack/ai-client'
import { act } from 'react'
import type { createRoot as CreateRoot, Root } from 'react-dom/client'
import { ChatScreen } from '../chat-screen.tsx'
import { AppHeader } from '../page-header.tsx'
import type { ThreadView } from '../pane-context.ts'
import { ThreadPane } from '../thread-pane.tsx'
import {
  adoptThread,
  clearThreadsForTest,
  getThreadStores,
  mintThread,
  type ThreadStores,
  threadListStore,
} from '../thread-stores.ts'
import { ensureDom, releaseDom } from './dom-environment.ts'
import {
  createScriptedFetch,
  requestedUrl,
  type ScriptedFetch,
  type ScriptedFetchOptions,
  SNAPSHOT_IDLE,
  SNAPSHOT_LIVE,
} from './scripted-server.ts'

// ⚠ Loaded HERE, not statically: react-dom/client probes the DOM when its module evaluates
// (`"oninput" in document` decides whether `onChange` uses the input event or an IE-era
// focus-tracking polyfill), and bun evaluates node_modules imports before a side-effect
// import can register the DOM. Statically imported, React sat in polyfill mode: `onChange`
// and `onKeyDown` never fired and its change plugin threw on every keystroke. `ensureDom`
// also re-registers when another mounting file ran first and released it.
ensureDom()
const { createRoot }: { createRoot: typeof CreateRoot } = await import('react-dom/client')

/**
 * The pane, MOUNTED, over a scripted server (#118, #125 items 1–3).
 *
 * Every in-flight reading in the pane (`thread-pane.tsx`) — the status bar, the stop button, the mode
 * select's `disabled`, the rail's busy dot — lives inside `createChatHook`'s closure over a
 * live `useChat`, where a static render cannot reach and a hook mock would only echo what the
 * test set. These mount the real pane with the real adapter over `scripted-server.ts`, write
 * wire frames, and read what a user reads: the DOM. The #103 receipt found four readings wrong
 * since #113 (`isLoading`, which the follow adapter never raises) and no test noticed; the
 * first test here FAILS if any of them reads `chat.isLoading` again.
 *
 * ⚠ `act` + `eventually`: the adapter consumes SSE frames on its own loop and a fetch resolves
 * on the event loop, so a frame's or a click's effect on the DOM lands SOME macrotasks later —
 * how many depends on the machine (#131's CI run: a 20 ms wait lost the race under load; the
 * same suite reproduces it locally pinned to one loaded core). So no reading after an action
 * is a sleep-then-assert: `eventually` retries the assertion inside `act` until it holds or a
 * deadline lapses, and a real failure reports as the assertion's own message. Real timers, no
 * fakes; the condition is the wait. A "nothing happens" reading (the disconnected composer's
 * Enter) cannot be waited for and stays a bounded tick — it can only fail toward passing.
 */

afterEach(() => clearThreadsForTest())
afterAll(releaseDom)

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20))

/** React's `act` with async work — typed so its Promise overload is the one seen (a type-aware `await-thenable` reads the sync one). */
const flush = (work: () => Promise<void>): Promise<void> => act(work)

/**
 * How long `eventually` keeps trying before a failing probe is a failure. It bounds a REAL
 * failure's report time, never a pass — a passing probe returns on its first true reading
 * (usually the first). The one knob if a slower runner ever loses the race again (#131 CI).
 */
const EVENTUALLY_DEADLINE_MS = 2000

/**
 * Retry `probe` — assertions, or a lookup that throws when its element is not there yet —
 * until it holds, yielding a tick inside `act` between tries so React flushes what the
 * adapter routed. The last failure is the report.
 */
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

interface MountedPane {
  readonly stores: ThreadStores
  readonly server: ScriptedFetch
  readonly container: HTMLElement
  /** Write frames, then let the adapter route them and React render. */
  readonly settle: (...frames: Parameters<ScriptedFetch['frame']>[0][]) => Promise<void>
  readonly unmount: () => Promise<void>
  /** Re-render the pane shown or hidden, as the page does when the rail switches threads. */
  readonly setActive: (active: boolean) => Promise<void>
  /** The status bar's words, e.g. `working · 0 turns …` with the separators dropped. */
  readonly status: () => string
  readonly stopButton: () => HTMLButtonElement | null
  readonly sendButton: () => HTMLButtonElement
  /** The composer's chip named `<label>: …` (#878) — `Mode`, `Effort`, `System prompt`. */
  readonly chip: (label: string) => HTMLButtonElement
  readonly composer: () => HTMLTextAreaElement
  /** The views the pane asked the page for, in order (#361) — the page is not mounted here. */
  readonly requestedViews: ThreadView[]
  /** Re-render the pane on another view, as the page does when it answers a request (#727). */
  readonly setView: (view: ThreadView) => Promise<void>
}

async function mountPane(
  options: {
    active?: boolean
    debugOpen?: boolean
    view?: ThreadView
    server?: ScriptedFetchOptions
    /** Leave a minted thread on its launch panel (#877); lowered otherwise, as a Start that went through lowers it. */
    launch?: boolean
    /** The page's GLOBAL fetch — the scripted server's unless a test sets a tripwire (#404). */
    globalFetch?: typeof fetch
    /** Mount a STORED thread, as a reload does (`adoptThread`), instead of minting a new one. */
    history?: EnsoThreadHistory
    /** The page opens what a fork answers (#433) — and so offers fork and restore on prompts. */
    onForked?: (receipt: EnsoForkReceipt) => void
  } = {},
): Promise<MountedPane> {
  const server = createScriptedFetch(options.server ?? {})
  // What the page itself fetches outside a thread; a pane's own requests go through its thread's.
  globalThis.fetch = options.globalFetch ?? server.fetch
  const stores = options.history === undefined ? mintThread(server.fetch) : adoptThread(options.history, server.fetch)
  // A minted thread opens on its launch panel (#877). These tests are about the started pane, so it
  // is lowered first — as a Start that went through lowers it — unless one asks.
  if (options.history === undefined) stores.launch.set(options.launch ?? false)
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  const requestedViews: ThreadView[] = []
  // What the page last rendered the pane with: `setActive` and `setView` each change one.
  let shownActive = options.active ?? true
  let shownView = options.view ?? 'chat'
  const render = (): void =>
    root.render(
      <ThreadPane
        threadId={stores.threadId}
        active={shownActive}
        debugOpen={options.debugOpen ?? false}
        view={shownView}
        onView={(view: ThreadView): void => {
          requestedViews.push(view)
        }}
        {...(options.onForked === undefined ? {} : { onForked: options.onForked })}
      />,
    )
  await flush(async () => {
    render()
  })
  const rerender = async (): Promise<void> => {
    await flush(async () => {
      render()
      await tick()
    })
  }
  await flush(tick)
  const one = <T extends Element>(selector: string): T => {
    const found = container.querySelector<T>(selector)
    if (found === null) throw new Error(`expected ${selector} in the pane`)
    return found
  }
  return {
    stores,
    server,
    container,
    settle: async (...frames) => {
      await flush(async () => {
        for (const frame of frames) server.frame(frame)
        await tick()
      })
    },
    unmount: async () => {
      await flush(async () => root.unmount())
      container.remove()
    },
    setActive: async (active: boolean) => {
      shownActive = active
      await rerender()
    },
    status: () => one('#thread-status').textContent ?? '',
    stopButton: () => container.querySelector<HTMLButtonElement>('button[aria-label="stop the run"]'),
    sendButton: () => one<HTMLButtonElement>('button[aria-label="send message"]'),
    chip: (label: string) => {
      const found = [...container.querySelectorAll<HTMLButtonElement>('button[aria-label]')].find((button) =>
        button.getAttribute('aria-label')?.startsWith(`${label}: `),
      )
      if (found === undefined) throw new Error(`expected the ${label} chip in the pane`)
      return found
    },
    composer: () => one<HTMLTextAreaElement>('textarea[name="message"]'),
    requestedViews,
    setView: async (view: ThreadView) => {
      shownView = view
      await rerender()
    },
  }
}

/**
 * Type into a React-controlled field the way a browser does: through the prototype's value
 * setter (React's value tracker wraps the instance's own, so a direct `.value =` is invisible
 * to it), then one bubbling `input` event — what React 19 listens to for `onChange`.
 */
function typeInto(field: HTMLTextAreaElement, text: string): void {
  if (!Reflect.set(HTMLTextAreaElement.prototype, 'value', text, field)) {
    throw new Error('HTMLTextAreaElement.prototype.value has no setter')
  }
  field.dispatchEvent(new Event('input', { bubbles: true }))
}

const pressEnter = (field: HTMLTextAreaElement): boolean =>
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))

/** The options a chip's open list offers, in order (Radix renders them in a portal on `document.body`). */
const offeredOptions = (): string[] =>
  [...document.querySelectorAll('[data-slot="select-item"]')].map((option) => option.textContent ?? '')

/**
 * Open a chip's list by KEYBOARD — Enter on the focused chip, as Radix's trigger takes it — and choose
 * the option named `label` with the arrow keys and Enter (#878: the keyboard path is the one to pin).
 * Answers what the list offered.
 */
async function chooseByKeyboard(chip: HTMLButtonElement, label: string): Promise<string[]> {
  await flush(async () => {
    chip.focus()
    chip.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await tick()
  })
  const offered = await eventually(() => {
    const options = offeredOptions()
    expect(options).toContain(label)
    return options
  })
  await flush(async () => {
    const option = [...document.querySelectorAll<HTMLElement>('[data-slot="select-item"]')].find(
      (candidate) => candidate.textContent === label,
    )
    option?.focus()
    option?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await tick()
  })
  return offered
}

const railBusy = (threadId: string): boolean | undefined =>
  threadListStore.get().find((thread) => thread.threadId === threadId)?.busy

/** The rail's own reading of a thread's title — what the summary effect writes (#283). */
const railTitle = (threadId: string): string | undefined =>
  threadListStore.get().find((thread) => thread.threadId === threadId)?.title

// ⚠ The LIVE title path, end to end (PR #310 review): a thread the page mints, a first user
// message typed into the composer, and the rail row that must carry its title. Every other
// title test drives the pure functions or a STORED thread whose title the server supplied —
// so the wiring #283 rewrote (first-user-message → memo → effect → `updateThreadSummary`)
// was covered nowhere. Depending on the message instead of the list is what stopped the
// effect firing per token; a memo keyed on the wrong thing would still title, so this test
// asserts the title ARRIVES, and the ones beside it assert what it is.
test('a live thread titles its rail row from the first user message (#283)', async () => {
  const pane = await mountPane()
  await pane.settle(SNAPSHOT_IDLE)
  expect(railTitle(pane.stores.threadId)).toBeUndefined()
  await flush(async () => {
    typeInto(pane.composer(), 'fix the login bug before the release')
    pressEnter(pane.composer())
    await tick()
  })
  await eventually(() => expect(railTitle(pane.stores.threadId)).toBe('fix the login bug before the release'))
  // …and a second prompt does not retitle: the FIRST user message is the title.
  await flush(async () => {
    typeInto(pane.composer(), 'and the logout one too')
    pressEnter(pane.composer())
    await tick()
  })
  await eventually(() => expect(pane.server.prompts.length).toBe(2))
  expect(railTitle(pane.stores.threadId)).toBe('fix the login bug before the release')
  await pane.unmount()
})

// ⚠ #620: a new thread has no session until one is built (#484), and the git route has nothing to
// read before then — every read was a 404 and a console error, three per new thread. The bar asks
// once the thread has a live session, and shows its git from that moment.
test('⚠ a new thread asks for no git state until its session is live, then reads it (#620)', async () => {
  const pane = await mountPane({ server: { git: () => ({ kind: 'not-a-repository' }) } })
  await pane.settle(SNAPSHOT_IDLE)
  // Usage moving is one of the readout's triggers: it must not ask for a thread with no session.
  await pane.settle({ ...SNAPSHOT_IDLE, usage: { ...SNAPSHOT_IDLE.usage, input: 1 } })
  expect(pane.server.gitReads).toEqual([])
  expect(pane.status()).not.toContain('no git')

  // The session is built (a Start, a first prompt): the snapshot says its model.
  await pane.settle(SNAPSHOT_LIVE)
  await eventually(() => {
    expect(pane.server.gitReads.length).toBeGreaterThan(0)
    expect(pane.status()).toContain('no git')
  })
  await pane.unmount()
})

// ⚠ #682: a first prompt sent from the composer is in the transcript at once, but the server builds
// the session only as it takes the prompt (#484) — about a second later in the arena. The bar read
// the transcript's length as "the thread can answer" and asked `/git` and `/tree` in that second:
// four 404s and four console errors per new thread. It asks once the server says the session is live.
test("⚠ a new thread's first prompt asks for no git state or tree until the session is live (#682)", async () => {
  const pane = await mountPane({
    server: {
      git: () => ({ kind: 'not-a-repository' }),
      pages: () => ({ path: '/scripted/launch', pages: [], truncated: false }),
    },
  })
  // A new thread in a tree of its own (#551), as the arena's are: the bar shows the "own tree" control.
  await pane.settle({ ...SNAPSHOT_IDLE, tree: true })
  // The prompt is posted; the server has not said the session is live yet, as while it builds one.
  await flush(async () => {
    typeInto(pane.composer(), 'build the snake game')
    pressEnter(pane.composer())
    await tick()
  })
  await eventually(() => expect(pane.server.prompts).toHaveLength(1))
  await flush(tick)
  expect(pane.server.gitReads).toEqual([])
  expect(pane.server.threadTreeReads).toEqual([])

  // The session is built: the snapshot says its model, and both are read from that moment.
  await pane.settle({ ...SNAPSHOT_LIVE, tree: true })
  await eventually(() => {
    expect(pane.server.gitReads.length).toBeGreaterThan(0)
    expect(pane.server.threadTreeReads.length).toBeGreaterThan(0)
  })
  await pane.unmount()
})

// ⚠ #619: a thread's work is in its own tree (#551), and the arena runs found no way to reach it —
// nor to play the game it built. The bar's "own tree" opens what the thread built: the tree's path,
// and each of its pages as a link on the thread's own preview origin (#713), in a new tab, holding no
// handle on this page.
test('⚠ "own tree" opens what the thread built: its path, and each page on its preview origin in a new tab (#619, #713)', async () => {
  const pane = await mountPane({
    server: {
      pages: () => ({
        path: '/home/me/.enso/projects/p/trees/t',
        pages: ['index.html', 'game/my page.html'],
        truncated: false,
        previewOrigin: 'http://127.0.0.1:41234',
      }),
    },
  })
  await pane.settle({ ...SNAPSHOT_LIVE, tree: true })
  const opener = [...pane.container.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === 'own tree, not your checkout',
  )
  if (opener === undefined) throw new Error('expected the "own tree" button on the bar')
  await flush(async () => {
    opener.click()
    await tick()
  })
  const panel = await eventually(() => {
    const dialog = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find((open) =>
      open.textContent?.includes('What this thread built'),
    )
    expect(dialog?.textContent).toContain('/home/me/.enso/projects/p/trees/t')
    return dialog
  })
  const links = [...(panel?.querySelectorAll<HTMLAnchorElement>('a') ?? [])].map((link) => [
    link.getAttribute('href'),
    link.getAttribute('target'),
    link.getAttribute('rel'),
  ])
  expect(links).toEqual([
    ['http://127.0.0.1:41234/index.html', '_blank', 'noopener noreferrer'],
    ['http://127.0.0.1:41234/game/my%20page.html', '_blank', 'noopener noreferrer'],
  ])

  // PR #635 review: a refused copy is said; a done one says Copied.
  const copyButton = (): HTMLButtonElement | undefined =>
    [...(panel?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((button) =>
      /Copy path|Copied/.test(button.textContent ?? ''),
    )
  const clipboard = (writeText: (text: string) => Promise<void>): void => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  }
  clipboard(() => Promise.reject(new Error('denied')))
  await flush(async () => {
    copyButton()?.click()
    await tick()
  })
  expect(panel?.textContent).toContain('The clipboard refused the copy: select the path to copy it.')
  const copiedText: string[] = []
  clipboard((text) => {
    copiedText.push(text)
    return Promise.resolve()
  })
  await flush(async () => {
    copyButton()?.click()
    await tick()
  })
  expect(copiedText).toEqual(['/home/me/.enso/projects/p/trees/t'])
  expect(copyButton()?.textContent).toContain('Copied')
  expect(panel?.textContent).not.toContain('The clipboard refused')
  await pane.unmount()
})

// ⚠ #754: a tree whose setup failed still opens its thread, and fails later far from the cause (a
// pre-commit hook with no node_modules). The panel says it on its face: the failing command, its
// exit, and the file its list came from; the command's output waits behind its step.
test('⚠ a failed tree setup is said on the panel — command, exit and the file to fix — its output on expanding (#754)', async () => {
  const pane = await mountPane({
    server: {
      pages: () => ({
        path: '/home/me/.enso/projects/p/trees/t',
        pages: [],
        truncated: false,
        setup: {
          ok: false,
          copied: [],
          missing: ['.env'],
          steps: [
            {
              command: 'bun install --frozen-lockfile',
              exitCode: 1,
              durationMs: 2300,
              output: 'error: lockfile had changes, but lockfile is frozen',
              truncated: false,
            },
          ],
          tiers: { setup: 'shared', copy: 'local' },
        },
      }),
    },
  })
  await pane.settle({ ...SNAPSHOT_LIVE, tree: true })
  const opener = [...pane.container.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === 'own tree, not your checkout',
  )
  if (opener === undefined) throw new Error('expected the "own tree" button on the bar')
  await flush(async () => {
    opener.click()
    await tick()
  })
  const panel = await eventually(() => {
    const dialog = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find((open) =>
      open.textContent?.includes('What this thread built'),
    )
    if (dialog === undefined) throw new Error('expected the panel')
    expect(dialog.querySelector('[role="alert"]')?.textContent).toBe(
      'Setup failed at bun install --frozen-lockfile (exit 1) — the commands are in shared with the project (.enso/config.json).',
    )
    return dialog
  })
  expect(panel.textContent).toContain('Missing, not copied: .env')
  expect(panel.textContent).not.toContain('lockfile is frozen')
  const step = [...panel.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
    button.textContent?.startsWith('output of bun install --frozen-lockfile'),
  )
  if (step === undefined) throw new Error('expected the step’s toggle')
  expect(step.textContent).toContain('exit 1, 2.3s')
  await flush(async () => {
    step.click()
    await tick()
  })
  await eventually(() =>
    expect(panel.querySelector('pre')?.textContent).toBe('error: lockfile had changes, but lockfile is frozen'),
  )
  await pane.unmount()
})

// ⚠ #640: the first agent run after the preview shipped read the "own tree" button and concluded
// Enso had no preview. Once the tree holds a page, the bar says "Preview", and it opens the panel.
test('⚠ the bar offers "Preview" once the thread’s tree holds a page, and not before (#640)', async () => {
  let pages: string[] = []
  const pane = await mountPane({ server: { pages: () => ({ path: '/trees/t', pages, truncated: false }) } })
  const previewButton = (): HTMLButtonElement | undefined =>
    [...pane.container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === 'Preview',
    )
  await pane.settle({ ...SNAPSHOT_LIVE, tree: true })
  await eventually(() => expect(pane.status()).toContain('own tree, not your checkout'))
  expect(previewButton()).toBeUndefined()

  // The run writes a page: a tool result settles, and the bar reads the tree again.
  pages = ['index.html']
  await pane.settle(
    { type: 'observation', seq: 1, observation: { kind: 'message-start', role: 'assistant' } },
    {
      type: 'observation',
      seq: 2,
      observation: { kind: 'tool-call', toolCallId: 'w1', toolName: 'write', args: { path: 'index.html' } },
    },
    {
      type: 'observation',
      seq: 3,
      observation: {
        kind: 'tool-result',
        toolCallId: 'w1',
        toolName: 'write',
        text: 'ok',
        complete: true,
        isError: false,
      },
    },
  )
  const preview = await eventually(() => {
    const found = previewButton()
    expect(found).toBeDefined()
    return found
  })
  await flush(async () => {
    preview?.click()
    await tick()
  })
  await eventually(() =>
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('What this thread built'),
  )
  await pane.unmount()
})

// ⚠ #714, from an arena run: the panel stayed open over the chat once its preview tab opened, so the
// agent's report of what it found by playing met a blocked chat, and its Enter — focus still on Open
// preview — opened a second preview tab. Open preview closes the panel and hands focus to the composer.
test('⚠ Open preview closes the panel and puts focus in the composer (#714)', async () => {
  const pane = await mountPane({
    server: {
      pages: () => ({
        path: '/trees/t',
        pages: ['index.html'],
        truncated: false,
        previewOrigin: 'http://127.0.0.1:41234',
      }),
    },
  })
  await pane.settle({ ...SNAPSHOT_LIVE, tree: true })
  const preview = await eventually(() => {
    const found = [...pane.container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === 'Preview',
    )
    expect(found).toBeDefined()
    return found
  })
  await flush(async () => {
    preview?.click()
    await tick()
  })
  const open = await eventually(() => {
    const link = [...document.querySelectorAll<HTMLAnchorElement>('[role="dialog"] a')].find((anchor) =>
      anchor.textContent?.includes('Open preview'),
    )
    expect(link).toBeDefined()
    return link
  })
  if (open === undefined) throw new Error('expected the Open preview link')
  // ⚠ #813: happy-dom follows a `_blank` link as a browser would, fetching the page into a new
  // window; nothing listens on the preview origin, so the click's default stays undone here. What
  // is pinned is the click's effect on this page; the link's href and target are pinned in #619's test.
  open.addEventListener('click', (event) => event.preventDefault(), { once: true })
  await flush(async () => {
    open.click()
    await tick()
  })
  await eventually(() => expect(document.querySelector('[role="dialog"]')).toBeNull())
  await eventually(() => expect(document.activeElement?.getAttribute('name')).toBe('message'))
  await pane.unmount()
})

// #729, from Opus's snake run: two pages listed two links both named "Open preview", and the agent
// had to pick one by position. Each link's name now says which page it opens.
test('each page in "What this thread built" has a link named for its page, not N identical "Open preview"s (#729)', async () => {
  const pane = await mountPane({
    server: {
      pages: () => ({
        path: '/trees/t',
        pages: ['debug.html', 'index.html'],
        truncated: false,
        previewOrigin: 'http://127.0.0.1:41234',
      }),
    },
  })
  await pane.settle({ ...SNAPSHOT_LIVE, tree: true })
  const preview = await eventually(() => {
    const found = [...pane.container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === 'Preview',
    )
    expect(found).toBeDefined()
    return found
  })
  await flush(async () => {
    preview?.click()
    await tick()
  })
  // A link's accessible name is its text, the visually hidden part included.
  const names = await eventually(() => {
    const links = [...document.querySelectorAll<HTMLAnchorElement>('[role="dialog"] a')]
    expect(links).toHaveLength(2)
    return links.map((link) => link.textContent?.replace(/\s+/g, ' ').trim())
  })
  expect(names).toEqual(['Open preview of debug.html', 'Open preview of index.html'])
  await pane.unmount()
})

// ⚠ #404: a thread's requests go through ITS fetch — the seam the fixture page closes (its threads
// get one that refuses), and the one that carries the project header (#395). A request a pane
// issues on the page's GLOBAL fetch instead escapes both: on the fixture page that ran a real
// model. The page global here is a tripwire; every pane path that reads or writes is driven.
test("every request a pane makes goes through its thread's fetch, never the page's global one (#404)", async () => {
  const strays: string[] = []
  const tripwire = (async (input: string): Promise<Response> => {
    strays.push(input)
    return new Response('the page global, not the thread fetch', { status: 500 })
  }) as typeof fetch
  // The composer: the mode seed on mount, then a typed `/word` — looked up in the thread's command
  // list first (#388), then sent as a prompt when it is not a host row.
  const pane = await mountPane({ globalFetch: tripwire })
  await pane.settle(SNAPSHOT_IDLE)
  await flush(async () => {
    typeInto(pane.composer(), '/not-a-host-command')
    pressEnter(pane.composer())
    await tick()
  })
  await eventually(() => expect(pane.server.prompts.map((prompt) => prompt.message)).toEqual(['/not-a-host-command']))
  await pane.unmount()
  // The Stats and Context views read their routes; the thread's server answers 404, which the view
  // says as "nothing has run" — the tripwire's 500 would read as a failure instead.
  for (const view of ['stats', 'context', 'changes'] as const) {
    const viewing = await mountPane({ view, globalFetch: tripwire })
    await eventually(() =>
      expect(viewing.container.textContent?.toLowerCase()).toContain('nothing has run in this thread yet'),
    )
    await viewing.unmount()
  }
  expect(strays).toEqual([])
})

// ── #125 item 1: the in-flight readings flip with the wire's status frames ───────────────

test('⚠ busy on the wire → working, stop offered, rail busy, and the Mode chip still offered (#618); settled → idle, all back', async () => {
  const pane = await mountPane()
  expect(pane.status()).toContain('idle')
  expect(pane.stopButton()).toBeNull()
  expect(pane.chip('Mode').disabled).toBe(false)
  expect(railBusy(pane.stores.threadId)).toBe(false)

  // Another tab's run: busy with no receipt of ours. `isLoading` would never rise for this
  // — it is TanStack's request-local flag — so a reading on it shows idle here and fails.
  await pane.settle({ ...SNAPSHOT_IDLE, live: true, busy: true, generation: 3 })
  await eventually(() => {
    expect(pane.status()).toContain('working')
    expect(pane.stopButton()).not.toBeNull()
    // A run that asks before every call is the one whose mode a user needs to change (#618).
    expect(pane.chip('Mode').disabled).toBe(false)
    expect(railBusy(pane.stores.threadId)).toBe(true)
  })

  await pane.settle(
    { type: 'observation', seq: 1, observation: { kind: 'settled', aborted: false } },
    { type: 'status', live: true, busy: false, generation: 3 },
  )
  await eventually(() => {
    expect(pane.status()).toContain('idle')
    expect(pane.stopButton()).toBeNull()
    expect(pane.chip('Mode').disabled).toBe(false)
    expect(railBusy(pane.stores.threadId)).toBe(false)
  })
  await pane.unmount()
})

// #348: a compaction rewrites the branch under the transcript the pane mounted with. The pane re-reads
// it, but only once the thread is idle: pi compacts on its own when the context overflows, inside the
// run it then retries, and replacing the transcript under a streaming reply would drop what streamed.
test('⚠ a compaction said mid-run waits for the run; once idle the pane shows the compacted branch', async () => {
  const text = (id: string, role: 'user' | 'assistant', content: string): UIMessage => ({
    id,
    role,
    parts: [{ type: 'text', content }],
  })
  const threadId = 'compacted-thread'
  const history = (messages: UIMessage[]): EnsoThreadHistory => ({
    threadId,
    projectId: 'p-launch',
    messages,
    permissionMode: { mode: 'default', available: ['default'] },
    sessionRisk: { level: 'low', signals: 0 },
    incidents: NO_SESSION_INCIDENTS,
  })
  const pane = await mountPane({
    history: history([text('u1', 'user', 'old question'), text('a1', 'assistant', 'the long old answer')]),
    // What the server holds after the compaction: pi's summary in place of the old turns.
    server: { histories: { [threadId]: history([text('s1', 'user', 'summary of what came before')]) } },
  })
  expect(pane.container.textContent).toContain('the long old answer')
  await pane.settle({ ...SNAPSHOT_IDLE, live: true, busy: true, generation: 1 })
  await pane.settle({ type: 'observation', seq: 1, observation: { kind: 'branch-compacted', reason: 'overflow' } })
  // Mid-run: nothing is replaced under the run pi is retrying.
  await flush(tick)
  expect(pane.container.textContent).toContain('the long old answer')
  await pane.settle(
    { type: 'observation', seq: 2, observation: { kind: 'settled', aborted: false } },
    { type: 'status', live: true, busy: false, generation: 1 },
  )
  await eventually(() => {
    expect(pane.container.textContent).toContain('summary of what came before')
    expect(pane.container.textContent).not.toContain('the long old answer')
  })
  await pane.unmount()
})

// #348: a login holds no run lease, so the thread reads idle through a device-code wait and Stop was
// never offered. The `login` observation is what the composer reads: Stop, named for the login,
// while it waits; pressing it is the same `POST …/abort`; gone once the login stops waiting.
test('⚠ while a login waits, the composer offers Stop for it; pressing it asks the server; gone once the login ends', async () => {
  const pane = await mountPane()
  const cancelLogin = (): HTMLButtonElement | null =>
    pane.container.querySelector<HTMLButtonElement>('button[aria-label="cancel the login to Anthropic"]')
  expect(cancelLogin()).toBeNull()
  await pane.settle({
    type: 'observation',
    seq: 1,
    observation: { kind: 'login', provider: 'Anthropic', waiting: true },
  })
  await eventually(() => expect(cancelLogin()).not.toBeNull())
  expect(pane.status()).toContain('idle') // a login is not a run
  await flush(async () => {
    cancelLogin()?.click()
    await tick()
  })
  await eventually(() => expect(pane.server.abortCount()).toBe(1))
  await pane.settle({
    type: 'observation',
    seq: 2,
    observation: { kind: 'login', provider: 'Anthropic', waiting: false },
  })
  await eventually(() => expect(cancelLogin()).toBeNull())
  await pane.unmount()
})

test("the snapshot's mode is the Mode chip's, its list the host's modes; the host's mode observation moves it (#84, #95, L3, #878)", async () => {
  const pane = await mountPane()
  await pane.settle({ ...SNAPSHOT_IDLE, permissionMode: { mode: 'plan', available: ['default', 'plan', 'auto'] } })
  await eventually(() => expect(pane.chip('Mode').getAttribute('aria-label')).toBe('Mode: plan'))
  // Choosing the mode it is in already asks nothing: the list offers the host's modes, as they came.
  expect(await chooseByKeyboard(pane.chip('Mode'), 'plan')).toEqual(['default', 'plan', 'auto'])
  expect(pane.server.modeChanges).toEqual([])
  await pane.settle({
    type: 'observation',
    seq: 1,
    observation: { kind: 'permission-mode', mode: 'auto', available: ['default', 'plan', 'auto'] },
  })
  await eventually(() => expect(pane.chip('Mode').getAttribute('aria-label')).toBe('Mode: auto'))
  // The readout never lies about what it was told: a mode the receipt's list omits is still offered, as current.
  await pane.settle({
    type: 'observation',
    seq: 2,
    observation: { kind: 'permission-mode', mode: 'bypassPermissions', available: ['default', 'plan'] },
  })
  await eventually(() => expect(pane.chip('Mode').getAttribute('aria-label')).toBe('Mode: bypassPermissions'))
  expect(await chooseByKeyboard(pane.chip('Mode'), 'bypassPermissions')).toEqual([
    'default',
    'plan',
    'bypassPermissions',
  ])
  await pane.unmount()
})

// ⚠ #878, from the prototype's click-through: a Mode change there left no trace in the thread. Here
// every change chosen on the chip goes to the mode route, and the host's receipt writes the
// thread's "Mode: …" line — `bypassPermissions` included, the one change a reader must see.
test('⚠ every Mode change chosen on the chip, bypassPermissions included, POSTs the mode and leaves its "Mode: …" line in the thread', async () => {
  const modes = ['default', 'plan', 'bypassPermissions']
  const pane = await mountPane()
  await pane.settle({ ...SNAPSHOT_IDLE, live: true, permissionMode: { mode: 'default', available: modes } })
  await eventually(() => expect(pane.chip('Mode').getAttribute('aria-label')).toBe('Mode: default'))
  const lines = (mode: string): number => pane.container.textContent?.split(`Mode: ${mode}`).length ?? 1
  for (const [index, mode] of ['bypassPermissions', 'plan', 'bypassPermissions'].entries()) {
    const before = lines(mode)
    await chooseByKeyboard(pane.chip('Mode'), mode)
    await eventually(() => expect(pane.server.modeChanges.at(-1)).toEqual({ mode }))
    // What the host emits once the mode is persisted (`POST …/mode` answers 204, the receipt follows).
    await pane.settle({
      type: 'observation',
      seq: index + 1,
      observation: { kind: 'permission-mode', mode, available: modes },
    })
    await eventually(() => {
      expect(pane.chip('Mode').getAttribute('aria-label')).toBe(`Mode: ${mode}`)
      expect(lines(mode)).toBe(before + 1)
    })
  }
  expect(pane.server.modeChanges).toEqual([
    { mode: 'bypassPermissions' },
    { mode: 'plan' },
    { mode: 'bypassPermissions' },
  ])
  await pane.unmount()
})

// #878: the started composer's System prompt chip is locked — the session took its prompt before its
// first request (#443) — and names the prompt the thread REPORTS: the snapshot's, which a reload
// reads off the branch, then an entry appended live. Pressed, it says why it cannot change.
test('the locked System prompt chip names the prompt the thread reports — the snapshot’s, then a live record — and pressing it says why it is fixed', async () => {
  const reviewer = { id: 'reviewer', name: 'Reviewer', mode: 'system' as const, sha256: 'a'.repeat(64) }
  const pane = await mountPane()
  await pane.settle({ ...SNAPSHOT_IDLE, systemPrompt: reviewer })
  const chip = (): HTMLButtonElement => pane.chip('System prompt')
  await eventually(() =>
    expect(chip().getAttribute('aria-label')).toBe('System prompt: Reviewer, fixed for this session'),
  )
  // A lock, not a list: nothing to choose from.
  expect(chip().getAttribute('role')).toBeNull()
  expect(chip().hasAttribute('aria-haspopup')).toBe(false)
  await flush(async () => {
    chip().click()
    await tick()
  })
  const explanation = await eventually(() => {
    const found = document.querySelector('[role="tooltip"]')
    if (found === null) throw new Error('expected the explanation')
    return found.textContent ?? ''
  })
  expect(explanation).toContain('Fixed for this session')
  // A choice recorded live — another tab's Start — is what the chip says next, without its text.
  await pane.settle({
    type: 'observation',
    seq: 1,
    observation: {
      kind: 'custom-entry',
      customType: ENSO_SYSTEM_PROMPT_ENTRY,
      data: { id: 'haiku', name: 'Haiku', mode: 'append', sha256: 'b'.repeat(64), text: 'Answer in haiku.' },
    },
  })
  await eventually(() =>
    expect(chip().getAttribute('aria-label')).toBe('System prompt: pi default + Haiku, fixed for this session'),
  )
  // pi's default, recorded over a choice, and a record that does not read — never shown as the default.
  await pane.settle({ ...SNAPSHOT_IDLE, systemPrompt: null })
  await eventually(() =>
    expect(chip().getAttribute('aria-label')).toBe('System prompt: pi default, fixed for this session'),
  )
  await pane.settle({ ...SNAPSHOT_IDLE, systemPrompt: 'unreadable' })
  await eventually(() =>
    expect(chip().getAttribute('aria-label')).toBe('System prompt: unreadable record, fixed for this session'),
  )
  await pane.unmount()
})

// #878: what the empty box and the line under it say follow the thread — idle, a run in flight — and
// say nothing about sending once nothing can be sent.
test('the placeholder and the hint follow the run: idle "Ask pi something", running "Type the next prompt…", and no hint once disconnected', async () => {
  const pane = await mountPane()
  await pane.settle(SNAPSHOT_IDLE)
  const hint = (): string => pane.composer().parentElement?.querySelector('p')?.textContent ?? ''
  await eventually(() => {
    expect(pane.composer().placeholder).toBe('Ask pi something')
    expect(hint()).toBe('Enter to send · Shift+Enter for a new line')
  })
  await pane.settle({ type: 'status', live: true, busy: true, generation: 1 })
  await eventually(() => {
    expect(pane.composer().placeholder).toBe('Type the next prompt — it queues until this run ends')
    expect(hint()).toBe('pi is running · Enter queues · Shift+Enter for a new line')
  })
  await pane.settle(
    { type: 'observation', seq: 1, observation: { kind: 'settled', aborted: false } },
    { type: 'status', live: true, busy: false, generation: 1 },
  )
  await eventually(() => expect(hint()).toBe('Enter to send · Shift+Enter for a new line'))
  await flush(async () => {
    pane.server.closeFollow()
    await tick()
  })
  await eventually(() => {
    expect(pane.composer().placeholder).toBe('disconnected — reload and resume from the rail')
    expect(hint()).toBe('')
  })
  await pane.unmount()
})

// #551, PR #561 review: "Restore files to here" is offered only on a thread with a tree of its own —
// on a thread in its checkout it was a confirm, then a 409 every time.
test('a prompt offers "Restore files to here" only while the snapshot says the thread has a tree; fork is offered either way', async () => {
  const prompted: UIMessage = { id: 'e-u1', role: 'user', parts: [{ type: 'text', content: 'first' }] }
  const pane = await mountPane({
    onForked: () => undefined,
    history: {
      threadId: crypto.randomUUID(),
      projectId: 'p-launch',
      messages: [prompted],
      permissionMode: { mode: 'default', available: ['default'] },
      sessionRisk: { level: 'low', signals: 0 },
      incidents: NO_SESSION_INCIDENTS,
    },
  })
  const buttons = (): string[] =>
    [...pane.container.querySelectorAll('button')].map((button) => button.textContent ?? '')
  await pane.settle({ ...SNAPSHOT_IDLE, messageCount: 1, tree: false })
  await eventually(() => expect(buttons()).toContain('Fork from here'))
  expect(buttons()).not.toContain('Restore files to here')
  await pane.settle({ ...SNAPSHOT_IDLE, messageCount: 1, tree: true })
  await eventually(() => expect(buttons()).toContain('Restore files to here'))
  await pane.unmount()
})

// ⚠ #651, from an arena run: three "Restore files to here" buttons shared one accessible name, and
// the agent had to guess which prompt by index; the confirmation named none. Numbered (PR #654
// review): two prompts with the same words would otherwise share a name again.
test('⚠ each prompt’s restore and fork are named for their prompt, uniquely, and the restore confirmation names it (#651)', async () => {
  const messages: UIMessage[] = [
    { id: 'e-u1', role: 'user', parts: [{ type: 'text', content: 'Create a minimal to-do app' }] },
    { id: 'e-a1', role: 'assistant', parts: [{ type: 'text', content: 'Done.' }] },
    { id: 'e-u2', role: 'user', parts: [{ type: 'text', content: 'continue' }] },
    { id: 'e-a2', role: 'assistant', parts: [{ type: 'text', content: 'Done.' }] },
    { id: 'e-u3', role: 'user', parts: [{ type: 'text', content: 'continue' }] },
  ]
  const pane = await mountPane({
    onForked: () => undefined,
    history: {
      threadId: crypto.randomUUID(),
      projectId: 'p-launch',
      messages,
      permissionMode: { mode: 'default', available: ['default'] },
      sessionRisk: { level: 'low', signals: 0 },
      incidents: NO_SESSION_INCIDENTS,
    },
  })
  await pane.settle({ ...SNAPSHOT_IDLE, messageCount: messages.length, tree: true })
  const named = (visible: string): Array<string | null> =>
    [...pane.container.querySelectorAll('button')]
      .filter((button) => button.textContent === visible)
      .map((button) => button.getAttribute('aria-label'))
  await eventually(() =>
    expect(named('Restore files to here')).toEqual([
      'Restore files to here, prompt 1: “Create a minimal to-do app”',
      'Restore files to here, prompt 2: “continue”',
      'Restore files to here, prompt 3: “continue”',
    ]),
  )
  expect(named('Fork from here')).toEqual([
    'Fork from here, prompt 1: “Create a minimal to-do app”',
    'Fork from here, prompt 2: “continue”',
    'Fork from here, prompt 3: “continue”',
  ])

  const third = [...pane.container.querySelectorAll('button')].find(
    (button) => button.getAttribute('aria-label') === 'Restore files to here, prompt 3: “continue”',
  )
  await flush(async () => {
    third?.click()
    await tick()
  })
  await eventually(() =>
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      'go back to how they were at prompt 3: “continue”.',
    ),
  )
  await pane.unmount()
})

// ── dialogs through the pane (#112, #114) ────────────────────────────────────────────────

test('a blocking question on the wire is the card; its settle from elsewhere removes it', async () => {
  const pane = await mountPane()
  await pane.settle(SNAPSHOT_IDLE, {
    type: 'observation',
    seq: 1,
    observation: {
      kind: 'extension-ui-request',
      id: 'd1',
      method: 'confirm',
      blocking: true,
      origin: 'run',
      dialog: { method: 'confirm', title: 'Apply the edit?', message: 'It is reversible' },
    },
  })
  await eventually(() => {
    expect(pane.container.textContent).toContain('Apply the edit?')
    expect(pane.container.querySelector('button')?.textContent).toBeDefined()
  })
  // Answered in another tab: the host says so, every follower drops the card (#114).
  await pane.settle({
    type: 'observation',
    seq: 2,
    observation: { kind: 'dialog-settled', id: 'd1', outcome: 'answered' },
  })
  await eventually(() => expect(pane.container.textContent).not.toContain('Apply the edit?'))
  await pane.unmount()
})

test('answering the card is one POST …/dialog, and the card goes when the server takes it', async () => {
  const pane = await mountPane()
  await pane.settle(SNAPSHOT_IDLE, {
    type: 'observation',
    seq: 1,
    observation: {
      kind: 'extension-ui-request',
      id: 'd2',
      method: 'select',
      blocking: true,
      origin: 'run',
      dialog: { method: 'select', title: 'Pick one', options: ['alpha', 'bravo'] },
    },
  })
  const bravo = await eventually(() => {
    const found = [...pane.container.querySelectorAll('button')].find((button) => button.textContent === 'bravo')
    if (found === undefined) throw new Error("expected the select's options as buttons")
    return found
  })
  await flush(async () => {
    bravo.click()
    await tick()
  })
  await eventually(() => {
    expect(pane.server.dialogs).toEqual([{ id: 'd2', value: 'bravo' }])
    expect(pane.container.textContent).not.toContain('Pick one')
  })
  await pane.unmount()
})

test('an input dialog: what is typed is the answer, one POST …/dialog, uncontrolled field read at submit', async () => {
  const pane = await mountPane()
  await pane.settle(SNAPSHOT_IDLE, {
    type: 'observation',
    seq: 1,
    observation: {
      kind: 'extension-ui-request',
      id: 'd3',
      method: 'input',
      blocking: true,
      origin: 'run',
      dialog: { method: 'input', title: 'Name?', placeholder: 'a name' },
    },
  })
  const { field, answerButton } = await eventually(() => {
    const found = pane.container.querySelector<HTMLInputElement>('input[name="answer"]')
    if (found === null) throw new Error("expected the input dialog's field")
    const answer = [...pane.container.querySelectorAll('button')].find((button) => button.textContent === 'Answer')
    if (answer === undefined) throw new Error('expected an Answer button')
    return { field: found, answerButton: answer }
  })
  await flush(async () => {
    field.value = 'enso' // uncontrolled: the form reads the field at submit, no React state in between
    answerButton.click()
    await tick()
  })
  await eventually(() => {
    expect(pane.server.dialogs).toEqual([{ id: 'd3', value: 'enso' }])
    expect(pane.container.textContent).not.toContain('Name?')
  })
  await pane.unmount()
})

// #275: the card stays mounted for the whole round trip (`settleDialog` clears the slot only
// once the server has taken the answer), and the server SPENDS a question on its first answer.
// So a second click — a double-click on `Yes`, a second option on a `select` — used to send a
// second POST, get the 404 for the spent question, and put a red `dialog d4 gone: 404 …` line
// on screen for an answer that had in fact landed. Measured before the guard: three POSTs
// (`alpha`, `alpha`, `bravo`) and that notice.
test('⚠ an open question is answered ONCE: extra clicks post nothing and no failure is reported for an answer that landed', async () => {
  const pane = await mountPane()
  const askSelect = async (id: string): Promise<void> => {
    await pane.settle({
      type: 'observation',
      seq: id === 'd4' ? 1 : 2,
      observation: {
        kind: 'extension-ui-request',
        id,
        method: 'select',
        blocking: true,
        origin: 'run',
        dialog: { method: 'select', title: `Pick one (${id})`, options: ['alpha', 'bravo'] },
      },
    })
  }
  await pane.settle(SNAPSHOT_IDLE)
  await askSelect('d4')
  const options = await eventually(() => {
    const found = [...pane.container.querySelectorAll('button')].filter(
      (button) => button.textContent === 'alpha' || button.textContent === 'bravo',
    )
    if (found.length !== 2) throw new Error("expected the select's two options as buttons")
    return found
  })
  // All in one task, before the first POST resolves: the double-click and a different option.
  await flush(async () => {
    options[0]?.click()
    options[0]?.click()
    options[1]?.click()
    await tick()
  })
  await eventually(() => {
    expect(pane.server.dialogs).toEqual([{ id: 'd4', value: 'alpha' }])
    expect(pane.container.textContent).not.toContain('Pick one (d4)')
    expect(pane.container.textContent).not.toContain('gone: 404')
  })

  // ⚠ And the NEXT question is answerable: the flag is per-question state, so a fresh card
  // must not inherit the spent one's. A red line here means the guard latched for the thread.
  await askSelect('d5')
  const nextOption = await eventually(() => {
    const found = [...pane.container.querySelectorAll('button')].find((button) => button.textContent === 'bravo')
    if (found === undefined) throw new Error("expected the next question's options")
    if (found.disabled) throw new Error('the next question arrived with its controls disabled')
    return found
  })
  await flush(async () => {
    nextOption.click()
    await tick()
  })
  await eventually(() => {
    expect(pane.server.dialogs).toEqual([
      { id: 'd4', value: 'alpha' },
      { id: 'd5', value: 'bravo' },
    ])
    expect(pane.container.textContent).not.toContain('Pick one (d5)')
  })
  await pane.unmount()
})

// ⚠ The other half of the guard (PR #317 review): a REFUSED answer leaves the question
// standing on the server, so the card has to become answerable again. Without the reset the
// card is inert with its question still open — the thread parks on a human who can no longer
// answer, which is a worse failure than the double post the guard was added for. The store
// layer's own tests cover the 422; this is the one that proves the CONTROLS come back.
test('a refused answer re-opens the card: the question is still open, so it must stay answerable (#275)', async () => {
  const pane = await mountPane({ server: { dialogStatus: 422 } })
  await pane.settle(SNAPSHOT_IDLE, {
    type: 'observation',
    seq: 1,
    observation: {
      kind: 'extension-ui-request',
      id: 'd6',
      method: 'select',
      blocking: true,
      origin: 'run',
      dialog: { method: 'select', title: 'Pick one (d6)', options: ['alpha', 'bravo'] },
    },
  })
  const alpha = await eventually(() => {
    const found = [...pane.container.querySelectorAll('button')].find((button) => button.textContent === 'alpha')
    if (found === undefined) throw new Error("expected the select's options as buttons")
    return found
  })
  await flush(async () => {
    alpha.click()
    await tick()
  })
  // The card stays, and its controls are live again — a second, different answer gets through.
  const bravo = await eventually(() => {
    const found = [...pane.container.querySelectorAll('button')].find((button) => button.textContent === 'bravo')
    if (found === undefined) throw new Error('the refused question lost its card')
    if (found.disabled) throw new Error('the refused question stayed disabled: it can never be answered')
    return found
  })
  await flush(async () => {
    bravo.click()
    await tick()
  })
  await eventually(() => {
    expect(pane.server.dialogs).toEqual([
      { id: 'd6', value: 'alpha' },
      { id: 'd6', value: 'bravo' },
    ])
  })
  await pane.unmount()
})

// ⚠ The SAME re-open, reached the other way (PR #317 review). `settle` re-opens on two
// outcomes and the reviewer's note is that only one of them was proven through the component:
// `refused` is an answer, `unreachable` is the absence of one, and they arrive on different
// code paths — a 422 response against a REJECTED fetch. The store layer pins the mapping; what
// this pins is that `OpenQuestion` treats the two alike, so a dropped connection cannot leave
// the thread parked on a human holding an inert card.
test('an unreachable answer re-opens the card too: nothing reached the server, so the question stands (#275)', async () => {
  const pane = await mountPane({ server: { dialogUnreachable: true } })
  await pane.settle(SNAPSHOT_IDLE, {
    type: 'observation',
    seq: 1,
    observation: {
      kind: 'extension-ui-request',
      id: 'd7',
      method: 'confirm',
      blocking: true,
      origin: 'run',
      dialog: { method: 'confirm', title: 'Apply the edit? (d7)', message: 'It is reversible' },
    },
  })
  const answerable = async (): Promise<HTMLButtonElement> =>
    await eventually(() => {
      const found = [...pane.container.querySelectorAll('button')].find((button) => button.textContent === 'Yes')
      if (found === undefined) throw new Error('the unreachable question lost its card')
      if (found.disabled) throw new Error('the unreachable question stayed disabled: it can never be answered')
      return found
    })
  await flush(async () => {
    ;(await answerable()).click()
    await tick()
  })
  // The retry is the assertion: a card that stayed disabled could not produce a second POST.
  await flush(async () => {
    ;(await answerable()).click()
    await tick()
  })
  await eventually(() => {
    expect(pane.server.dialogs).toEqual([
      { id: 'd7', confirmed: true },
      { id: 'd7', confirmed: true },
    ])
  })
  await pane.unmount()
})

// #276: the one surface that parks pi on a human used to carry no role, no accessible name and
// no focus — a screen-reader user could not tell a parked thread from a slow one, and a
// keyboard user had to tab the whole transcript to find the question. The name and the focus
// move are the behaviour: read through the accessibility properties of the DOM, never a class.
test('a blocking question announces itself: a group named by the question, and focus on the control that answers it', async () => {
  const pane = await mountPane()
  await pane.settle(SNAPSHOT_IDLE, {
    type: 'observation',
    seq: 1,
    observation: {
      kind: 'extension-ui-request',
      id: 'd6',
      method: 'confirm',
      blocking: true,
      origin: 'run',
      dialog: { method: 'confirm', title: 'Apply the edit?', message: 'It is reversible' },
    },
  })
  const card = await eventually(() => {
    const found = pane.container.querySelector<HTMLElement>('[role="group"]')
    if (found === null) throw new Error('expected the question as a named group')
    return found
  })
  // The accessible name is the question itself — `aria-labelledby` resolved the way a screen
  // reader resolves it, and the title is a heading so the rotor can reach it.
  const nameSource = document.getElementById(card.getAttribute('aria-labelledby') ?? '')
  expect(nameSource?.textContent).toBe('Apply the edit?')
  expect(nameSource?.matches('h1, h2, h3, h4, h5, h6, [role="heading"]')).toBe(true)
  // Focus is inside the group, on the control a human answers with — not still in the transcript.
  await eventually(() => {
    expect(card.contains(document.activeElement)).toBe(true)
    expect(document.activeElement?.textContent).toBe('Yes')
  })
  await pane.unmount()
})

// ── the accessible names the e2e spec selects by (#277) ──────────────────────────────────

/**
 * `packages/web/e2e/chat.e2e.ts` finds the composer by these three names and nothing checked
 * them: `STOP_BUTTON_NAME` read `'stop the current response'` from before #116 renamed the
 * control to `stop the run`, so the one e2e that proves a run started could never match. The
 * spec does not run in CI, so the contract is gated in two halves that meet here: this test
 * pins name → RENDERED MARKUP, and `test/e2e-selectors.test.ts` pins the spec's constants →
 * the names in `composer.tsx`. Renaming a control fails both; editing a constant fails the
 * gate. (⚠ The spec cannot be read from here: `packages/web/src` is the browser zone and
 * fallow refuses a browser → test edge. The names are literal on purpose.)
 */
test("⚠ the composer's e2e selectors match the rendered markup, and the spec's settle gate is false mid-run", async () => {
  const pane = await mountPane()
  await pane.settle(SNAPSHOT_IDLE)
  const stopByName = (): number => pane.container.querySelectorAll('button[aria-label="stop the run"]').length
  await eventually(() => {
    expect(pane.composer().placeholder).toBe('Ask pi something')
    expect(pane.sendButton().getAttribute('aria-label')).toBe('send message')
    // Settled, so the spec's settle gate — the stop control's absence — holds.
    expect(stopByName()).toBe(0)
  })

  // Mid-run it is FALSE, which is what makes it a gate: send is rendered the whole time (only
  // disabled), so the old reading "send is visible" was already true on the empty page.
  await pane.settle({ type: 'status', live: true, busy: true, generation: 1 })
  await eventually(() => {
    expect(stopByName()).toBe(1)
    expect(pane.sendButton().isConnected).toBe(true)
  })

  await pane.settle(
    { type: 'observation', seq: 1, observation: { kind: 'settled', aborted: false } },
    { type: 'status', live: true, busy: false, generation: 1 },
  )
  await eventually(() => expect(stopByName()).toBe(0))
  await pane.unmount()
})

// PR #129 review: the take-back runs after a network round trip, from a closure an older
// render made. It must act on the transcript as it is THEN — not revert what streamed in between.
test('⚠ a queued prompt refused after a delay takes back only its own bubble; deltas that streamed meanwhile stay', async () => {
  const server = createScriptedFetch()
  let releaseSecondPrompt: () => void = () => undefined
  let prompts = 0
  // The second `/prompt` (the queued one) is held, then refused with a 400.
  const gated = ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const path = new URL(requestedUrl(input), 'http://localhost').pathname
    if (path.endsWith('/prompt')) {
      prompts += 1
      if (prompts === 2) {
        return new Promise<Response>((resolve) => {
          releaseSecondPrompt = () => resolve(new Response('pi would not take it', { status: 400 }))
        })
      }
    }
    return server.fetch(input, init)
  }) as typeof fetch
  globalThis.fetch = gated
  const stores = mintThread(gated)
  // About the started pane's composer: its launch panel is lowered, as a Start that went through lowers it (#877).
  stores.launch.set(false)
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  await flush(async () => {
    root.render(<ThreadPane threadId={stores.threadId} active={true} debugOpen={false} />)
  })
  await flush(tick)
  const composer = (): HTMLTextAreaElement => {
    const found = container.querySelector<HTMLTextAreaElement>('textarea[name="message"]')
    if (found === null) throw new Error('expected the composer')
    return found
  }
  await flush(async () => {
    server.frame(SNAPSHOT_IDLE)
    await tick()
  })
  await flush(async () => {
    typeInto(composer(), 'first')
    pressEnter(composer())
    await tick()
  })
  // Mid-run: the queued prompt goes out and is held by the server.
  await flush(async () => {
    typeInto(composer(), 'second, queued')
    await tick()
  })
  await flush(async () => {
    pressEnter(composer())
    await tick()
  })
  await eventually(() => expect(container.textContent).toContain('second, queued'))
  // Meanwhile the first answer streams.
  await flush(async () => {
    server.frame({ type: 'observation', seq: 1, observation: { kind: 'message-start', role: 'assistant' } })
    server.frame({
      type: 'observation',
      seq: 2,
      observation: { kind: 'text-delta', contentIndex: 0, delta: 'streamed while held' },
    })
    await tick()
  })
  await eventually(() => expect(container.textContent).toContain('streamed while held'))
  // Now the refusal lands: its bubble leaves, its text returns to the draft — and the delta STAYS.
  await flush(async () => {
    releaseSecondPrompt()
    await tick()
  })
  await eventually(() => {
    expect(composer().value).toBe('second, queued')
    expect((container.textContent?.match(/second, queued/g) ?? []).length).toBe(1) // the composer only
    expect(container.textContent).toContain('streamed while held')
    expect(container.textContent).toContain('first')
  })
  await flush(async () => root.unmount())
  container.remove()
})

// ── the follow ending under the page (#103 receipt, #119) ───────────────────────────────

// @pins abort-clear-restore/composer-takes-back
test('Enter or the button: one POST …/prompt each and the draft clears; DURING a run the prompt goes to pi now, listed above the composer, and a stop hands it back (#75)', async () => {
  const pane = await mountPane({ server: { queued: ['by the button, mid-run'] } })
  await pane.settle(SNAPSHOT_IDLE)
  await flush(async () => {
    typeInto(pane.composer(), 'hello pi')
    pressEnter(pane.composer())
    await tick()
  })
  await eventually(() => {
    expect(pane.server.prompts).toEqual([{ message: 'hello pi' }])
    expect(pane.composer().value).toBe('')
    // The receipt opened OUR run (generation 1); the bar says so and the server is busy.
    expect(pane.status()).toContain('working')
  })

  // A prompt during the run: to pi NOW as a follow-up — not TanStack's browser queue (which
  // held it until settle before #75) — with the user message in the transcript at once.
  await flush(async () => {
    typeInto(pane.composer(), 'by the button, mid-run')
    await tick()
  })
  await eventually(() => expect(pane.sendButton().disabled).toBe(false))
  await flush(async () => {
    pane.sendButton().click()
    await tick()
  })
  await eventually(() => {
    expect(pane.composer().value).toBe('')
    expect(pane.server.prompts).toEqual([
      { message: 'hello pi' },
      { message: 'by the button, mid-run', admission: 'enqueue' },
    ])
    expect(pane.container.textContent).toContain('by the button, mid-run')
  })
  // pi lists it for every follower; this pane shows the list above the composer.
  await pane.settle({
    type: 'observation',
    seq: 1,
    observation: { kind: 'queue', interrupting: [], enqueued: ['by the button, mid-run'] },
  })
  await eventually(() => {
    const queueList = pane.container.querySelector('[aria-label="queued prompts"]')
    expect(queueList?.textContent).toContain('1 prompt queued')
    expect(queueList?.textContent).toContain('by the button, mid-run')
  })

  // Stop: pi is told, its queue is cleared (the frame every follower reads), and the words
  // come back to THIS composer — clear-and-restore, pi's TUI's behaviour.
  const stop = pane.stopButton()
  if (stop === null) throw new Error('expected the stop button during the run')
  await flush(async () => {
    stop.click()
    await tick()
  })
  await eventually(() => {
    expect(pane.server.abortCount()).toBe(1)
    expect(pane.composer().value).toBe('by the button, mid-run')
  })
  await pane.settle({ type: 'observation', seq: 2, observation: { kind: 'queue', interrupting: [], enqueued: [] } })
  await eventually(() => {
    expect(pane.container.querySelector('[aria-label="queued prompts"]')).toBeNull()
    // The bubble that was never asked leaves with its text (pi's TUI does the same): with the
    // queue list gone, the ONLY place the words remain is the composer. The first prompt's bubble stays.
    expect((pane.container.textContent?.match(/by the button, mid-run/g) ?? []).length).toBe(1)
    expect(pane.container.textContent).toContain('hello pi')
  })
  await pane.unmount()
})

// ⚠ THE PALETTE LEAVES THE DRAFT ALONE (#338, PR #343 review). `send` used to clear the draft
// itself, so picking an extension command destroyed what was typed; and the insert overwrote it.
// The clear belongs to the submit — the draft WAS that text — and a template goes in FRONT of
// the words already typed, which become its argument, because pi reads `/name` at the start only.
test('the `/` palette: an extension command sends and the typed draft stays; a template is inserted ahead of it', async () => {
  const pane = await mountPane({
    server: {
      commands: [
        { name: 'mode', source: 'extension', description: 'the mode' },
        { name: 'review', source: 'prompt', description: 'review it' },
      ],
    },
  })
  await pane.settle(SNAPSHOT_IDLE)
  await flush(async () => {
    typeInto(pane.composer(), 'and then deploy it')
    await tick()
  })
  const openPalette = async (): Promise<void> => {
    await flush(async () => {
      const trigger = pane.container.querySelector<HTMLButtonElement>('button[aria-label="commands"]')
      if (trigger === null) throw new Error('expected the `/` button')
      trigger.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }))
      await tick()
    })
    await eventually(() => expect(document.querySelectorAll('[cmdk-item]').length).toBe(2))
  }
  const pick = async (label: string): Promise<void> => {
    await flush(async () => {
      const row = [...document.querySelectorAll<HTMLElement>('[cmdk-item]')].find(
        (candidate) => candidate.getAttribute('data-value') === label,
      )
      if (row === undefined) throw new Error(`expected the ${label} row`)
      row.click()
      await tick()
    })
  }
  await openPalette()
  await pick('/mode')
  await eventually(() => {
    expect(pane.server.prompts).toEqual([{ message: '/mode' }])
    expect(pane.composer().value).toBe('and then deploy it')
  })
  await openPalette()
  await pick('/review')
  await eventually(() => {
    expect(pane.composer().value).toBe('/review and then deploy it')
    expect(pane.server.prompts).toHaveLength(1)
  })
  await pane.unmount()
})

// ⚠ THE COMPOSER'S MODEL CONTROLS ARE THE FEED'S, AND CHANGE IT THROUGH THE COMMAND ROUTE (#338
// slice 2, the control half of #44). Before a live snapshot the chip says the model is unknown;
// the snapshot's `model` names it; the chip opens the dialog the palette's `/model` shares;
// picking POSTs `{ name: 'model', value }` and moves nothing itself — the `model` observation
// does; a refusal (409 running, 422 the host's reason) is a warning notice, the click did nothing else.
test('the model chip and the Effort chip follow the snapshot; picking a model POSTs …/command; a refusal is a notice', async () => {
  const modelRow = {
    name: 'model',
    source: 'host' as const,
    kind: 'select' as const,
    description: 'switch the model',
    value: 'fake/fake-1',
    options: [
      { id: 'fake/fake-1', label: 'Fake One', detail: 'fake' },
      { id: 'fake/fake-2', label: 'Fake Two', detail: 'fake' },
    ],
  }
  const pane = await mountPane({
    server: { commands: [modelRow], commandStatus: 422, commandBody: 'model fake/fake-2 is not available here' },
  })
  await pane.settle(SNAPSHOT_IDLE)
  const chip = (): HTMLButtonElement => {
    const found = pane.container.querySelector<HTMLButtonElement>('button[aria-label^="Model"]')
    if (found === null) throw new Error('expected the model chip')
    return found
  }
  await eventually(() => expect(chip().textContent).toContain('default until the thread runs'))
  expect(pane.container.querySelector('[aria-label^="Effort: "]')).toBeNull()

  await pane.settle({
    ...SNAPSHOT_IDLE,
    live: true,
    model: {
      model: { provider: 'fake', id: 'fake-1', name: 'Fake One' },
      thinkingLevel: 'medium',
      availableThinkingLevels: ['off', 'low', 'medium', 'high'],
    },
  })
  await eventually(() => {
    expect(chip().textContent).toContain('Fake One')
    expect(pane.chip('Effort').getAttribute('aria-label')).toBe('Effort: medium')
  })

  // The chip opens the dialog; the dialog reads the thread's commands and lists the row's options.
  await flush(async () => {
    chip().click()
    await tick()
  })
  const secondOption = await eventually(() => {
    const rows = [...document.querySelectorAll<HTMLElement>('[role="dialog"] [cmdk-item]')]
    expect(rows.map((row) => row.getAttribute('data-value'))).toEqual(['fake/fake-1', 'fake/fake-2'])
    const found = rows[1]
    if (found === undefined) throw new Error('expected the second model')
    return found
  })
  await flush(async () => {
    secondOption.click()
    await tick()
  })
  await eventually(() => {
    expect(pane.server.hostCommands).toEqual([{ name: 'model', value: 'fake/fake-2' }])
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    // The scripted 422: said, verbatim, as a notice; the chip did not move (no observation came).
    const notices = [...pane.container.querySelectorAll('[role="status"]')].map((notice) => notice.textContent)
    expect(
      notices.some((notice) => notice?.includes('/model refused: 422 model fake/fake-2 is not available here')),
    ).toBe(true)
    expect(chip().textContent).toContain('Fake One')
  })

  // The feed moves the chip — never the click.
  await pane.settle({
    type: 'observation',
    seq: 1,
    observation: {
      kind: 'model',
      model: { provider: 'fake', id: 'fake-2', name: 'Fake Two' },
      thinkingLevel: 'high',
      availableThinkingLevels: ['off', 'low', 'medium', 'high'],
    },
  })
  await eventually(() => {
    expect(chip().textContent).toContain('Fake Two')
    expect(pane.chip('Effort').getAttribute('aria-label')).toBe('Effort: high')
  })
  // The Effort chip (#878), by keyboard: the levels the model offers, and a choice is the `/thinking` command.
  expect(await chooseByKeyboard(pane.chip('Effort'), 'low')).toEqual(['off', 'low', 'medium', 'high'])
  await eventually(() => expect(pane.server.hostCommands.at(-1)).toEqual({ name: 'thinking', value: 'low' }))
  await pane.unmount()
})

// #434: a cold thread's snapshot names what its branch last ran on. The chip says it, marked
// recorded — never as live, so no Effort chip (the levels are pi's to offer once built) —
// and the live snapshot replaces it once the thread runs.
test('a cold thread shows its recorded model on the chip, marked recorded; the live snapshot wins once it runs', async () => {
  const pane = await mountPane()
  await pane.settle({
    ...SNAPSHOT_IDLE,
    recordedModel: { model: { provider: 'anthropic', modelId: 'claude-sonnet-5' }, thinkingLevel: 'medium' },
  })
  const chip = (): HTMLButtonElement => {
    const found = pane.container.querySelector<HTMLButtonElement>('button[aria-label^="Model"]')
    if (found === null) throw new Error('expected the model chip')
    return found
  }
  // The shared chip control (#880): named `Model (recorded)`, so it never reads as live.
  await eventually(() =>
    expect(chip().getAttribute('aria-label')).toBe('Model (recorded): claude-sonnet-5 · anthropic · medium'),
  )
  expect(pane.container.querySelector('[aria-label^="Effort: "]')).toBeNull()

  await pane.settle({
    ...SNAPSHOT_IDLE,
    live: true,
    model: {
      model: { provider: 'fake', id: 'fake-1', name: 'Fake One' },
      thinkingLevel: 'high',
      availableThinkingLevels: ['off', 'low', 'medium', 'high'],
    },
  })
  await eventually(() => {
    expect(chip().getAttribute('aria-label')).toBe('Model: Fake One · fake')
    expect(pane.chip('Effort').getAttribute('aria-label')).toBe('Effort: high')
  })
  await pane.unmount()
})

test('⚠ the follow closing mid-run: the notice, disconnected on the bar, no stop, and Enter sends nothing', async () => {
  const pane = await mountPane()
  await pane.settle({ ...SNAPSHOT_IDLE, live: true, busy: true, generation: 2 })
  await eventually(() => expect(pane.stopButton()).not.toBeNull())
  // A draft typed BEFORE the drop, so the send path has something to send.
  await flush(async () => {
    typeInto(pane.composer(), 'this must not send')
    await tick()
  })
  await eventually(() => expect(pane.sendButton().disabled).toBe(false))
  await flush(async () => {
    pane.server.closeFollow()
    await tick()
  })
  await eventually(() => {
    expect(pane.container.textContent).toContain('the connection to the server ended')
    expect(pane.status()).toContain('disconnected')
    expect(pane.stopButton()).toBeNull()
    expect(pane.sendButton().disabled).toBe(true)
    expect(pane.composer().placeholder).toContain('disconnected')
  })
  await flush(async () => {
    pressEnter(pane.composer())
    await tick()
  })
  expect(pane.server.prompts).toEqual([])
  expect(pane.composer().value).toBe('this must not send')
  // ⚠ Past the port's disabled-button check: a submit that reaches the form anyway — a future
  // keybinding, an upstream re-fetch dropping that check — still sends nothing AND keeps the
  // words. The draft clears on `send` having sent, not on the submit having happened (PR #343 review).
  await flush(async () => {
    pane.composer().form?.requestSubmit()
    await tick()
  })
  expect(pane.server.prompts).toEqual([])
  expect(pane.composer().value).toBe('this must not send')
  await pane.unmount()
})

// ── #130: a tool call the run ended without answering is aborted, not running ─────────

test('⚠ a tool call reads running… while its run is open and aborted once the run ends without a result', async () => {
  const pane = await mountPane()
  await pane.settle(SNAPSHOT_IDLE)
  await flush(async () => {
    typeInto(pane.composer(), 'run it')
    pressEnter(pane.composer())
    await tick()
  })
  await pane.settle(
    { type: 'observation', seq: 1, observation: { kind: 'message-start', role: 'assistant' } },
    {
      type: 'observation',
      seq: 2,
      observation: { kind: 'tool-call', toolCallId: 'c1', toolName: 'bash', args: { command: 'sleep 40' } },
    },
  )
  const step = (): string | null =>
    pane.container.querySelector('[data-enso-tool-call]')?.getAttribute('data-enso-tool-call') ?? null
  await eventually(() => {
    expect(step()).toBe('pending')
    expect(pane.container.textContent).toContain('running…')
    expect(pane.status()).toContain('running bash')
  })
  // The stop: pi is told, and the run ends on the feed with no result for the call.
  const stop = pane.stopButton()
  if (stop === null) throw new Error('expected the stop button')
  await flush(async () => {
    stop.click()
    await tick()
  })
  await pane.settle(
    { type: 'observation', seq: 3, observation: { kind: 'settled', aborted: false } },
    { type: 'status', live: true, busy: false, generation: 1 },
  )
  await eventually(() => {
    expect(pane.status()).toContain('idle')
    expect(step()).toBe('aborted')
    expect(pane.container.textContent).toContain('aborted')
    expect(pane.container.textContent).not.toContain('running…')
  })
  await pane.unmount()
})

// #411: a truncated result's descriptor rides the AG-UI result, and TanStack's processor keeps
// none of it — so live, the note was never drawn (resumed, the result carries it in metadata).
// The follow connection hands it to the thread's store before the result is pushed.
test('⚠ a truncated tool result says so LIVE, from the descriptor TanStack would have dropped (#411)', async () => {
  const pane = await mountPane()
  await pane.settle(SNAPSHOT_IDLE)
  await flush(async () => {
    typeInto(pane.composer(), 'read it')
    pressEnter(pane.composer())
    await tick()
  })
  await pane.settle(
    { type: 'observation', seq: 1, observation: { kind: 'message-start', role: 'assistant' } },
    {
      type: 'observation',
      seq: 2,
      observation: { kind: 'tool-call', toolCallId: 'c1', toolName: 'read', args: { path: 'big.ts' } },
    },
    {
      type: 'observation',
      seq: 3,
      observation: {
        kind: 'tool-result',
        toolCallId: 'c1',
        toolName: 'read',
        text: 'line 1',
        complete: true,
        isError: false,
        descriptor: { kind: 'pi.tool.read', props: {}, truncated: { shown: 1, total: 400, unit: 'lines' } },
      },
    },
  )
  await eventually(() => {
    expect(pane.container.querySelector('[data-enso-tool-call="done"]')).not.toBeNull()
    expect(pane.container.querySelector('[data-enso-truncation]')?.textContent).toBe('showing 1 of 400 lines')
  })
  await pane.unmount()
})

// #412: a reload while pi is parked on a question. The stored history ends on the `ask_user` call,
// with no result yet, and the snapshot says the run is live. Joining it opens a new assistant
// message for what streams next, so the history's message holding the call is no longer the
// LAST one — and a row whose run is "the last message's" read the open call as aborted.
test('⚠ a call still waiting when the page joins a busy run reads running, not aborted — row and status bar (#412, #418)', async () => {
  const pane = await mountPane({
    history: {
      threadId: 'asked-1',
      projectId: 'p-launch',
      messages: [
        { id: 'u1', role: 'user', parts: [{ type: 'text', content: 'pick one' }] },
        {
          id: 'a1',
          role: 'assistant',
          parts: [
            {
              type: 'tool-call',
              id: 'ask-1',
              name: 'ask_user',
              arguments: '{}',
              input: {},
              state: 'input-complete',
            },
          ],
        },
      ],
      permissionMode: { mode: 'default', available: ['default', 'plan'] },
      sessionRisk: { level: 'low', signals: 0 },
      incidents: NO_SESSION_INCIDENTS,
    },
  })
  await pane.settle({ ...SNAPSHOT_IDLE, threadId: 'asked-1', live: true, busy: true, generation: 1 })
  await eventually(() => {
    // The joined run's own message is still empty; the bar names the call behind it (#418).
    expect(pane.status()).toContain('running ask_user')
    expect(pane.container.querySelector('[data-enso-tool-call]')?.getAttribute('data-enso-tool-call')).toBe('pending')
  })
  await pane.unmount()
})

// An `isError` result with NO guard-denial entry — a command that ran and failed — reads error. The
// reason text here is a guard's on purpose: the page never reads the wording (#387); only the
// entry makes a refusal, and its live path is the sibling test below.
test('⚠ an isError result with no guard denial reads error LIVE — the same as a resumed log shows it (#130, #407)', async () => {
  const pane = await mountPane()
  await pane.settle(SNAPSHOT_IDLE)
  await flush(async () => {
    typeInto(pane.composer(), 'write it')
    pressEnter(pane.composer())
    await tick()
  })
  await pane.settle(
    { type: 'observation', seq: 1, observation: { kind: 'message-start', role: 'assistant' } },
    {
      type: 'observation',
      seq: 2,
      observation: { kind: 'tool-call', toolCallId: 'c2', toolName: 'write', args: { path: '/etc/x' } },
    },
    {
      type: 'observation',
      seq: 3,
      observation: {
        kind: 'tool-result',
        toolCallId: 'c2',
        toolName: 'write',
        text: 'blocked: outside the write root',
        complete: true,
        isError: true,
      },
    },
  )
  await eventually(() => {
    const row = pane.container.querySelector('[data-enso-tool-call]')
    expect(row?.getAttribute('data-enso-tool-call')).toBe('error')
    expect(row?.hasAttribute('open')).toBe(true) // an error opens itself
    expect(pane.container.textContent).toContain('blocked: outside the write root')
    expect(pane.status()).toContain('working') // the model has the output and is composing
  })
  await pane.unmount()
})

// #387, #407 — live: the guard appends its entry inside `tool_call`, before pi builds the error
// result, so the entry's `custom-entry` crosses FIRST. The row is the refusal card from that
// moment (its verdict; no reason yet), gains the reason when the result lands, and never reads
// `error`; the status bar counts it refused, not failed.
test('⚠ a guard-refused call reads refused LIVE: the entry, then the result — the card, then its reason (#387, #407)', async () => {
  const pane = await mountPane()
  await pane.settle(SNAPSHOT_IDLE)
  await flush(async () => {
    typeInto(pane.composer(), 'write it')
    pressEnter(pane.composer())
    await tick()
  })
  await pane.settle(
    { type: 'observation', seq: 1, observation: { kind: 'message-start', role: 'assistant' } },
    {
      type: 'observation',
      seq: 2,
      observation: { kind: 'tool-call', toolCallId: 'c2', toolName: 'write', args: { path: '/etc/x' } },
    },
    {
      type: 'observation',
      seq: 3,
      observation: {
        kind: 'custom-entry',
        customType: ENSO_GUARD_DENIAL_ENTRY,
        data: { toolCallId: 'c2', rule: 'write-confinement' },
      },
    },
  )
  const row = (): Element | null => pane.container.querySelector('[data-tool-call-id="c2"]')
  await eventually(() => {
    expect(row()?.getAttribute('data-enso-tool-call')).toBe('refused')
    expect(row()?.textContent).toContain('Refused · outside the workspace')
    expect(row()?.textContent).not.toContain('outside the write root')
  })
  await pane.settle({
    type: 'observation',
    seq: 4,
    observation: {
      kind: 'tool-result',
      toolCallId: 'c2',
      toolName: 'write',
      text: 'blocked: outside the write root',
      complete: true,
      isError: true,
    },
  })
  await eventually(() => {
    expect(row()?.getAttribute('data-enso-tool-call')).toBe('refused')
    expect(row()?.textContent).toContain('blocked: outside the write root')
    expect(pane.container.querySelector('[data-enso-tool-call="error"]')).toBeNull()
    expect(pane.status()).toContain('1 refused')
    expect(pane.status()).not.toContain('failed')
  })
  await pane.unmount()
})

/**
 * ⚠ THE INVARIANT THE WHOLE-TRANSCRIPT SELECTION EXISTS FOR (#280).
 *
 * pi claiming a queued prompt rotates the assistant bubble (`follow-connection.ts`, the user
 * `message-start`), so a tool result can land on a LATER message than its call. The earlier
 * bubble must still pair them — and that bubble's own message object never changed, so any
 * memoisation keyed on message identity (which is what TanStack's `memo(MessageView)` does)
 * leaves this call reading `running…` for the rest of the session. A red line here means the
 * row is bailing out on something other than what it draws.
 */
test('⚠ a tool result the wire lands on a LATER message still completes the call in the earlier bubble', async () => {
  const pane = await mountPane()
  await pane.settle(SNAPSHOT_IDLE)
  await flush(async () => {
    typeInto(pane.composer(), 'list them')
    pressEnter(pane.composer())
    await tick()
  })
  await pane.settle(
    { type: 'observation', seq: 1, observation: { kind: 'message-start', role: 'assistant' } },
    { type: 'observation', seq: 2, observation: { kind: 'text-delta', contentIndex: 0, delta: 'calling it ' } },
    {
      type: 'observation',
      seq: 3,
      observation: { kind: 'tool-call', toolCallId: 'c3', toolName: 'bash', args: { command: 'ls' } },
    },
  )
  const call = (): Element | null => pane.container.querySelector('[data-enso-tool-call]')
  await eventually(() => expect(call()?.getAttribute('data-enso-tool-call')).toBe('pending'))

  // pi takes the queued prompt: this ENDS the bubble holding the call and opens a new one,
  // and everything after it — the result included — belongs to the new message.
  await pane.settle({ type: 'observation', seq: 4, observation: { kind: 'message-start', role: 'user' } })
  await pane.settle(
    {
      type: 'observation',
      seq: 5,
      observation: {
        kind: 'tool-result',
        toolCallId: 'c3',
        toolName: 'bash',
        text: 'a.ts b.ts',
        complete: true,
        isError: false,
      },
    },
    { type: 'observation', seq: 6, observation: { kind: 'text-delta', contentIndex: 0, delta: 'two files' } },
  )
  await eventually(() => {
    expect(call()?.getAttribute('data-enso-tool-call')).toBe('done')
    expect(pane.container.textContent).toContain('a.ts b.ts')
    expect(pane.container.textContent).not.toContain('running…')
  })
  await pane.unmount()
})

// ── #739: a long thread opens on its last page, and a chunk redraws only its own message ─────────

const text = (id: string, role: 'user' | 'assistant', content: string): UIMessage => ({
  id,
  role,
  parts: [{ type: 'text', content }],
})

/** A stored thread's history as `/history` answers it, around `messages`. */
const storedHistory = (threadId: string, messages: UIMessage[]): EnsoThreadHistory => ({
  threadId,
  projectId: 'p-launch',
  messages,
  permissionMode: { mode: 'default', available: ['default'] },
  sessionRisk: { level: 'low', signals: 0 },
  incidents: NO_SESSION_INCIDENTS,
})

test('a long thread opens on its last page; "Load earlier" puts the page before it above, its prompts numbered from the branch’s start (#739)', async () => {
  const threadId = crypto.randomUUID()
  const earlier = [
    text('b-u1', 'user', 'first ask'),
    text('b-a1', 'assistant', 'FIRST-REPLY'),
    text('b-u2', 'user', 'second ask'),
    text('b-a2', 'assistant', 'SECOND-REPLY'),
  ]
  const page = [text('b-u3', 'user', 'third ask'), text('b-a3', 'assistant', 'THIRD-REPLY')]
  const pane = await mountPane({
    onForked: () => undefined,
    history: {
      ...storedHistory(threadId, page),
      earlier: { messages: earlier.length, prompts: 2, firstPrompt: earlier[0] },
    },
    server: { earlierHistories: { 'b-u3': storedHistory(threadId, earlier) } },
  })
  await pane.settle({ ...SNAPSHOT_IDLE, threadId, messageCount: earlier.length + page.length })
  const forkNames = (): Array<string | null> =>
    [...pane.container.querySelectorAll('button')]
      .filter((button) => button.textContent === 'Fork from here')
      .map((button) => button.getAttribute('aria-label'))
  const loadEarlier = (): HTMLButtonElement | undefined =>
    [...pane.container.querySelectorAll('button')].find((button) => button.textContent?.startsWith('Load earlier'))

  // Only the page: its prompt is the branch's third, and the thread is titled by its first.
  await eventually(() => expect(pane.container.textContent).toContain('THIRD-REPLY'))
  expect(pane.container.textContent).not.toContain('SECOND-REPLY')
  expect(forkNames()).toEqual(['Fork from here, prompt 3: “third ask”'])
  expect(railTitle(threadId)).toBe('first ask')
  expect(loadEarlier()?.textContent).toBe('Load earlier · 4 earlier messages')

  await flush(async () => {
    loadEarlier()?.click()
    await tick()
  })
  const all = ['FIRST-REPLY', 'SECOND-REPLY', 'THIRD-REPLY']
  await eventually(() => expect(readingOrder(pane, all)).toEqual(all))
  expect(forkNames()).toEqual([
    'Fork from here, prompt 1: “first ask”',
    'Fork from here, prompt 2: “second ask”',
    'Fork from here, prompt 3: “third ask”',
  ])
  // The branch is whole on the page now: nothing earlier to offer.
  expect(loadEarlier()).toBeUndefined()
  await pane.unmount()
})

test('a streamed chunk redraws its own message and no other: the earlier bubbles see no DOM change (#739)', async () => {
  const threadId = crypto.randomUUID()
  const pane = await mountPane({
    history: storedHistory(threadId, [
      text('s-u1', 'user', 'first ask'),
      text('s-a1', 'assistant', 'FIRST-REPLY'),
      text('s-u2', 'user', 'second ask'),
      text('s-a2', 'assistant', 'SECOND-REPLY'),
    ]),
  })
  await pane.settle({ ...SNAPSHOT_IDLE, threadId, messageCount: 4 })
  await sendPrompt(pane, 'third ask')
  await pane.settle(
    { type: 'observation', seq: 1, observation: { kind: 'message-start', role: 'assistant' } },
    { type: 'observation', seq: 2, observation: { kind: 'text-delta', contentIndex: 0, delta: 'STREAM' } },
  )
  await eventually(() => expect(assistantBubbles(pane).at(-1)).toContain('STREAM'))
  const earlierBubbles = [...pane.container.querySelectorAll('[data-role]')].filter((bubble) =>
    /first ask|FIRST-REPLY|second ask|SECOND-REPLY/.test(bubble.textContent ?? ''),
  )
  expect(earlierBubbles).toHaveLength(4)
  const changed: Node[] = []
  const observer = new MutationObserver((records) => {
    for (const record of records) changed.push(record.target)
  })
  observer.observe(pane.container, { subtree: true, childList: true, characterData: true, attributes: true })
  await pane.settle(
    { type: 'observation', seq: 3, observation: { kind: 'text-delta', contentIndex: 0, delta: '-ING' } },
    { type: 'observation', seq: 4, observation: { kind: 'text-delta', contentIndex: 0, delta: '-ON' } },
  )
  await eventually(() => expect(assistantBubbles(pane).at(-1)).toContain('STREAM-ING-ON'))
  observer.disconnect()
  expect(changed.length).toBeGreaterThan(0)
  expect(changed.filter((target) => earlierBubbles.some((bubble) => bubble.contains(target)))).toEqual([])
  await pane.unmount()
})

// ── #382: a run line reads where it happened, not after the whole transcript ─────────────────

/** Send `text` from the composer, as a person would. */
async function sendPrompt(pane: MountedPane, text: string): Promise<void> {
  await flush(async () => {
    typeInto(pane.composer(), text)
    pressEnter(pane.composer())
    await tick()
  })
}

/** A provider's refusal of the current attempt (#340), its words carrying `marker`. */
function refusedFrame(seq: number, status: number, marker: string): EnsoFollowFrame {
  return {
    type: 'observation',
    seq,
    observation: {
      kind: 'provider-refused',
      provider: 'anthropic',
      providerName: 'Anthropic',
      model: 'claude-sonnet-4-5',
      status,
      message: `${status} {"type":"error","error":{"type":"rate_limit_error","message":"${marker}"}}`,
    },
  }
}

/** Where each of `needles` first appears in the pane's text, as the reader meets them. */
function readingOrder(pane: MountedPane, needles: readonly string[]): string[] {
  const text = pane.container.textContent ?? ''
  for (const needle of needles) expect(text).toContain(needle)
  return needles.toSorted((left, right) => text.indexOf(left) - text.indexOf(right))
}

const assistantBubbles = (pane: MountedPane): string[] =>
  [...pane.container.querySelectorAll('[data-role="assistant"]')].map((bubble) => bubble.textContent ?? '')

test('⚠ refused → retry → reply reads in order, and stays in order under a later turn; the refused attempt draws no empty bubble (#382)', async () => {
  const pane = await mountPane()
  await pane.settle(SNAPSHOT_IDLE)
  await sendPrompt(pane, 'first prompt')
  await pane.settle(
    { type: 'observation', seq: 1, observation: { kind: 'message-start', role: 'assistant' } },
    refusedFrame(2, 429, 'RATE-LIMITED'),
    { type: 'observation', seq: 3, observation: { kind: 'provider-retry', attempt: 1, maxAttempts: 2, delayMs: 4000 } },
    { type: 'observation', seq: 4, observation: { kind: 'message-start', role: 'assistant' } },
    { type: 'observation', seq: 5, observation: { kind: 'text-delta', contentIndex: 0, delta: 'FIRST-REPLY' } },
    { type: 'observation', seq: 6, observation: { kind: 'provider-retry-ended', success: true, attempt: 1 } },
    { type: 'observation', seq: 7, observation: { kind: 'settled', aborted: false } },
    { type: 'status', live: true, busy: false, generation: 1 },
  )
  const firstRun = ['first prompt', 'RATE-LIMITED', 'retrying in 4 s', 'FIRST-REPLY']
  await eventually(() => expect(readingOrder(pane, firstRun)).toEqual(firstRun))
  await sendPrompt(pane, 'second prompt')
  await pane.settle(
    { type: 'observation', seq: 8, observation: { kind: 'message-start', role: 'assistant' } },
    { type: 'observation', seq: 9, observation: { kind: 'text-delta', contentIndex: 0, delta: 'SECOND-REPLY' } },
    { type: 'observation', seq: 10, observation: { kind: 'settled', aborted: false } },
    { type: 'status', live: true, busy: false, generation: 2 },
  )
  const bothRuns = [...firstRun, 'second prompt', 'SECOND-REPLY']
  await eventually(() => expect(readingOrder(pane, bothRuns)).toEqual(bothRuns))
  // The attempt refused before any token is no bubble of its own, and the reply speaks as pi.
  expect(assistantBubbles(pane)).toEqual(['piFIRST-REPLY', 'piSECOND-REPLY'])
  await pane.unmount()
})

// The retry's own refusal arrives in the same batch as the retry's message: the page has not
// rendered that message yet, and a line placed by the rendered transcript lands one bubble early.
test('⚠ a mid-stream refusal keeps its partial text; the retry’s refusal and `no reply after …` follow the retry, not the first attempt (#382)', async () => {
  const pane = await mountPane()
  await pane.settle(SNAPSHOT_IDLE)
  await sendPrompt(pane, 'first prompt')
  await pane.settle(
    { type: 'observation', seq: 1, observation: { kind: 'message-start', role: 'assistant' } },
    { type: 'observation', seq: 2, observation: { kind: 'text-delta', contentIndex: 0, delta: 'FIRST-PARTIAL' } },
    refusedFrame(3, 529, 'OVERLOADED-ONE'),
    { type: 'observation', seq: 4, observation: { kind: 'provider-retry', attempt: 1, maxAttempts: 1, delayMs: 2000 } },
    { type: 'observation', seq: 5, observation: { kind: 'message-start', role: 'assistant' } },
    { type: 'observation', seq: 6, observation: { kind: 'text-delta', contentIndex: 0, delta: 'RETRY-PARTIAL' } },
    refusedFrame(7, 529, 'OVERLOADED-TWO'),
    {
      type: 'observation',
      seq: 8,
      observation: { kind: 'provider-retry-ended', success: false, attempt: 1, finalError: '529 overloaded' },
    },
    { type: 'observation', seq: 9, observation: { kind: 'settled', aborted: false } },
    { type: 'status', live: true, busy: false, generation: 1 },
  )
  await sendPrompt(pane, 'second prompt')
  await pane.settle(
    { type: 'observation', seq: 10, observation: { kind: 'message-start', role: 'assistant' } },
    { type: 'observation', seq: 11, observation: { kind: 'text-delta', contentIndex: 0, delta: 'SECOND-REPLY' } },
    { type: 'observation', seq: 12, observation: { kind: 'settled', aborted: false } },
    { type: 'status', live: true, busy: false, generation: 2 },
  )
  const expected = [
    'first prompt',
    'FIRST-PARTIAL',
    'OVERLOADED-ONE',
    'retrying in 2 s',
    'RETRY-PARTIAL',
    'OVERLOADED-TWO',
    'no reply after 1 retry',
    'second prompt',
    'SECOND-REPLY',
  ]
  await eventually(() => expect(readingOrder(pane, expected)).toEqual(expected))
  // Each attempt's partial text in its own bubble: the reply that never came is not glued to the first.
  expect(assistantBubbles(pane)).toEqual(['piFIRST-PARTIAL', 'RETRY-PARTIAL', 'piSECOND-REPLY'])
  await pane.unmount()
})

test('a `Mode:` line set between runs reads after the run before it and before the next prompt (#382)', async () => {
  const pane = await mountPane()
  await pane.settle(SNAPSHOT_IDLE)
  await sendPrompt(pane, 'first prompt')
  await pane.settle(
    { type: 'observation', seq: 1, observation: { kind: 'message-start', role: 'assistant' } },
    { type: 'observation', seq: 2, observation: { kind: 'text-delta', contentIndex: 0, delta: 'FIRST-REPLY' } },
    { type: 'observation', seq: 3, observation: { kind: 'settled', aborted: false } },
    { type: 'status', live: true, busy: false, generation: 1 },
  )
  await pane.settle({
    type: 'observation',
    seq: 4,
    observation: { kind: 'permission-mode', mode: 'plan', available: ['default', 'plan'] },
  })
  await sendPrompt(pane, 'second prompt')
  await pane.settle(
    { type: 'observation', seq: 5, observation: { kind: 'message-start', role: 'assistant' } },
    { type: 'observation', seq: 6, observation: { kind: 'text-delta', contentIndex: 0, delta: 'SECOND-REPLY' } },
    { type: 'observation', seq: 7, observation: { kind: 'settled', aborted: false } },
    { type: 'status', live: true, busy: false, generation: 2 },
  )
  const expected = ['first prompt', 'FIRST-REPLY', 'Mode: plan', 'second prompt', 'SECOND-REPLY']
  await eventually(() => expect(readingOrder(pane, expected)).toEqual(expected))
  await pane.unmount()
})

// ── #588: an incident card reads after the message holding its tipping call ────────────────────

/** An opening whose tipping call — its last signal's — is `toolCallId`. */
const openingAt = (incidentId: string, toolCallId: string, halted: boolean): EnsoIncidentOpened => ({
  incidentId,
  signals: [{ signal: 'alternate-execution-path', toolCallId, detail: 'a second route after a refusal', after: [] }],
  halted,
  suspended: halted ? ['execute', 'network', 'write'] : [],
})

/** A stored assistant message saying `words`, then making call `toolCallId` and holding its result. */
const calling = (id: string, words: string, toolCallId: string): UIMessage => ({
  id,
  role: 'assistant',
  parts: [
    { type: 'text', content: words },
    { type: 'tool-call', id: toolCallId, name: 'bash', arguments: '{}', state: 'input-complete' },
    { type: 'tool-result', toolCallId, content: 'ok', state: 'complete' },
  ],
})

/** The incidents as the snapshot folds them (a reload): `records` in order, resolved or not. */
const foldedIncidents = (records: readonly EnsoIncidentRecord[]): EnsoSessionIncidents => ({
  incidents: [...records],
  suspended: records.at(-1)?.resolutions.length === 0 ? (records.at(-1)?.opened.suspended ?? []) : [],
  ended: false,
})

/** A stored thread whose snapshot carries `incidents`, as a reload reads it. */
async function mountStored(
  messages: UIMessage[],
  incidents: EnsoSessionIncidents,
  extra: { earlier?: EnsoThreadHistory['earlier']; server?: ScriptedFetchOptions } = {},
): Promise<MountedPane> {
  const threadId = crypto.randomUUID()
  const pane = await mountPane({
    history: {
      ...storedHistory(threadId, messages),
      incidents,
      ...(extra.earlier === undefined ? {} : { earlier: extra.earlier }),
    },
    ...(extra.server === undefined ? {} : { server: extra.server }),
  })
  const count = messages.length + (extra.earlier?.messages ?? 0)
  await pane.settle({ ...SNAPSHOT_IDLE, threadId, messageCount: count, incidents })
  return pane
}

test('⚠ an incident card reads after the message holding its tipping call, and stays there under a later turn (#588)', async () => {
  const pane = await mountPane()
  await pane.settle(SNAPSHOT_IDLE)
  await sendPrompt(pane, 'first prompt')
  await pane.settle(
    { type: 'observation', seq: 1, observation: { kind: 'message-start', role: 'assistant' } },
    { type: 'observation', seq: 2, observation: { kind: 'text-delta', contentIndex: 0, delta: 'CALLING-REPLY' } },
    {
      type: 'observation',
      seq: 3,
      observation: { kind: 'tool-call', toolCallId: 'c1', toolName: 'bash', args: { command: 'ls' } },
    },
    {
      type: 'observation',
      seq: 4,
      observation: {
        kind: 'custom-entry',
        customType: ENSO_INCIDENT_OPENED_ENTRY,
        data: openingAt('inc-live', 'c1', false),
      },
    },
    {
      type: 'observation',
      seq: 5,
      observation: {
        kind: 'tool-result',
        toolCallId: 'c1',
        toolName: 'bash',
        text: 'a.ts',
        complete: true,
        isError: false,
      },
    },
    { type: 'observation', seq: 6, observation: { kind: 'message-start', role: 'assistant' } },
    { type: 'observation', seq: 7, observation: { kind: 'text-delta', contentIndex: 0, delta: 'WRAP-UP' } },
    { type: 'observation', seq: 8, observation: { kind: 'settled', aborted: false } },
    { type: 'status', live: true, busy: false, generation: 1 },
  )
  // Live, one bubble holds the whole run (every turn of it), so the card follows the run's reply.
  const firstRun = ['first prompt', 'CALLING-REPLY', 'WRAP-UP', 'Incident inc-live']
  await eventually(() => expect(readingOrder(pane, firstRun)).toEqual(firstRun))
  await sendPrompt(pane, 'second prompt')
  await pane.settle(
    { type: 'observation', seq: 9, observation: { kind: 'message-start', role: 'assistant' } },
    { type: 'observation', seq: 10, observation: { kind: 'text-delta', contentIndex: 0, delta: 'SECOND-REPLY' } },
    { type: 'observation', seq: 11, observation: { kind: 'settled', aborted: false } },
    { type: 'status', live: true, busy: false, generation: 2 },
  )
  const bothRuns = [...firstRun, 'second prompt', 'SECOND-REPLY']
  await eventually(() => expect(readingOrder(pane, bothRuns)).toEqual(bothRuns))
  await pane.unmount()
})

test('after a reload, the snapshot’s incidents read where they did live — no message id is stored for them (#588)', async () => {
  const resolved: EnsoIncidentRecord = {
    opened: openingAt('inc-stored', 'c1', true),
    resolutions: [{ incidentId: 'inc-stored', classification: 'false-positive', outcome: 'resume', suspended: [] }],
  }
  const pane = await mountStored(
    [
      text('r-u1', 'user', 'first prompt'),
      calling('r-a1', 'CALLING-REPLY', 'c1'),
      text('r-a2', 'assistant', 'WRAP-UP'),
      text('r-u2', 'user', 'second prompt'),
      text('r-a3', 'assistant', 'SECOND-REPLY'),
    ],
    foldedIncidents([resolved]),
  )
  const expected = ['first prompt', 'CALLING-REPLY', 'Incident inc-stored', 'WRAP-UP', 'second prompt', 'SECOND-REPLY']
  await eventually(() => expect(readingOrder(pane, expected)).toEqual(expected))
  // Resolved: no pointer at the tail.
  expect(pane.container.querySelector('[data-incident-pointer]')).toBeNull()
  await pane.unmount()
})

// PR #794 review: two incidents whose tipping calls are in the SAME message both follow it, in the
// order they opened, and neither moves to the tail or past the next message.
test('two incidents tipped by calls in one message both read after it, in the order they opened (#588)', async () => {
  const twoCalls: UIMessage = {
    id: 'm-a1',
    role: 'assistant',
    parts: [
      { type: 'text', content: 'CALLING-TWICE' },
      { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}', state: 'input-complete' },
      { type: 'tool-result', toolCallId: 'c1', content: 'ok', state: 'complete' },
      { type: 'tool-call', id: 'c2', name: 'bash', arguments: '{}', state: 'input-complete' },
      { type: 'tool-result', toolCallId: 'c2', content: 'ok', state: 'complete' },
    ],
  }
  const resolvedAt = (incidentId: string, toolCallId: string): EnsoIncidentRecord => ({
    opened: openingAt(incidentId, toolCallId, false),
    resolutions: [{ incidentId, classification: 'false-positive', outcome: 'resume', suspended: [] }],
  })
  const pane = await mountStored(
    [text('m-u1', 'user', 'first prompt'), twoCalls, text('m-u2', 'user', 'second prompt')],
    foldedIncidents([resolvedAt('inc-one', 'c1'), resolvedAt('inc-two', 'c2')]),
  )
  const expected = ['first prompt', 'CALLING-TWICE', 'Incident inc-one', 'Incident inc-two', 'second prompt']
  await eventually(() => expect(readingOrder(pane, expected)).toEqual(expected))
  await pane.unmount()
})

test('a card whose tipping call the transcript does not hold reads at the tail; one on a page not loaded yet moves up when it loads (#588)', async () => {
  const earlier = [text('p-u1', 'user', 'first prompt'), calling('p-a1', 'CALLING-REPLY', 'c1')]
  const page = [text('p-u2', 'user', 'second prompt'), text('p-a2', 'assistant', 'SECOND-REPLY')]
  const records: EnsoIncidentRecord[] = [
    {
      opened: openingAt('inc-paged', 'c1', false),
      resolutions: [{ incidentId: 'inc-paged', classification: 'agent-error', outcome: 'resume', suspended: [] }],
    },
    // Its tipping call was compacted away: no message holds it.
    { opened: openingAt('inc-gone', 'compacted-call', false), resolutions: [] },
  ]
  const pane = await mountStored(page, foldedIncidents(records), {
    earlier: { messages: earlier.length, prompts: 1, firstPrompt: earlier[0] },
    server: { earlierHistories: { 'p-u2': storedHistory('paged', earlier) } },
  })
  // Both at the tail while the call's page is not loaded.
  const tail = ['second prompt', 'SECOND-REPLY', 'Incident inc-paged', 'Incident inc-gone']
  await eventually(() => expect(readingOrder(pane, tail)).toEqual(tail))
  const loadEarlier = [...pane.container.querySelectorAll('button')].find((button) =>
    button.textContent?.startsWith('Load earlier'),
  )
  await flush(async () => {
    loadEarlier?.click()
    await tick()
  })
  const loaded = [
    'first prompt',
    'CALLING-REPLY',
    'Incident inc-paged',
    'second prompt',
    'SECOND-REPLY',
    'Incident inc-gone',
  ]
  await eventually(() => expect(readingOrder(pane, loaded)).toEqual(loaded))
  await pane.unmount()
})

test('⚠ a halted thread’s open incident keeps a pointer at the tail that reveals its card above; resolved, the pointer goes (#588)', async () => {
  const pane = await mountStored(
    [
      text('h-u1', 'user', 'first prompt'),
      calling('h-a1', 'CALLING-REPLY', 'c1'),
      text('h-a2', 'assistant', 'REPORT-TURN'),
    ],
    foldedIncidents([{ opened: openingAt('inc-halted', 'c1', true), resolutions: [] }]),
  )
  const pointerWords = 'is open and halted this thread'
  const expected = ['CALLING-REPLY', 'Incident inc-halted', 'REPORT-TURN', pointerWords]
  await eventually(() => expect(readingOrder(pane, expected)).toEqual(expected))
  const card = pane.container.querySelector('[data-incident-id="inc-halted"]')
  const show = [...pane.container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Show the incident',
  )
  const scrolled: Element[] = []
  const scroll = spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function record(this: Element): void {
    scrolled.push(this)
  })
  try {
    await flush(async () => {
      show?.click()
      await tick()
    })
    expect(card).not.toBeNull()
    expect(scrolled).toEqual([card as Element])
  } finally {
    scroll.mockRestore()
  }
  await pane.settle({
    type: 'observation',
    seq: 1,
    observation: {
      kind: 'custom-entry',
      customType: ENSO_INCIDENT_RESOLVED_ENTRY,
      data: { incidentId: 'inc-halted', classification: 'false-positive', outcome: 'resume', suspended: [] },
    },
  })
  await eventually(() => expect(pane.container.textContent).not.toContain(pointerWords))
  // The card itself stays where it reads.
  const resolved = ['CALLING-REPLY', 'Incident inc-halted', 'REPORT-TURN']
  expect(readingOrder(pane, resolved)).toEqual(resolved)
  await pane.unmount()
})

// ── #125 item 3: runtime truth vs browser belief, through the mounted debug pane (#86) ──

test("⚠ the debug pane names a MISMATCH between the page's mode and the server's, and drops it once they agree", async () => {
  const pane = await mountPane({
    debugOpen: true,
    server: {
      inspection: {
        cwd: '/repo',
        sessionDir: '/agent/sessions/--repo--',
        sessionFile: null,
        permissionMode: { mode: 'plan', available: ['default', 'plan'] },
        commands: ['default', 'plan'],
        busy: false,
        generation: 3,
        lastActivityAt: new Date().toISOString(),
        // The branch agrees with the host (its `active_agent` entry says plan): the one disagreement is the page's.
        entries: [{ kind: 'custom', id: 'm1', customType: 'active_agent', data: { name: 'enso-mode-plan' } }],
      },
    },
  })
  // The snapshot says default; the server's inspection says plan. The pane must say so — once.
  await pane.settle({ ...SNAPSHOT_IDLE, generation: 3 })
  const debug = pane.container.querySelector('[aria-label="session debug"]') ?? pane.container
  const mismatches = (): number => (debug.textContent?.match(/MISMATCH/g) ?? []).length
  // A row of the pane's label/value grid: the value beside its label.
  const row = (label: string): string | null | undefined =>
    [...debug.querySelectorAll('dt')].find((term) => term.textContent === label)?.nextElementSibling?.textContent
  await eventually(() => {
    expect(row('host mode')).toBe('plan')
    expect(debug.textContent).toContain('MISMATCH: host says plan')
    // Exactly one: generations agree (both 3) and the branch agrees with the host.
    expect(mismatches()).toBe(1)
  })
  // The host's mode observation brings the page's store to plan — the same value the host already
  // reports — so the MISMATCH goes with no refetch: a `permission-mode` chunk is deliberately NOT a refetch trigger.
  await pane.settle({
    type: 'observation',
    seq: 1,
    observation: { kind: 'permission-mode', mode: 'plan', available: ['default', 'plan'] },
  })
  await eventually(() => {
    expect(pane.chip('Mode').getAttribute('aria-label')).toBe('Mode: plan')
    expect(row('host mode')).toBe('plan')
    expect(mismatches()).toBe(0)
  })
  await pane.unmount()
})

// ── #125 item 2: two threads, one page, nothing crosses ─────────────────────────────────

test("⚠ a frame on one thread's follow changes that pane and no other — cost, activity, dialog", async () => {
  const alpha = await mountPane({ active: true })
  const bravo = await mountPane({ active: false })
  await alpha.settle({ ...SNAPSHOT_IDLE, live: true, busy: true, generation: 1 })
  await alpha.settle({
    type: 'observation',
    seq: 1,
    observation: {
      kind: 'session-usage',
      cost: 0.0123,
      input: 1000,
      output: 100,
      cacheRead: 0,
      cacheWrite: 0,
      context: null,
    },
  })
  await alpha.settle({
    type: 'observation',
    seq: 2,
    observation: {
      kind: 'extension-ui-request',
      id: 'd9',
      method: 'confirm',
      blocking: true,
      origin: 'run',
      dialog: { method: 'confirm', title: 'Only alpha asks', message: 'm' },
    },
  })
  await eventually(() => {
    expect(alpha.status()).toContain('working')
    expect(alpha.status()).toContain('$0.0123')
    expect(alpha.container.textContent).toContain('Only alpha asks')
    expect(bravo.status()).toContain('idle')
    expect(bravo.status()).toContain('$—')
    expect(bravo.container.textContent).not.toContain('Only alpha asks')
    expect(railBusy(bravo.stores.threadId)).toBe(false)
  })
  await alpha.unmount()
  await bravo.unmount()
})

// #453: the status bar reads git in the thread's cwd on mount, and again when a tool result
// settles — the moment an edit, a write or a `git commit` lands — so the readout follows the tree.
// The prompt is another tab's (no composer here): since #739 the re-reads are paced, and a run
// started on this page opens the window the result would then wait out — `thread-status-pace.test.tsx`.
test('the status bar reads git on mount and again when a tool result settles (#453)', async () => {
  let reads = 0
  let unstaged = 0
  const pane = await mountPane({
    server: {
      git: () => {
        reads += 1
        return {
          kind: 'repository',
          root: '/scripted/launch',
          scope: '',
          head: 'f00d',
          branch: 'main',
          upstream: 'origin/main',
          baseline: { rule: 'upstream', ref: 'origin/main', commit: 'f00d' },
          ahead: 0,
          behind: 0,
          changes: { staged: 0, unstaged, untracked: 0, conflicted: 0 },
          operation: null,
        }
      },
    },
  })
  // A thread with a session (#620): a new one with none asks for nothing.
  await pane.settle(SNAPSHOT_LIVE)
  await eventually(() => expect(pane.status()).toContain('main· clean'))
  const beforeRun = reads
  unstaged = 1
  await pane.settle(
    { type: 'observation', seq: 1, observation: { kind: 'message-start', role: 'assistant' } },
    {
      type: 'observation',
      seq: 2,
      observation: { kind: 'tool-call', toolCallId: 'c1', toolName: 'edit', args: { path: 'a.ts' } },
    },
    {
      type: 'observation',
      seq: 3,
      observation: {
        kind: 'tool-result',
        toolCallId: 'c1',
        toolName: 'edit',
        text: 'ok',
        complete: true,
        isError: false,
      },
    },
  )
  await eventually(() => expect(pane.status()).toContain('· 1 unstaged'))
  expect(reads).toBeGreaterThan(beforeRun)
  await pane.unmount()
})

// #452: the Diff view — the tree of every file that differs from the last push, the chosen
// file's diff side by side, a directory folded away, and a read again when a tool result settles.
test('the Diff view lists the tree, shows the chosen file, folds a directory, and reads again on a settled call (#452)', async () => {
  const repository: EnsoGitRepository = {
    kind: 'repository',
    root: '/scripted/launch',
    scope: '',
    head: 'f00d',
    branch: 'main',
    upstream: 'origin/main',
    baseline: { rule: 'upstream', ref: 'origin/main', commit: 'f00d' },
    ahead: 0,
    behind: 0,
    changes: { staged: 0, unstaged: 2, untracked: 0, conflicted: 0 },
    operation: null,
  }
  const edit = (path: string, before: string, after: string): EnsoGitFileChange => ({
    path,
    oldPath: null,
    status: 'modified',
    added: 1,
    removed: 1,
    patch: [`diff --git a/${path} b/${path}`, '@@ -1 +1 @@', `-${before}`, `+${after}`, ''].join('\n'),
    omitted: null,
  })
  let files = [edit('src/a.ts', 'alpha-old', 'alpha-new'), edit('src/b.ts', 'beta-old', 'beta-new')]
  const pane = await mountPane({
    view: 'changes',
    server: { changes: () => ({ git: repository, files, truncated: false, copy: null }) },
  })
  await pane.settle(SNAPSHOT_IDLE)
  const panel = (): HTMLElement => {
    const found = pane.container.querySelector<HTMLElement>('#thread-view-changes')
    if (found === null) throw new Error('expected the Diff panel')
    return found
  }
  const fileButton = (name: string): HTMLButtonElement => {
    const found = [...panel().querySelectorAll<HTMLButtonElement>('nav button')].find((button) =>
      button.textContent?.includes(name),
    )
    if (found === undefined) throw new Error(`expected ${name} in the tree`)
    return found
  }
  await eventually(() => expect(panel().textContent).toContain('alpha-new'))
  expect(panel().textContent).not.toContain('beta-new')
  await flush(async () => fileButton('b.ts').click())
  await eventually(() => expect(panel().textContent).toContain('beta-new'))
  expect(fileButton('b.ts').getAttribute('aria-current')).toBe('true')

  // Folding `src/` hides its files; the diff on screen stays.
  const folder = fileButton('src')
  expect(folder.getAttribute('aria-expanded')).toBe('true')
  await flush(async () => folder.click())
  expect(folder.getAttribute('aria-expanded')).toBe('false')
  expect(panel().querySelector('nav')?.textContent).not.toContain('a.ts')
  await flush(async () => folder.click())

  // A tool result settles: the view reads again, and the chosen file stays chosen.
  files = [...files, edit('src/c.ts', 'gamma-old', 'gamma-new')]
  await flush(async () => {
    typeInto(pane.composer(), 'edit c')
    pressEnter(pane.composer())
    await tick()
  })
  await pane.settle(
    { type: 'observation', seq: 1, observation: { kind: 'message-start', role: 'assistant' } },
    { type: 'observation', seq: 2, observation: { kind: 'tool-call', toolCallId: 'c1', toolName: 'edit', args: {} } },
    {
      type: 'observation',
      seq: 3,
      observation: {
        kind: 'tool-result',
        toolCallId: 'c1',
        toolName: 'edit',
        text: 'ok',
        complete: true,
        isError: false,
      },
    },
  )
  await eventually(() => expect(panel().querySelector('nav')?.textContent).toContain('c.ts'))
  expect(panel().textContent).toContain('beta-new')
  await pane.unmount()
})

// PR #358 review: every live pane stays mounted off screen, so the stats view — its panel
// `id`, its fetches, its `stores.usage` subscription — must exist only in the pane on screen
// (the debug column's rule, PR #94), and be back when the thread is shown again.
test('⚠ the stats view exists only while its pane is shown, and is back when the pane is', async () => {
  const pane = await mountPane({ active: true, view: 'stats' })
  const views = (): number => pane.container.querySelectorAll('#thread-view-stats').length
  await eventually(() => expect(views()).toBe(1))
  await pane.setActive(false)
  expect(views()).toBe(0)
  // An off-screen pane still draws its transcript, but names no panel: the ids are the shown pane's.
  expect(pane.container.querySelectorAll('[id^="thread-view-"]')).toHaveLength(0)
  await pane.setActive(true)
  expect(views()).toBe(1)
  await pane.unmount()
})

const NO_DURATIONS = { count: 0, minMs: 0, maxMs: 0, meanMs: 0, totalMs: 0 }

/** Two calls: `c1`, which the transcript below draws, and `c-gone`, which it does not. */
const TWO_CALL_STATS: Omit<EnsoThreadStats, 'threadId'> = {
  live: true,
  usage: { cost: 0.01, input: 10, output: 10, cacheRead: 0, cacheWrite: 0, context: null },
  branchCost: 0.01,
  turnStats: [],
  promptStats: [],
  callStats: [
    {
      toolCallId: 'c1',
      toolName: 'bash',
      turn: 1,
      prompt: 1,
      inputChars: 50,
      outputChars: 0,
      isError: false,
      pending: true,
    },
    {
      toolCallId: 'c-gone',
      toolName: 'read',
      turn: 1,
      prompt: 1,
      inputChars: 10,
      outputChars: 0,
      isError: false,
      pending: false,
    },
  ],
  latency: { prompts: NO_DURATIONS, firstDelta: NO_DURATIONS },
  logDays: [],
}

// ⚠ PR #661 review: a resync nulls the model when the session idles out, and a thread minted on this
// page has no stored history — readability keyed on those two read a thread that ran as never run.
test('⚠ Stats keeps reading a thread that ran after its session idles out and the model is gone (#659)', async () => {
  const pane = await mountPane({ view: 'stats', server: { stats: TWO_CALL_STATS } })
  const panel = (): string => pane.container.querySelector('#thread-view-stats')?.textContent ?? ''
  await pane.settle(SNAPSHOT_LIVE)
  await eventually(() => expect(panel()).toContain('Session analysis'))
  // The session idles out: the resync says no model, and this page-minted thread has no stored history.
  await pane.settle(SNAPSHOT_IDLE)
  await flush(tick)
  expect(panel()).toContain('Session analysis')
  // The stats' own line: this scripted server serves no `/eval`, whose 404 says nothing has run on its own.
  expect(panel()).not.toContain('no stats')
  await pane.unmount()
})

// ⚠ #707, from an arena run: the composer was drawn inside the chat's panel, which goes invisible and
// inert under every other view, so a prompt typed on Diff (checking a round's changes) went nowhere,
// silently. It is under every view now: there, it sends, and the page is asked for the chat, where
// the run, its questions and its reply are — for a typed `/command` pi runs as a prompt too (PR #716
// review: that path skipped the switch, and its run would have started behind the view).
test('⚠ on Context, Stats and Diff the composer is there: a prompt or a typed /command sent there asks for Chat (#707)', async () => {
  for (const view of ['context', 'stats', 'changes'] as const) {
    for (const typed of [`asked from ${view}`, '/not-a-host-command']) {
      const pane = await mountPane({ view, server: { stats: TWO_CALL_STATS } })
      await pane.settle(SNAPSHOT_LIVE)
      const composer = pane.composer()
      // Not inside anything a view hides: a person and an accessibility read both reach it.
      expect(composer.closest('[inert], .invisible')).toBeNull()
      await flush(async () => {
        typeInto(composer, typed)
        pressEnter(composer)
        await tick()
      })
      await eventually(() => expect(pane.server.prompts.map((prompt) => prompt.message)).toEqual([typed]))
      expect(pane.requestedViews).toEqual(['chat'])
      await eventually(() => expect(pane.composer().value).toBe(''))
      await pane.unmount()
    }
  }
})

// #359, #361: a stats row is a way into THIS pane's transcript — through the bridge inside
// `<Conversation>`, the layout's reveal, and the step row's `data-tool-call-id`. The transcript
// is under the Stats view, still mounted: the row finds its call there, asks the page for the
// Chat view, and scrolls once shown. A target the transcript does not draw is said, and the
// view stays where it is.
test('⚠ a costliest-calls row opens Chat at its call; a call not drawn there is said and Stats stays (#359, #361)', async () => {
  const scrolled: Element[] = []
  const scroll = spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function record(this: Element): void {
    scrolled.push(this)
  })
  try {
    const pane = await mountPane({ view: 'stats', server: { stats: TWO_CALL_STATS } })
    // A thread that runs is live: its snapshot says its model (#659: no read before that).
    await pane.settle(SNAPSHOT_LIVE)
    await flush(async () => {
      typeInto(pane.composer(), 'run it')
      pressEnter(pane.composer())
      await tick()
    })
    await pane.settle(
      { type: 'observation', seq: 1, observation: { kind: 'message-start', role: 'assistant' } },
      { type: 'observation', seq: 2, observation: { kind: 'tool-call', toolCallId: 'c1', toolName: 'bash', args: {} } },
    )
    const rows = await eventually(() => {
      const found = [...pane.container.querySelectorAll<HTMLButtonElement>('#thread-view-stats li button')]
      expect(found).toHaveLength(2)
      return found
    })
    // The prompt that made it run was sent from Stats, which asks for Chat (#707); the rows' own asks follow.
    expect(pane.requestedViews).toEqual(['chat'])
    await flush(async () => rows[1]?.click())
    await eventually(() => expect(pane.container.textContent).toContain('that call is not in the transcript on screen'))
    expect(pane.requestedViews).toEqual(['chat'])
    await flush(async () => rows[0]?.click())
    expect(pane.requestedViews).toEqual(['chat', 'chat'])
    await eventually(() =>
      expect(scrolled).toEqual([pane.container.querySelector('[data-tool-call-id="c1"]') as Element]),
    )
    await pane.unmount()
  } finally {
    scroll.mockRestore()
  }
})

/** A branch whose replay raises two signals: `denial-retry` on c2, `alternate-execution-path` on c3. */
const RISKY_BRANCH: EnsoTranscriptEntry[] = [
  ['c1', 'curl https://example.test'],
  ['c2', 'wget https://example.test'],
  ['c3', 'python3 -c "import urllib"'],
].flatMap(([toolCallId = '', command]): EnsoTranscriptEntry[] => [
  {
    kind: 'message',
    id: `m-${toolCallId}`,
    role: 'assistant',
    parts: [{ type: 'tool-call', toolCallId, toolName: 'bash', args: { command } }],
  },
  ...(toolCallId === 'c3'
    ? []
    : [
        {
          kind: 'custom',
          id: `d-${toolCallId}`,
          customType: ENSO_GUARD_DENIAL_ENTRY,
          data: { toolCallId, rule: 'network-egress', via: 'command-position' },
        } as const,
      ]),
])

// #727, from an arena run: `risk high · 2 signals` was a span with a tooltip; a click opened
// nothing, and the Stats tab it named only counted the signals. It is a button now: it asks the
// page for Stats and the eval lands on the list, where each signal's call opens Chat at its row.
test('⚠ the risk word opens Stats at the security signals, and a signal’s call opens Chat at its row (#727)', async () => {
  const scrolled: Element[] = []
  const scroll = spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function record(this: Element): void {
    scrolled.push(this)
  })
  try {
    const evaluated = {
      live: true,
      ...sessionEvalOf({ transcript: RISKY_BRANCH, turnStats: [], log: [], logDays: [] }),
    }
    const pane = await mountPane({ server: { stats: TWO_CALL_STATS, eval: evaluated } })
    await pane.settle(SNAPSHOT_LIVE)
    await flush(async () => {
      typeInto(pane.composer(), 'run it')
      pressEnter(pane.composer())
      await tick()
    })
    await pane.settle(
      { type: 'observation', seq: 1, observation: { kind: 'message-start', role: 'assistant' } },
      { type: 'observation', seq: 2, observation: { kind: 'tool-call', toolCallId: 'c3', toolName: 'bash', args: {} } },
      {
        type: 'observation',
        seq: 3,
        observation: { kind: 'custom-entry', customType: ENSO_SESSION_RISK_ENTRY, data: { level: 'high', signals: 2 } },
      },
    )
    const riskWord = await eventually(() => {
      const found = pane.container.querySelector<HTMLButtonElement>('#thread-status button[aria-label^="risk high"]')
      expect(found?.getAttribute('aria-label')).toBe('risk high · 2 signals: show them on the Stats tab')
      return found as HTMLButtonElement
    })
    expect(riskWord.textContent).toBe('risk high · 2 signals')
    await flush(async () => riskWord.click())
    expect(pane.requestedViews.at(-1)).toBe('stats')
    expect(pane.stores.landOnRiskSignals.get()).toBe(true)
    // The page answers with Stats: the eval reads, and lands on the list, focus with it.
    await pane.setView('stats')
    const signals = await eventually(() => {
      const found = pane.container.querySelector<HTMLElement>(
        '#thread-view-stats section[aria-label="security signals"]',
      )
      expect(found?.textContent).toContain('alternate-execution-path')
      return found as HTMLElement
    })
    expect(signals.textContent).toContain('denial-retry')
    expect(scrolled).toEqual([signals])
    expect(document.activeElement).toBe(signals)
    expect(pane.stores.landOnRiskSignals.get()).toBe(false)
    // A signal's call, drawn in the transcript under Stats: Chat is asked for, and the row scrolled to.
    const callLink = (toolCallId: string): HTMLButtonElement => {
      const found = signals.querySelector<HTMLButtonElement>(
        `button[aria-label="show call ${toolCallId} in the transcript"]`,
      )
      if (found === null) throw new Error(`expected a link to ${toolCallId}`)
      return found
    }
    await flush(async () => callLink('c1').click())
    await eventually(() => expect(signals.textContent).toContain('that call is not in the transcript on screen'))
    expect(pane.requestedViews.at(-1)).toBe('stats')
    await flush(async () => callLink('c3').click())
    expect(pane.requestedViews.at(-1)).toBe('chat')
    await eventually(() =>
      expect(scrolled.at(-1)).toBe(pane.container.querySelector('[data-tool-call-id="c3"]') as Element),
    )
    await pane.unmount()
  } finally {
    scroll.mockRestore()
  }
})

// ── the page (#90): the rail, New thread, switching, earlier threads, resume (#95) ───────

interface MountedPage {
  readonly container: HTMLElement
  readonly server: ScriptedFetch
  readonly unmount: () => Promise<void>
  readonly activeRows: () => HTMLButtonElement[]
  readonly previousRows: () => HTMLButtonElement[]
  readonly click: (button: HTMLElement) => Promise<void>
  /** The pane on screen (not an `inert` one kept laid out under it, #370) — exactly one when any thread exists. */
  readonly visiblePanes: () => HTMLElement[]
}

async function mountPage(options: ScriptedFetchOptions = {}): Promise<MountedPage> {
  const server = createScriptedFetch(options)
  globalThis.fetch = server.fetch
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  await flush(async () => {
    root.render(<ChatScreen />)
  })
  await flush(tick)
  // The rail's two kinds of row, across every project's section and day (#395, #875): open on this
  // page, and earlier — each row names its thread, and the page's list says which are open here.
  const buttons = (list: 'open' | 'earlier'): HTMLButtonElement[] =>
    [...container.querySelectorAll<HTMLButtonElement>('#threads-rail button[data-thread-id]')].filter(
      (row) => threadListStore.get().some((thread) => thread.threadId === row.dataset.threadId) === (list === 'open'),
    )
  return {
    container,
    server,
    unmount: async () => {
      await flush(async () => root.unmount())
      container.remove()
    },
    activeRows: () => buttons('open'),
    previousRows: () => buttons('earlier'),
    click: async (button: HTMLElement) => {
      await flush(async () => {
        button.click()
        await tick()
      })
    },
    visiblePanes: () =>
      [...container.querySelectorAll<HTMLElement>('#thread-status')].filter((bar) => bar.closest('[inert]') === null),
  }
}

/**
 * The page with `prompts.length` stored threads, each opened from the rail in turn — the last one on
 * screen. Started threads, the server's: a draft's Context, Stats and Diff are disabled (#879). Each
 * thread's history is its prompt and a reply, `u-<index>` and `a-<index>`, unless `server` names one.
 */
async function mountStartedThreads(
  prompts: readonly string[],
  server: ScriptedFetchOptions = {},
): Promise<MountedPage> {
  const ids = prompts.map((_, index) => `stored-started-${index}`)
  const page = await mountPage({
    ...server,
    storedThreads: prompts.map((prompt, index) => ({
      threadId: ids[index] ?? '',
      projectId: 'p-launch',
      title: prompt,
      lastActivityAt: new Date(Date.now() - index * 60_000).toISOString(),
      messageCount: 2,
      busy: false,
      waiting: false,
    })),
    histories: {
      ...Object.fromEntries(
        prompts.map((prompt, index) => [
          ids[index] ?? '',
          storedHistory(ids[index] ?? '', [
            text(`u-${index}`, 'user', prompt),
            text(`a-${index}`, 'assistant', 'done'),
          ]),
        ]),
      ),
      ...server.histories,
    },
  })
  for (const [index, prompt] of prompts.entries()) {
    const row = await eventually(() => {
      const found = page.previousRows().find((stored) => stored.textContent?.includes(prompt))
      if (found === undefined) throw new Error(`expected the stored row ${prompt}`)
      return found
    })
    await page.click(row)
    await eventually(() => expect(new URLSearchParams(window.location.search).get('thread')).toBe(ids[index] ?? ''))
  }
  return page
}

// #361: Chat and Stats are the page's views, as tabs in the header. One choice for the page:
// the view shown is the ACTIVE thread's, and it follows a switch of thread.
test('the Stats tab replaces the transcript in the thread on screen, and follows a switch of thread', async () => {
  const page = await mountStartedThreads(['first ask', 'second ask'])
  const tab = (name: string): HTMLButtonElement => {
    const found = page.container.querySelector<HTMLButtonElement>(`header [role="tab"]#thread-view-${name}-tab`)
    if (found === null) throw new Error(`expected the ${name} tab in the header`)
    return found
  }
  // Radix activates a tab on mousedown, as a pointer does; a bare click event would not.
  const choose = async (name: string): Promise<void> => {
    await flush(async () => {
      tab(name).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
      await tick()
    })
  }
  expect(tab('chat').getAttribute('aria-selected')).toBe('true')
  // Shown: in the pane on screen, and not the transcript kept laid out but `inert` under another view.
  const shown = (id: string): HTMLElement[] =>
    [...page.container.querySelectorAll<HTMLElement>(`#${id}`)].filter((panel) => panel.closest('[inert]') === null)
  expect(shown('thread-view-chat')).toHaveLength(1)
  // Every tab's `aria-controls` names a panel that is in the page (#362 review): only the shown one has one.
  const dangling = (): string[] =>
    [...page.container.querySelectorAll<HTMLElement>('header [role="tab"][aria-controls]')]
      .map((trigger) => trigger.getAttribute('aria-controls') ?? '')
      .filter((panelId) => page.container.querySelector(`#${panelId}`) === null)
  expect(dangling()).toEqual([])
  await choose('stats')
  await eventually(() => {
    expect(tab('stats').getAttribute('aria-selected')).toBe('true')
    expect(shown('thread-view-stats')).toHaveLength(1)
    expect(shown('thread-view-chat')).toHaveLength(0)
  })
  expect(dangling()).toEqual([])
  const older = page.activeRows().find((row) => row.getAttribute('aria-current') === null)
  if (older === undefined) throw new Error('expected two rows')
  await page.click(older)
  await eventually(() => expect(shown('thread-view-stats')).toHaveLength(1))
  await choose('chat')
  await eventually(() => {
    expect(page.container.querySelectorAll('#thread-view-stats')).toHaveLength(0)
    expect(shown('thread-view-chat')).toHaveLength(1)
  })
  await page.unmount()
})

// #407: on a narrow screen the rail is a drawer over the thread (#417), behind the header's threads
// button. Choosing a thread from it must also close it — otherwise, on a phone, the thread just
// chosen stays hidden behind the rail. ⚠ happy-dom has no media queries: this reads the state the
// classes encode (the rail `max-md:invisible` while closed; a scrim over the thread while open), not a layout.
test('the threads button opens the rail over the thread; choosing a thread from it closes it again', async () => {
  const page = await mountStartedThreads(['first ask', 'second ask'])
  const toggle = page.container.querySelector<HTMLButtonElement>('header button[aria-controls="threads-rail"]')
  const rail = page.container.querySelector<HTMLElement>('#threads-rail')
  if (toggle === null || rail === null) throw new Error('expected the threads button and the rail it controls')
  const scrim = (): boolean => page.container.querySelector('.bg-scrim') !== null
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  expect(rail.classList.contains('max-md:invisible')).toBe(true)
  expect(scrim()).toBe(false)

  await page.click(toggle)
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
  expect(toggle.getAttribute('aria-label')).toBe('hide threads')
  expect(rail.classList.contains('max-md:invisible')).toBe(false)
  expect(scrim()).toBe(true)

  const older = page.activeRows()[1]
  if (older === undefined) throw new Error('expected two rows')
  expect(older.getAttribute('aria-current')).toBeNull()
  await page.click(older)
  await eventually(() => {
    expect(older.getAttribute('aria-current')).toBe('true')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(rail.classList.contains('max-md:invisible')).toBe(true)
    expect(scrim()).toBe(false)
  })
  await page.unmount()
})

// A question from pi waits in the transcript; on another view the Chat tab, the status bar and the
// rail's row say so, and nothing moves the reader (#362 review) — they switch when ready.
test('a question waiting while Stats is shown is said on the Chat tab, in the status bar and on the rail; the view stays', async () => {
  const page = await mountStartedThreads(['ask something'])
  const tab = (name: string): HTMLElement => {
    const found = page.container.querySelector<HTMLElement>(`header [role="tab"]#thread-view-${name}-tab`)
    if (found === null) throw new Error(`expected the ${name} tab`)
    return found
  }
  const statusBar = (): string => page.visiblePanes()[0]?.textContent ?? ''
  await flush(async () => {
    tab('stats').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    await tick()
  })
  const threadId = new URLSearchParams(window.location.search).get('thread')
  if (threadId === null) throw new Error('expected the thread in the url')
  expect(tab('chat').textContent).not.toContain('a question is waiting')
  // The rail's row is the pane's summary: `waiting` follows the thread's open dialog (PR #403 review).
  const railRow = (): string => page.activeRows()[0]?.textContent ?? ''
  expect(railRow()).not.toContain('waiting on you')
  // #371: the live region is there BEFORE the question, empty — a screen reader announces a change
  // inside a region that exists, not one that appears already filled.
  const liveRegion = page.visiblePanes()[0]?.querySelector('[role="status"]')
  expect(liveRegion?.textContent).toBe('')
  await flush(async () => {
    getThreadStores(threadId).dialog.set({ id: 'd1', dialog: { method: 'confirm', title: 'Proceed?', message: '' } })
    await tick()
  })
  expect(tab('stats').getAttribute('aria-selected')).toBe('true')
  expect(tab('chat').textContent).toContain('a question is waiting')
  expect(statusBar()).toContain('a question is waiting')
  // The same node, now holding the words; the visible line is hidden from it, so it is read once.
  expect(page.visiblePanes()[0]?.querySelector('[role="status"]')).toBe(liveRegion ?? null)
  expect(liveRegion?.textContent).toBe('a question is waiting')
  expect(page.visiblePanes()[0]?.querySelectorAll('[role="status"]')).toHaveLength(1)
  expect(railRow()).toContain('waiting on you')
  // On Chat the question is in view: the tab no longer flags it; the bar still says it waits.
  await flush(async () => {
    tab('chat').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    await tick()
  })
  expect(tab('chat').textContent).not.toContain('a question is waiting')
  expect(statusBar()).toContain('a question is waiting')
  await flush(async () => {
    getThreadStores(threadId).dialog.set(undefined)
    await tick()
  })
  expect(statusBar()).not.toContain('a question is waiting')
  expect(liveRegion?.isConnected).toBe(true)
  expect(liveRegion?.textContent).toBe('')
  expect(railRow()).not.toContain('waiting on you')
  await page.unmount()
})

// #737: the bar announces what it shows as `enso:thread-status` on `document` — on mount, and on
// each change of status, question or `shown` — so a listener (the arena's wait, the browser suite)
// never samples the page. The event follows the RENDER: it carries what the bar says at that moment.
test('⚠ the status bar announces enso:thread-status on mount and at each change of status, question and shown (#737)', async () => {
  const heard: EnsoThreadStatusEvent[] = []
  const listener = (event: Event): void => {
    if (event instanceof CustomEvent) heard.push(event.detail as EnsoThreadStatusEvent)
  }
  document.addEventListener(ENSO_UI_EVENTS.threadStatus, listener)
  try {
    const pane = await mountPane()
    const { threadId } = pane.stores
    // Mounted idle: said once, not once per render.
    expect(heard).toEqual([{ threadId, shown: true, status: 'idle' }])
    await pane.settle({ ...SNAPSHOT_IDLE, live: true, busy: true, generation: 1 })
    await eventually(() => expect(heard.at(-1)).toEqual({ threadId, shown: true, status: 'running' }))
    // A finer activity word is still `running`: no event for the bar going from working to a tool.
    await pane.settle(
      { type: 'observation', seq: 1, observation: { kind: 'message-start', role: 'assistant' } },
      {
        type: 'observation',
        seq: 2,
        observation: { kind: 'tool-call', toolCallId: 'c1', toolName: 'bash', args: { command: 'ls' } },
      },
    )
    await eventually(() => expect(pane.status()).toContain('running bash'))
    expect(heard).toHaveLength(2)
    // A question: its id and title go with it, so a listener can tell the next one from this one.
    await flush(async () => {
      getThreadStores(threadId).dialog.set({ id: 'd1', dialog: { method: 'confirm', title: 'Proceed?', message: '' } })
      await tick()
    })
    expect(heard.at(-1)).toEqual({
      threadId,
      shown: true,
      status: 'question',
      question: { id: 'd1', title: 'Proceed?' },
    })
    await flush(async () => {
      getThreadStores(threadId).dialog.set(undefined)
      await tick()
    })
    expect(heard.at(-1)).toEqual({ threadId, shown: true, status: 'running' })
    // The rail switches away: the bar stays mounted and says so; back again, it says that too.
    await pane.setActive(false)
    expect(heard.at(-1)).toEqual({ threadId, shown: false, status: 'running' })
    await pane.setActive(true)
    expect(heard.at(-1)).toEqual({ threadId, shown: true, status: 'running' })
    // The follow ends: disconnected, over everything else.
    await flush(async () => {
      getThreadStores(threadId).dialog.set({ id: 'd2', dialog: { method: 'confirm', title: 'Still?', message: '' } })
      getThreadStores(threadId).disconnected.set(true)
      await tick()
    })
    expect(heard.at(-1)).toEqual({ threadId, shown: true, status: 'disconnected' })
    await pane.unmount()
  } finally {
    document.removeEventListener(ENSO_UI_EVENTS.threadStatus, listener)
  }
})

test('New thread mints a thread, lists it in the rail as current, and shows exactly its pane', async () => {
  // `afterEach` cleared the module's first thread, so the page starts with none: header only.
  const page = await mountPage()
  expect(page.activeRows()).toHaveLength(0)
  expect(page.visiblePanes()).toHaveLength(0)
  const newThread = [...page.container.querySelectorAll('button')].find((button) => button.textContent === 'New thread')
  if (newThread === undefined) throw new Error('expected a New thread button')
  await page.click(newThread)
  await eventually(() => {
    expect(page.activeRows()).toHaveLength(1)
    expect(page.activeRows()[0]?.getAttribute('aria-current')).toBe('true')
    expect(page.visiblePanes()).toHaveLength(1)
  })
  // A prompt half-typed, so the draft stays when the page leaves it (#875).
  await flush(async () => {
    typeInto(shownComposer(page), 'half a thought')
    await tick()
  })
  await page.click(newThread)
  await eventually(() => {
    expect(page.activeRows()).toHaveLength(2)
    // Newest first, and the newest is current; one pane on screen, the other mounted off it.
    expect(page.activeRows().map((row) => row.getAttribute('aria-current'))).toEqual(['true', null])
    expect(page.visiblePanes()).toHaveLength(1)
    expect(page.container.querySelectorAll('#thread-status')).toHaveLength(2)
  })
  // Click the older row (the newer one holding words too): it becomes current and its pane is the visible one.
  await flush(async () => {
    typeInto(shownComposer(page), 'another half')
    await tick()
  })
  const older = page.activeRows()[1]
  if (older === undefined) throw new Error('expected two rows')
  await page.click(older)
  await eventually(() => {
    expect(page.activeRows().map((row) => row.getAttribute('aria-current'))).toEqual([null, 'true'])
    expect(page.visiblePanes()).toHaveLength(1)
  })
  await page.unmount()
})

/** The composer of the pane on screen — not one kept laid out, `inert`, under it (#370). */
function shownComposer(page: MountedPage): HTMLTextAreaElement {
  const found = [...page.container.querySelectorAll<HTMLTextAreaElement>('textarea[name="message"]')].find(
    (composer) => composer.closest('[inert]') === null,
  )
  if (found === undefined) throw new Error('expected the composer of the pane on screen')
  return found
}

// #875: a draft is the page's alone (#879), so one left with nothing typed — New thread clicked
// twice, a row clicked from it — would pile up on the rail. Leaving it drops it; words typed in its
// composer — the launch panel's form until it starts (#877) — keep it, and nothing is ever asked of
// the server.
test('⚠ a draft left with nothing typed is discarded; one holding a prompt on its launch panel stays (#875, #877)', async () => {
  // A model to offer, so the launch panel shows its settings.
  const page = await mountPage({
    commands: [
      {
        name: 'model',
        source: 'host',
        kind: 'select',
        value: 'fake/plain',
        options: [{ id: 'fake/plain', label: 'Plain' }],
      },
    ],
  })
  const newThread = [...page.container.querySelectorAll('button')].find((button) => button.textContent === 'New thread')
  if (newThread === undefined) throw new Error('expected a New thread button')
  const shown = (): string => new URLSearchParams(window.location.search).get('thread') ?? ''
  const listed = (): string[] => threadListStore.get().map((thread) => thread.threadId)
  await page.click(newThread)
  const empty = shown()
  await page.click(newThread)
  const kept = shown()
  await eventually(() => expect(listed()).toEqual([kept]))
  // Words in the launch panel's prompt: the composer, before Start.
  await eventually(() => expect(page.container.textContent).toContain('What should pi work on?'))
  await flush(async () => {
    typeInto(shownComposer(page), 'a prompt on the launch panel')
    await tick()
  })
  await page.click(newThread)
  const emptied = shown()
  await flush(async () => {
    typeInto(shownComposer(page), 'a prompt typed, then taken back')
    await tick()
  })
  const row = (threadId: string): HTMLButtonElement => {
    const found = page.activeRows().find((candidate) => candidate.dataset.threadId === threadId)
    if (found === undefined) throw new Error(`expected the row of ${threadId}`)
    return found
  }
  await page.click(row(kept))
  await eventually(() => expect(shown()).toBe(kept))
  expect(listed()).toEqual([emptied, kept])
  expect(shownComposer(page).value).toBe('a prompt on the launch panel')
  // Emptied again, the composer's draft goes the next time the page leaves it.
  await page.click(row(emptied))
  await flush(async () => {
    typeInto(shownComposer(page), '   ')
    await tick()
  })
  await page.click(row(kept))
  await eventually(() => expect(listed()).toEqual([kept]))
  expect(listed()).not.toContain(empty)
  expect(page.server.deletes).toEqual([])
  await page.unmount()
})

test("the rail lists the server's stored threads; a click resumes one with its history and mode (#95)", async () => {
  const page = await mountPage({
    storedThreads: [
      {
        threadId: 'stored-1',
        projectId: 'p-launch',
        title: 'fix the login bug',
        lastActivityAt: new Date().toISOString(),
        messageCount: 2,
        busy: false,
        waiting: false,
      },
    ],
    histories: {
      'stored-1': {
        threadId: 'stored-1',
        projectId: 'p-launch',
        messages: [
          { id: 'u1', role: 'user', parts: [{ type: 'text', content: 'fix the login bug' }] },
          { id: 'a1', role: 'assistant', parts: [{ type: 'text', content: 'Looking at auth.ts' }] },
        ],
        permissionMode: { mode: 'plan', available: ['default', 'plan'] },
        sessionRisk: { level: 'low', signals: 0 },
        incidents: NO_SESSION_INCIDENTS,
      },
    },
  })
  // The listing is a fetch of its own; the row is there once it has answered.
  const row = await eventually(() => {
    expect(page.previousRows().map((r) => r.textContent)).toEqual([expect.stringContaining('fix the login bug')])
    const found = page.previousRows()[0]
    if (found === undefined) throw new Error('expected a stored row')
    return found
  })
  await page.click(row)
  // Adopted: now an Active Session and current, gone from Previous, its pane shows the branch and opens in plan.
  await eventually(() => {
    expect(
      page.activeRows().map((r) => [r.textContent?.includes('fix the login bug'), r.getAttribute('aria-current')]),
    ).toEqual([[true, 'true']])
    expect(page.previousRows()).toHaveLength(0)
    expect(page.container.textContent).toContain('Looking at auth.ts')
    const visible = page.visiblePanes()[0]?.closest('div.flex-1') ?? page.container
    expect(visible.querySelector('select')?.value).toBe('plan')
  })
  await page.unmount()
})

// ── deleting a thread (#571): the header's Delete, its confirmation, and what each answer does ──

const DELETABLE = 'stored-delete'

/** The page with one stored thread, opened from the rail and on screen: one the server holds, so Delete is offered. */
async function openDeletable(
  options: Pick<ScriptedFetchOptions, 'deleteAnswers' | 'deletePreview' | 'trees' | 'histories' | 'projects'> & {
    readonly others?: readonly EnsoStoredThread[]
  } = {},
): Promise<MountedPage> {
  const { others = [], histories = {}, ...scripted } = options
  const page = await mountPage({
    storedThreads: [
      {
        threadId: DELETABLE,
        projectId: 'p-launch',
        title: 'try the parser rewrite',
        lastActivityAt: new Date().toISOString(),
        messageCount: 2,
        busy: false,
        waiting: false,
      },
      ...others,
    ],
    histories: {
      [DELETABLE]: {
        threadId: DELETABLE,
        projectId: 'p-launch',
        messages: [
          { id: 'u1', role: 'user', parts: [{ type: 'text', content: 'try the parser rewrite' }] },
          { id: 'a1', role: 'assistant', parts: [{ type: 'text', content: 'Rewriting parse.ts' }] },
        ],
        permissionMode: { mode: 'default', available: ['default', 'plan'] },
        sessionRisk: { level: 'low', signals: 0 },
        incidents: NO_SESSION_INCIDENTS,
      },
      ...histories,
    },
    ...scripted,
  })
  const row = await eventually(() => {
    const found = page.previousRows().find((stored) => stored.textContent?.includes('try the parser rewrite'))
    if (found === undefined) throw new Error('expected the stored row')
    return found
  })
  await page.click(row)
  await eventually(() => expect(new URLSearchParams(window.location.search).get('thread')).toBe(DELETABLE))
  return page
}

/** The open menu's items (#879) — Radix renders a menu into `document.body`. */
const menuItems = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]

/** The header's thread menu (#879), opened as a pointer opens it: its items. */
async function openThreadMenu(page: Pick<MountedPage, 'container'>): Promise<HTMLElement[]> {
  const trigger = page.container.querySelector<HTMLElement>('header button[aria-label="thread actions"]')
  if (trigger === null) throw new Error('expected the thread menu in the header')
  await flush(async () => {
    // Radix opens a menu on a primary-button pointerdown.
    trigger.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, pointerType: 'mouse' }))
    await tick()
  })
  return eventually(() => {
    const items = menuItems()
    expect(items.length).toBeGreaterThan(0)
    return items
  })
}

/** Choose the thread menu's item reading `words`; it must be enabled. */
async function chooseFromThreadMenu(page: Pick<MountedPage, 'container' | 'click'>, words: string): Promise<void> {
  const item = (await openThreadMenu(page)).find((found) => found.textContent === words)
  if (item === undefined) throw new Error(`expected ${words} in the thread menu`)
  expect(item.hasAttribute('data-disabled')).toBe(false)
  await page.click(item)
  await eventually(() => expect(menuItems()).toHaveLength(0))
}

/** The thread menu's items as they read, a disabled one marked so; the menu is closed again. */
async function threadMenuReads(page: Pick<MountedPage, 'container'>): Promise<string[]> {
  const items = (await openThreadMenu(page)).map(
    (item) => `${item.textContent ?? ''}${item.hasAttribute('data-disabled') ? ' (disabled)' : ''}`,
  )
  await flush(async () => {
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await tick()
  })
  await eventually(() => expect(menuItems()).toHaveLength(0))
  return items
}

/**
 * The open delete confirmation, or `undefined` — Radix renders dialogs into `document.body`, and a
 * fresh thread's launch panel may be open beside it (#877).
 */
const deleteDialog = (): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find((dialog) =>
    dialog.textContent?.includes('Delete this thread?'),
  )

/** The delete confirmation's button reading `text`. */
function dialogButton(text: string): HTMLButtonElement {
  const found = [...(deleteDialog()?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
    (button) => button.textContent === text,
  )
  if (found === undefined) throw new Error(`expected a ${text} button in the delete dialog`)
  return found
}

async function openDeleteDialog(page: MountedPage): Promise<HTMLElement> {
  await chooseFromThreadMenu(page, 'Delete thread…')
  return eventually(() => {
    const dialog = deleteDialog()
    if (dialog === undefined) throw new Error('expected the delete dialog')
    return dialog
  })
}

const notices = (page: MountedPage): string[] =>
  [...page.container.querySelectorAll('[role="status"]')].map((notice) => notice.textContent ?? '')

// #879: the header's separate Rename, Delete and debug buttons are one thread menu. A thread the
// server holds offers Rename, Fork thread and Delete thread…; a draft — minted here and never
// prompted, the page's alone — has nothing to rename, fork or delete, and is discarded instead.
test('the thread menu offers Rename, Fork thread and Delete on a thread the server holds; a draft only Discard draft', async () => {
  const page = await openDeletable()
  expect(await threadMenuReads(page)).toEqual(['Rename', 'Fork thread', 'Delete thread…'])
  const newThread = [...page.container.querySelectorAll('button')].find((button) => button.textContent === 'New thread')
  if (newThread === undefined) throw new Error('expected a New thread button')
  await page.click(newThread)
  expect(await threadMenuReads(page)).toEqual(['Rename (disabled)', 'Fork thread (disabled)', 'Discard draft'])
  const stored = page.activeRows().find((row) => row.textContent?.includes('try the parser rewrite'))
  if (stored === undefined) throw new Error('expected the stored thread on the rail')
  await page.click(stored)
  expect(await threadMenuReads(page)).toEqual(['Rename', 'Fork thread', 'Delete thread…'])
  await page.unmount()
})

/** Whether the header's view tabs are disabled, Chat, Context, Stats and Diff in turn. */
const viewTabsDisabled = (page: MountedPage): boolean[] =>
  ['chat', 'context', 'stats', 'changes'].map(
    (view) => page.container.querySelector<HTMLButtonElement>(`header #thread-view-${view}-tab`)?.disabled ?? true,
  )

test('a draft is "not started", its Context, Stats and Diff disabled; Discard draft leaves it and asks nothing of the server (#879)', async () => {
  const page = await openDeletable()
  const header = (): string => page.container.querySelector('header')?.textContent ?? ''
  expect(header()).not.toContain('not started')
  expect(viewTabsDisabled(page)).toEqual([false, false, false, false])
  const newThread = [...page.container.querySelectorAll('button')].find((button) => button.textContent === 'New thread')
  if (newThread === undefined) throw new Error('expected a New thread button')
  await page.click(newThread)
  const draft = new URLSearchParams(window.location.search).get('thread')
  expect(draft).not.toBe(DELETABLE)
  expect(header()).toContain('not started')
  // Chat stays: the way back from a view shown before the draft was.
  expect(viewTabsDisabled(page)).toEqual([false, true, true, true])
  await chooseFromThreadMenu(page, 'Discard draft')
  // The project's newest other thread is shown, and says the draft went; the draft is nowhere.
  await eventually(() => {
    expect(new URLSearchParams(window.location.search).get('thread')).toBe(DELETABLE)
    expect(threadListStore.get().some((thread) => thread.threadId === draft)).toBe(false)
    expect(notices(page).some((notice) => notice.endsWith('draft discarded'))).toBe(true)
  })
  expect(page.server.deletes).toEqual([])
  expect(page.server.previewReads).toEqual([])
  await page.unmount()
})

test("the menu's Fork thread is the palette's /fork: it forks at the last prompt and opens the fork, its composer holding that prompt (#879, #433)", async () => {
  const source = 'stored-started-0'
  const forked = 'stored-forked'
  const page = await mountStartedThreads(['first ask'], {
    histories: {
      [source]: storedHistory(source, [
        text('u-first', 'user', 'first ask'),
        text('a-first', 'assistant', 'first answer'),
        text('u-second', 'user', 'second ask'),
        text('a-second', 'assistant', 'second answer'),
      ]),
      [forked]: storedHistory(forked, [
        text('u-first', 'user', 'first ask'),
        text('a-first', 'assistant', 'first answer'),
      ]),
    },
    forkReceipt: { threadId: forked, prefill: 'second ask' },
  })
  await chooseFromThreadMenu(page, 'Fork thread')
  await eventually(() => {
    expect(page.server.forks).toEqual([{ threadId: source, body: { entryId: 'u-second' } }])
    expect(new URLSearchParams(window.location.search).get('thread')).toBe(forked)
    const composers = [...page.container.querySelectorAll<HTMLTextAreaElement>('textarea[name="message"]')]
    expect(composers.filter((composer) => composer.closest('[inert]') === null).map(({ value }) => value)).toEqual([
      'second ask',
    ])
  })
  await page.unmount()
})

/** Press `key` in `field`, as the keyboard does. */
async function pressKey(field: HTMLElement, key: string): Promise<void> {
  await flush(async () => {
    field.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    await tick()
  })
}

/** Type `text` over a controlled input's value, as a browser does: the prototype's setter, then `input`. */
async function typeOver(field: HTMLInputElement, text: string): Promise<void> {
  await flush(async () => {
    Reflect.set(HTMLInputElement.prototype, 'value', text, field)
    field.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
  })
}

const titleButton = (page: MountedPage): HTMLButtonElement | null =>
  page.container.querySelector<HTMLButtonElement>('header button[title^="rename this thread"]')
const nameField = (page: MountedPage): HTMLInputElement | null =>
  page.container.querySelector<HTMLInputElement>('header input[aria-label="thread name"]')

async function openNameField(page: MountedPage): Promise<HTMLInputElement> {
  return eventually(() => {
    const field = nameField(page)
    if (field === null) throw new Error('expected the name field in the header')
    return field
  })
}

test('Rename edits the title in place: focused with the whole name selected; Escape sends nothing, Enter saves (#879)', async () => {
  const page = await mountStartedThreads(['try the parser rewrite'])
  await chooseFromThreadMenu(page, 'Rename')
  const field = await openNameField(page)
  expect(document.activeElement).toBe(field)
  expect([field.selectionStart, field.selectionEnd]).toEqual([0, 'try the parser rewrite'.length])
  await typeOver(field, 'never sent')
  await pressKey(field, 'Escape')
  expect(nameField(page)).toBeNull()
  expect(titleButton(page)?.textContent).toContain('try the parser rewrite')
  // The title itself is the other way in.
  const title = titleButton(page)
  if (title === null) throw new Error('expected the title as a button')
  await page.click(title)
  const again = await openNameField(page)
  expect(again.value).toBe('try the parser rewrite')
  await typeOver(again, '  parser, take two  ')
  await pressKey(again, 'Enter')
  await eventually(() => {
    expect(nameField(page)).toBeNull()
    expect(titleButton(page)?.textContent).toContain('parser, take two')
  })
  expect(page.server.names).toEqual([{ threadId: 'stored-started-0', body: { name: 'parser, take two' } }])
  await page.unmount()
})

test('a rename left open ends when another thread is shown: coming back shows the title, not the field (#879, PR #892 review)', async () => {
  const page = await mountStartedThreads(['first ask', 'second ask'])
  await chooseFromThreadMenu(page, 'Rename')
  await openNameField(page)
  const row = (words: string): HTMLButtonElement => {
    const found = page.activeRows().find((candidate) => candidate.textContent?.includes(words))
    if (found === undefined) throw new Error(`expected the ${words} row`)
    return found
  }
  await page.click(row('first ask'))
  await eventually(() => expect(titleButton(page)?.textContent).toContain('first ask'))
  await page.click(row('second ask'))
  await eventually(() => expect(titleButton(page)?.textContent).toContain('second ask'))
  expect(nameField(page)).toBeNull()
  expect(page.server.names).toEqual([])
  await page.unmount()
})

test('a rename the server refuses is said under the field, which keeps the name to try again (#879)', async () => {
  const page = await mountStartedThreads(['try the parser rewrite'], {
    nameStatus: 409,
    nameReason: 'thread stored-started-0 is running',
  })
  await chooseFromThreadMenu(page, 'Rename')
  const field = await openNameField(page)
  await typeOver(field, 'parser, take two')
  await pressKey(field, 'Enter')
  await eventually(() =>
    expect(page.container.querySelector('header [role="alert"]')?.textContent).toBe(
      'Not renamed: 409 thread stored-started-0 is running',
    ),
  )
  expect(nameField(page)?.value).toBe('parser, take two')
  await page.unmount()
})

// #879: a thread the rail still lists but the server no longer holds is said in the pane, by its
// id, with the ways on — not as a line in the rail.
test('a listed thread the server no longer holds opens the not-found screen with its id; Start a new thread leaves it (#879)', async () => {
  const page = await openDeletable({
    others: [
      {
        threadId: 'stored-gone',
        projectId: 'p-launch',
        title: 'a thread deleted elsewhere',
        lastActivityAt: new Date(Date.now() - 60_000).toISOString(),
        messageCount: 2,
        busy: false,
        waiting: false,
      },
    ],
  })
  const gone = page.previousRows().find((row) => row.textContent?.includes('a thread deleted elsewhere'))
  if (gone === undefined) throw new Error('expected the stale row')
  await page.click(gone)
  const screen = await eventually(() => {
    const found = page.container.querySelector<HTMLElement>('section[aria-labelledby="thread-not-found-title"]')
    if (found === null) throw new Error('expected the not-found screen')
    return found
  })
  expect(screen.querySelector('h2')?.textContent).toBe('This thread isn’t on the server')
  expect(screen.querySelector('code')?.textContent).toBe('stored-gone')
  expect(document.activeElement).toBe(screen.querySelector('h2'))
  expect(page.container.textContent).not.toContain('could not open the thread')
  // No thread is on screen: the header names none and offers none of a thread's actions.
  expect(page.container.querySelector('header')?.textContent).toContain('Thread not found')
  expect(page.container.querySelector('header button[aria-label="thread actions"]')).toBeNull()
  expect(page.visiblePanes()).toHaveLength(0)
  const start = [...screen.querySelectorAll('button')].find((button) => button.textContent === 'Start a new thread')
  if (start === undefined) throw new Error('expected Start a new thread')
  await page.click(start)
  await eventually(() => {
    expect(page.container.querySelector('section[aria-labelledby="thread-not-found-title"]')).toBeNull()
    expect(page.container.querySelector('header')?.textContent).toContain('not started')
    expect(page.visiblePanes()).toHaveLength(1)
  })
  expect(new URLSearchParams(window.location.search).get('thread')).not.toBe(DELETABLE)
  await page.unmount()
})

test("the not-found screen's Search threads takes focus to the rail's search box (#879, #875)", async () => {
  const page = await openDeletable({
    others: [
      {
        threadId: 'stored-gone',
        projectId: 'p-launch',
        title: 'a thread deleted elsewhere',
        lastActivityAt: new Date(Date.now() - 60_000).toISOString(),
        messageCount: 2,
        busy: false,
        waiting: false,
      },
    ],
  })
  const gone = page.previousRows().find((row) => row.textContent?.includes('a thread deleted elsewhere'))
  if (gone === undefined) throw new Error('expected the stale row')
  await page.click(gone)
  const search = await eventually(() => {
    const found = [...page.container.querySelectorAll('section button')].find(
      (button) => button.textContent === 'Search threads',
    )
    if (!(found instanceof HTMLButtonElement)) throw new Error('expected Search threads')
    return found
  })
  await page.click(search)
  await eventually(() => {
    const focused = document.activeElement
    expect(focused?.closest('#threads-rail')).not.toBeNull()
    expect(focused?.getAttribute('aria-label')).toBe('Search threads')
  })
  await page.unmount()
})

test('under the title, what the thread runs with: project · model · effort, live — or recorded, said so — and nothing guessed (#879)', async () => {
  const page = await mountStartedThreads(['ask something'])
  const subtitle = (): string | undefined =>
    page.container.querySelector('header button[title^="rename this thread"] + span')?.textContent ?? undefined
  // A cold thread nothing has said a model for: its project alone.
  expect(subtitle()).toBe('launch')
  await flush(async () => {
    page.server.frame({
      ...SNAPSHOT_IDLE,
      threadId: 'stored-started-0',
      model: null,
      recordedModel: { model: { provider: 'anthropic', modelId: 'claude-sonnet-5' }, thinkingLevel: 'medium' },
    })
    await tick()
  })
  await eventually(() => expect(subtitle()).toBe('launch · claude-sonnet-5 (recorded) · medium'))
  await flush(async () => {
    page.server.frame({
      ...SNAPSHOT_LIVE,
      threadId: 'stored-started-0',
      model: {
        model: { provider: 'anthropic', id: 'claude-opus-5', name: 'Claude Opus 5' },
        thinkingLevel: 'high',
        availableThinkingLevels: ['off', 'high'],
      },
    })
    await tick()
  })
  await eventually(() => expect(subtitle()).toBe('launch · Claude Opus 5 · high'))
  await page.unmount()
})

test("with ?debug, the thread menu shows and hides the debug pane where the header's switch did (#879)", async () => {
  const stores = mintThread()
  const active = threadListStore.get().find((thread) => thread.threadId === stores.threadId)
  if (active === undefined) throw new Error('expected the minted thread in the list')
  const toggles: string[] = []
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  const render = async (debugOpen: boolean | undefined): Promise<void> => {
    await flush(async () => {
      root.render(
        <AppHeader
          active={active}
          activeThreadId={active.threadId}
          notFound={false}
          rail={{ open: false, toggle: () => undefined }}
          view="chat"
          onView={() => undefined}
          debug={debugOpen === undefined ? undefined : { open: debugOpen, toggle: () => toggles.push('toggle') }}
          onDeleted={() => undefined}
          onDiscardDraft={() => undefined}
          stored={[]}
        />,
      )
      await tick()
    })
  }
  const header = {
    container,
    click: async (button: HTMLElement): Promise<void> => {
      await flush(async () => {
        button.click()
        await tick()
      })
    },
  }
  // A page without ?debug has no debug pane to offer.
  await render(undefined)
  expect(await threadMenuReads(header)).not.toContain('Show debug pane')
  await render(false)
  await chooseFromThreadMenu(header, 'Show debug pane')
  expect(toggles).toEqual(['toggle'])
  await render(true)
  await chooseFromThreadMenu(header, 'Hide debug pane')
  expect(toggles).toEqual(['toggle', 'toggle'])
  await flush(async () => root.unmount())
  container.remove()
})

/** The dialog once the preview is in: Delete enabled, its description past the loading line. */
async function openPreviewedDialog(page: MountedPage): Promise<HTMLElement> {
  const dialog = await openDeleteDialog(page)
  await eventually(() => expect(dialog.textContent).not.toContain('Checking what a delete would take'))
  return dialog
}

// The preview (#571): the dialog says before the click what the delete takes and what it leaves.
test('a thread in the checkout: the dialog says the checkout is not touched, and names no tree', async () => {
  const page = await openDeletable({ deletePreview: { tree: null, size: null, holdsWork: null, keptFor: [] } })
  // The follow snapshot's flag says a tree; the server's preview, which the dialog reads, says none.
  await flush(async () => {
    getThreadStores(DELETABLE).tree.set(true)
    await tick()
  })
  const dialog = await openPreviewedDialog(page)
  expect(dialog.textContent).toContain('Your checkout is not touched')
  expect(dialog.textContent).not.toContain('tree')
  expect(page.server.deletes).toEqual([])
  await page.unmount()
})

/** A tree thread's preview whose snapshots the forks `keptFor` keep; 412 MB on disk unless `size` says. */
const treeKeptFor = (
  keptFor: { threadId: string }[],
  size: EnsoThreadDeletePreview['size'] = { kind: 'measured', bytes: 412_000_000 },
): EnsoThreadDeletePreview => ({
  tree: { kind: 'worktree', path: '/work/.enso/trees/stored-delete', branch: 'enso/stored-delete' },
  size,
  holdsWork: null,
  keptFor,
})

/** A stored fork the rail lists under `title`. */
const storedFork = (threadId: string, title?: string): EnsoStoredThread => ({
  threadId,
  projectId: 'p-launch',
  ...(title === undefined ? {} : { title }),
  lastActivityAt: new Date().toISOString(),
  messageCount: 1,
  busy: false,
  waiting: false,
})

const TREE_AT =
  "This cannot be undone. The conversation is deleted, and so is the thread's tree at /work/.enso/trees/stored-delete (branch enso/stored-delete)"
const TREE_GOES = `${TREE_AT}, 412 MB on disk.`

// #578: the tree's size is said in the sentence naming it — at least what was read when the walk
// was cut short, with why (#579 review), and an unreadable one by its reason, never as 0.
for (const [size, said] of [
  [
    { kind: 'partial', bytes: 412_000_000, reason: 'not finished in time' },
    `${TREE_AT}, at least 412 MB on disk (not finished in time).`,
  ],
  [
    { kind: 'unreadable', reason: 'EACCES: permission denied' },
    `${TREE_AT}; its size could not be read (EACCES: permission denied).`,
  ],
  [null, `${TREE_AT}.`],
] as const satisfies readonly (readonly [EnsoThreadDeletePreview['size'], string])[]) {
  test(`the dialog names a ${size?.kind ?? 'missing'} tree size as "${said.slice(TREE_AT.length)}"`, async () => {
    const page = await openDeletable({ deletePreview: treeKeptFor([], size) })
    const dialog = await openPreviewedDialog(page)
    expect(dialog.querySelector('[data-slot="dialog-description"]')?.textContent).toBe(`${said} Its snapshots go too.`)
    await page.unmount()
  })
}

test('a tree whose snapshots a fork keeps: the dialog quotes the fork by its rail title and says its snapshots up to the fork stay', async () => {
  // A title that reads as a sentence of its own: quoted, it cannot run into the dialog's.
  const page = await openDeletable({
    deletePreview: treeKeptFor([{ threadId: 'stored-fork-live' }]),
    others: [storedFork('stored-fork-live', 'Reply with the single word one.')],
  })
  const dialog = await openPreviewedDialog(page)
  expect(dialog.querySelector('[data-slot="dialog-description"]')?.textContent).toBe(
    `${TREE_GOES} Its snapshots up to where the fork “Reply with the single word one.” branched stay with that fork; the rest go. The fork itself is not deleted.`,
  )
  await page.unmount()
})

test('two forks keep the snapshots: each is named, a long title cut and quoted, an untitled one by its short id', async () => {
  const page = await openDeletable({
    deletePreview: treeKeptFor([{ threadId: 'stored-fork-long' }, { threadId: 'a1b2c3d4-untitled-fork' }]),
    others: [
      storedFork('stored-fork-long', 'rewrite the parser and the lexer, then port every test to the new API'),
      storedFork('a1b2c3d4-untitled-fork'),
    ],
  })
  const dialog = await openPreviewedDialog(page)
  expect(dialog.querySelector('[data-slot="dialog-description"]')?.textContent).toBe(
    `${TREE_GOES} Its snapshots up to where each of 2 forks (“rewrite the parser and the lexer, then…”, a1b2c3d4) branched stay with them; the rest go. The forks themselves are not deleted.`,
  )
  await page.unmount()
})

/** The `If-Match` a "Delete anyway" confirms `work` with: the sha256 of the text shown, quoted. */
const workTag = (work: string): string => `"${createHash('sha256').update(work, 'utf8').digest('hex')}"`

test('a tree holding work by the preview: the work is named before any click, and "Delete anyway" confirms that text', async () => {
  const work = 'the tree holds work — modified: src/parse.ts'
  const page = await openDeletable({
    deletePreview: {
      tree: { kind: 'copy', path: '/work/copy', branch: null },
      size: { kind: 'measured', bytes: 1300 },
      holdsWork: work,
      keptFor: [],
    },
  })
  const dialog = await openPreviewedDialog(page)
  expect(dialog.querySelector('[role="alert"]')?.textContent).toBe(work)
  await page.click(dialogButton('Delete anyway'))
  await eventually(() => expect(page.server.deletes).toEqual([`/api/threads/${DELETABLE}?force=1`]))
  expect(page.server.deleteTags).toEqual([workTag(work)])
  await page.unmount()
})

// PR #572 review: a forced delete confirms the work it was shown. A run that wrote more files since
// makes the server refuse it (422) with the list as it is now — shown in place of the old one, and
// confirmed by the next click.
test('a "Delete anyway" refused (422) for work changed since: the new list is shown as changed, and the next click confirms it', async () => {
  const shown = 'the tree holds work — modified: src/parse.ts'
  const now = 'the tree holds work — modified: src/parse.ts, src/lexer.ts'
  const page = await openDeletable({
    deletePreview: {
      tree: { kind: 'copy', path: '/work/copy', branch: null },
      size: { kind: 'measured', bytes: 1300 },
      holdsWork: shown,
      keptFor: [],
    },
    deleteAnswers: [{ status: 422, reason: now }, { status: 204 }],
  })
  await openPreviewedDialog(page)
  await page.click(dialogButton('Delete anyway'))
  await eventually(() => {
    const alert = deleteDialog()?.querySelector('[role="alert"]')?.textContent ?? ''
    expect(alert).toContain('The tree changed since')
    expect(alert).toContain(now)
  })
  expect(new URLSearchParams(window.location.search).get('thread')).toBe(DELETABLE)
  await page.click(dialogButton('Delete anyway'))
  await eventually(() => {
    expect(page.server.deletes).toEqual([`/api/threads/${DELETABLE}?force=1`, `/api/threads/${DELETABLE}?force=1`])
    expect(new URLSearchParams(window.location.search).get('thread')).not.toBe(DELETABLE)
  })
  expect(page.server.deleteTags).toEqual([workTag(shown), workTag(now)])
  await page.unmount()
})

test('a preview the server refuses: its reason is shown, and Delete still sends a plain delete', async () => {
  const page = await openDeletable({ deletePreview: { status: 410, reason: `thread ${DELETABLE} was deleted` } })
  const dialog = await openPreviewedDialog(page)
  expect(dialog.textContent).toContain(`410 thread ${DELETABLE} was deleted`)
  await page.click(dialogButton('Delete'))
  await eventually(() => expect(page.server.deletes).toEqual([`/api/threads/${DELETABLE}`]))
  await page.unmount()
})

/** The page's main region while a page (#869) is on screen, or null while a thread is. */
const pageRegion = (page: MountedPage): HTMLElement | null =>
  page.container.querySelector<HTMLElement>('[role="region"][aria-labelledby="page-heading"]')

/** A button by its words, inside `scope` of the page. */
function buttonIn(page: MountedPage, scope: string, words: string): HTMLButtonElement {
  const found = [...page.container.querySelectorAll<HTMLButtonElement>(`${scope} button`)].find(
    (button) => button.textContent === words,
  )
  if (found === undefined) throw new Error(`expected ${words} in ${scope}`)
  return found
}

/** Settings opened on its Storage section (#578, #869): the rail's link, then the section's. */
async function openStorage(page: MountedPage): Promise<HTMLElement> {
  await page.click(buttonIn(page, '#threads-rail', 'Settings'))
  await page.click(buttonIn(page, 'nav[aria-label="Settings sections"]', 'Storage'))
  const settings = pageRegion(page)
  if (settings === null) throw new Error('expected Settings to be open')
  return settings
}

const TREES_WORK = 'the tree holds work — modified: src/parse.ts'

/** A tree no thread records, its size unreadable. */
const ORPHAN_TREE: EnsoTreeOnDisk = {
  threadId: null,
  path: '/work/.enso/trees/orphan',
  kind: 'copy',
  branch: null,
  size: { kind: 'unreadable', reason: 'EACCES: permission denied' },
  holdsWork: null,
}

/** The launch project's trees and snapshot store, before any delete. */
const LAUNCH_TREES: EnsoTreesListing['projects'][number] = {
  projectId: 'p-launch',
  objectStore: { kind: 'measured', bytes: 2_100_000_000 },
  trees: [
    ORPHAN_TREE,
    {
      threadId: DELETABLE,
      path: '/work/.enso/trees/stored-delete',
      kind: 'worktree',
      branch: 'enso/stored-delete',
      size: { kind: 'measured', bytes: 412_000_000 },
      holdsWork: TREES_WORK,
    },
  ],
}

/** A launch project with the deletable thread's tree, holding work, and a tree no thread records. */
const TREES_LISTING: EnsoTreesListing = { projects: [LAUNCH_TREES] }

test("Settings' Storage lists each tree by its thread's title with size and held work, an unreadable size as such, and the snapshot store", async () => {
  const page = await openDeletable({ trees: () => TREES_LISTING })
  const settings = await openStorage(page)
  await eventually(() => expect(settings.textContent).not.toContain('Measuring…'))
  const section = settings.querySelector('section[aria-label="trees of launch"]')
  // The project's total (#870): its trees and its snapshot store, one unreadable tree making it a partial.
  expect(section?.querySelector('h3')?.textContent).toBe(
    'launchat least 2.5 GB on disk (partial: 1 of 3 not fully read)snapshots 2.1 GBOpen project',
  )
  const rows = [...(section?.querySelectorAll('li') ?? [])].map((row) => row.textContent ?? '')
  // Largest first: the unreadable one orders as 0, and is never said as 0.
  expect(rows[0]).toContain('try the parser rewrite')
  expect(rows[0]).toContain('412 MB')
  expect(rows[0]).toContain(TREES_WORK)
  expect(rows[1]).toContain('no thread records this tree')
  expect(rows[1]).toContain('size could not be read (EACCES: permission denied)')
  expect(rows[1]).toContain('work not checked: no thread records it')
  expect(rows[1]).not.toMatch(/\b0 B\b/)
  window.history.replaceState(null, '', '/')
  await page.unmount()
})

/** Each total of Storage's row as it reads: its value, what it counts, and, when partial, how much was not read. */
function storageTotals(settings: HTMLElement): string[][] {
  const row = settings.querySelector('dl[aria-label="storage totals"]')
  return [...(row?.children ?? [])].map((total) => {
    const value = total.querySelector('dd')?.textContent ?? ''
    const label = total.querySelector('dt')?.textContent ?? ''
    const short = [...total.querySelectorAll('dd')].slice(1).map((part) => part.textContent ?? '')
    return [value, label, ...short]
  })
}

/** A second project: one tree, measured, and a snapshot store whose walk did not finish. */
const OTHER_TREES: EnsoTreesListing['projects'][number] = {
  projectId: 'p-other',
  objectStore: { kind: 'partial', bytes: 300_000_000, reason: 'not finished in time' },
  trees: [{ ...ORPHAN_TREE, path: '/other/.enso/trees/a', size: { kind: 'measured', bytes: 88_000_000 } }],
}

/** Storage's totals, once the listing they sum is read. */
async function totalsOf(listing: EnsoTreesListing): Promise<string[][]> {
  const page = await openDeletable({ trees: () => listing })
  const settings = await openStorage(page)
  await eventually(() => expect(settings.textContent).not.toContain('Measuring…'))
  const totals = storageTotals(settings)
  window.history.replaceState(null, '', '/')
  await page.unmount()
  return totals
}

// #874: the totals across every project, summed from the groups below them. A size not fully read
// makes its total "at least", saying how many were not, never an exact number.
test("⚠ Storage's totals are the sums of its groups, across projects; one size not fully read makes its total partial (#874)", async () => {
  // 412 MB + 88 MB, the orphan's unreadable size not counted as 0; 2.1 GB + at least 300 MB.
  expect(await totalsOf({ projects: [LAUNCH_TREES, OTHER_TREES] })).toEqual([
    ['3', 'trees'],
    ['at least 500 MB', 'in trees', 'partial: 1 of 3 not fully read'],
    ['at least 2.4 GB', 'in snapshot stores', 'partial: 1 of 2 not fully read'],
  ])
})

test("Storage's totals, every size measured, are exact and say nothing of partial (#874)", async () => {
  const listing: EnsoTreesListing = {
    projects: [
      { ...LAUNCH_TREES, trees: LAUNCH_TREES.trees.filter((tree) => tree !== ORPHAN_TREE) },
      { ...OTHER_TREES, objectStore: { kind: 'measured', bytes: 300_000_000 } },
    ],
  }
  expect(await totalsOf(listing)).toEqual([
    ['2', 'trees'],
    ['500 MB', 'in trees'],
    ['2.4 GB', 'in snapshot stores'],
  ])
})

test("a delete from Settings' Storage goes through the header's preview and forced DELETE, then the listing is read again; the page stays", async () => {
  let listing = TREES_LISTING
  const page = await openDeletable({
    trees: () => listing,
    deletePreview: {
      tree: { kind: 'worktree', path: '/work/.enso/trees/stored-delete', branch: 'enso/stored-delete' },
      size: { kind: 'measured', bytes: 412_000_000 },
      holdsWork: TREES_WORK,
      keptFor: [],
    },
  })
  // A browser's `fetch` refuses any `this` but the window (`Illegal invocation`): the tab's delete
  // once called it as `target.fetch(…)`, which the scripted server never noticed.
  const scripted = globalThis.fetch
  globalThis.fetch = function strictFetch(this: unknown, input: string | URL | Request, init?: RequestInit) {
    if (this !== undefined && this !== globalThis) {
      throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation")
    }
    return scripted(input, init)
  } as typeof fetch
  const settings = await openStorage(page)
  const trigger = await eventually(() => {
    const found = settings.querySelector<HTMLButtonElement>('button[aria-label="delete thread try the parser rewrite"]')
    if (found === null) throw new Error("expected the tree's Delete")
    return found
  })
  await page.click(trigger)
  await eventually(() => expect(deleteDialog()?.querySelector('[role="alert"]')?.textContent).toBe(TREES_WORK))
  listing = { projects: [{ ...LAUNCH_TREES, trees: [ORPHAN_TREE] }] }
  await page.click(dialogButton('Delete anyway'))
  await eventually(() => expect(page.server.treeReads).toHaveLength(2))
  expect(page.server.previewReads).toEqual([`/api/threads/${DELETABLE}/delete-preview`])
  expect(page.server.deletes).toEqual([`/api/threads/${DELETABLE}?force=1`])
  expect(page.server.deleteTags).toEqual([workTag(TREES_WORK)])
  // The thread behind the page went; the page did not (#869): still Storage, at its URL, over the next thread.
  const shown = new URLSearchParams(window.location.search)
  expect([shown.get('page'), shown.get('section')]).toEqual(['settings', 'storage'])
  expect(shown.get('thread')).not.toBe(DELETABLE)
  expect(pageRegion(page)?.querySelector('h2')?.textContent).toBe('Storage')
  window.history.replaceState(null, '', '/')
  await page.unmount()
})

test('a delete the server takes (204) leaves the thread for a fresh one, and the rail lists it nowhere', async () => {
  const page = await openDeletable()
  await openDeleteDialog(page)
  await page.click(dialogButton('Delete'))
  await eventually(() => {
    expect(page.server.deletes).toEqual([`/api/threads/${DELETABLE}`])
    const shown = new URLSearchParams(window.location.search).get('thread') ?? ''
    expect(shown).not.toBe(DELETABLE)
    // The deleted pane left the page; the one on screen is the fresh thread the URL now names.
    expect(threadListStore.get().map((thread) => thread.threadId)).toEqual([shown])
    // Neither open nor earlier: the refreshed listing no longer holds it.
    expect(page.container.querySelector('#threads-rail')?.textContent).not.toContain('try the parser rewrite')
    expect(page.container.textContent).not.toContain('Rewriting parse.ts')
    expect(notices(page).some((notice) => notice.endsWith(`thread ${DELETABLE} deleted`))).toBe(true)
  })
  await page.unmount()
})

// ⚠ #663, from an arena run: deleting one of two approaches opened a new empty thread and its Start
// dialog — now its launch panel (#877) — the other right there in the rail. The page goes to the
// project's newest other thread — here a stored one, resumed — and says the delete on it (#721
// review: the notice was lost on this path).
test('⚠ a delete of the thread on screen goes to its project’s newest other thread — a stored one resumed with its history — and says the delete there; no launch panel (#663)', async () => {
  const sibling = 'stored-sibling'
  const page = await openDeletable({
    others: [
      {
        threadId: sibling,
        projectId: 'p-launch',
        title: 'try the regex rewrite',
        lastActivityAt: new Date(Date.now() - 60_000).toISOString(),
        messageCount: 2,
        busy: false,
        waiting: false,
      },
    ],
    histories: {
      [sibling]: {
        threadId: sibling,
        projectId: 'p-launch',
        messages: [
          { id: 'u2', role: 'user', parts: [{ type: 'text', content: 'try the regex rewrite' }] },
          { id: 'a2', role: 'assistant', parts: [{ type: 'text', content: 'Rewriting with regexes' }] },
        ],
        permissionMode: { mode: 'default', available: ['default', 'plan'] },
        sessionRisk: { level: 'low', signals: 0 },
        incidents: NO_SESSION_INCIDENTS,
      },
    },
  })
  await openDeleteDialog(page)
  await page.click(dialogButton('Delete'))
  await eventually(() => {
    expect(new URLSearchParams(window.location.search).get('thread')).toBe(sibling)
    expect(page.container.textContent).toContain('Rewriting with regexes')
    expect(page.container.textContent).not.toContain('Rewriting parse.ts')
    expect(notices(page).some((notice) => notice.endsWith(`thread ${DELETABLE} deleted`))).toBe(true)
  })
  expect(page.container.textContent).not.toContain('What should pi work on?')
  await page.unmount()
})

// #721 review: the next thread a delete chose can be gone too (the listing was stale). The page then
// starts a fresh thread, as any resume with nothing behind it does — and still says the delete.
test('a delete whose next thread the server no longer holds leaves a fresh thread, and says the delete on it (#663)', async () => {
  const page = await openDeletable({
    others: [
      {
        threadId: 'stored-gone',
        projectId: 'p-launch',
        title: 'a thread deleted elsewhere',
        lastActivityAt: new Date(Date.now() - 60_000).toISOString(),
        messageCount: 2,
        busy: false,
        waiting: false,
      },
    ],
  })
  await openDeleteDialog(page)
  await page.click(dialogButton('Delete'))
  await eventually(() => {
    const shown = new URLSearchParams(window.location.search).get('thread') ?? ''
    expect([DELETABLE, 'stored-gone', '']).not.toContain(shown)
    expect(threadListStore.get().some((thread) => thread.threadId === shown)).toBe(true)
    expect(page.container.textContent).toContain('the server holds no session for thread stored-gone')
    expect(notices(page).some((notice) => notice.endsWith(`thread ${DELETABLE} deleted`))).toBe(true)
  })
  await page.unmount()
})

test('a tree holding work (422) is named in the dialog, and "Delete anyway" repeats the delete with force', async () => {
  // The server's words, longer than a failure line's bound: every file force would destroy is named.
  const reason =
    'the tree holds work — modified: src/parse.ts, src/lexer.ts, README.md; untracked: notes/plan.md, notes/next.md; 2 commits on enso/stored-delete that no other ref reaches'
  const page = await openDeletable({ deleteAnswers: [{ status: 422, reason }, { status: 204 }] })
  await openDeleteDialog(page)
  await page.click(dialogButton('Delete'))
  // Said once, as the server said it: no status before it, no label of the page's around it.
  await eventually(() => expect(deleteDialog()?.querySelector('[role="alert"]')?.textContent).toBe(reason))
  // Refused, so still here: nothing left the page.
  expect(new URLSearchParams(window.location.search).get('thread')).toBe(DELETABLE)
  await page.click(dialogButton('Delete anyway'))
  await eventually(() => {
    expect(page.server.deletes).toEqual([`/api/threads/${DELETABLE}`, `/api/threads/${DELETABLE}?force=1`])
    expect(page.server.deleteTags).toEqual([null, workTag(reason)])
    expect(new URLSearchParams(window.location.search).get('thread')).not.toBe(DELETABLE)
  })
  await page.unmount()
})

// A fork at a thread's first prompt opens empty, its words in the composer — yet the fork route has
// already written its session, and the listing says so. Reopened from the rail it is the same: an
// adopted thread with no branch yet. The listing is what says the server holds it.
test('a thread the stored listing holds offers Delete before anything is prompted on it', async () => {
  const forked = 'stored-fork'
  const page = await mountPage({
    storedThreads: [
      {
        threadId: forked,
        projectId: 'p-launch',
        lastActivityAt: new Date().toISOString(),
        messageCount: 0,
        busy: false,
        waiting: false,
      },
    ],
    histories: {
      [forked]: {
        threadId: forked,
        projectId: 'p-launch',
        messages: [],
        permissionMode: { mode: 'default', available: ['default', 'plan'] },
        sessionRisk: { level: 'low', signals: 0 },
        incidents: NO_SESSION_INCIDENTS,
      },
    },
  })
  const row = await eventually(() => {
    const found = page.previousRows()[0]
    if (found === undefined) throw new Error('expected the stored row')
    return found
  })
  await page.click(row)
  await eventually(() => expect(new URLSearchParams(window.location.search).get('thread')).toBe(forked))
  expect(await threadMenuReads(page)).toContain('Delete thread…')
  await page.unmount()
})

test('a delete refused while the thread runs (409) is said on the thread and offers no force; the thread stays', async () => {
  const reason = 'thread stored-delete is running; stop it first'
  const page = await openDeletable({ deleteAnswers: [{ status: 409, reason }] })
  await openDeleteDialog(page)
  await page.click(dialogButton('Delete'))
  await eventually(() => {
    expect(deleteDialog()).toBeUndefined()
    expect(notices(page).some((notice) => notice.endsWith(`thread ${DELETABLE}: delete refused: 409 ${reason}`))).toBe(
      true,
    )
  })
  expect(page.server.deletes).toEqual([`/api/threads/${DELETABLE}`])
  expect(new URLSearchParams(window.location.search).get('thread')).toBe(DELETABLE)
  expect(page.container.textContent).toContain('Rewriting parse.ts')
  await page.unmount()
})

// PR #572 review: a delete the server has not answered cannot be called back — so nothing in the
// dialog may read as calling it back. Cancel, Esc and the close button would close the dialog while
// the request ran on, and the 204 then pulled the user off whatever they had turned to.
test('while the server has not answered a delete, the dialog cannot be dismissed: Cancel is disabled and Esc does nothing', async () => {
  const page = await openDeletable()
  const release = page.server.holdDelete()
  await openDeleteDialog(page)
  await page.click(dialogButton('Delete'))
  await eventually(() => expect(page.server.deletes).toEqual([`/api/threads/${DELETABLE}`]))
  expect(dialogButton('Cancel').disabled).toBe(true)
  // The close button would claim the same thing Cancel does.
  expect(deleteDialog()?.querySelector('button[data-slot="dialog-close"]')).toBeNull()
  await flush(async () => {
    deleteDialog()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await tick()
  })
  expect(deleteDialog()).not.toBeUndefined()
  // Answered: the delete it could not cancel goes through, and the page leaves the thread.
  await flush(async () => {
    release()
    await tick()
  })
  await eventually(() => {
    expect(deleteDialog()).toBeUndefined()
    expect(new URLSearchParams(window.location.search).get('thread')).not.toBe(DELETABLE)
  })
  await page.unmount()
})

test('a 204 that arrives after the user moved to another thread leaves them there; the deleted thread is gone from the rail', async () => {
  const page = await openDeletable()
  const newThread = [...page.container.querySelectorAll('button')].find((button) => button.textContent === 'New thread')
  if (newThread === undefined) throw new Error('expected a New thread button')
  await page.click(newThread)
  const other = new URLSearchParams(window.location.search).get('thread') ?? ''
  expect(other).not.toBe(DELETABLE)
  const stored = page.activeRows().find((row) => row.textContent?.includes('try the parser rewrite'))
  if (stored === undefined) throw new Error('expected the stored thread on the rail')
  await page.click(stored)
  const release = page.server.holdDelete()
  await openDeleteDialog(page)
  await page.click(dialogButton('Delete'))
  await eventually(() => expect(page.server.deletes).toEqual([`/api/threads/${DELETABLE}`]))
  // Back, while the server works: the thread before is on screen again.
  await visitThreadUrl(other)
  await eventually(() =>
    expect(page.activeRows().find((row) => row.getAttribute('aria-current') === 'true')?.textContent).not.toContain(
      'try the parser rewrite',
    ),
  )
  await flush(async () => {
    release()
    await tick()
  })
  await eventually(() => {
    expect(threadListStore.get().map((thread) => thread.threadId)).toEqual([other])
    expect(page.container.querySelector('#threads-rail')?.textContent).not.toContain('try the parser rewrite')
  })
  expect(new URLSearchParams(window.location.search).get('thread')).toBe(other)
  // Said on the thread the user is on.
  const shownPane = page.visiblePanes()[0]?.closest('.absolute.inset-0')
  const said = [...(shownPane?.querySelectorAll('[role="status"]') ?? [])].map((notice) => notice.textContent ?? '')
  expect(said.some((notice) => notice.endsWith(`thread ${DELETABLE} deleted`))).toBe(true)
  await page.unmount()
})

// docs/flows/resume.md, stated gap: the reader was pinned to produce an image part from the file
// (transcript-to-messages.test.ts); nothing asserted the PAGE renders it. A resumed thread's
// image must come back as an <img> from the server's history — no page state involved.
// @pins resume/transcript-ours
test("a resumed thread's image renders as an <img> from the stored history, bytes inline (#68, #95)", async () => {
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
  const page = await mountPage({
    storedThreads: [
      {
        threadId: 'stored-img',
        projectId: 'p-launch',
        title: 'what does this say?',
        lastActivityAt: new Date().toISOString(),
        messageCount: 1,
        busy: false,
        waiting: false,
      },
    ],
    histories: {
      'stored-img': {
        threadId: 'stored-img',
        projectId: 'p-launch',
        messages: [
          {
            id: 'u1',
            role: 'user',
            parts: [
              { type: 'text', content: 'what does this say?' },
              { type: 'image', source: { type: 'data', value: PNG, mimeType: 'image/png' } },
            ],
          },
        ],
        permissionMode: { mode: 'default', available: ['default'] },
        sessionRisk: { level: 'low', signals: 0 },
        incidents: NO_SESSION_INCIDENTS,
      },
    },
  })
  const row = await eventually(() => {
    const found = page.previousRows()[0]
    if (found === undefined) throw new Error('expected a stored row')
    return found
  })
  await page.click(row)
  await eventually(() => {
    const image = page.container.querySelector('img[alt="attached by the user"]')
    expect(image).not.toBeNull()
    expect(image?.getAttribute('src')).toBe(`data:image/png;base64,${PNG}`)
    // and it is the user's, beside the text it was sent with
    expect(page.container.textContent).toContain('what does this say?')
  })
  await page.unmount()
})

// #381: a refused attempt reloaded as an EMPTY bubble — the refusal lived only in the live page's
// notifications. From the stored history alone it must be said in the attempt's own place: after
// the prompt, before the reply the retry got.
// @pins resume/transcript-ours
test("a resumed thread's refused attempt says the refusal in its own bubble, before the reply (#381)", async () => {
  const page = await mountPage({
    storedThreads: [
      {
        threadId: 'stored-refused',
        projectId: 'p-launch',
        title: 'hi',
        lastActivityAt: new Date().toISOString(),
        messageCount: 3,
        busy: false,
        waiting: false,
      },
    ],
    histories: {
      'stored-refused': {
        threadId: 'stored-refused',
        projectId: 'p-launch',
        messages: [
          { id: 'u1', role: 'user', parts: [{ type: 'text', content: 'hi' }] },
          {
            id: 'a1',
            role: 'assistant',
            parts: [],
            metadata: {
              [ENSO_PROVIDER_REFUSAL_KEY]: {
                provider: 'anthropic',
                model: 'claude-sonnet-4-5',
                status: 429,
                message: '429 {"type":"error","error":{"type":"rate_limit_error","message":"rate limit exceeded"}}',
              },
            },
          },
          { id: 'a2', role: 'assistant', parts: [{ type: 'text', content: 'hello after the retry' }] },
        ],
        permissionMode: { mode: 'default', available: ['default'] },
        sessionRisk: { level: 'low', signals: 0 },
        incidents: NO_SESSION_INCIDENTS,
      },
    },
  })
  const row = await eventually(() => {
    const found = page.previousRows()[0]
    if (found === undefined) throw new Error('expected a stored row')
    return found
  })
  await page.click(row)
  await eventually(() => {
    const lines = page.container.querySelectorAll('[data-enso-refused-attempt]')
    expect([...lines].map((line) => line.textContent)).toEqual([
      'anthropic · claude-sonnet-4-5 refused: rate-limited (429) — rate limit exceeded',
    ])
    // in the attempt's place: the bubble between the prompt and the reply
    const text = page.container.textContent ?? ''
    expect(text.indexOf('refused: rate-limited')).toBeGreaterThan(text.indexOf('hi'))
    expect(text.indexOf('refused: rate-limited')).toBeLessThan(text.indexOf('hello after the retry'))
  })
  await page.unmount()
})

test('a stored listing the server cannot serve is said in the rail, and the page still works', async () => {
  const server = createScriptedFetch()
  const failing = ((input: string | URL | Request, init?: RequestInit): Promise<Response> =>
    requestedUrl(input).endsWith('/api/stored-threads')
      ? Promise.resolve(new Response('<!doctype html>\n<html>boom</html>', { status: 500 }))
      : server.fetch(input, init)) as typeof fetch
  globalThis.fetch = failing
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  await flush(async () => {
    root.render(<ChatScreen />)
  })
  await flush(tick)
  // One bounded line, status first, never the page (#103 receipt, step 8).
  await eventually(() => {
    expect(container.textContent).toContain('could not list threads: 500 <!doctype html>')
    expect(container.textContent).not.toContain('<html>boom</html>')
  })
  await flush(async () => root.unmount())
  container.remove()
})

/** The URL names `threadId`, and the page is told the way back/forward tells it. */
async function visitThreadUrl(threadId: string): Promise<void> {
  await flush(async () => {
    window.history.pushState(null, '', `?thread=${threadId}`)
    window.dispatchEvent(new PopStateEvent('popstate'))
    await tick()
  })
}

const railAlerts = (container: HTMLElement): string[] =>
  [...container.querySelectorAll('#threads-rail [role="alert"]')].map((alert) => alert.textContent ?? '')

// #378: the page writes a fresh thread's id to the URL before its first prompt. If the server
// restarts, or drops the empty thread, before that prompt, the URL names an id the server has never
// held: a 404. That is no error — the thread is started under the id the URL already names.
test("⚠ the URL's own thread, never held by the server, is started under that id: no error, its launch panel shown (#378, #877)", async () => {
  const page = await mountPage()
  const unused = crypto.randomUUID()
  try {
    await visitThreadUrl(unused)
    await eventually(() => {
      expect(threadListStore.get().map((thread) => thread.threadId)).toContain(unused)
      expect(page.container.querySelector('[role="region"] h2')?.textContent).toBe('What should pi work on?')
    })
    expect(window.location.search).toBe(`?thread=${unused}`)
    expect(railAlerts(page.container)).toEqual([])
  } finally {
    window.history.replaceState(null, '', '/')
    await page.unmount()
  }
})

// ⚠ #479: a reload before the first prompt — a Start refused, the tab reloaded — found the empty
// thread the server still held: a 200 with no messages, adopted as a resumed thread, and the
// settings a session starts with, the system prompt among them, were offered nowhere. The server
// says the thread is a draft, and the page opens it on its launch panel, as it opens one it minted.
test('⚠ a reload of a thread the server holds but never started opens its launch panel, not an empty transcript (#479)', async () => {
  const draft = crypto.randomUUID()
  const page = await mountPage({
    histories: {
      [draft]: {
        threadId: draft,
        projectId: 'p-launch',
        messages: [],
        permissionMode: { mode: 'default', available: ['default', 'plan'] },
        sessionRisk: { level: 'low', signals: 0 },
        incidents: NO_SESSION_INCIDENTS,
        draft: true,
      },
    },
  })
  try {
    await visitThreadUrl(draft)
    await eventually(() => {
      expect(threadListStore.get().map((thread) => thread.threadId)).toContain(draft)
      expect(page.container.querySelector('[role="region"] h2')?.textContent).toBe('What should pi work on?')
    })
    expect(getThreadStores(draft)?.launch.get()).toBe(true)
    expect(railAlerts(page.container)).toEqual([])
  } finally {
    window.history.replaceState(null, '', '/')
    await page.unmount()
  }
})

// #378: a thread stored in a directory that is no project here is not an unused id. It is refused
// by name, on the rail's own line for a thread that would not open — never as a list that failed.
test('a thread stored outside the projects is said on its own rail line, never as the listing failing (#378)', async () => {
  const server = createScriptedFetch()
  const outside = crypto.randomUUID()
  const refusal = 'stored in /elsewhere — not a project here; add it as one to open it'
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit): Promise<Response> =>
    requestedUrl(input).endsWith(`/api/threads/${outside}/history`)
      ? Promise.resolve(new Response(refusal, { status: 403 }))
      : server.fetch(input, init)) as typeof fetch
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  try {
    await flush(async () => {
      root.render(<ChatScreen />)
    })
    await flush(tick)
    await visitThreadUrl(outside)
    await eventually(() => expect(railAlerts(container)).toEqual([`could not open the thread: 403 ${refusal}`]))
    // Not started under its id: it is someone's stored thread, just not one this server serves.
    expect(threadListStore.get().map((thread) => thread.threadId)).not.toContain(outside)
  } finally {
    window.history.replaceState(null, '', '/')
    await flush(async () => root.unmount())
    container.remove()
  }
})

// #571: a deleted id is refused for the server's lifetime — its history answers 410, not #378's
// 404. A URL naming it (Back to it, or a reload) must not start a thread under the deleted id: the
// page says it would not open, and stays on a thread of its own.
test('a URL naming a deleted thread (410) is said on the rail and never started under that id (#571)', async () => {
  const server = createScriptedFetch()
  const deleted = crypto.randomUUID()
  const refusal = `thread ${deleted} was deleted`
  globalThis.fetch = server.fetch
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  const answeringDeleted = ((input: string | URL | Request, init?: RequestInit): Promise<Response> =>
    requestedUrl(input).endsWith(`/api/threads/${deleted}/history`)
      ? Promise.resolve(new Response(refusal, { status: 410 }))
      : server.fetch(input, init)) as typeof fetch
  try {
    await flush(async () => {
      root.render(<ChatScreen />)
    })
    await flush(tick)
    const newThread = [...container.querySelectorAll('button')].find((button) => button.textContent === 'New thread')
    if (newThread === undefined) throw new Error('expected a New thread button')
    await flush(async () => {
      newThread.click()
      await tick()
    })
    const shown = new URLSearchParams(window.location.search).get('thread') ?? ''
    globalThis.fetch = answeringDeleted
    await visitThreadUrl(deleted)
    await eventually(() => {
      // Not started under the deleted id — what #378's 404 branch would do — and still on the thread before.
      expect(threadListStore.get().map((thread) => thread.threadId)).not.toContain(deleted)
      expect(railAlerts(container)).toEqual([`could not open the thread: 410 ${refusal}`])
    })
    expect(threadListStore.get().map((thread) => thread.threadId)).toContain(shown)
    expect(
      container.querySelector(`#threads-rail button[data-thread-id="${shown}"][aria-current="true"]`),
    ).not.toBeNull()
  } finally {
    window.history.replaceState(null, '', '/')
    await flush(async () => root.unmount())
    container.remove()
  }
})

// ── the pages beside the threads (#869): Settings at its own URL, opened from the rail, left by a thread ──

/** Where the browser's back or forward button lands: the URL moves, then the page is told. */
async function popTo(search: string): Promise<void> {
  await flush(async () => {
    window.history.replaceState(null, '', search)
    window.dispatchEvent(new PopStateEvent('popstate'))
    await tick()
  })
}

/** The URL's page and section, `[null, null]` while a thread is shown. */
const pageInUrl = (): (string | null)[] => {
  const parameters = new URLSearchParams(window.location.search)
  return [parameters.get('page'), parameters.get('section')]
}

const pageHeading = (page: MountedPage): string | undefined =>
  page.container.querySelector('#page-heading')?.textContent ?? undefined

// @pins resume/url-names-page
test('Settings opens from the rail as a page, each section a URL of its own; back and forward walk them and the thread behind', async () => {
  const page = await openDeletable()
  try {
    const settingsLink = (): HTMLButtonElement => buttonIn(page, '#threads-rail', 'Settings')
    await page.click(settingsLink())
    expect(pageInUrl()).toEqual(['settings', 'appearance'])
    expect(new URLSearchParams(window.location.search).get('thread')).toBe(DELETABLE)
    expect(pageHeading(page)).toBe('Settings')
    expect(settingsLink().getAttribute('aria-current')).toBe('page')
    // The thread is behind the page: off screen, no row marked current, the header the page's own.
    expect(page.visiblePanes()).toHaveLength(0)
    expect(page.container.querySelector('#threads-rail [aria-current="true"]')).toBeNull()
    expect(page.container.querySelector('header button[aria-label="thread actions"]')).toBeNull()
    await page.click(buttonIn(page, 'nav[aria-label="Settings sections"]', 'Permissions'))
    expect(pageInUrl()).toEqual(['settings', 'permissions'])
    expect(pageRegion(page)?.querySelector('h2')?.textContent).toBe('Permissions')
    // Back: the section before, then the thread with no page; forward: the page again.
    await popTo(`?thread=${DELETABLE}&page=settings&section=appearance`)
    expect(pageRegion(page)?.querySelector('h2')?.textContent).toBe('Appearance')
    await popTo(`?thread=${DELETABLE}`)
    expect(pageRegion(page)).toBeNull()
    expect(page.visiblePanes()).toHaveLength(1)
    expect(settingsLink().getAttribute('aria-current')).toBeNull()
    expect(page.container.querySelector('header button[aria-label="thread actions"]')).not.toBeNull()
    await popTo(`?thread=${DELETABLE}&page=settings&section=appearance`)
    expect(pageHeading(page)).toBe('Settings')
  } finally {
    window.history.replaceState(null, '', '/')
    await page.unmount()
  }
})

// @pins resume/url-names-page
test('a thread opened from Settings leaves the page, its URL the thread alone; back returns to the page', async () => {
  const page = await openDeletable()
  try {
    await page.click(buttonIn(page, '#threads-rail', 'Settings'))
    const onSettings = window.location.search
    const row = page.activeRows().find((found) => found.textContent?.includes('try the parser rewrite'))
    if (row === undefined) throw new Error('expected the thread behind the page in the rail')
    await page.click(row)
    expect(pageInUrl()).toEqual([null, null])
    expect(new URLSearchParams(window.location.search).get('thread')).toBe(DELETABLE)
    expect(pageRegion(page)).toBeNull()
    expect(page.visiblePanes()).toHaveLength(1)
    await popTo(onSettings)
    expect(pageHeading(page)).toBe('Settings')
    expect(page.visiblePanes()).toHaveLength(0)
  } finally {
    window.history.replaceState(null, '', '/')
    await page.unmount()
  }
})

// @pins resume/url-names-page
test('a reload at a Settings URL comes back to its section', async () => {
  window.history.replaceState(null, '', '?page=settings&section=storage')
  const page = await mountPage()
  try {
    expect(pageHeading(page)).toBe('Settings')
    expect(pageRegion(page)?.querySelector('h2')?.textContent).toBe('Storage')
    expect(buttonIn(page, '#threads-rail', 'Settings').getAttribute('aria-current')).toBe('page')
  } finally {
    window.history.replaceState(null, '', '/')
    await page.unmount()
  }
})

// @pins resume/url-names-page
test('a section Settings does not have, or a page Enso does not, is not found with the way back — never a blank page', async () => {
  const page = await openDeletable()
  try {
    await popTo(`?thread=${DELETABLE}&page=settings&section=trees`)
    expect(pageHeading(page)).toBe('Section not found')
    expect(pageRegion(page)?.textContent).toContain('Settings has no section called “trees”.')
    expect(buttonIn(page, '#threads-rail', 'Settings').getAttribute('aria-current')).toBe('page')
    // The breadcrumb back: Settings, at its first section.
    await page.click(buttonIn(page, 'header', 'Settings'))
    expect(pageInUrl()).toEqual(['settings', 'appearance'])
    expect(pageRegion(page)?.querySelector('h2')?.textContent).toBe('Appearance')
    await popTo(`?thread=${DELETABLE}&page=trees`)
    expect(pageHeading(page)).toBe('Page not found')
    expect(pageRegion(page)?.textContent).toContain('Enso has no page called “trees”.')
    await page.click(buttonIn(page, '[role="region"]', 'Back to the thread'))
    expect(pageInUrl()).toEqual([null, null])
    expect(new URLSearchParams(window.location.search).get('thread')).toBe(DELETABLE)
    expect(page.visiblePanes()).toHaveLength(1)
  } finally {
    window.history.replaceState(null, '', '/')
    await page.unmount()
  }
})

// ── the Projects page (#870): opened from the rail, each project a card ──

const LAUNCH_PROJECT: EnsoProject = {
  projectId: 'p-launch',
  title: 'launch',
  path: '/scripted/launch',
  status: 'ok',
  launch: true,
}
/** A registered project: `OTHER_TREES`' project, with one stored thread of its own. */
const OTHER_PROJECT: EnsoProject = { projectId: 'p-other', title: 'other', path: '/other', status: 'ok', launch: false }
const OTHER_THREAD = 'stored-other'

/** A project's card on the Projects page, by its name. */
function projectCard(page: MountedPage, name: string): HTMLElement {
  const card = [...page.container.querySelectorAll<HTMLElement>('ul[aria-label="Projects"] > li')].find(
    (found) => found.querySelector('h2')?.textContent === name,
  )
  if (card === undefined) throw new Error(`expected the card of ${name}`)
  return card
}

/** What a project takes on disk, as `scope` says it: the size that reads "… on disk". */
function onDiskIn(scope: Element): string {
  const size = [...scope.querySelectorAll('span')].find(
    (span) => span.querySelector('strong') !== null && span.textContent.includes(' on disk'),
  )
  if (size === undefined) throw new Error('expected a size on disk')
  return size.textContent
}

// @pins resume/url-names-page
test('Projects opens from the rail as a page at its own URL; Open threads resumes the project’s latest thread and leaves the page; back returns', async () => {
  const page = await openDeletable({
    projects: [LAUNCH_PROJECT, OTHER_PROJECT],
    others: [
      {
        threadId: OTHER_THREAD,
        projectId: 'p-other',
        title: 'tidy the docs',
        lastActivityAt: new Date(Date.now() - 60_000).toISOString(),
        messageCount: 2,
        busy: false,
        waiting: false,
      },
    ],
    histories: {
      [OTHER_THREAD]: {
        threadId: OTHER_THREAD,
        projectId: 'p-other',
        messages: [
          { id: 'u3', role: 'user', parts: [{ type: 'text', content: 'tidy the docs' }] },
          { id: 'a3', role: 'assistant', parts: [{ type: 'text', content: 'Tidying README.md' }] },
        ],
        permissionMode: { mode: 'default', available: ['default', 'plan'] },
        sessionRisk: { level: 'low', signals: 0 },
        incidents: NO_SESSION_INCIDENTS,
      },
    },
  })
  try {
    const projectsLink = (): HTMLButtonElement => buttonIn(page, '#threads-rail', 'Projects')
    await page.click(projectsLink())
    expect(pageInUrl()).toEqual(['projects', null])
    expect(new URLSearchParams(window.location.search).get('thread')).toBe(DELETABLE)
    expect(pageHeading(page)).toBe('Projects')
    expect(projectsLink().getAttribute('aria-current')).toBe('page')
    expect(buttonIn(page, '#threads-rail', 'Settings').getAttribute('aria-current')).toBeNull()
    expect(page.visiblePanes()).toHaveLength(0)
    // The thread behind the page names the current project; the open thread and the stored one are counted once each.
    expect(projectCard(page, 'launch').textContent).toContain('current')
    expect(projectCard(page, 'other').textContent).not.toContain('current')
    expect(projectCard(page, 'launch').textContent).toContain('1 thread')
    const onProjects = window.location.search
    const open = [...projectCard(page, 'other').querySelectorAll('button')].find(
      (button) => button.textContent === 'Open threads',
    )
    if (open === undefined) throw new Error('expected Open threads on the card of other')
    await page.click(open)
    await eventually(() => {
      expect(new URLSearchParams(window.location.search).get('thread')).toBe(OTHER_THREAD)
      expect(page.container.textContent).toContain('Tidying README.md')
    })
    expect(pageInUrl()).toEqual([null, null])
    expect(pageRegion(page)).toBeNull()
    expect(projectsLink().getAttribute('aria-current')).toBeNull()
    await popTo(onProjects)
    expect(pageHeading(page)).toBe('Projects')
  } finally {
    window.history.replaceState(null, '', '/')
    await page.unmount()
  }
})

// The comment on #870: one project read three sizes in the prototype. One sum, so one number.
test('⚠ each project’s card says the size Settings › Storage says for it — a partial one as "at least", never exact (#870)', async () => {
  const page = await openDeletable({
    projects: [LAUNCH_PROJECT, OTHER_PROJECT],
    trees: () => ({ projects: [LAUNCH_TREES, OTHER_TREES] }),
  })
  try {
    await page.click(buttonIn(page, '#threads-rail', 'Projects'))
    const cards = await eventually(() => {
      const read = [onDiskIn(projectCard(page, 'launch')), onDiskIn(projectCard(page, 'other'))]
      expect(read.join()).not.toContain('measuring')
      return read
    })
    const settings = await openStorage(page)
    await eventually(() => expect(settings.textContent).not.toContain('Measuring…'))
    const storage = ['launch', 'other'].map((title) => {
      const heading = settings.querySelector(`section[aria-label="trees of ${title}"] h3`)
      if (heading === null) throw new Error(`expected Storage's group of ${title}`)
      return onDiskIn(heading)
    })
    expect(cards).toEqual(storage)
    // 412 MB + 2.1 GB, the unreadable tree not counted as 0; 88 MB + at least 300 MB.
    expect(cards).toEqual([
      'at least 2.5 GB on disk (partial: 1 of 3 not fully read)',
      'at least 388 MB on disk (partial: 1 of 2 not fully read)',
    ])
  } finally {
    window.history.replaceState(null, '', '/')
    await page.unmount()
  }
})

/** The project page's place in the URL: its project and tab. */
const projectInUrl = (): [string | null, string | null, string | null] => {
  const shown = new URLSearchParams(window.location.search)
  return [shown.get('page'), shown.get('project'), shown.get('tab')]
}

// #871: the project settings dialog is the project's page now. Every way in reaches it at its URL:
// a card's Settings and the rail's ⋯ at the Worktrees tab, Settings › Storage's group at Storage.
// @pins resume/url-names-page
test('a project’s page opens at its URL from a card’s Settings, the rail’s ⋯ and Storage’s group — the same size there; back walks them (#871)', async () => {
  const page = await openDeletable({
    projects: [LAUNCH_PROJECT, OTHER_PROJECT],
    trees: () => ({ projects: [LAUNCH_TREES, OTHER_TREES] }),
  })
  try {
    const menu = page.container.querySelector<HTMLElement>('button[aria-label="more for other"]')
    await flush(async () => {
      // Radix opens a menu on a primary-button pointerdown.
      menu?.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, pointerType: 'mouse' }))
      await tick()
    })
    const item = await eventually(() => {
      const found = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        (candidate) => candidate.textContent === 'Project settings…',
      )
      if (found === undefined) throw new Error('expected Project settings… in the menu of other')
      return found
    })
    await page.click(item)
    expect(projectInUrl()).toEqual(['project', 'p-other', 'worktrees'])
    expect(pageHeading(page)).toBe('other')
    await popTo(`?thread=${DELETABLE}`)
    await page.click(buttonIn(page, '#threads-rail', 'Projects'))
    const settings = [...projectCard(page, 'other').querySelectorAll('button')].find(
      (button) => button.textContent === 'Settings',
    )
    if (settings === undefined) throw new Error('expected Settings on the card of other')
    await page.click(settings)
    expect(projectInUrl()).toEqual(['project', 'p-other', 'worktrees'])
    expect(pageHeading(page)).toBe('other')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(pageRegion(page)?.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Worktree settings')
    // Still under Projects: its link stays marked.
    expect(buttonIn(page, '#threads-rail', 'Projects').getAttribute('aria-current')).toBe('page')

    const storage = await openStorage(page)
    const group = await eventually(() => {
      const found = storage.querySelector('section[aria-label="trees of other"]')
      if (found === null) throw new Error("expected Storage's group of other")
      return found
    })
    const said = onDiskIn(group.querySelector('h3') ?? group)
    await page.click(buttonIn(page, 'section[aria-label="trees of other"] h3', 'Open project'))
    expect(projectInUrl()).toEqual(['project', 'p-other', 'storage'])
    const tab = await eventually(() => {
      const found = pageRegion(page)?.querySelector('section[aria-label="trees of other"]')
      if (found === null || found === undefined) throw new Error("expected the project's Storage tab")
      return found
    })
    expect(onDiskIn(tab)).toBe(said)
    await popTo(`?thread=${DELETABLE}&page=settings&section=storage`)
    expect(pageRegion(page)?.querySelector('h2')?.textContent).toBe('Storage')
  } finally {
    window.history.replaceState(null, '', '/')
    await page.unmount()
  }
})

// #939: a project's page renames it in place, as a thread's header does (#879). Escape sends
// nothing; Enter saves, and the page, the rail and Projects show the name the server now lists.
test('a project’s title renames it in place: Escape sends nothing, Enter saves — the page, the rail and Projects show the new name (#939)', async () => {
  const page = await openDeletable({ projects: [LAUNCH_PROJECT, OTHER_PROJECT] })
  try {
    await page.click(buttonIn(page, '#threads-rail', 'Projects'))
    const settings = [...projectCard(page, 'other').querySelectorAll('button')].find(
      (button) => button.textContent === 'Settings',
    )
    if (settings === undefined) throw new Error('expected Settings on the card of other')
    await page.click(settings)
    const titleButton = (): HTMLButtonElement | null =>
      page.container.querySelector<HTMLButtonElement>('#page-heading button[aria-label^="Rename project"]')
    const field = (): HTMLInputElement | null =>
      page.container.querySelector<HTMLInputElement>('header input[aria-label="project name"]')
    const open = async (): Promise<HTMLInputElement> => {
      const button = titleButton()
      if (button === null) throw new Error('expected the project title as a button')
      await page.click(button)
      return eventually(() => {
        const found = field()
        if (found === null) throw new Error('expected the project name field')
        return found
      })
    }
    const first = await open()
    expect(document.activeElement).toBe(first)
    expect(first.value).toBe('other')
    expect(document.getElementById(first.getAttribute('aria-describedby') ?? '')?.textContent).toBe(
      'Enter to save · Escape to cancel · the folder keeps its name',
    )
    await typeOver(first, 'never sent')
    await pressKey(first, 'Escape')
    expect(field()).toBeNull()
    expect(document.activeElement).toBe(titleButton())
    expect(page.server.projectTitles).toEqual([])

    const again = await open()
    await typeOver(again, '  Ledger  ')
    await pressKey(again, 'Enter')
    await eventually(() => {
      expect(field()).toBeNull()
      expect(pageHeading(page)).toBe('Ledger')
    })
    expect(page.server.projectTitles).toEqual([{ projectId: 'p-other', body: { title: 'Ledger' } }])
    // The path under the title is the folder's, unchanged.
    expect(page.container.querySelector('header p.font-mono')?.textContent).toBe('/other')
    expect(page.container.querySelector('button[aria-label="more for Ledger"]')).not.toBeNull()
    await page.click(buttonIn(page, '#threads-rail', 'Projects'))
    expect(projectCard(page, 'Ledger')).toBeDefined()
  } finally {
    window.history.replaceState(null, '', '/')
    await page.unmount()
  }
})
