import { afterAll, afterEach, expect, test } from 'bun:test'
import type { EnsoProject, EnsoProjectSettings, EnsoStoredThread } from '@enso/core'
import { act, useState } from 'react'
import type { createRoot as CreateRoot, Root } from 'react-dom/client'
import type { FetchLike } from '../browser-logging.ts'
import type { ThreadSummary } from '../thread-stores.ts'
import type { PageRoute } from '../thread-url.ts'
import type * as ThreadsRailModule from '../threads-rail.tsx'
import { ensureDom, releaseDom } from './dom-environment.ts'
import { requestedUrl } from './scripted-server.ts'

// ⚠ A DOM before react-dom/client and Radix evaluate — `command-palette.test.tsx` has the measurement.
ensureDom()
const { createRoot }: { createRoot: typeof CreateRoot } = await import('react-dom/client')
const { ThreadsRail }: typeof ThreadsRailModule = await import('../threads-rail.tsx')

/**
 * The rail's project accordions and switcher (#876), MOUNTED: the current project open and the
 * others closed, each closed one saying how many of its threads wait on you (or else run) and
 * clearing when they are answered; the switcher choosing where New thread starts, keyboard operable,
 * the current project checked, each project's trouble flagged; the reader's open and closed kept
 * across a reload.
 */

afterAll(releaseDom)
afterEach(() => globalThis.localStorage.removeItem('enso.rail.sections'))

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
  // The other callbacks are not what these tests exercise.
}

const LAUNCH: EnsoProject = { projectId: 'p-launch', title: 'enso', path: '/code/enso', status: 'ok', launch: true }
const APP: EnsoProject = { projectId: 'p-app', title: 'app', path: '/code/app', status: 'ok', launch: false }
const GONE: EnsoProject = {
  projectId: 'p-gone',
  title: 'gone',
  path: '/code/gone',
  status: 'missing-dir',
  launch: false,
}

function open(threadId: string, projectId: string, extra: Partial<ThreadSummary> = {}): ThreadSummary {
  return { threadId, title: threadId, lastActivityAt: new Date(), busy: false, waiting: false, projectId, ...extra }
}

function stored(threadId: string, projectId: string, extra: Partial<EnsoStoredThread> = {}): EnsoStoredThread {
  return {
    threadId,
    projectId,
    title: threadId,
    lastActivityAt: new Date().toISOString(),
    messageCount: 2,
    busy: false,
    waiting: false,
    ...extra,
  }
}

/** A project's settings, trusted or not — all the switcher reads of them. */
function settingsOf(project: EnsoProject, trusted: boolean): EnsoProjectSettings {
  return {
    projectId: project.projectId,
    path: project.path,
    trusted,
    threads: {
      tree: { value: 'worktree', tier: 'default' },
      setup: { value: [], tier: 'default' },
      copy: { value: [], tier: 'default' },
    },
    files: {
      user: '/home/me/.enso/config.json',
      shared: `${project.path}/.enso/config.json`,
      local: `${project.path}/.enso/config.local.json`,
    },
    unreadable: [],
  }
}

/** The server's settings for each project: the launch folder trusted, the app not; the gone one unread. */
const fetchSettings: FetchLike = (input) => {
  const id = /^\/api\/projects\/([^/]+)\/settings$/.exec(requestedUrl(input))?.[1]
  const answer = { 'p-launch': settingsOf(LAUNCH, true), 'p-app': settingsOf(APP, false) }[decodeURIComponent(id ?? '')]
  return Promise.resolve(answer === undefined ? new Response('no', { status: 404 }) : Response.json(answer))
}

/** What the rail asked of the page. */
interface Asked {
  readonly started: (string | undefined)[]
  readonly opened: string[]
  readonly selected: string[]
  readonly pages: PageRoute[]
}

interface Scene {
  readonly projects: readonly EnsoProject[]
  readonly threads: readonly ThreadSummary[]
  readonly earlier?: readonly EnsoStoredThread[]
  readonly activeThreadId: string | undefined
}

/**
 * The rail as the page holds it: choosing a project opens its latest thread on this page, and a
 * row shown is the thread on screen — so the current project follows, as it does in `ChatScreen`.
 */
