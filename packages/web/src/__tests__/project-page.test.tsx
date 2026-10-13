import { afterAll, expect, test } from 'bun:test'
import type {
  EnsoProject,
  EnsoProjectSettings,
  EnsoStoredThread,
  EnsoTreeSetupOutcome,
  EnsoTreesListing,
} from '@enso/core'
import { act, useState } from 'react'
import type { createRoot as CreateRoot, Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ListingState } from '../listing-store.ts'
import type * as PageModule from '../project-page.tsx'
import type { PageRoute } from '../thread-url.ts'
import type * as RailModule from '../threads-rail.tsx'
import type * as ReportModule from '../tree-setup-report.tsx'
import { ensureDom, releaseDom } from './dom-environment.ts'
import { requestedUrl } from './scripted-server.ts'

// ⚠ A DOM before react-dom/client and Radix evaluate — `command-palette.test.tsx` has the
// measurement. The menu, the tabs and the dialogs are Radix; hence the imports below are dynamic.
ensureDom()
const { createRoot }: { createRoot: typeof CreateRoot } = await import('react-dom/client')
const { ProjectPage }: typeof PageModule = await import('../project-page.tsx')
const { ThreadsRail }: typeof RailModule = await import('../threads-rail.tsx')
const { TreeSetupReport }: typeof ReportModule = await import('../tree-setup-report.tsx')

/**
 * A project's page (#871; its Worktrees tab was the project settings dialog, #754), MOUNTED over a
 * fetch seam: the tabs at the route's, keyboard operable; each tiered value with the file it comes
 * from, and a Save that writes only what changed to the file chosen; the project's threads with
 * their models; its trees; the missing-folder and untrusted banners; and the Remove card saying
 * what the server's removal does.
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
  // The other callbacks are not what these tests exercise.
}

const LAUNCH: EnsoProject = { projectId: 'p-launch', title: 'enso', path: '/code/enso', status: 'ok', launch: true }
const APP: EnsoProject = { projectId: 'p-app', title: 'app', path: '/code/app', status: 'ok', launch: false }
const GONE: EnsoProject = { ...APP, status: 'missing-dir' }

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

const minutesAgo = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString()

const STORED: readonly EnsoStoredThread[] = [
  {
    threadId: 't-switched',
    projectId: 'p-app',
    title: 'switched models',
    lastActivityAt: minutesAgo(5),
    messageCount: 4,
    busy: false,
    model: { provider: 'openai', modelId: 'gpt-kept' },
  },
  {
    threadId: 't-none',
    projectId: 'p-app',
    title: 'no reply yet',
    lastActivityAt: minutesAgo(60),
    messageCount: 1,
    busy: true,
  },
  {
    threadId: 't-launch',
    projectId: 'p-launch',
    title: 'elsewhere',
    lastActivityAt: minutesAgo(1),
    messageCount: 2,
    busy: false,
  },
]

const TREES: EnsoTreesListing = {
  projects: [
    {
      projectId: 'p-launch',
      objectStore: null,
      trees: [
        {
          threadId: 't-launch',
          path: '/trees/launch',
          kind: 'worktree',
          branch: 'enso/l',
          size: { kind: 'measured', bytes: 900_000_000 },
          holdsWork: null,
        },
      ],
    },
    {
      projectId: 'p-app',
      objectStore: { kind: 'measured', bytes: 48_000_000 },
      trees: [
        {
          threadId: 't-switched',
          path: '/trees/switched',
          kind: 'worktree',
          branch: 'enso/s',
          size: { kind: 'measured', bytes: 300_000_000 },
          holdsWork: '2 files changed, not committed',
        },
      ],
    },
  ],
}

/** A PUT the page sent: its body, parsed. */
type Sent = { readonly tier: string; readonly threads: Record<string, unknown> }

type ProjectRoute = Extract<PageRoute, { kind: 'project' }>

/** What the page asked its owner for. */
interface Asked {
  readonly opened: PageRoute[]
  readonly threads: string[]
  readonly removed: string[]
}

