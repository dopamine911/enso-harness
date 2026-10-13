import { afterAll, expect, test } from 'bun:test'
import type { EnsoDirectoryListing, EnsoProject, EnsoProjectTrust } from '@enso/core'
import { act } from 'react'
import type { createRoot as CreateRoot, Root } from 'react-dom/client'
import type * as AddProjectModule from '../add-project.tsx'
import type { PageRoute } from '../thread-url.ts'
import { ensureDom, releaseDom } from './dom-environment.ts'

// ⚠ A DOM before react-dom/client and Radix evaluate — `command-palette.test.tsx` has the measurement.
ensureDom()
const { createRoot }: { createRoot: typeof CreateRoot } = await import('react-dom/client')
const { AddProjectPage, NAME_NEEDED, NO_START, trustFailedAfterAdd }: typeof AddProjectModule =
  await import('../add-project.tsx')

/**
 * The Add project page (#395 slice 3, #866, a page since #872), MOUNTED over a fetch seam: the page
 * can only choose what the server listed or resolved, a starting folder is browsed and never chosen,
 * a refusal is said in the server's words, a folder already a project says which and opens it, and
 * nothing registers until the person has confirmed — under the name they gave, never an empty one.
 * Trust (#873) is off by default; ticked, the project registers, then its trust is confirmed in a
 * dialog naming its files and setup commands, and a trust that fails says the project is there, untrusted.
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
  refusal: 'That folder is a project root itself (projects.roots). Pick a project folder inside it.',
  directories: [
    { name: 'app', path: '/home/me/code/app' },
    { name: 'ledger', path: '/home/me/code/ledger', projectId: 'p-ledger' },
  ],
  truncated: false,
}
const APP: EnsoDirectoryListing = {
  path: '/home/me/code/app',
  parent: '/home/me/code',
  registrable: true,
  directories: [],
  truncated: false,
}
const LEDGER: EnsoProject = {
  projectId: 'p-ledger',
  title: 'Ledger',
  path: '/home/me/code/ledger',
  status: 'ok',
  launch: false,
}
const REGISTERED: EnsoProject = {
  projectId: 'a1',
  title: 'My app',
  path: '/home/me/code/app',
  status: 'ok',
  launch: false,
}

/** The trust the server reads for the project just registered: one file with two commands, one with none. */
const TRUST: EnsoProjectTrust = {
  projectId: 'a1',
  path: '/home/me/code/app',
  trusted: false,
  files: [
    { tier: 'local', path: '/home/me/code/app/.enso/config.local.json' },
    { tier: 'shared', path: '/home/me/code/app/.enso/config.json', setup: ['bun install', 'make db'] },
  ],
}

interface Mounted {
  /** Each registration the page sent: its path (`+hidden` when it asked for hidden folders) and title. */
  readonly registered: string[]
  /** Each trust the page set: the body it sent, as sent. */
  readonly trusted: string[]
  readonly added: EnsoProject[]
  readonly opened: PageRoute[]
  readonly text: () => string
  /** The open dialog — portalled out of the page — or an error. */
  readonly dialog: () => Promise<HTMLElement>
  readonly button: (label: string) => Promise<HTMLButtonElement>
  readonly click: (label: string) => Promise<void>
  /** Type into the field labelled `label`, as a person does: the value set, then React told. */
  readonly type: (label: string, value: string) => Promise<void>
  readonly field: (label: string) => HTMLInputElement
  /** Leave the page and come back to it: the page is unmounted while another is shown. */
  readonly revisit: () => Promise<void>
  readonly unmount: () => Promise<void>
}

