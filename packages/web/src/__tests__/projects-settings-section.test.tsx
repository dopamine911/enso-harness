import { afterAll, expect, test } from 'bun:test'
import type { EnsoProject } from '@enso/core'
import { act } from 'react'
import type { createRoot as CreateRoot } from 'react-dom/client'
import type * as ProjectsSettingsModule from '../projects-settings.tsx'
import { ensureDom, releaseDom } from './dom-environment.ts'

/**
 * Settings › Projects & threads (#934) over a scripted server: what a Save sends is what lands in
 * the user's `config.json`, so a key written to the wrong place, a cleared list left behind, a root
 * the server would not start with posted, or a project's own mode lost would each show up here as
 * the body the server received; and the trust default goes to its own route, never the file.
 */

// ⚠ A DOM before react-dom/client evaluates.
ensureDom()
const { createRoot }: { createRoot: typeof CreateRoot } = await import('react-dom/client')
const { ProjectsSection }: typeof ProjectsSettingsModule = await import('../projects-settings.tsx')
afterAll(releaseDom)

const flush = (work: () => Promise<void> | void): Promise<void> => act(async () => work())
const ETAG = `"${'b'.repeat(64)}"`
const PROJECT: EnsoProject = {
  projectId: '0123456789abcdef',
  title: 'app',
  path: '/code/app',
  status: 'ok',
  launch: true,
}

function read(sections: { projects?: unknown; threads: unknown }, defaultProjectTrust = 'ask'): unknown {
  return {
    kind: 'ok',
    path: '/h/config.json',
    etag: ETAG,
    ...sections,
    trustPath: '/h/pi-agent/settings.json',
    defaultProjectTrust,
  }
}

type Sent = { url: string; method: string; headers: Record<string, string>; body: unknown }

async function mounted(
  initial: unknown,
): Promise<{ container: HTMLElement; sent: Sent[]; unmount: () => Promise<void> }> {
  const sent: Sent[] = []
  let current = initial
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    sent.push({ url, method, headers: (init?.headers ?? {}) as Record<string, string>, body })
    if (url.endsWith('/trust')) return Response.json(body)
    if (method === 'PUT') current = read(body)
    return Response.json(current)
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await flush(() => root.render(<ProjectsSection fetch={fetchImpl} projects={[PROJECT]} />))
  await flush(() => undefined)
  return {
    container,
    sent,
    unmount: async () => {
      await flush(() => root.unmount())
      container.remove()
    },
  }
}

function button(container: HTMLElement, name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((each) => each.textContent?.trim() === name)
  if (found === undefined) throw new Error(`no button ${name}`)
  return found
}

function type(element: HTMLTextAreaElement | HTMLSelectElement, value: string): void {
  const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLTextAreaElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value)
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
}

const control = <Element extends HTMLElement>(container: HTMLElement, id: string): Element => {
  const found = container.querySelector<Element>(`#projects-settings-${id}`)
  if (found === null) throw new Error(`no control ${id}`)
  return found
}

test('a root the server would refuse saves nothing; a save sends both sections whole, each key where it lives', async () => {
  const page = await mounted(read({ threads: { copy: ['.env'], projects: { '/elsewhere': 'off' } } }))
  const { container, sent } = page
  await flush(() => type(control(container, 'roots'), 'code'))
  await flush(() => button(container, 'Save').click())
  expect(container.textContent).toContain('code is neither an absolute path nor ~/')
  expect(sent.filter((each) => each.method === 'PUT')).toEqual([])

  await flush(() => type(control(container, 'roots'), '~/code\n\n/srv/work '))
  await flush(() => type(control(container, 'tree'), 'off'))
  await flush(() => type(control(container, 'setup'), 'bun install\n'))
  await flush(() => type(control(container, 'copy'), ''))
  const ownMode = container.querySelector<HTMLSelectElement>('select[aria-label="app: new threads run in"]')
  if (ownMode === null) throw new Error('no own-mode select for the project')
  await flush(() => type(ownMode, 'copy'))
  expect(container.textContent).toContain('5 unsaved changes')
  await flush(() => button(container, 'Save').click())
  const put = sent.find((each) => each.method === 'PUT')
  expect(put?.headers['If-Match']).toBe(ETAG)
  // A path the file names that is not one of the page's projects keeps its mode.
  expect(put?.body).toEqual({
    projects: { roots: ['~/code', '/srv/work'] },
    threads: { tree: 'off', setup: ['bun install'], copy: [], projects: { '/elsewhere': 'off', '/code/app': 'copy' } },
  })
  expect(container.textContent).toContain('saved')
  await page.unmount()
})