interface MountOptions {
  readonly route?: ProjectRoute
  readonly projects?: readonly EnsoProject[]
  readonly settings?: EnsoProjectSettings
  /** Each PUT answers the next of these. */
  readonly answers?: readonly Response[]
  /** Each Check again lists these next. */
  readonly listings?: ReadonlyArray<ListingState<EnsoProject>>
}

interface Mounted {
  readonly sent: Sent[]
  readonly asked: Asked
  readonly container: HTMLElement
  readonly unmount: () => Promise<void>
}

async function mountPage(options: MountOptions = {}): Promise<Mounted> {
  const { settings = SETTINGS, answers = [], listings = [] } = options
  const sent: Sent[] = []
  const asked: Asked = { opened: [], threads: [], removed: [] }
  const fetchImpl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const path = requestedUrl(input)
    if (path === '/api/trees') return Promise.resolve(Response.json(TREES))
    if (init?.method === 'PUT') {
      if (typeof init.body !== 'string') throw new Error(`expected a JSON text body, got ${typeof init.body}`)
      sent.push(JSON.parse(init.body) as Sent)
      const answer = answers[sent.length - 1]
      if (answer === undefined) throw new Error(`no answer scripted for PUT ${sent.length}`)
      return Promise.resolve(answer)
    }
    return Promise.resolve(Response.json(settings))
  }
  let checks = 0
  function Harness(): React.ReactNode {
    const [route, setRoute] = useState<ProjectRoute>(
      options.route ?? { kind: 'project', projectId: 'p-app', tab: 'threads' },
    )
    const [projects, setProjects] = useState<ListingState<EnsoProject>>({
      rows: options.projects ?? [LAUNCH, APP],
      error: undefined,
    })
    return (
      <ProjectPage
        route={route}
        fetch={fetchImpl}
        projects={projects}
        pageThreads={[]}
        stored={STORED}
        notice={undefined}
        onOpen={(next: PageRoute) => {
          asked.opened.push(next)
          if (next.kind === 'project') setRoute(next)
        }}
        onOpenThread={(thread) => asked.threads.push(thread.threadId)}
        onCheckAgain={() => {
          const next = listings[checks]
          checks += 1
          if (next === undefined) throw new Error(`no listing scripted for check ${checks}`)
          setProjects(next)
          return Promise.resolve(next)
        }}
        onRemove={(projectId: string) => asked.removed.push(projectId)}
        onDeleted={noop}
      />
    )
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  await flush(async () => {
    root.render(<Harness />)
    await tick()
  })
  return {
    sent,
    asked,
    container,
    unmount: async () => {
      await flush(async () => root.unmount())
      container.remove()
    },
  }
}

/** The control a visible label names, as a screen reader finds it. */
function labelled<Control extends HTMLElement>(within: HTMLElement, label: string): Control {
  const found = [...within.querySelectorAll('label')].find((candidate) => candidate.textContent === label)
  const control = found === undefined ? null : document.getElementById(found.htmlFor)
  if (control === null) throw new Error(`no control labelled ${label}`)
  return control as Control
}