function Page({ scene, asked }: { scene: Scene; asked: Asked }): React.ReactNode {
  const [active, setActive] = useState(scene.activeThreadId)
  return (
    <ThreadsRail
      projects={scene.projects}
      threads={scene.threads}
      activeThreadId={active}
      earlier={scene.earlier ?? []}
      earlierError={undefined}
      fetch={fetchSettings}
      onSelect={(threadId) => {
        asked.selected.push(threadId)
        setActive(threadId)
      }}
      onResume={noop}
      onNew={(projectId) => asked.started.push(projectId)}
      onOpenProject={(projectId) => {
        asked.opened.push(projectId)
        setActive(scene.threads.find((thread) => thread.projectId === projectId)?.threadId)
      }}
      onRemoveProject={noop}
      onProjectSettings={noop}
      onPage={(route) => asked.pages.push(route)}
      projectNotice={undefined}
    />
  )
}

interface Mounted {
  readonly asked: Asked
  readonly rail: () => HTMLElement
  /** The scene changed under the rail — a question answered, a run ended — with the page's own state kept. */
  readonly rerender: (scene: Scene) => Promise<void>
  /** A section's header, by its name. */
  readonly header: (name: string) => HTMLButtonElement
  readonly button: (name: string) => HTMLButtonElement
  readonly click: (target: HTMLElement) => Promise<void>
  readonly key: (target: Element | null, key: string) => Promise<void>
  /** Open the switcher with a pointer, as Radix opens a menu: its entries, once it is open. */
  readonly openSwitcher: () => Promise<HTMLElement[]>
  readonly unmount: () => Promise<void>
}

async function mount(scene: Scene): Promise<Mounted> {
  const asked: Asked = { started: [], opened: [], selected: [], pages: [] }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  await flush(async () => {
    root.render(<Page scene={scene} asked={asked} />)
    await tick()
  })
  const rail = (): HTMLElement => {
    const found = container.querySelector<HTMLElement>('nav[aria-label="threads"]')
    if (found === null) throw new Error('expected the rail')
    return found
  }
  const header = (name: string): HTMLButtonElement => {
    const found = rail().querySelector<HTMLButtonElement>(`section[aria-label="${name}"] button[aria-expanded]`)
    if (found === null) throw new Error(`expected the ${name} section`)
    return found
  }
  const button = (name: string): HTMLButtonElement => {
    const found = [...rail().querySelectorAll<HTMLButtonElement>('button')].find(
      (candidate) => candidate.getAttribute('aria-label') === name || candidate.textContent === name,
    )
    if (found === undefined) throw new Error(`expected the ${name} button`)
    return found
  }
  const click = async (target: HTMLElement): Promise<void> => {
    await flush(async () => {
      target.click()
      await tick()
    })
  }
  const key = async (target: Element | null, pressed: string): Promise<void> => {
    await flush(async () => {
      target?.dispatchEvent(new KeyboardEvent('keydown', { key: pressed, bubbles: true, cancelable: true }))
      await tick()
    })
  }
  const switcher = (): HTMLButtonElement => {
    const found = rail().querySelector<HTMLButtonElement>('button[aria-label$="Switch project"]')
    if (found === null) throw new Error('expected the switcher')
    return found
  }
  return {
    asked,
    rail,
    rerender: async (next) => {
      await flush(async () => {
        root.render(<Page scene={next} asked={asked} />)
        await tick()
      })
    },
    header,
    button,
    click,
    key,
    openSwitcher: async () => {
      await flush(async () => {
        switcher().dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, pointerType: 'mouse' }))
        await tick()
      })
      return eventually(() => {
        const items = [...document.querySelectorAll<HTMLElement>('[role="menu"] [role^="menuitem"]')]
        expect(items.length).toBeGreaterThan(0)
        return items
      })
    },
    unmount: async () => {
      await flush(async () => root.unmount())
      container.remove()
    },
  }
}

const switcherLabel = (mounted: Mounted): string | null =>
  mounted.rail().querySelector('button[aria-label$="Switch project"]')?.getAttribute('aria-label') ?? null

