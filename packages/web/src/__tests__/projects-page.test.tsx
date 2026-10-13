import { afterAll, expect, test } from 'bun:test'
import type { EnsoProject, EnsoProjectSettings, EnsoStoredThread, EnsoTreesListing } from '@enso/core'
import { act } from 'react'
import type { createRoot as CreateRoot, Root } from 'react-dom/client'
import type * as ProjectsPageModule from '../projects-page.tsx'
import { ensureDom, releaseDom } from './dom-environment.ts'
import { requestedUrl } from './scripted-server.ts'

// ⚠ A DOM before react-dom/client and Radix evaluate — `command-palette.test.tsx` has the
// measurement. The remove menu is a Radix portal; hence the dynamic import below.
ensureDom()
const { createRoot }: { createRoot: typeof CreateRoot } = await import('react-dom/client')
const { ProjectsPage }: typeof ProjectsPageModule = await import('../projects-page.tsx')

/**
 * The Projects page (#870), MOUNTED over a fetch seam: the launch folder first and never offered for
 * removal, each card's badges from the project and its settings, a missing folder's card still
 * opening its threads, a size not fully read never said as exact, nothing guessed when a read
 * fails, and every action reachable from the keyboard.
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

const LAUNCH: EnsoProject = { projectId: 'p-launch', title: 'enso', path: '/code/enso', status: 'ok', launch: true }
const SPIKE: EnsoProject = {
  projectId: 'p-spike',
  title: 'spike',
  path: '/code/spike',
  status: 'missing-dir',
  launch: false,
}
const DESIGN: EnsoProject = {
  projectId: 'p-design',
  title: 'design',
  path: '/code/design',
  status: 'ok',
  launch: false,
}
const GONE: EnsoProject = {
  projectId: 'p-gone',
  title: 'gone',
  path: '/code/gone',
  status: 'missing-dir',
  launch: false,
}

const settingsOf = (projectId: string, trusted: boolean, tree: 'worktree' | 'copy' | 'off'): EnsoProjectSettings => ({
  projectId,
  path: `/code/${projectId}`,
  trusted,
  threads: {
    tree: { value: tree, tier: 'default' },
    setup: { value: [], tier: 'default' },
    copy: { value: [], tier: 'default' },
  },
  files: { user: '~/.enso/config.json', shared: '.enso/config.json', local: '.enso/config.local.json' },
  unreadable: [],
})

const SETTINGS: Readonly<Record<string, EnsoProjectSettings>> = {
  'p-launch': settingsOf('p-launch', true, 'worktree'),
  'p-spike': settingsOf('p-spike', true, 'worktree'),
  'p-design': settingsOf('p-design', false, 'copy'),
  'p-gone': settingsOf('p-gone', true, 'off'),
}

const TREES: EnsoTreesListing = {
  projects: [
    {
      projectId: 'p-launch',
      objectStore: { kind: 'measured', bytes: 100_000_000 },
      trees: [
        {
          threadId: 't-launch',
          path: '/code/enso/.enso/trees/a',
          kind: 'worktree',
          branch: 'enso/a',
          size: { kind: 'measured', bytes: 300_000_000 },
          holdsWork: null,
        },
      ],
    },
    {
      projectId: 'p-spike',
      objectStore: { kind: 'partial', bytes: 40_000_000, reason: 'not finished in time' },
      trees: [],
    },
  ],
}

const stored = (threadId: string, projectId: string, minutesAgo: number): EnsoStoredThread => ({
  threadId,
  projectId,
  title: `work in ${projectId}`,
  lastActivityAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
  messageCount: 2,
  busy: false,
})

/** What the page was asked to do, by action, each with the project it was asked for. */
interface Asked {
  readonly opened: string[]
  readonly settings: string[]
  readonly removed: string[]
}

/** A route the fetch seam answers with a refusal: its path and status. */
type Refusals = Readonly<Record<string, number>>

async function mountProjects(
  options: { projects?: readonly EnsoProject[]; refusals?: Refusals; notice?: string } = {},
): Promise<{ readonly asked: Asked; readonly container: HTMLElement; readonly unmount: () => Promise<void> }> {
  const { projects = [DESIGN, SPIKE, LAUNCH, GONE], refusals = {}, notice } = options
  const asked: Asked = { opened: [], settings: [], removed: [] }
  const fetchImpl = (input: string | URL | Request): Promise<Response> => {
    const path = requestedUrl(input)
    const refused = refusals[path]
    if (refused !== undefined) return Promise.resolve(new Response('the disk is busy', { status: refused }))
    if (path === '/api/trees') return Promise.resolve(Response.json(TREES))
    const settings = /^\/api\/projects\/([^/]+)\/settings$/.exec(path)?.[1]
    const answer = settings === undefined ? undefined : SETTINGS[decodeURIComponent(settings)]
    return Promise.resolve(answer === undefined ? new Response('no', { status: 404 }) : Response.json(answer))
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  await flush(async () => {
    root.render(
      <ProjectsPage
        fetch={fetchImpl}
        projects={{ rows: projects, error: undefined }}
        pageThreads={[]}
        stored={[stored('t-launch', 'p-launch', 3), stored('t-spike', 'p-spike', 60 * 24 * 9)]}
        currentProjectId="p-launch"
        notice={notice}
        onOpenThreads={(projectId) => asked.opened.push(projectId)}
        onSettings={(projectId) => asked.settings.push(projectId)}
        onRemove={(projectId) => asked.removed.push(projectId)}
      />,
    )
    await tick()
  })
  return {
    asked,
    container,
    unmount: async () => {
      await flush(async () => root.unmount())
      container.remove()
    },
  }
}

const cards = (container: HTMLElement): HTMLElement[] => [
  ...container.querySelectorAll<HTMLElement>('ul[aria-label="Projects"] > li'),
]
const nameOf = (card: HTMLElement): string => card.querySelector('h2')?.textContent ?? ''

function cardOf(container: HTMLElement, name: string): HTMLElement {
  const card = cards(container).find((found) => nameOf(found) === name)
  if (card === undefined) throw new Error(`expected the card of ${name}`)
  return card
}

function button(card: HTMLElement, words: string): HTMLButtonElement {
  const found = [...card.querySelectorAll('button')].find(
    (candidate) => candidate.textContent === words || candidate.getAttribute('aria-label') === words,
  )
  if (found === undefined) throw new Error(`expected ${words} on the card`)
  return found
}

/** Press a key on what has focus, as a keyboard does: down, then up. */
async function press(key: string): Promise<void> {
  await flush(async () => {
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
    document.activeElement?.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }))
    await tick()
  })
}