function buttonNamed(within: ParentNode, name: string): HTMLButtonElement {
  const found = [...within.querySelectorAll('button')].find(
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
function tierOf(within: HTMLElement, label: string): string {
  const field = [...within.querySelectorAll('label')]
    .find((candidate) => candidate.textContent === label)
    ?.closest('[data-slot="field"]')
  const line = [...(field?.querySelectorAll('p') ?? [])].find((paragraph) => paragraph.textContent?.startsWith('from '))
  return line?.textContent ?? `no tier under ${label}`
}

const tabs = (container: HTMLElement): HTMLElement[] => [...container.querySelectorAll<HTMLElement>('[role="tab"]')]
const selectedTab = (container: HTMLElement): string =>
  tabs(container).find((tab) => tab.getAttribute('aria-selected') === 'true')?.textContent ?? 'none'

/** The page at its Worktrees tab, once the settings are read. */
async function mountWorktrees(options: MountOptions = {}): Promise<Mounted> {
  const page = await mountPage({ ...options, route: { kind: 'project', projectId: 'p-app', tab: 'worktrees' } })
  await eventually(() => expect(page.container.textContent).toContain('Setup commands'))
  return page
}

// ── the rail's way in ─────────────────────────────────────────────────────────

test('every project’s rail menu offers Project settings — the launch one too — and only a registered one offers Remove (#754)', async () => {
  const opened: string[] = []
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  await flush(async () => {
    root.render(
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
        onPage={noop}
        projectNotice={undefined}
      />,
    )
    await tick()
  })
  const openMenu = async (name: string): Promise<string[]> => {
    const trigger = document.querySelector<HTMLElement>(`button[aria-label="more for ${name}"]`)
    await flush(async () => {
      // Radix opens a menu on a primary-button pointerdown.
      trigger?.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, pointerType: 'mouse' }))
      await tick()
    })
    return eventually(() => {
      const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(
        (item) => item.textContent ?? '',
      )
      expect(items.length).toBeGreaterThan(0)
      return items
    })
  }
  expect(await openMenu('enso')).toEqual(['Project settings…'])
  await flush(async () => {
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await tick()
  })
  await eventually(() => expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(0))
  expect(await openMenu('app')).toEqual(['Project settings…', 'Remove project — its threads stay on disk'])
  const settingsItem = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (item) => item.textContent === 'Project settings…',
  )
  await press(settingsItem ?? document.body)
  expect(opened).toEqual(['p-app'])
  await flush(async () => root.unmount())
  container.remove()
})

// ── tabs ─────────────────────────────────────────────────────────────────────

test('the tabs open at the route’s and move with the arrow keys, each move a route of its own (#871)', async () => {
  const page = await mountPage()
  expect(tabs(page.container).map((tab) => tab.textContent)).toEqual(['Threads', 'Worktree settings', 'Storage'])
  expect(selectedTab(page.container)).toBe('Threads')
  const threads = tabs(page.container)[0]
  await flush(async () => {
    threads?.focus()
    threads?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    await tick()
  })
  await eventually(() => expect(selectedTab(page.container)).toBe('Worktree settings'))
  expect(document.activeElement?.textContent).toBe('Worktree settings')
  expect(page.asked.opened).toEqual([{ kind: 'project', projectId: 'p-app', tab: 'worktrees' }])
  await eventually(() => expect(page.container.textContent).toContain('Setup commands'))
  await page.unmount()
})

test('a project the listing does not have is not found, with the way to Projects; a listing not read yet is no verdict (#871)', async () => {
  const unread = await mountPage({ projects: [], route: { kind: 'project', projectId: 'p-nope', tab: 'threads' } })
  expect(unread.container.textContent).toContain('Reading the projects')
  await unread.unmount()
  const page = await mountPage({ route: { kind: 'project', projectId: 'p-nope', tab: 'storage' } })
  expect(page.container.textContent).toContain('Enso lists no project with the id “p-nope”')
  expect(tabs(page.container)).toHaveLength(0)
  await press(buttonNamed(page.container, 'Open Projects'))
  expect(page.asked.opened).toEqual([{ kind: 'projects' }])
  await page.unmount()
})

// ── Threads ──────────────────────────────────────────────────────────────────

test('Threads lists this project’s threads, newest first, with the model each last ran on — or none recorded — and opens one (#871)', async () => {
  const page = await mountPage()
  const rows = await eventually(() => {
    const listed = [...page.container.querySelectorAll('[aria-label="threads in app"] li')].map(
      (row) => row.textContent,
    )
    expect(listed).toHaveLength(2)
    return listed
  })
  expect(rows[0]).toContain('switched models')
  expect(rows[0]).toContain('gpt-kept')
  expect(rows[1]).toContain('no reply yet')
  expect(rows[1]).toContain('no model recorded')
  expect(rows[1]).toContain('running')
  expect(page.container.textContent).not.toContain('elsewhere')
  await press(buttonNamed(page.container, 'switched modelsgpt-kept5m'))
  expect(page.asked.threads).toEqual(['t-switched'])
  await page.unmount()
})

