import { afterAll, expect, test } from 'bun:test'
import { act } from 'react'
import type { createRoot as CreateRoot } from 'react-dom/client'
import type * as SecuritySettingsModule from '../security-settings.tsx'
import { ensureDom, releaseDom } from './dom-environment.ts'

/**
 * Settings › Security (#933) over a scripted server: what a Save sends is what lands in the file,
 * so a field written to the wrong key, a hidden local field left behind, a loosening saved without
 * being said, or a bad value posted would each show up here as the body the server received.
 */

// ⚠ A DOM before react-dom/client evaluates.
ensureDom()
const { createRoot }: { createRoot: typeof CreateRoot } = await import('react-dom/client')
const { SecuritySection }: typeof SecuritySettingsModule = await import('../security-settings.tsx')
afterAll(releaseDom)

const flush = (work: () => Promise<void> | void): Promise<void> => act(async () => work())
const ETAG = `"${'a'.repeat(64)}"`

function read(security: unknown, judgeKeySet = false): unknown {
  return { kind: 'ok', path: '/h/config.json', etag: ETAG, security, secretsPath: '/h/secrets.env', judgeKeySet }
}

async function mounted(initial: unknown): Promise<{
  container: HTMLElement
  sent: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }>
  unmount: () => Promise<void>
}> {
  const sent: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }> = []
  let current = initial
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    sent.push({ url, method, headers: (init?.headers ?? {}) as Record<string, string>, body })
    if (url.endsWith('/judge-key')) return Response.json({ judgeKeySet: body.value !== null })
    if (method === 'PUT') current = read(body.security)
    return Response.json(current)
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await flush(() => root.render(<SecuritySection fetch={fetchImpl} />))
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

function type(element: HTMLInputElement | HTMLSelectElement, value: string): void {
  const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value)
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
}

const field = (container: HTMLElement, id: string): HTMLInputElement =>
  container.querySelector(`#security-${id}`) as HTMLInputElement

test('a bad value saves nothing and is listed; a loosening is said first; the save sends only declared keys', async () => {
  const page = await mounted(
    read({
      incidents: { halt: true },
      judge: { backend: 'local', local: { baseUrl: 'http://127.0.0.1:1', model: 'm' } },
    }),
  )
  const { container, sent } = page
  await flush(() => type(field(container, 'highAtSignals'), '0'))
  await flush(() => button(container, 'Save').click())
  expect(container.textContent).toContain('Nothing was saved — one setting needs fixing')
  expect(sent.filter((each) => each.method === 'PUT')).toEqual([])

  await flush(() => type(field(container, 'highAtSignals'), '6'))
  await flush(() => field(container, 'halt').click())
  await flush(() => type(container.querySelector('#security-backend') as HTMLSelectElement, 'jev'))
  await flush(() => button(container, 'Save').click())
  expect(container.textContent).toContain('an incident will no longer suspend tools')
  expect(container.textContent).toContain('Signals for high risk: 3 → 6 signals')
  expect(sent.filter((each) => each.method === 'PUT')).toEqual([])

  await flush(() => button(container, 'Save anyway').click())
  const put = sent.find((each) => each.method === 'PUT')
  expect(put?.headers['If-Match']).toBe(ETAG)
  // The local judge's address and model are gone with the local judge.
  expect(put?.body).toEqual({ security: { incidents: { halt: false, highAtSignals: 6 }, judge: { backend: 'jev' } } })

  // Jev shows its key, stored write-only.
  const key = container.querySelector('input[type="password"]') as HTMLInputElement
  await flush(() => type(key, 'ts-key-1'))
  await flush(() => button(container, 'Store key').click())
  expect(sent.at(-1)?.body).toEqual({ value: 'ts-key-1' })
  expect(container.textContent).toContain('Replace key')
  await page.unmount()
})

// #969 review, issue 1: the confirm lists what the draft loosened when Save was pressed; an edit
// made while it is open must not ride along on "Save anyway" unlisted.
test('an edit while the loosening confirm is open closes it, and nothing unconfirmed is sent', async () => {
  const page = await mounted(read({ incidents: { halt: true } }))
  const { container, sent } = page
  await flush(() => field(container, 'halt').click())
  await flush(() => button(container, 'Save').click())
  expect(container.textContent).toContain('Halting goes off')
  await flush(() => type(field(container, 'highAtSignals'), '50'))
  expect(container.textContent).not.toContain('Save anyway')
  expect(sent.filter((each) => each.method === 'PUT')).toEqual([])

  await flush(() => button(container, 'Save').click())
  expect(container.textContent).toContain('Signals for high risk: 3 → 50 signals')
  await flush(() => button(container, 'Save anyway').click())
  expect(sent.find((each) => each.method === 'PUT')?.body).toEqual({
    security: { incidents: { halt: false, highAtSignals: 50 } },
  })
  await page.unmount()
})

// #969 review, issue 2: a local judge that is not on this machine is never asked, so the page
// refuses the address instead of saving a judge that judges nothing.
test('a local judge address off this machine is a field error, and nothing is saved', async () => {
  const page = await mounted(read({}))
  const { container, sent } = page
  await flush(() => type(container.querySelector('#security-backend') as HTMLSelectElement, 'local'))
  await flush(() => type(field(container, 'baseUrl'), 'http://10.0.0.2:8080'))
  await flush(() => type(field(container, 'model'), 'm'))
  await flush(() => button(container, 'Save').click())
  expect(container.textContent).toContain('The local judge only talks to this machine')
  expect(sent.filter((each) => each.method === 'PUT')).toEqual([])

  await flush(() => type(field(container, 'baseUrl'), 'http://[::1]:8080/v1'))
  await flush(() => button(container, 'Save').click())
  expect(sent.find((each) => each.method === 'PUT')?.body).toEqual({
    security: { judge: { backend: 'local', local: { baseUrl: 'http://[::1]:8080/v1', model: 'm' } } },
  })
  await page.unmount()
})

// #969 review, issue 5: a `judge.local` kept while the judge is not local is dropped by the next
// save, so the unsaved list names it rather than claiming only the edited field changes.
test('a hidden local judge the next save drops is listed as unsaved', async () => {
  const page = await mounted(read({ judge: { backend: 'off', local: { baseUrl: 'http://127.0.0.1:1', model: 'm' } } }))
  const { container } = page
  expect(container.textContent).not.toContain('Local judge address')
  await flush(() => type(field(container, 'windowCalls'), '12'))
  expect(container.textContent).toContain('Calls in the risk window · Local judge address · Local judge model →')
  await page.unmount()
})

// #969 review, issue 6: Jev with no key stored judges nothing, so it is said before Save.
test('choosing Jev with no key stored is said before the save', async () => {
  const page = await mounted(read({}))
  const { container, sent } = page
  await flush(() => type(container.querySelector('#security-backend') as HTMLSelectElement, 'jev'))
  await flush(() => button(container, 'Save').click())
  expect(container.textContent).toContain('no TypeSafe key is stored: every command goes unjudged')
  expect(sent.filter((each) => each.method === 'PUT')).toEqual([])
  await page.unmount()
})

test('an unreadable file is said, and no form is offered', async () => {
  const page = await mounted({
    kind: 'unreadable',
    path: '/h/config.json',
    reason: 'not JSON',
    secretsPath: '/h/secrets.env',
    judgeKeySet: false,
  })
  expect(page.container.textContent).toContain('config.json cannot be read')
  expect(page.container.querySelector('#security-halt')).toBeNull()
  await page.unmount()
})
