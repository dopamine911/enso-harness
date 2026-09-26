import { afterAll, expect, test } from 'bun:test'
import type { EnsoDirectoryListing, EnsoProject } from '@enso/core'
import { act } from 'react'
import type { createRoot as CreateRoot, Root } from 'react-dom/client'
import type * as AddProjectModule from '../add-project.tsx'
import { ensureDom, releaseDom } from './dom-environment.ts'

// ⚠ A DOM before react-dom/client and Radix evaluate — `command-palette.test.tsx` has the
// measurement. The dialog is a Radix portal.
ensureDom()
const { createRoot }: { createRoot: typeof CreateRoot } = await import('react-dom/client')
const { AddProjectDialog, NO_ROOTS }: typeof AddProjectModule = await import('../add-project.tsx')

/**
 * The Add project dialog (#395 slice 3), MOUNTED over a fetch seam: the page can only add what the
 * server listed, a root is browsed and never added, and what gets registered is the directory on
 * screen — then the page is told, and the dialog closes. A refused registration stays and says why.
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

const ROOTS: EnsoDirectoryListing = {
  path: null,
  parent: null,
  registrable: false,
  directories: [{ name: '/home/me/code', path: '/home/me/code' }],
  truncated: false,
}
const ROOT: EnsoDirectoryListing = {
  path: '/home/me/code',
  parent: null,
  registrable: false,
  directories: [{ name: 'app', path: '/home/me/code/app' }],
  truncated: false,
}
const APP: EnsoDirectoryListing = {
  path: '/home/me/code/app',
  parent: '/home/me/code',
  registrable: true,
  directories: [],
  truncated: false,
}
const REGISTERED: EnsoProject = {
  projectId: 'a1',
  title: 'app',
  path: '/home/me/code/app',
  status: 'ok',
  launch: false,
}

interface Mounted {
  readonly registered: string[]
  readonly added: EnsoProject[]
  readonly closes: number[]
  readonly dialog: () => HTMLElement
  readonly click: (label: string) => Promise<void>
  /** Render the dialog open or closed, as the page does with the same mounted component. */
  readonly setOpen: (open: boolean) => Promise<void>
  readonly unmount: () => Promise<void>
}

async function mountAdd(listings: Record<string, EnsoDirectoryListing>, registration: Response): Promise<Mounted> {
  const registered: string[] = []
  const added: EnsoProject[] = []
  const closes: number[] = []
  const fetchImpl = (input: string, init?: RequestInit): Promise<Response> => {
    if (init?.method === 'POST') {
      registered.push((JSON.parse(String(init.body)) as { path: string }).path)
      return Promise.resolve(registration.clone())
    }
    const path = new URL(input, 'http://page').searchParams.get('path') ?? ''
    const listing = listings[path]
    return Promise.resolve(listing === undefined ? new Response('no', { status: 422 }) : Response.json(listing))
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  const view = (open: boolean): React.ReactNode => (
    <AddProjectDialog
      open={open}
      onClose={(): void => {
        closes.push(1)
      }}
      onAdded={(project: EnsoProject): void => {
        added.push(project)
      }}
      fetch={fetchImpl}
    />
  )
  await flush(async () => {
    root.render(view(true))
  })
  const dialog = (): HTMLElement => {
    const found = document.querySelector<HTMLElement>('[role="dialog"]')
    if (found === null) throw new Error('no dialog')
    return found
  }
  const buttonNamed = (label: string): HTMLButtonElement => {
    const found = [...dialog().querySelectorAll('button')].find((button) => button.textContent?.trim() === label)
    if (found === undefined) throw new Error(`no ${label} button`)
    return found
  }
  return {
    registered,
    added,
    closes,
    dialog,
    click: async (label: string) => {
      const button = await eventually(() => buttonNamed(label))
      await flush(async () => {
        button.click()
        await tick()
      })
    },
    setOpen: async (open: boolean) => {
      await flush(async () => {
        root.render(view(open))
        await tick()
      })
    },
    unmount: async () => {
      await flush(async () => root.unmount())
      container.remove()
    },
  }
}

test('⚠ a root is browsed, never added; the directory on screen is what registers, then the page is told and the dialog closes', async () => {
  const mounted = await mountAdd(
    { '': ROOTS, '/home/me/code': ROOT, '/home/me/code/app': APP },
    Response.json(REGISTERED, { status: 201 }),
  )
  await mounted.click('/home/me/code')
  const add = await eventually(() => {
    const found = [...mounted.dialog().querySelectorAll('button')].find(
      (button) => button.textContent === 'Add this folder',
    )
    if (found === undefined) throw new Error('no add button')
    return found
  })
  expect(add.disabled).toBe(true)
  await mounted.click('app')
  await eventually(() => expect(add.disabled).toBe(false))
  await mounted.click('Add this folder')
  expect(mounted.registered).toEqual(['/home/me/code/app'])
  expect(mounted.added).toEqual([REGISTERED])
  expect(mounted.closes).toHaveLength(1)
  await mounted.unmount()
})

test("a refused registration stays open and says the server's reason; no roots declared says how to declare one", async () => {
  const refused = await mountAdd(
    { '': ROOTS, '/home/me/code': ROOT, '/home/me/code/app': APP },
    new Response('/home/me/code/app is inside a hidden directory (.x)', { status: 422 }),
  )
  await refused.click('/home/me/code')
  await refused.click('app')
  await refused.click('Add this folder')
  await eventually(() =>
    expect(refused.dialog().textContent).toContain('422 /home/me/code/app is inside a hidden directory'),
  )
  expect(refused.added).toEqual([])
  expect(refused.closes).toEqual([])
  await refused.unmount()

  const none = await mountAdd({ '': { ...ROOTS, directories: [] } }, new Response(null, { status: 500 }))
  await eventually(() => expect(none.dialog().textContent).toContain(NO_ROOTS))
  await none.unmount()
})

// PR #401 review: the page keeps the dialog mounted while it is closed; each opening starts at the
// roots, never at the folder it was left on — which may since be gone, unreadable, or added.
test('closed mid-browse and opened again, the dialog starts at the roots', async () => {
  const mounted = await mountAdd({ '': ROOTS, '/home/me/code': ROOT }, new Response(null, { status: 500 }))
  await mounted.click('/home/me/code')
  await mounted.click('Close')
  await mounted.setOpen(false)
  await mounted.setOpen(true)
  await eventually(() => expect(mounted.dialog().textContent).toContain('the project roots enso.config.json declares'))
  await mounted.unmount()
})