test('a project with no thread says so (#871)', async () => {
  const page = await mountPage({
    route: { kind: 'project', projectId: 'p-other', tab: 'threads' },
    projects: [LAUNCH, { ...APP, projectId: 'p-other' }],
  })
  expect(page.container.textContent).toContain('No threads yet')
  await page.unmount()
})

// ── Worktrees (the dialog that was, #754) ────────────────────────────────────

test('Worktrees shows each value with the tier and the file it comes from, and the save target by its file (#754, #871)', async () => {
  const page = await mountWorktrees()
  const { container } = page
  expect(labelled<HTMLSelectElement>(container, 'New threads run in').value).toBe('copy')
  expect(labelled<HTMLTextAreaElement>(container, 'Files to copy into a new tree').value).toBe('.env')
  expect(labelled<HTMLTextAreaElement>(container, 'Setup commands').value).toBe('bun install')
  expect(tierOf(container, 'New threads run in')).toBe('from shared with the project (/code/app/.enso/config.json)')
  expect(tierOf(container, 'Setup commands')).toBe('from your settings (/home/me/.enso/config.json)')
  expect(tierOf(container, 'Files to copy into a new tree')).toBe(
    'from only you, this project (/code/app/.enso/config.local.json)',
  )
  // ⚠ The commands run on this machine: said beside them.
  expect(container.textContent).toContain(
    "These run on your machine, in the new tree, each time a thread's tree is made.",
  )
  // Only a value from the project's own files can be reset here; the user's is edited where it always was.
  expect(() => buttonNamed(container, 'Reset Setup commands')).toThrow()
  const saveTo = container.querySelector<HTMLElement>('[role="radiogroup"]')
  expect(document.getElementById(saveTo?.getAttribute('aria-labelledby') ?? '')?.textContent).toBe('Save changes to')
  expect(saveTo?.querySelector('[role="radio"][aria-checked="true"]')?.getAttribute('value')).toBe('local')
  expect(saveTo?.textContent).toContain('Only me — this project.enso/config.local.json')
  expect(saveTo?.textContent).toContain('Shared — committed with the project.enso/config.json')
  // Nothing edited: nothing to save.
  expect(container.querySelector('[aria-label="Unsaved worktree settings"]')).toBeNull()
  await page.unmount()
})

test('an edit is counted and marked; Discard puts the values back; Save sends one PUT to Only me with just the changed key (#754, #871)', async () => {
  const saved: EnsoProjectSettings = {
    ...SETTINGS,
    threads: {
      ...SETTINGS.threads,
      setup: { value: ['bun install --frozen-lockfile', 'bun run build'], tier: 'local' },
    },
  }
  const page = await mountWorktrees({ answers: [Response.json(saved)] })
  const { container } = page
  const setup = labelled<HTMLTextAreaElement>(container, 'Setup commands')
  await typeInto(setup, 'bun test')
  const bar = (): HTMLElement | null => container.querySelector('[aria-label="Unsaved worktree settings"]')
  expect(bar()?.textContent).toContain('1 unsaved change')
  expect(bar()?.textContent).toContain('Saves to .enso/config.local.json')
  expect(container.textContent).toContain('edited')
  await press(buttonNamed(container, 'Discard'))
  expect(labelled<HTMLTextAreaElement>(container, 'Setup commands').value).toBe('bun install')
  expect(bar()).toBeNull()
  expect(page.sent).toEqual([])

  await typeInto(
    labelled<HTMLTextAreaElement>(container, 'Setup commands'),
    '  bun install --frozen-lockfile\n\nbun run build\n',
  )
  const bar1 = bar()
  if (bar1 === null) throw new Error('expected the unsaved bar')
  await press(buttonNamed(bar1, 'Save'))
  await eventually(() =>
    expect(tierOf(container, 'Setup commands')).toBe('from only you, this project (/code/app/.enso/config.local.json)'),
  )
  expect(page.sent).toEqual([{ tier: 'local', threads: { setup: ['bun install --frozen-lockfile', 'bun run build'] } }])
  expect(labelled<HTMLTextAreaElement>(container, 'Setup commands').value).toBe(
    'bun install --frozen-lockfile\nbun run build',
  )
  expect(bar()).toBeNull()
  await page.unmount()
})

