import { afterAll, afterEach, expect, test } from 'bun:test'
import type { WebFetchAllowlist, WebFetchHostCheck } from '@enso/core'
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
 * confirmed, the redirect's host from Check — and what it shows of the server's answer.
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
  readonly stored?: WebToolsModule.WebToolsSectionProps['stored']
  readonly unreadable?: string
}): Promise<Mounted> {
  let hosts = options.hosts ?? []
  const posted: string[] = []
  const listed = (): WebFetchAllowlist => ({
    path: PATH,
    hosts,
    ...(options.unreadable === undefined ? {} : { unreadable: options.unreadable }),
    projects: [{ projectId: 'p1', title: 'docs-site', path: '/srv/docs/.enso/config.json', hosts: ['docs.p.example'] }],
    staleThreads: options.staleThreads ?? [],
  })
  const fetchImpl: FetchLike = async (url, init) => {
    if (init?.method !== 'POST') return Response.json(listed())
    const body = typeof init.body === 'string' ? init.body : ''
    posted.push(`${url} ${body}`)
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

async function type(mounted: Mounted, text: string): Promise<void> {
  const field = mounted.root.querySelector<HTMLInputElement>('#settings-web-fetch-host')
  if (field === null) throw new Error('expected the host field')
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
  const stored = [{ threadId: 'aaaaaaaa-1111', title: 'Read the bun docs' }]
  const mounted = await mountSection({ staleThreads: ['aaaaaaaa-1111', 'bbbbbbbb-2222'], stored })
  expect(mounted.root.textContent).toContain('Still running on the old list: Read the bun docs, new thread bbbbbbbb.')
  const group = mounted.root.querySelector('[aria-label="hosts from docs-site"]')
  expect(group?.textContent).toContain('docs.p.example')
  expect(group?.querySelector('button[aria-label^="remove"]')).toBeNull()
})

test('a user file that can’t be read is said so, with its path and the reason (#924 review)', async () => {
  const mounted = await mountSection({ unreadable: 'config.json is not valid JSON' })
  expect(mounted.root.querySelector('[role="alert"]')?.textContent).toContain(
    `${PATH} can't be read (config.json is not valid JSON), so nothing is fetchable and nothing is written here`,
  )
})
