import { afterAll, afterEach, expect, test } from 'bun:test'
import type { EnsoStoredThread, WebFetchAllowlist, WebFetchHostCheck, WebSearchSettings } from '@enso/core'
import { act } from 'react'
import type { createRoot as CreateRoot, Root } from 'react-dom/client'
import type { FetchLike } from '../browser-logging.ts'
import type * as WebToolsModule from '../web-tools-settings.tsx'
import { ensureDom, releaseDom } from './dom-environment.ts'

// ⚠ A DOM before react-dom/client evaluates — `dom-environment.ts` has the measurement.
ensureDom()
const { createRoot }: { createRoot: typeof CreateRoot } = await import('react-dom/client')
const { WebToolsSection }: typeof WebToolsModule = await import('../web-tools-settings.tsx')

/**
 * Settings › Web tools (#924), MOUNTED under happy-dom over a scripted server: what the page sends
 * for each thing a person types — nothing for a refused form, the host alone for a pasted URL once
 * confirmed, the redirect's host from Check — and what it shows of the server's answer. Searching
 * (#932): the backend and domain changes it sends, and a Tavily key sent once and never shown.
 */

afterAll(releaseDom)

const settle = (): Promise<void> =>
  act(async () => {
    for (let round = 0; round < 10; round += 1) await Promise.resolve()
  })

async function eventually<T>(probe: () => T): Promise<T> {
  for (let round = 0; ; round += 1) {
    try {
      return probe()
    } catch (failure) {
      if (round >= 50) throw failure
      await settle()
    }
  }
}

const PATH = '/home/person/.enso/config.json'

interface Mounted {
  readonly root: HTMLElement
  /** Each POST the page sent, as `<url> <body>`. */
  readonly posted: string[]
  readonly unmount: () => void
}

const open = new Set<Mounted>()
afterEach(() => {
  for (const mounted of open) mounted.unmount()
  open.clear()
})

async function mountSection(options: {
  readonly hosts?: string[]
  readonly staleThreads?: string[]
  readonly check?: WebFetchHostCheck
  readonly stored?: EnsoStoredThread[]
}): Promise<Mounted> {
  let hosts = options.hosts ?? []
  const posted: string[] = []
  const listed = (): WebFetchAllowlist => ({
    path: PATH,
    hosts,
    projects: [{ projectId: 'p1', title: 'docs-site', path: '/srv/docs/.enso/config.json', hosts: ['docs.p.example'] }],
    staleThreads: options.staleThreads ?? [],
  })
  let search: WebSearchSettings = {
    path: PATH,
    backend: 'model',
    includeDomains: [],
    excludeDomains: [],
    secretsPath: '/home/person/.enso/secrets.env',
    tavilyKeySet: false,
    projects: [],
    staleThreads: [],
  }
  const fetchImpl: FetchLike = async (url, init) => {
    const searching = url.startsWith('/api/settings/web-search')
    if (init?.method !== 'POST') return Response.json(searching ? search : listed())
    const body = typeof init.body === 'string' ? init.body : ''
    posted.push(`${url} ${body}`)
    if (url.endsWith('/tavily-key')) {
      search = { ...search, tavilyKeySet: 'set' in (JSON.parse(body) as object) }
      return Response.json(search)
    }
    if (searching) {
      const change = JSON.parse(body) as { backend?: 'model' | 'deepseek'; list?: 'includeDomains'; add?: string }
      if (change.backend !== undefined) search = { ...search, backend: change.backend }
      if (change.list !== undefined && change.add !== undefined)
        search = { ...search, [change.list]: [...search[change.list], change.add] }
      return Response.json(search)
    }
    if (url.endsWith('/check')) return Response.json(options.check ?? { kind: 'answered', status: 200 })
    const change = JSON.parse(body) as { add?: string; remove?: string }
    hosts = change.add === undefined ? hosts.filter((host) => host !== change.remove) : [...hosts, change.add]
    return Response.json(listed())
  }
  const container = document.createElement('div')
  document.body.append(container)
  let root: Root | undefined
  await act(async () => {
    root = createRoot(container)
    root.render(<WebToolsSection fetch={fetchImpl} stored={options.stored ?? []} onOpenProject={() => undefined} />)
  })
  const mounted: Mounted = {
    root: container,
    posted,
    unmount: () => {
      act(() => root?.unmount())
      container.remove()
    },
  }
  open.add(mounted)
  await eventually(() => expect(container.textContent).toContain(PATH))
  return mounted
}

function button(mounted: Mounted, name: string): HTMLButtonElement {
  const found = [...mounted.root.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent?.trim() === name || candidate.getAttribute('aria-label') === name,
  )
  if (found === undefined) throw new Error(`expected the ${name} button`)
  return found
}

async function click(mounted: Mounted, name: string): Promise<void> {
  const found = await eventually(() => button(mounted, name))
  await act(async () => found.click())
  await settle()
}

