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
const { AddProjectDialog, NO_START, reachOf }: typeof AddProjectModule = await import('../add-project.tsx')

/**
 * The Add project dialog (#395 slice 3, #866), MOUNTED over a fetch seam: the page can only add what
 * the server listed, a starting folder is browsed and never added, a typed path browses there, and
 * nothing registers until the person has read what an agent in the folder can reach and confirmed —
 * then the page is told, and the dialog closes. A refused registration stays and says why.
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
  /** Type into the field labelled `label`, as a person does: the value set, then React told. */
  readonly type: (label: string, value: string) => Promise<void>
  /** Render the dialog open or closed, as the page does with the same mounted component. */
  readonly setOpen: (open: boolean) => Promise<void>
  readonly unmount: () => Promise<void>
}

async function mountAdd(listings: Record<string, EnsoDirectoryListing>, registration: Response): Promise<Mounted> {
  const registered: string[] = []
  const added: EnsoProject[] = []
  const closes: number[] = []
  // A browse with hidden folders shown is keyed `<path> +hidden`; a registration that asked for them
  // is recorded as `<path> +hidden` — so a test sees what the page asked, not just where.
  const fetchImpl = (input: string, init?: RequestInit): Promise<Response> => {
    if (init?.method === 'POST') {
      if (typeof init.body !== 'string') throw new Error(`expected a JSON text body, got ${typeof init.body}`)
      const body = JSON.parse(init.body) as { path: string; hidden?: boolean }
      registered.push(body.hidden === true ? `${body.path} +hidden` : body.path)
      return Promise.resolve(registration.clone())
    }
    const query = new URL(input, 'http://page').searchParams
    const path = query.get('path') ?? ''
    const listing = listings[query.get('hidden') === '1' ? `${path} +hidden` : path]
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
    type: async (label: string, value: string) => {
      const input = await eventually(() => {
        const found = dialog().querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)
        if (found === null) throw new Error(`no ${label} field`)
        return found
      })
      await flush(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
        input.dispatchEvent(new Event('input', { bubbles: true }))
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

test('⚠ a starting folder is browsed, never added; the folder on screen registers only after the person confirms what it reaches, then the page is told and the dialog closes (#866)', async () => {
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
  // Choosing says what the folder reaches, and registers nothing yet; Back leaves it unregistered.
  await mounted.click('Add this folder')
  await eventually(() => expect(mounted.dialog().textContent).toContain(reachOf('/home/me/code/app')))
  expect(mounted.registered).toEqual([])
  await mounted.click('Back')
  expect(mounted.registered).toEqual([])
  await mounted.click('Add this folder')
  await mounted.click('Add project')
  expect(mounted.registered).toEqual(['/home/me/code/app'])
  expect(mounted.added).toEqual([REGISTERED])
  expect(mounted.closes).toHaveLength(1)
  await mounted.unmount()
})

test('a typed path browses there — `~/` and all, the server resolves it — and the folder it names is what registers (#866)', async () => {
  const mounted = await mountAdd({ '': ROOTS, '~/code/app': APP }, Response.json(REGISTERED, { status: 201 }))
  await mounted.type('folder path', '  ~/code/app  ')
  await mounted.click('Go')
  await eventually(() => expect(mounted.dialog().textContent).toContain('/home/me/code/app'))
  await mounted.click('Add this folder')
  await mounted.click('Add project')
  expect(mounted.registered).toEqual(['/home/me/code/app'])
  await mounted.unmount()
})

// #866: a folder inside a hidden one is reachable only after the person asks to see hidden folders;
// the request carries that, the confirmation says the folder is hidden, and every opening starts with them hidden again.
test('⚠ "show hidden folders" lists them and registers one with the flag the server needs; the confirmation says it is hidden, and the next opening hides them again (#866)', async () => {
  const config = '/home/me/code/.config'
  const mounted = await mountAdd(
    {
      '': ROOTS,
      '/home/me/code': ROOT,
      '/home/me/code +hidden': { ...ROOT, directories: [{ name: '.config', path: config }, ...ROOT.directories] },
      [`${config} +hidden`]: { ...APP, path: config, parent: '/home/me/code' },
    },
    Response.json(REGISTERED, { status: 201 }),
  )
  const toggle = (): HTMLElement => {
    const found = mounted.dialog().querySelector<HTMLElement>('button[role="checkbox"]')
    if (found === null) throw new Error('no hidden-folders toggle')
    return found
  }
  await mounted.click('/home/me/code')
  await eventually(() => expect(mounted.dialog().textContent).toContain('app'))
  expect(mounted.dialog().textContent).not.toContain('.config')
  await act(async () => {
    toggle().click()
    await tick()
  })
  await mounted.click('.config')
  await mounted.click('Add this folder')
  await eventually(() => expect(mounted.dialog().textContent).toContain('It is inside a hidden folder'))
  await mounted.click('Add project')
  expect(mounted.registered).toEqual([`${config} +hidden`])

  await mounted.setOpen(false)
  await mounted.setOpen(true)
  await eventually(() => expect(toggle().getAttribute('aria-checked')).toBe('false'))
  await mounted.unmount()
})

test("a refused registration stays open and says the server's reason; no folder to start from says to type a path", async () => {
  const refused = await mountAdd(
    { '': ROOTS, '/home/me/code': ROOT, '/home/me/code/app': APP },
    new Response('/home/me/code/app is inside a hidden directory (.x)', { status: 422 }),
  )
  await refused.click('/home/me/code')
  await refused.click('app')
  await refused.click('Add this folder')
  await refused.click('Add project')
  await eventually(() =>
    expect(refused.dialog().textContent).toContain('422 /home/me/code/app is inside a hidden directory'),
  )
  expect(refused.added).toEqual([])
  expect(refused.closes).toEqual([])
  await refused.unmount()

  const none = await mountAdd({ '': { ...ROOTS, directories: [] } }, new Response(null, { status: 500 }))
  await eventually(() => expect(none.dialog().textContent).toContain(NO_START))
  await none.unmount()
})

// PR #401 review: the page keeps the dialog mounted while it is closed; each opening starts where
// browsing starts, never at the folder it was left on — which may since be gone, unreadable, or added.
test('closed mid-browse and opened again, the dialog starts where browsing starts', async () => {
  const mounted = await mountAdd({ '': ROOTS, '/home/me/code': ROOT }, new Response(null, { status: 500 }))
  await mounted.click('/home/me/code')
  await mounted.click('Close')
  await mounted.setOpen(false)
  await mounted.setOpen(true)
  await eventually(() => expect(mounted.dialog().textContent).toContain('choose a folder, or type its path'))
  await mounted.unmount()
})
