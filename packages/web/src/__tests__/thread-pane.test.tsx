import { afterAll, afterEach, expect, spyOn, test } from 'bun:test'
import {
  ENSO_GUARD_DENIAL_ENTRY,
  ENSO_PROVIDER_REFUSAL_KEY,
  type EnsoGitFileChange,
  type EnsoGitRepository,
  type EnsoThreadHistory,
  type EnsoThreadStats,
} from '@enso/core'
import type { UIMessage } from '@tanstack/ai-client'
import { act } from 'react'
import type { createRoot as CreateRoot, Root } from 'react-dom/client'
import { ChatScreen, ThreadPane, type ThreadView } from '../chat-screen.tsx'
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
 * Every in-flight reading in `chat-screen.tsx` — the status bar, the stop button, the mode
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
  readonly modeSelect: () => HTMLSelectElement
  readonly composer: () => HTMLTextAreaElement
  /** The views the pane asked the page for, in order (#361) — the page is not mounted here. */
  readonly requestedViews: ThreadView[]
}

async function mountPane(
  options: {
    active?: boolean
    debugOpen?: boolean
    view?: ThreadView
    server?: ScriptedFetchOptions
    /** Leave the Start-a-session dialog open (#391); closed otherwise, as Escape would. */
    startSession?: boolean
    /** The page's GLOBAL fetch — the scripted server's unless a test sets a tripwire (#404). */
    globalFetch?: typeof fetch
    /** Mount a STORED thread, as a reload does (`adoptThread`), instead of minting a new one. */
    history?: EnsoThreadHistory
  } = {},
): Promise<MountedPane> {
  const server = createScriptedFetch(options.server ?? {})
  // What the page itself fetches outside a thread; a pane's own requests go through its thread's.
  globalThis.fetch = options.globalFetch ?? server.fetch
  const stores = options.history === undefined ? mintThread(server.fetch) : adoptThread(options.history, server.fetch)
  // A minted thread opens on the Start-a-session dialog (#391). These tests are about the pane
  // behind it, so it is closed first — as the person pressing Escape would — unless one asks.
  stores.startSession.set(options.startSession ?? false)
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  const requestedViews: ThreadView[] = []
  const render = (active: boolean): void =>
    root.render(
      <ThreadPane
        threadId={stores.threadId}
        active={active}
        debugOpen={options.debugOpen ?? false}
        view={options.view ?? 'chat'}
        onView={(view: ThreadView): void => {
          requestedViews.push(view)
        }}
      />,
    )
  await flush(async () => {
    render(options.active ?? true)
  })
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
      await flush(async () => {
        render(active)
        await tick()
      })
    },
    status: () => one('#thread-status').textContent ?? '',
    stopButton: () => container.querySelector<HTMLButtonElement>('button[aria-label="stop the run"]'),
    sendButton: () => one<HTMLButtonElement>('button[aria-label="send message"]'),
    modeSelect: () => one<HTMLSelectElement>('select'),
    composer: () => one<HTMLTextAreaElement>('textarea[name="message"]'),
    requestedViews,
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