test('Save changes to Shared names the shared file and writes the shared tier, an emptied list as []; a refusal is shown in the server’s words (#754, #871)', async () => {
  const page = await mountWorktrees({
    answers: [new Response('the project has a file named .enso, not a folder', { status: 422 })],
  })
  const { container } = page
  const shared = container.querySelector<HTMLElement>('[role="radio"][value="shared"]')
  if (shared === null) throw new Error('expected the Shared choice')
  await press(shared)
  await typeInto(labelled<HTMLTextAreaElement>(container, 'Files to copy into a new tree'), '')
  const bar = container.querySelector<HTMLElement>('[aria-label="Unsaved worktree settings"]')
  expect(bar?.textContent).toContain('Saves to .enso/config.json')
  await press(buttonNamed(bar ?? container, 'Save'))
  await eventually(() =>
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      '422 the project has a file named .enso, not a folder',
    ),
  )
  expect(page.sent).toEqual([{ tier: 'shared', threads: { copy: [] } }])
  // The draft is kept, to fix and save again.
  expect(labelled<HTMLTextAreaElement>(container, 'Files to copy into a new tree').value).toBe('')
  await page.unmount()
})

test('a save to Shared leaves Shared chosen, so the next save writes the same file (#871)', async () => {
  const page = await mountWorktrees({ answers: [Response.json(SETTINGS), Response.json(SETTINGS)] })
  const { container } = page
  const shared = container.querySelector<HTMLElement>('[role="radio"][value="shared"]')
  if (shared === null) throw new Error('expected the Shared choice')
  await press(shared)
  await typeInto(labelled<HTMLTextAreaElement>(container, 'Files to copy into a new tree'), '.npmrc')
  await press(buttonNamed(container, 'Save'))
  await eventually(() => expect(page.sent).toHaveLength(1))
  await eventually(() =>
    expect(container.querySelector('[role="radio"][value="shared"]')?.getAttribute('aria-checked')).toBe('true'),
  )
  await typeInto(labelled<HTMLTextAreaElement>(container, 'Setup commands'), 'make')
  await press(buttonNamed(container, 'Save'))
  await eventually(() => expect(page.sent).toHaveLength(2))
  expect(page.sent.map((update) => update.tier)).toEqual(['shared', 'shared'])
  await page.unmount()
})

test('Reset removes a key from the tier that set it, so the next tier shows through (#754)', async () => {
  const afterReset: EnsoProjectSettings = {
    ...SETTINGS,
    threads: { ...SETTINGS.threads, tree: { value: 'worktree', tier: 'default' } },
  }
  const page = await mountWorktrees({ answers: [Response.json(afterReset)] })
  await press(buttonNamed(page.container, 'Reset New threads run in'))
  await eventually(() => expect(tierOf(page.container, 'New threads run in')).toBe('from default'))
  expect(page.sent).toEqual([{ tier: 'shared', threads: { tree: null } }])
  expect(labelled<HTMLSelectElement>(page.container, 'New threads run in').value).toBe('worktree')
  await page.unmount()
})

test('Reset waits while a field holds an unsaved change, which a Reset’s answer would drop (#871)', async () => {
  const page = await mountWorktrees({ answers: [] })
  const { container } = page
  const reset = buttonNamed(container, 'Reset New threads run in')
  expect(reset.hasAttribute('disabled')).toBe(false)
  await typeInto(labelled<HTMLTextAreaElement>(container, 'Setup commands'), 'make')
  expect(reset.hasAttribute('disabled')).toBe(true)
  await press(buttonNamed(container, 'Discard'))
  expect(reset.hasAttribute('disabled')).toBe(false)
  expect(page.sent).toEqual([])
  await page.unmount()
})