test('the launch folder is first, whatever order the list arrives in, and offers no remove; every other project does', async () => {
  const page = await mountProjects()
  try {
    expect(cards(page.container).map(nameOf)).toEqual(['enso', 'design', 'spike', 'gone'])
    const removable = cards(page.container).map(
      (card) => card.querySelector(`button[aria-label="remove ${nameOf(card)}"]`) !== null,
    )
    expect(removable).toEqual([false, true, true, true])
    expect(page.container.textContent).toContain('The folder Enso was started in is always first and can’t be removed.')
  } finally {
    await page.unmount()
  }
})

test('each card says what its project is: current and started here, folder missing, not trusted — and its tree mode', async () => {
  const page = await mountProjects()
  try {
    await eventually(() => expect(cardOf(page.container, 'design').textContent).toContain('not trusted'))
    const launch = cardOf(page.container, 'enso').textContent ?? ''
    expect(launch).toContain('current')
    expect(launch).toContain('started here')
    expect(launch).toContain('each thread gets a worktree')
    expect(launch).not.toContain('not trusted')
    expect(launch).not.toContain('folder missing')
    expect(cardOf(page.container, 'spike').textContent).toContain('folder missing')
    expect(cardOf(page.container, 'spike').textContent).not.toContain('current')
    expect(cardOf(page.container, 'design').textContent).toContain('each thread gets a copy')
    expect(cardOf(page.container, 'gone').textContent).toContain('threads run in the folder itself')
    expect(launch).toContain('1 thread')
    expect(launch).toContain('last active 3m')
    expect(launch).toContain('/code/enso')
  } finally {
    await page.unmount()
  }
})

test('a size is the project’s trees and snapshot store; one not fully read is "at least", never exact; none on disk is 0 B', async () => {
  const page = await mountProjects()
  try {
    await eventually(() => expect(page.container.textContent).not.toContain('measuring'))
    expect(cardOf(page.container, 'enso').textContent).toContain('400 MB on disk')
    expect(cardOf(page.container, 'enso').textContent).not.toContain('at least')
    expect(cardOf(page.container, 'spike').textContent).toContain(
      'at least 40 MB on disk (partial: 1 of 1 not fully read)',
    )
    expect(cardOf(page.container, 'design').textContent).toContain('0 B on disk')
  } finally {
    await page.unmount()
  }
})

test('a missing folder’s card still opens its threads; one with no thread kept has nothing to open', async () => {
  const page = await mountProjects()
  try {
    const spike = button(cardOf(page.container, 'spike'), 'Open threads')
    expect(spike.disabled).toBe(false)
    await flush(async () => {
      spike.click()
      await tick()
    })
    expect(page.asked.opened).toEqual(['p-spike'])
    expect(button(cardOf(page.container, 'gone'), 'Open threads').disabled).toBe(true)
    // A folder that is there opens a thread even with none kept: a new one starts in it.
    expect(button(cardOf(page.container, 'design'), 'Open threads').disabled).toBe(false)
    await flush(async () => {
      button(cardOf(page.container, 'spike'), 'Settings').click()
      await tick()
    })
    expect(page.asked.settings).toEqual(['p-spike'])
  } finally {
    await page.unmount()
  }
})

test('remove is the rail’s own menu item, from the keyboard: the trash opens it, Enter on the item asks for the removal', async () => {
  const page = await mountProjects()
  try {
    const trash = button(cardOf(page.container, 'design'), 'remove design')
    trash.focus()
    await press('Enter')
    const item = await eventually(() => {
      const found = document.querySelector<HTMLElement>('[role="menuitem"]')
      expect(found?.textContent).toBe('Remove project — its threads stay on disk')
      return found
    })
    item?.focus()
    expect(page.asked.removed).toEqual([])
    await press('Enter')
    expect(page.asked.removed).toEqual(['p-design'])
  } finally {
    await page.unmount()
  }
})

test('a read that fails is said on the card, and nothing is guessed: no size, no trust badge', async () => {
  const page = await mountProjects({
    projects: [LAUNCH, DESIGN],
    refusals: { '/api/trees': 503, '/api/projects/p-design/settings': 503 },
    notice: 'could not remove the project: 409 a thread in this project is running',
  })
  try {
    await eventually(() => expect(page.container.textContent).toContain('size not read'))
    const design = cardOf(page.container, 'design').textContent ?? ''
    expect(design).toContain('settings not read')
    expect(design).not.toContain('not trusted')
    expect(design).not.toContain('on disk')
    expect(page.container.querySelector('[role="alert"]')?.textContent).toBe(
      'could not remove the project: 409 a thread in this project is running',
    )
  } finally {
    await page.unmount()
  }
})