test('⚠ busy on the wire → working, stop offered, mode select disabled, rail busy; settled → idle, all back', async () => {
  const pane = await mountPane()
  expect(pane.status()).toContain('idle')
  expect(pane.stopButton()).toBeNull()
  expect(pane.modeSelect().disabled).toBe(false)
  expect(railBusy(pane.stores.threadId)).toBe(false)

  // Another tab's run: busy with no receipt of ours. `isLoading` would never rise for this
  // — it is TanStack's request-local flag — so a reading on it shows idle here and fails.
  await pane.settle({ ...SNAPSHOT_IDLE, live: true, busy: true, generation: 3 })
  await eventually(() => {
    expect(pane.status()).toContain('working')
    expect(pane.stopButton()).not.toBeNull()
    expect(pane.modeSelect().disabled).toBe(true)
    expect(railBusy(pane.stores.threadId)).toBe(true)
  })

  await pane.settle(
    { type: 'observation', seq: 1, observation: { kind: 'settled' } },
    { type: 'status', live: true, busy: false, generation: 3 },
  )
  await eventually(() => {
    expect(pane.status()).toContain('idle')
    expect(pane.stopButton()).toBeNull()
    expect(pane.modeSelect().disabled).toBe(false)
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
    { type: 'observation', seq: 2, observation: { kind: 'settled' } },
    { type: 'status', live: true, busy: false, generation: 1 },
  )
  await eventually(() => {
    expect(pane.container.textContent).toContain('summary of what came before')
    expect(pane.container.textContent).not.toContain('the long old answer')
  })
  await pane.unmount()
})

test("the snapshot's mode is the select's value; the host's mode observation moves it (#84, #95, L3)", async () => {
  const pane = await mountPane()
  await pane.settle({ ...SNAPSHOT_IDLE, permissionMode: { mode: 'plan', available: ['default', 'plan', 'auto'] } })
  await eventually(() => {
    expect(pane.modeSelect().value).toBe('plan')
    expect([...pane.modeSelect().options].map((option) => option.value)).toEqual(['default', 'plan', 'auto'])
  })
  await pane.settle({
    type: 'observation',
    seq: 1,
    observation: { kind: 'permission-mode', mode: 'auto', available: ['default', 'plan', 'auto'] },
  })
  await eventually(() => expect(pane.modeSelect().value).toBe('auto'))
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
 * the names in `chat-screen.tsx`. Renaming a control fails both; editing a constant fails the
 * gate. (⚠ The spec cannot be read from here: `packages/web/src` is the browser zone and
 * fallow refuses a browser → test edge. The names are literal on purpose.)
 */
test("⚠ the composer's e2e selectors match the rendered markup, and the spec's settle gate is false mid-run", async () => {
  const pane = await mountPane()
  await pane.settle(SNAPSHOT_IDLE)
  const stopByName = (): number => pane.container.querySelectorAll('button[aria-label="stop the run"]').length
  await eventually(() => {
    expect(pane.composer().placeholder).toBe('ask pi something')
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
    { type: 'observation', seq: 1, observation: { kind: 'settled' } },
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
test('the model chip and thinking level follow the snapshot; picking a model POSTs …/command; a refusal is a notice', async () => {
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
    const found = pane.container.querySelector<HTMLButtonElement>('button[aria-label="model"]')
    if (found === null) throw new Error('expected the model chip')
    return found
  }
  await eventually(() => expect(chip().textContent).toContain('default until the thread runs'))
  expect(pane.container.querySelector('[aria-label="thinking level"]')).toBeNull()

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
    expect(pane.container.querySelector('[aria-label="thinking level"]')?.textContent).toBe('medium')
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
    expect(pane.container.querySelector('[aria-label="thinking level"]')?.textContent).toBe('high')
  })
  await pane.unmount()
})

// #434: a cold thread's snapshot names what its branch last ran on. The chip says it, marked
// recorded — never as live, so no thinking select (the levels are pi's to offer once built) —
// and the live snapshot replaces it once the thread runs.
test('a cold thread shows its recorded model on the chip, marked recorded; the live snapshot wins once it runs', async () => {
  const pane = await mountPane()
  await pane.settle({
    ...SNAPSHOT_IDLE,
    recordedModel: { model: { provider: 'anthropic', modelId: 'claude-sonnet-5' }, thinkingLevel: 'medium' },
  })
  const chip = (): HTMLButtonElement => {
    const found = pane.container.querySelector<HTMLButtonElement>('button[aria-label="model"]')
    if (found === null) throw new Error('expected the model chip')
    return found
  }
  await eventually(() => expect(chip().textContent).toBe('model (recorded): claude-sonnet-5 · anthropic · medium'))
  expect(pane.container.querySelector('[aria-label="thinking level"]')).toBeNull()

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
    expect(chip().textContent).toBe('modelFake One· fake')
    expect(pane.container.querySelector('[aria-label="thinking level"]')?.textContent).toBe('high')
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
    { type: 'observation', seq: 3, observation: { kind: 'settled' } },
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
        // The branch agrees with the host (picc's modes entry says plan): the one disagreement is the page's.
        entries: [{ kind: 'custom', id: 'm1', customType: 'modes', data: { mode: 'plan' } }],
      },
    },
  })
  // The snapshot says default; the server's inspection says plan. The pane must say so — once.
  await pane.settle({ ...SNAPSHOT_IDLE, generation: 3 })
  const debug = pane.container.querySelector('[aria-label="session debug"]') ?? pane.container
  const mismatches = (): number => (debug.textContent?.match(/MISMATCH/g) ?? []).length
  await eventually(() => {
    expect(debug.textContent).toContain('host mode: plan')
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
    expect(pane.modeSelect().value).toBe('plan')
    expect(debug.textContent).toContain('host mode: plan')
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
  await pane.settle(SNAPSHOT_IDLE)
  await eventually(() => expect(pane.status()).toContain('main· clean'))
  const beforeRun = reads
  await flush(async () => {
    typeInto(pane.composer(), 'edit it')
    pressEnter(pane.composer())
    await tick()
  })
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

// #452: the Changes view — the tree of every file that differs from the last push, the chosen
// file's diff side by side, a directory folded away, and a read again when a tool result settles.
test('the Changes view lists the tree, shows the chosen file, folds a directory, and reads again on a settled call (#452)', async () => {
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
    server: { changes: () => ({ git: repository, files, truncated: false }) },
  })
  await pane.settle(SNAPSHOT_IDLE)
  const panel = (): HTMLElement => {
    const found = pane.container.querySelector<HTMLElement>('#thread-view-changes')
    if (found === null) throw new Error('expected the Changes panel')
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
    await pane.settle(SNAPSHOT_IDLE)
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
    await flush(async () => rows[1]?.click())
    await eventually(() => expect(pane.container.textContent).toContain('that call is not in the transcript on screen'))
    expect(pane.requestedViews).toEqual([])
    await flush(async () => rows[0]?.click())
    expect(pane.requestedViews).toEqual(['chat'])
    await eventually(() =>
      expect(scrolled).toEqual([pane.container.querySelector('[data-tool-call-id="c1"]') as Element]),
    )
    await pane.unmount()
  } finally {
    scroll.mockRestore()
  }
})

// ── the page (#90): the rail, New Thread, switching, earlier threads, resume (#95) ───────

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
  // The rail's two kinds of row, across every project's section (#395): open on this page, and earlier.
  const buttons = (list: 'open' | 'earlier'): HTMLButtonElement[] => [
    ...container.querySelectorAll<HTMLButtonElement>(`ol[aria-label^="${list} threads in"] button`),
  ]
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

// #361: Chat and Stats are the page's views, as tabs in the header. One choice for the page:
// the view shown is the ACTIVE thread's, and it follows a switch of thread.
test('the Stats tab replaces the transcript in the thread on screen, and follows a switch of thread', async () => {
  const page = await mountPage()
  const byText = (text: string): HTMLButtonElement => {
    const found = [...page.container.querySelectorAll('button')].find((button) => button.textContent === text)
    if (found === undefined) throw new Error(`expected a ${text} button`)
    return found
  }
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
  await page.click(byText('New Thread'))
  await page.click(byText('New Thread'))
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
  const older = page.activeRows()[1]
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

// #407: on a narrow screen the rail is a page of its own, behind the header's threads button.
// Choosing a thread from it must also close it — otherwise, on a phone, the thread just chosen
// stays hidden behind the rail. ⚠ happy-dom has no media queries: this reads the state the
// classes encode (`hidden` below md; the panes `max-md:hidden` while it is open), not a layout.
test('the threads button opens the rail over the thread; choosing a thread from it closes it again', async () => {
  const page = await mountPage()
  const newThread = [...page.container.querySelectorAll('button')].find((button) => button.textContent === 'New Thread')
  if (newThread === undefined) throw new Error('expected a New Thread button')
  await page.click(newThread)
  await page.click(newThread)
  const toggle = page.container.querySelector<HTMLButtonElement>('header button[aria-controls="threads-rail"]')
  const rail = page.container.querySelector<HTMLElement>('#threads-rail')
  if (toggle === null || rail === null) throw new Error('expected the threads button and the rail it controls')
  const panesHiddenNarrow = (): boolean =>
    page.container.querySelector('#thread-status')?.parentElement?.closest('.max-md\\:hidden') !== null
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  expect(rail.classList.contains('hidden')).toBe(true)
  expect(panesHiddenNarrow()).toBe(false)

  await page.click(toggle)
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
  expect(toggle.getAttribute('aria-label')).toBe('hide threads')
  expect(rail.classList.contains('hidden')).toBe(false)
  expect(panesHiddenNarrow()).toBe(true)

  const older = page.activeRows()[1]
  if (older === undefined) throw new Error('expected two rows')
  expect(older.getAttribute('aria-current')).toBeNull()
  await page.click(older)
  await eventually(() => {
    expect(older.getAttribute('aria-current')).toBe('true')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(rail.classList.contains('hidden')).toBe(true)
    expect(panesHiddenNarrow()).toBe(false)
  })
  await page.unmount()
})

// A question from pi waits in the transcript; on another view the Chat tab, the status bar and the
// rail's row say so, and nothing moves the reader (#362 review) — they switch when ready.
test('a question waiting while Stats is shown is said on the Chat tab, in the status bar and on the rail; the view stays', async () => {
  const page = await mountPage()
  const newThread = [...page.container.querySelectorAll('button')].find((button) => button.textContent === 'New Thread')
  if (newThread === undefined) throw new Error('expected a New Thread button')
  await page.click(newThread)
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

test('New Thread mints a thread, lists it in the rail as current, and shows exactly its pane', async () => {
  // `afterEach` cleared the module's first thread, so the page starts with none: header only.
  const page = await mountPage()
  expect(page.activeRows()).toHaveLength(0)
  expect(page.visiblePanes()).toHaveLength(0)
  const newThread = [...page.container.querySelectorAll('button')].find((button) => button.textContent === 'New Thread')
  if (newThread === undefined) throw new Error('expected a New Thread button')
  await page.click(newThread)
  await eventually(() => {
    expect(page.activeRows()).toHaveLength(1)
    expect(page.activeRows()[0]?.getAttribute('aria-current')).toBe('true')
    expect(page.visiblePanes()).toHaveLength(1)
  })
  await page.click(newThread)
  await eventually(() => {
    expect(page.activeRows()).toHaveLength(2)
    // Newest first, and the newest is current; one pane on screen, the other mounted off it.
    expect(page.activeRows().map((row) => row.getAttribute('aria-current'))).toEqual(['true', null])
    expect(page.visiblePanes()).toHaveLength(1)
    expect(page.container.querySelectorAll('#thread-status')).toHaveLength(2)
  })
  // Click the older row: it becomes current and its pane is the visible one.
  const older = page.activeRows()[1]
  if (older === undefined) throw new Error('expected two rows')
  await page.click(older)
  await eventually(() => {
    expect(page.activeRows().map((row) => row.getAttribute('aria-current'))).toEqual([null, 'true'])
    expect(page.visiblePanes()).toHaveLength(1)
  })
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

// docs/flows/resume.md, stated gap: the reader was pinned to produce an image part from the file
// (transcript-to-messages.test.ts); nothing asserted the PAGE renders it. A resumed thread's
// image must come back as an <img> from the server's history — no page state involved.
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
test("⚠ the URL's own thread, never held by the server, is started under that id: no error, the Start dialog open (#378)", async () => {
  const page = await mountPage()
  const unused = crypto.randomUUID()
  try {
    await visitThreadUrl(unused)
    await eventually(() => {
      expect(threadListStore.get().map((thread) => thread.threadId)).toContain(unused)
      // Radix renders the dialog into `document.body`, not inside the page's container.
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Start a session')
    })
    expect(window.location.search).toBe(`?thread=${unused}`)
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