// ── Storage ──────────────────────────────────────────────────────────────────

test('Storage lists this project’s trees alone, under its one total, each with its work and its Delete (#871)', async () => {
  const page = await mountPage({ route: { kind: 'project', projectId: 'p-app', tab: 'storage' } })
  const section = await eventually(() => {
    const found = page.container.querySelector<HTMLElement>('[aria-label="trees of app"]')
    expect(found).not.toBeNull()
    return found as HTMLElement
  })
  // 300 MB of tree and 48 MB of snapshots: the sum the Projects card says.
  expect(section.textContent).toContain('348 MB on disk: 1 tree, and 48 MB in the snapshot store')
  expect(section.textContent).toContain('2 files changed, not committed')
  expect(() => buttonNamed(section, 'delete thread switched models')).not.toThrow()
  expect(page.container.textContent).not.toContain('/trees/launch')
  await page.unmount()
})

// ── banners ──────────────────────────────────────────────────────────────────

test('a missing folder’s banner: Check again says “Still missing” while it is, and the banner goes once it is back (#871)', async () => {
  const page = await mountPage({
    projects: [LAUNCH, GONE],
    listings: [
      { rows: [LAUNCH, GONE], error: undefined },
      { rows: [LAUNCH, APP], error: undefined },
    ],
  })
  const banner = (): HTMLElement | null => page.container.querySelector('[aria-labelledby="missing-folder-title"]')
  expect(banner()?.textContent).toContain('/code/app isn’t on disk any more')
  await press(buttonNamed(banner() ?? page.container, 'Check again'))
  await eventually(() =>
    expect(banner()?.querySelector('[role="status"]')?.textContent).toBe('Still missing: /code/app'),
  )
  await press(buttonNamed(banner() ?? page.container, 'Check again'))
  await eventually(() => expect(banner()).toBeNull())
  await page.unmount()
})

test('an untrusted project’s banner names the files Enso does not read (#871)', async () => {
  const page = await mountPage({ settings: { ...SETTINGS, trusted: false } })
  const banner = await eventually(() => {
    const found = page.container.querySelector('[aria-labelledby="untrusted-title"]')
    expect(found).not.toBeNull()
    return found
  })
  expect(banner?.textContent).toContain('Not trusted yet')
  expect(banner?.textContent).toContain('/code/app/.enso/config.json, /code/app/.enso/config.local.json')
  expect(banner?.querySelector('button')).toBeNull()
  await page.unmount()
})

// ── Remove ───────────────────────────────────────────────────────────────────

test('the Remove card says what removal does to the threads — what the server does, `server-handler.test.ts` — and asks before it removes (#871)', async () => {
  const page = await mountPage()
  const card = page.container.querySelector<HTMLElement>('[aria-labelledby="remove-title"]')
  const words =
    'Stops listing this project. Its folder and files aren’t touched. Its 2 threads stay on disk, but aren’t listed or opened until you add this folder again. Enso won’t remove it while one of its threads is running.'
  expect(card?.textContent).toContain(words)
  await press(buttonNamed(card ?? page.container, 'Remove project…'))
  const dialog = await eventually(() => {
    const found = document.querySelector<HTMLElement>('[role="dialog"]')
    expect(found).not.toBeNull()
    return found as HTMLElement
  })
  expect(dialog.textContent).toContain('Remove app from Enso?')
  expect(page.asked.removed).toEqual([])
  await press(buttonNamed(dialog, 'Remove project'))
  expect(page.asked.removed).toEqual(['p-app'])
  await page.unmount()
})

test('the launch folder has no Remove: it can’t be removed (#871)', async () => {
  const page = await mountPage({ route: { kind: 'project', projectId: 'p-launch', tab: 'threads' } })
  expect(page.container.textContent).toContain('This is the folder Enso was started in, so it can’t be removed.')
  expect(page.container.querySelector('[aria-labelledby="remove-title"]')).toBeNull()
  await page.unmount()
})

// ── the tree setup report (#754) ─────────────────────────────────────────────

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