async function mountAdd(
  listings: Record<string, EnsoDirectoryListing | Response>,
  registration: Response,
  trustWrite: Response = Response.json({ ...TRUST, trusted: true }),
): Promise<Mounted> {
  const registered: string[] = []
  const trusted: string[] = []
  const added: EnsoProject[] = []
  const opened: PageRoute[] = []
  // A browse with hidden folders shown is keyed `<path> +hidden`; so is a registration that asked for them.
  const fetchImpl = (input: string, init?: RequestInit): Promise<Response> => {
    if (input === '/api/projects/a1/trust') {
      if (init?.method !== 'PUT') return Promise.resolve(Response.json(TRUST))
      if (typeof init.body !== 'string') throw new Error(`expected a JSON text body, got ${typeof init.body}`)
      trusted.push(init.body)
      return Promise.resolve(trustWrite.clone())
    }
    if (init?.method === 'POST') {
      if (typeof init.body !== 'string') throw new Error(`expected a JSON text body, got ${typeof init.body}`)
      const body = JSON.parse(init.body) as { path: string; title?: string; hidden?: boolean }
      registered.push(`${body.hidden === true ? `${body.path} +hidden` : body.path} as ${body.title}`)
      return Promise.resolve(registration.clone())
    }
    const query = new URL(input, 'http://page').searchParams
    const path = query.get('path') ?? ''
    const listing = listings[query.get('hidden') === '1' ? `${path} +hidden` : path]
    if (listing instanceof Response) return Promise.resolve(listing.clone())
    return Promise.resolve(listing === undefined ? new Response('no', { status: 500 }) : Response.json(listing))
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  const view = (shown: boolean): React.ReactNode =>
    shown ? (
      <AddProjectPage
        projects={[LEDGER]}
        onOpen={(route: PageRoute): void => {
          opened.push(route)
        }}
        onAdded={(project: EnsoProject): void => {
          added.push(project)
        }}
        fetch={fetchImpl}
      />
    ) : null
  await flush(async () => {
    root.render(view(true))
  })
  const buttonNamed = (label: string): HTMLButtonElement => {
    const found = [...container.querySelectorAll('button')].find((button) => button.textContent?.trim() === label)
    if (found === undefined) throw new Error(`no ${label} button`)
    return found
  }
  const field = (label: string): HTMLInputElement => {
    const named = [...container.querySelectorAll('label')].find((candidate) => candidate.textContent === label)
    const input = named === undefined ? null : document.getElementById(named.htmlFor)
    if (!(input instanceof HTMLInputElement)) throw new Error(`no ${label} field`)
    return input
  }
  return {
    registered,
    trusted,
    added,
    opened,
    text: () => container.textContent ?? '',
    dialog: () =>
      eventually(() => {
        const found = document.querySelector<HTMLElement>('[role="dialog"]')
        if (found === null) throw new Error('no dialog open')
        return found
      }),
    button: (label: string) => eventually(() => buttonNamed(label)),
    click: async (label: string) => {
      const button = await eventually(() => buttonNamed(label))
      await flush(async () => {
        button.click()
        await tick()
      })
    },
    type: async (label: string, value: string) => {
      const input = await eventually(() => field(label))
      await flush(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
        input.dispatchEvent(new Event('input', { bubbles: true }))
        await tick()
      })
    },
    field,
    revisit: async () => {
      await flush(async () => {
        root.render(view(false))
        await tick()
      })
      await flush(async () => {
        root.render(view(true))
        await tick()
      })
    },
    unmount: async () => {
      await flush(async () => root.unmount())
      container.remove()
    },
  }
}

test('⚠ a starting folder is browsed, never chosen; the folder chosen registers only after the person confirms, under the name they gave, and the page is told (#866, #872)', async () => {
  const mounted = await mountAdd(
    { '': ROOTS, '/home/me/code': ROOT, '/home/me/code/app': APP },
    Response.json(REGISTERED, { status: 201 }),
  )
  const choose = await mounted.button('Choose this folder')
  expect(choose.disabled).toBe(true)
  await mounted.click('/home/me/code')
  // A root is browsed from, never added — and the page says why.
  await eventually(() => expect(mounted.text()).toContain('That folder is a project root itself'))
  expect(choose.disabled).toBe(true)
  await mounted.click('app')
  await eventually(() => expect(choose.disabled).toBe(false))
  await mounted.click('Choose this folder')
  // Step 2 names the folder by its own name until the person changes it, and registers nothing yet.
  await eventually(() => expect(mounted.field('Name in Enso').value).toBe('app'))
  expect(mounted.text()).toContain('/home/me/code/app and everything inside it. Enso does not sandbox agents')
  expect(mounted.registered).toEqual([])
  await mounted.click('Back')
  expect(mounted.registered).toEqual([])
  await mounted.click('Choose this folder')
  await mounted.type('Name in Enso', '  My app  ')
  await mounted.click('Add project')
  expect(mounted.registered).toEqual(['/home/me/code/app as My app'])
  expect(mounted.added).toEqual([REGISTERED])
  await mounted.unmount()
})

test('an empty name is refused and nothing registers (#872)', async () => {
  const mounted = await mountAdd({ '': ROOTS, '~/code/app': APP }, Response.json(REGISTERED, { status: 201 }))
  await mounted.type('Folder path', '~/code/app')
  await mounted.click('Use this path')
  await mounted.type('Name in Enso', '   ')
  await mounted.click('Add project')
  await eventually(() => expect(mounted.text()).toContain(NAME_NEEDED))
  expect(mounted.registered).toEqual([])
  expect(mounted.added).toEqual([])
  await mounted.unmount()
})