const sectionRows = (mounted: Mounted, name: string): string[] =>
  [...mounted.rail().querySelectorAll<HTMLButtonElement>(`section[aria-label="${name}"] button[data-thread-id]`)].map(
    (row) => row.dataset.threadId ?? '',
  )

test('⚠ a thread waiting on you in a closed project is a signal with its count, without opening it, and it clears when answered (#876)', async () => {
  const here = open('here', 'p-launch')
  const asks = open('asks', 'p-app', { busy: true, waiting: true })
  const asksToo = open('asks-too', 'p-app', { busy: true, waiting: true })
  const works = open('works', 'p-app', { busy: true })
  const scene = (threads: ThreadSummary[]): Scene => ({
    projects: [LAUNCH, APP],
    threads: [here, ...threads],
    activeThreadId: 'here',
  })
  const mounted = await mount(scene([asks, asksToo, works]))
  // The current project is open; the other is closed, its rows not drawn — its header says what waits.
  expect(mounted.header('enso').getAttribute('aria-expanded')).toBe('true')
  expect(mounted.header('app').getAttribute('aria-expanded')).toBe('false')
  expect(sectionRows(mounted, 'app')).toEqual([])
  expect(mounted.header('app').textContent).toContain('2 waiting on you')
  expect(mounted.header('app').textContent).not.toContain('running')

  // Both questions answered, two runs still in flight: the signal says running, with its count.
  await mounted.rerender(scene([{ ...asks, waiting: false }, { ...asksToo, waiting: false }, works]))
  expect(mounted.header('app').textContent).not.toContain('waiting on you')
  expect(mounted.header('app').textContent).toContain('3 running')

  // Every run over: nothing to say.
  await mounted.rerender(
    scene([
      { ...asks, waiting: false, busy: false },
      { ...works, busy: false },
    ]),
  )
  expect(mounted.header('app').textContent).toBe('app')
  // Opened, the header says nothing; the rows do.
  await mounted.rerender(scene([asks]))
  await mounted.click(mounted.header('app'))
  expect(sectionRows(mounted, 'app')).toEqual(['asks'])
  expect(mounted.header('app').textContent).toBe('app')
  await mounted.unmount()
})

// After a reload the page holds no store for a thread in another project: only the server's listing
// says it is parked on a question (#876). Read as merely running, a permission ask would be understated.
test('⚠ after a reload, a closed project says "waiting on you" from the listing alone, with no page store for the thread; answered, it says running (#876)', async () => {
  const here = open('here', 'p-launch')
  const scene = (earlier: EnsoStoredThread[]): Scene => ({
    projects: [LAUNCH, APP],
    threads: [here],
    earlier,
    activeThreadId: 'here',
  })
  const asks = stored('asks', 'p-app', { busy: true, waiting: true })
  const works = stored('works', 'p-app', { busy: true })
  const mounted = await mount(scene([asks, works]))
  expect(mounted.header('app').getAttribute('aria-expanded')).toBe('false')
  expect(mounted.header('app').textContent).toContain('1 waiting on you')
  expect(mounted.header('app').textContent).not.toContain('running')
  // Opened, the stored row itself says it.
  await mounted.click(mounted.header('app'))
  const row = mounted.rail().querySelector<HTMLElement>('button[data-thread-id="asks"]')
  expect(row?.textContent).toContain('waiting on you')
  expect(row?.title).toBe('waiting on you — open it to answer')
  await mounted.click(mounted.header('app'))

  // The listing refreshed after the answer: the run goes on, nothing waits.
  await mounted.rerender(scene([{ ...asks, waiting: false }, works]))
  expect(mounted.header('app').textContent).not.toContain('waiting on you')
  expect(mounted.header('app').textContent).toContain('2 running')
  await mounted.unmount()
})