async function type(mounted: Mounted, text: string, fieldId = 'settings-web-fetch-host'): Promise<void> {
  const field = await eventually(() => {
    const found = mounted.root.querySelector<HTMLInputElement>(`#${fieldId}`)
    if (found === null) throw new Error(`expected the #${fieldId} field`)
    return found
  })
  await act(async () => {
    Reflect.set(HTMLInputElement.prototype, 'value', text, field)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

test('a refused form says why and sends nothing', async () => {
  const mounted = await mountSection({})
  await type(mounted, '*.example.com')
  await click(mounted, 'Add')
  await eventually(() => expect(mounted.root.textContent).toContain('Wildcards aren’t supported'))
  expect(mounted.root.querySelector('#settings-web-fetch-host')?.getAttribute('aria-invalid')).toBe('true')
  expect(mounted.posted).toEqual([])
})

test('⚠ a pasted URL is added only once its host is confirmed, and only the host is sent', async () => {
  const mounted = await mountSection({})
  await type(mounted, 'https://Docs.Bun.sh/guides/http?x=1')
  await click(mounted, 'Add')
  await eventually(() => expect(mounted.root.textContent).toContain("That's a URL"))
  expect(mounted.posted).toEqual([])
  await click(mounted, 'Add docs.bun.sh')
  expect(mounted.posted).toEqual(['/api/settings/web-fetch {"add":"docs.bun.sh"}'])
  await eventually(() => button(mounted, 'remove docs.bun.sh'))
})

test('a bare host is sent normalised; Remove sends that host', async () => {
  const mounted = await mountSection({ hosts: ['a.example'] })
  await type(mounted, '  WWW.Enso.Engineer ')
  await click(mounted, 'Add')
  await click(mounted, 'remove a.example')
  expect(mounted.posted).toEqual([
    '/api/settings/web-fetch {"add":"www.enso.engineer"}',
    '/api/settings/web-fetch {"remove":"a.example"}',
  ])
})

test('⚠ Check on a host that redirects offers the host it redirects to, and adding it sends that host', async () => {
  const check: WebFetchHostCheck = {
    kind: 'redirect',
    status: 301,
    target: 'https://www.enso.engineer/',
    suggestedHost: 'www.enso.engineer',
  }
  const mounted = await mountSection({ check })
  await type(mounted, 'enso.engineer')
  await click(mounted, 'Check')
  await eventually(() =>
    expect(mounted.root.textContent).toContain('answers 301, a redirect to https://www.enso.engineer/'),
  )
  await click(mounted, 'Add www.enso.engineer instead?')
  expect(mounted.posted).toEqual([
    '/api/settings/web-fetch/check {"host":"enso.engineer"}',
    '/api/settings/web-fetch {"add":"www.enso.engineer"}',
  ])
})

test('Check reports a host that answers, and one that does not', async () => {
  const answered = await mountSection({ check: { kind: 'answered', status: 200 } })
  await type(answered, 'www.enso.engineer')
  await click(answered, 'Check')
  await eventually(() => expect(answered.root.textContent).toContain('https://www.enso.engineer/ answered 200'))
  const failed = await mountSection({ check: { kind: 'failed', reason: 'https://nope.example/ did not answer' } })
  await type(failed, 'nope.example')
  await click(failed, 'Check')
  await eventually(() => expect(failed.root.textContent).toContain('did not answer'))
})

test('a thread still on the old list is named by its title; a project’s hosts are shown with no Remove', async () => {
  const stored = [{ threadId: 'aaaaaaaa-1111', title: 'Read the bun docs' } as EnsoStoredThread]
  const mounted = await mountSection({ staleThreads: ['aaaaaaaa-1111', 'bbbbbbbb-2222'], stored })
  expect(mounted.root.textContent).toContain('Still running on the old list: Read the bun docs, new thread bbbbbbbb.')
  const group = mounted.root.querySelector('[aria-label="hosts from docs-site"]')
  expect(group?.textContent).toContain('docs.p.example')
  expect(group?.querySelector('button[aria-label^="remove"]')).toBeNull()
})

/** The Searching group's form that holds the field `fieldId`, submitted. */
async function submit(mounted: Mounted, fieldId: string): Promise<void> {
  const form = mounted.root.querySelector(`#${fieldId}`)?.closest('form')
  if (form === null || form === undefined) throw new Error(`expected the form of #${fieldId}`)
  await act(async () => form.requestSubmit())
  await settle()
}

test('Searching sends the backend chosen, and a domain normalised; a URL as a domain is refused and sends nothing', async () => {
  const mounted = await mountSection({})
  const deepseek = await eventually(() => {
    const found = mounted.root.querySelector<HTMLInputElement>(
      'input[name="settings-web-search-backend"][value="deepseek"]',
    )
    if (found === null) throw new Error('expected the DeepSeek choice')
    return found
  })
  await act(async () => deepseek.click())
  await settle()
  await type(mounted, 'https://docs.bun.sh/guides', 'settings-web-search-includeDomains')
  await submit(mounted, 'settings-web-search-includeDomains')
  await eventually(() => expect(mounted.root.textContent).toContain('Type the domain alone: docs.bun.sh.'))
  await type(mounted, ' Docs.Bun.sh ', 'settings-web-search-includeDomains')
  await submit(mounted, 'settings-web-search-includeDomains')
  expect(mounted.posted).toEqual([
    '/api/settings/web-search {"backend":"deepseek"}',
    '/api/settings/web-search {"list":"includeDomains","add":"docs.bun.sh"}',
  ])
  await eventually(() =>
    expect(mounted.root.textContent).toContain('webSearch.backend · /home/person/.enso/config.json'),
  )
  await eventually(() => button(mounted, 'remove docs.bun.sh from only these domains'))
})

test('⚠ a Tavily key is sent once and never shown: the field empties and the page says only that a key is set', async () => {
  const key = 'tvly-dev-0123456789abcdef'
  const mounted = await mountSection({})
  await eventually(() => expect(mounted.root.textContent).toContain('No key: there is no Tavily fallback.'))
  await type(mounted, key, 'settings-tavily-key')
  await submit(mounted, 'settings-tavily-key')
  await eventually(() => expect(mounted.root.textContent).toContain('A key is set'))
  expect(mounted.root.querySelector<HTMLInputElement>('#settings-tavily-key')?.value).toBe('')
  expect(mounted.root.innerHTML).not.toContain(key)
  await click(mounted, 'Remove')
  expect(mounted.posted).toEqual([
    `/api/settings/web-search/tavily-key {"set":"${key}"}`,
    '/api/settings/web-search/tavily-key {"remove":true}',
  ])
})