test('a typed path is resolved by the server and is what registers; Change goes back with the path still typed (#866, #872)', async () => {
  const mounted = await mountAdd({ '': ROOTS, '~/code/app': APP }, Response.json(REGISTERED, { status: 201 }))
  await mounted.type('Folder path', '  ~/code/app  ')
  await mounted.click('Use this path')
  await eventually(() => expect(mounted.text()).toContain('Name in Enso'))
  await mounted.click('Change')
  await eventually(() => expect(mounted.field('Folder path').value).toBe('  ~/code/app  '))
  expect(mounted.registered).toEqual([])
  await mounted.click('Use this path')
  await mounted.click('Add project')
  expect(mounted.registered).toEqual(['/home/me/code/app as app'])
  await mounted.unmount()
})

test("a typed path the server refuses is said in the server's words, and nothing is chosen (#872)", async () => {
  const missing = 'There’s no folder at ~/nope/does-not-exist.'
  const mounted = await mountAdd(
    { '': ROOTS, '~/nope/does-not-exist': new Response(missing, { status: 422 }) },
    Response.json(REGISTERED, { status: 201 }),
  )
  await mounted.type('Folder path', '~/nope/does-not-exist')
  await mounted.click('Use this path')
  // The words alone: no status code before them.
  await eventually(() => expect(mounted.text()).toContain(missing))
  expect(mounted.text()).not.toContain('422')
  expect(mounted.text()).not.toContain('Name in Enso')
  await mounted.unmount()
})

test('a folder already a project is marked when browsing, and choosing it says which project it is and opens it (#872)', async () => {
  const mounted = await mountAdd(
    {
      '': ROOTS,
      '/home/me/code': ROOT,
      '~/code/ledger': { ...APP, path: LEDGER.path },
    },
    Response.json(REGISTERED, { status: 201 }),
  )
  await mounted.click('/home/me/code')
  const ledgerRow = await mounted.button('ledgeralready a project')
  expect(ledgerRow.title).toBe(LEDGER.path)
  await mounted.type('Folder path', '~/code/ledger')
  await mounted.click('Use this path')
  await eventually(() => expect(mounted.text()).toContain('That folder is already a project: Ledger.'))
  await mounted.click('Open it')
  expect(mounted.opened).toEqual([{ kind: 'project', projectId: 'p-ledger', tab: 'threads' }])
  expect(mounted.registered).toEqual([])
  await mounted.unmount()
})

test("a registration answered by a project already there (200) says so and opens it; a refused one says the server's reason and stays (#872)", async () => {
  const listings = { '': ROOTS, '~/code/app': APP }
  const existing = await mountAdd(listings, Response.json(REGISTERED, { status: 200 }))
  await existing.type('Folder path', '~/code/app')
  await existing.click('Use this path')
  await existing.click('Add project')
  await eventually(() => expect(existing.text()).toContain('That folder is already a project: My app.'))
  expect(existing.added).toEqual([])
  await existing.click('Open it')
  expect(existing.opened).toEqual([{ kind: 'project', projectId: 'a1', tab: 'threads' }])
  await existing.unmount()

  const hidden = 'That folder is inside a hidden folder (.x), where tools keep their settings and keys.'
  const refused = await mountAdd(listings, new Response(hidden, { status: 422 }))
  await refused.type('Folder path', '~/code/app')
  await refused.click('Use this path')
  await refused.click('Add project')
  await eventually(() => expect(refused.text()).toContain(hidden))
  expect(refused.text()).toContain('Name in Enso')
  expect(refused.added).toEqual([])
  await refused.unmount()

  const none = await mountAdd({ '': { ...ROOTS, directories: [] } }, new Response(null, { status: 500 }))
  await eventually(() => expect(none.text()).toContain(NO_START))
  await none.unmount()
})

// #866: a folder inside a hidden one is reachable only after the person asks to see hidden folders;
// the request carries that, the confirmation says the folder is hidden, and every visit starts with them hidden again.
test('⚠ "show hidden folders" lists them and registers one with the flag the server needs; step 2 says it is hidden, and the next visit hides them again (#866)', async () => {
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
    const found = document.querySelector<HTMLElement>('button[role="checkbox"]')
    if (found === null) throw new Error('no hidden-folders toggle')
    return found
  }
  await mounted.click('/home/me/code')
  await eventually(() => expect(mounted.text()).toContain('app'))
  expect(mounted.text()).not.toContain('.config')
  await act(async () => {
    toggle().click()
    await tick()
  })
  await mounted.click('.config')
  await mounted.click('Choose this folder')
  await eventually(() => expect(mounted.text()).toContain('It is inside a hidden folder'))
  await mounted.click('Add project')
  expect(mounted.registered).toEqual([`${config} +hidden as .config`])

  await mounted.revisit()
  await eventually(() => expect(toggle().getAttribute('aria-checked')).toBe('false'))
  await mounted.unmount()
})