test('choosing a project in the switcher makes it current: New thread starts there, and the rail opens it and closes the one left (#876)', async () => {
  const mounted = await mount({
    projects: [LAUNCH, APP],
    threads: [open('in-launch', 'p-launch'), open('in-app', 'p-app')],
    activeThreadId: 'in-launch',
  })
  expect(switcherLabel(mounted)).toBe('Project: enso. Switch project')
  await mounted.click(mounted.button('New thread'))
  expect(mounted.asked.started).toEqual(['p-launch'])

  const items = await mounted.openSwitcher()
  // The current project is checked — for a screen reader too.
  const checked = items.filter((item) => item.getAttribute('aria-checked') === 'true').map((item) => item.textContent)
  expect(checked).toEqual(['enso/code/enso'])
  const app = items.find((item) => item.textContent?.startsWith('app'))
  if (app === undefined) throw new Error('expected app in the switcher')
  await mounted.click(app)
  expect(mounted.asked.opened).toEqual(['p-app'])
  expect(switcherLabel(mounted)).toBe('Project: app. Switch project')
  expect(mounted.header('app').getAttribute('aria-expanded')).toBe('true')
  expect(mounted.header('enso').getAttribute('aria-expanded')).toBe('false')
  await mounted.click(mounted.button('New thread'))
  expect(mounted.asked.started).toEqual(['p-launch', 'p-app'])

  // Choosing the current project again goes nowhere.
  const again = (await mounted.openSwitcher()).find((item) => item.textContent?.startsWith('app'))
  if (again === undefined) throw new Error('expected app in the switcher')
  await mounted.click(again)
  expect(mounted.asked.opened).toEqual(['p-app'])
  await mounted.unmount()
})

test('opening a thread of another project makes that project current (#876)', async () => {
  const mounted = await mount({
    projects: [LAUNCH, APP],
    threads: [open('in-launch', 'p-launch'), open('in-app', 'p-app')],
    activeThreadId: 'in-launch',
  })
  await mounted.click(mounted.header('app'))
  await mounted.click(mounted.rail().querySelector<HTMLElement>('button[data-thread-id="in-app"]') ?? document.body)
  expect(mounted.asked.selected).toEqual(['in-app'])
  expect(switcherLabel(mounted)).toBe('Project: app. Switch project')
  await mounted.click(mounted.button('New thread'))
  expect(mounted.asked.started).toEqual(['p-app'])
  await mounted.unmount()
})

test('the switcher is keyboard operable: Enter opens it, the arrows move, Enter chooses, Escape closes (#876)', async () => {
  const mounted = await mount({
    projects: [LAUNCH, APP],
    threads: [open('in-launch', 'p-launch'), open('in-app', 'p-app')],
    activeThreadId: 'in-launch',
  })
  const trigger = mounted.rail().querySelector<HTMLButtonElement>('button[aria-label$="Switch project"]')
  trigger?.focus()
  await mounted.key(trigger, 'Enter')
  await eventually(() => expect(document.activeElement?.getAttribute('role')).toBe('menuitemradio'))
  expect(document.activeElement?.textContent).toStartWith('enso/code/enso')
  await mounted.key(document.activeElement, 'ArrowDown')
  await eventually(() => expect(document.activeElement?.textContent).toStartWith('app/code/app'))
  await mounted.key(document.activeElement, 'Escape')
  await eventually(() => expect(document.querySelector('[role="menu"]')).toBeNull())
  await eventually(() => expect(document.activeElement === trigger).toBe(true))
  expect(mounted.asked.opened).toEqual([])

  await mounted.key(trigger, 'ArrowDown')
  await eventually(() => expect(document.activeElement?.getAttribute('role')).toBe('menuitemradio'))
  await mounted.key(document.activeElement, 'ArrowDown')
  await eventually(() => expect(document.activeElement?.textContent).toStartWith('app/code/app'))
  await mounted.key(document.activeElement, 'Enter')
  await eventually(() => expect(mounted.asked.opened).toEqual(['p-app']))
  await mounted.unmount()
})