// #979 review, issue 4: trusting every undecided project protects less, so — #933's rule — it is
// confirmed before it is set, not only warned about.
test('the trust default is set on its own route, and a choice that trusts every project is confirmed first', async () => {
  const page = await mounted(read({ projects: { roots: ['/code'] }, threads: {} }))
  const { container, sent } = page
  expect(button(container, 'Set').disabled).toBe(true)
  await flush(() => type(control<HTMLSelectElement>(container, 'trust'), 'always'))
  expect(container.textContent).toContain('will run its own extensions and setup commands without asking')
  await flush(() => button(container, 'Set').click())
  expect(container.textContent).toContain('This save protects less than what is in force now')
  expect(sent.some((each) => each.url.endsWith('/trust'))).toBe(false)
  await flush(() => button(container, 'Save anyway').click())
  expect(sent.at(-1)).toMatchObject({
    url: '/api/settings/projects/trust',
    method: 'PUT',
    body: { defaultProjectTrust: 'always' },
  })
  expect(control<HTMLSelectElement>(container, 'trust').value).toBe('always')
  expect(button(container, 'Set').disabled).toBe(true)
  // The file's draft is untouched by it.
  expect(sent.some((each) => each.url === '/api/settings/projects' && each.method === 'PUT')).toBe(false)

  // Tightening needs no confirm.
  await flush(() => type(control<HTMLSelectElement>(container, 'trust'), 'never'))
  await flush(() => button(container, 'Set').click())
  expect(sent.at(-1)).toMatchObject({ url: '/api/settings/projects/trust', body: { defaultProjectTrust: 'never' } })
  await page.unmount()
})

// #979 review, issue 3: a pi settings file that cannot be read shows `ask`, and a Set would be refused.
test('an unreadable pi settings file is said, and the trust cannot be set', async () => {
  const page = await mounted({ ...(read({ threads: {} }) as object), trustUnreadable: 'Unexpected token' })
  const { container } = page
  expect(container.textContent).toContain('settings.json could not be read')
  await flush(() => type(control<HTMLSelectElement>(container, 'trust'), 'never'))
  expect(button(container, 'Set').disabled).toBe(true)
  await page.unmount()
})

// #979 review, issue 5: a mode chosen and chosen back moves its key to the end; that is no change.
test('a project mode set and set back is not an unsaved change', async () => {
  const page = await mounted(read({ threads: { projects: { '/code/app': 'off', '/elsewhere': 'copy' } } }))
  const { container } = page
  const ownMode = container.querySelector<HTMLSelectElement>('select[aria-label="app: new threads run in"]')
  if (ownMode === null) throw new Error('no own-mode select for the project')
  await flush(() => type(ownMode, 'copy'))
  expect(container.textContent).toContain('1 unsaved change')
  await flush(() => type(ownMode, 'off'))
  expect(container.textContent).not.toContain('unsaved change')
  expect(button(container, 'Save').disabled).toBe(true)
  await page.unmount()
})

test('an unreadable file is said, and no form is offered', async () => {
  const page = await mounted({
    kind: 'unreadable',
    path: '/h/config.json',
    reason: 'not JSON',
    trustPath: '/h/pi-agent/settings.json',
    defaultProjectTrust: 'ask',
  })
  expect(page.container.textContent).toContain('config.json cannot be read')
  expect(page.container.querySelector('#projects-settings-roots')).toBeNull()
  await page.unmount()
})