test('step 2 links what pi may run to Settings › Permissions (#872)', async () => {
  const mounted = await mountAdd({ '': ROOTS, '~/code/app': APP }, Response.json(REGISTERED, { status: 201 }))
  await mounted.type('Folder path', '~/code/app')
  await mounted.click('Use this path')
  await mounted.click('Settings › Permissions')
  expect(mounted.opened).toEqual([{ kind: 'settings', section: 'permissions' }])
  await mounted.unmount()
})

// ── trust (#873) ─────────────────────────────────────────────────────────────

/** Step 2 for `~/code/app`, its trust box ticked or not. */
async function confirmApp(trust: boolean, trustWrite?: Response): Promise<Mounted> {
  const mounted = await mountAdd(
    { '': ROOTS, '~/code/app': APP },
    Response.json(REGISTERED, { status: 201 }),
    trustWrite,
  )
  await mounted.type('Folder path', '~/code/app')
  await mounted.click('Use this path')
  const box = await eventually(() => {
    const label = [...document.querySelectorAll('label')].find(
      (candidate) => candidate.textContent === 'Trust this project’s own settings',
    )
    const found = label === undefined ? null : document.getElementById(label.htmlFor)
    if (found === null) throw new Error('no trust box')
    return found
  })
  expect(box.getAttribute('aria-checked')).toBe('false')
  if (trust) {
    await act(async () => {
      box.click()
      await tick()
    })
    expect(box.getAttribute('aria-checked')).toBe('true')
  }
  return mounted
}

/** Press a dialog's button by its words. */
async function pressIn(dialog: HTMLElement, label: string): Promise<void> {
  const button = [...dialog.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === label)
  if (button === undefined) throw new Error(`no ${label} button in the dialog`)
  await act(async () => {
    button.click()
    await tick()
  })
}

test('trust is off by default: Add project registers the folder and trusts nothing (#873)', async () => {
  const mounted = await confirmApp(false)
  await mounted.click('Add project')
  expect(mounted.registered).toEqual(['/home/me/code/app as app'])
  expect(mounted.added).toEqual([REGISTERED])
  expect(mounted.trusted).toEqual([])
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  await mounted.unmount()
})

test('⚠ ticked, the folder registers, then the confirmation names its files and their setup commands — or none — before Trust project sends the trust (#873)', async () => {
  const mounted = await confirmApp(true)
  await mounted.click('Add project')
  expect(mounted.registered).toEqual(['/home/me/code/app as app'])
  const dialog = await mounted.dialog()
  await eventually(() => expect(dialog.textContent).toContain('/home/me/code/app/.enso/config.json'))
  expect(dialog.textContent).toContain('Trust My app?')
  const files = [...dialog.querySelectorAll('[aria-label="the project’s own settings files"] > li')]
  expect(files.map((file) => file.textContent)).toEqual([
    '/home/me/code/app/.enso/config.local.jsonSetup commands: none',
    '/home/me/code/app/.enso/config.jsonSetup commands, run in order on this machine in every new tree:bun installmake db',
  ])
  // Nothing is trusted, and the page not left, until the person says so.
  expect(mounted.trusted).toEqual([])
  expect(mounted.added).toEqual([])
  await pressIn(dialog, 'Trust project')
  expect(mounted.trusted).toEqual(['{"trusted":true}'])
  expect(mounted.added).toEqual([REGISTERED])
  await mounted.unmount()
})

test('⚠ a trust that fails after the folder registered says the project is there, untrusted; Not now opens it so (#873)', async () => {
  const mounted = await confirmApp(true, new Response('trust.json is locked', { status: 500 }))
  await mounted.click('Add project')
  const dialog = await mounted.dialog()
  await eventually(() => expect(dialog.textContent).toContain('Setup commands: none'))
  await pressIn(dialog, 'Trust project')
  expect(mounted.trusted).toEqual(['{"trusted":true}'])
  await eventually(() =>
    expect(dialog.querySelector('[role="alert"]')?.textContent).toBe(
      trustFailedAfterAdd(REGISTERED, '500 trust.json is locked'),
    ),
  )
  expect(mounted.added).toEqual([])
  await pressIn(dialog, 'Not now')
  expect(mounted.added).toEqual([REGISTERED])
  await mounted.unmount()
})