test('⚠ the switcher flags a missing folder and an untrusted project; lists the threads in no project with their count; opens Add project and Projects (#876)', async () => {
  const minutesAgo = (minutes: number): Date => new Date(Date.now() - minutes * 60_000)
  const mounted = await mount({
    projects: [LAUNCH, APP, GONE],
    threads: [
      open('in-launch', 'p-launch'),
      // The newest thread in no project is a draft: it holds nothing, so it is not what opens.
      open('orphan-draft', 'p-removed', { title: undefined }),
      open('orphan', 'p-removed', { lastActivityAt: minutesAgo(1) }),
    ],
    earlier: [{ ...stored('orphan-stored', 'p-removed'), lastActivityAt: minutesAgo(2).toISOString() }],
    activeThreadId: 'in-launch',
  })
  const entries = async (): Promise<HTMLElement[]> => {
    const items = await mounted.openSwitcher()
    // The trust reads land after the menu opens.
    await eventually(() =>
      expect(items.find((item) => item.textContent?.startsWith('app'))?.textContent).toContain('not trusted'),
    )
    return items
  }
  const items = await entries()
  const entry = (start: string): HTMLElement => {
    const found = items.find((item) => item.textContent?.startsWith(start))
    if (found === undefined) throw new Error(`expected ${start} in the switcher`)
    return found
  }
  expect(entry('enso').textContent).toBe('enso/code/enso')
  expect(entry('app').textContent).toBe('app/code/appnot trusted')
  // Its folder gone and no thread in it: flagged, and nothing to choose.
  expect(entry('gone').textContent).toContain('folder missing')
  expect(entry('gone').getAttribute('aria-disabled')).toBe('true')
  expect(entry('Not in a project').textContent).toBe('Not in a project3 threads')
  expect(items.map((item) => item.textContent).slice(-2)).toEqual(['Add project…', 'Manage projects'])

  // The threads in no project: the latest that holds something opens, and they are current.
  await mounted.click(entry('Not in a project'))
  expect(mounted.asked.selected).toEqual(['orphan'])
  expect(switcherLabel(mounted)).toBe('Project: Not in a project. Switch project')

  const add = (await entries()).find((item) => item.textContent === 'Add project…')
  await mounted.click(add ?? document.body)
  const manage = (await entries()).find((item) => item.textContent === 'Manage projects')
  await mounted.click(manage ?? document.body)
  expect(mounted.asked.pages).toEqual([{ kind: 'add-project' }, { kind: 'projects' }])
  await mounted.unmount()
})

test('⚠ open and closed survive a reload per project; arriving in a project opens it, and leaving closes it again (#876)', async () => {
  const scene: Scene = {
    projects: [LAUNCH, APP],
    threads: [open('in-launch', 'p-launch'), open('in-app', 'p-app')],
    activeThreadId: 'in-launch',
  }
  const first = await mount(scene)
  // The reader opens the other project and closes the current one.
  await first.click(first.header('app'))
  await first.click(first.header('enso'))
  expect(first.header('app').getAttribute('aria-expanded')).toBe('true')
  expect(first.header('enso').getAttribute('aria-expanded')).toBe('false')
  await first.unmount()

  // A reload lands on the same thread: no arrival, the rail as it was left.
  const reloaded = await mount(scene)
  expect(reloaded.header('app').getAttribute('aria-expanded')).toBe('true')
  expect(reloaded.header('enso').getAttribute('aria-expanded')).toBe('false')
  // Closed again, then arrived in through the switcher: it opens.
  await reloaded.click(reloaded.header('app'))
  expect(reloaded.header('app').getAttribute('aria-expanded')).toBe('false')
  const app = (await reloaded.openSwitcher()).find((item) => item.textContent?.startsWith('app'))
  await reloaded.click(app ?? document.body)
  expect(reloaded.header('app').getAttribute('aria-expanded')).toBe('true')
  // Back to the launch project: it opens though the reader had closed it; the one left closes.
  const launch = (await reloaded.openSwitcher()).find((item) => item.textContent?.startsWith('enso'))
  await reloaded.click(launch ?? document.body)
  expect(reloaded.header('enso').getAttribute('aria-expanded')).toBe('true')
  expect(reloaded.header('app').getAttribute('aria-expanded')).toBe('false')
  await reloaded.unmount()

  const again = await mount({ ...scene, activeThreadId: 'in-launch' })
  expect(again.header('enso').getAttribute('aria-expanded')).toBe('true')
  expect(again.header('app').getAttribute('aria-expanded')).toBe('false')
  await again.unmount()
})
