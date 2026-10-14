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
