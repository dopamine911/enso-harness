import { afterAll, expect, test } from 'bun:test'
import type { EnsoContextEvent, EnsoFileOperation } from '@enso/core'
import { act } from 'react'
import type { createRoot as CreateRoot } from 'react-dom/client'
import type * as ContextActivityModule from '../context-activity.tsx'
import type { ContextBrowserFocus, ContextBrowserRequest } from '../context-browser.tsx'
import { ensureDom, releaseDom } from './dom-environment.ts'

/**
 * #361 phase 4: where Context Events and File Activity send the reader — an event to the first
 * request it reached, an operation to its tool result in the request after its turn, and either to
 * the next request when the branch has none that far yet.
 */

ensureDom()
const { createRoot }: { createRoot: typeof CreateRoot } = await import('react-dom/client')
const { ContextEvents, FileActivity }: typeof ContextActivityModule = await import('../context-activity.tsx')
afterAll(releaseDom)

type OnOpen = (request: ContextBrowserRequest, focus?: ContextBrowserFocus) => void
type Opened = [ContextBrowserRequest, ContextBrowserFocus | undefined]
/** A button to click, looked up once the click before it has rendered. */
type Step = (container: HTMLElement) => HTMLButtonElement | undefined

const flush = (work: () => Promise<void>): Promise<void> => act(work)

interface ClickedThrough {
  readonly opened: Opened[]
  /** Each step's button, as it was when clicked — undefined when the step found none. */
  readonly clicked: Array<HTMLButtonElement | undefined>
}

/** Mounts the card `node` draws, clicks each step's button in turn, and returns what the card opened. */
async function clickThrough(
  node: (onOpen: OnOpen) => React.ReactNode,
  steps: readonly Step[],
): Promise<ClickedThrough> {
  const opened: Opened[] = []
  const clicked: Array<HTMLButtonElement | undefined> = []
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await flush(async () => {
    root.render(node((request, focus) => opened.push([request, focus])))
  })
  for (const step of steps) {
    const button = step(container)
    clicked.push(button)
    await flush(async () => {
      button?.click()
    })
  }
  await flush(async () => root.unmount())
  container.remove()
  return { opened, clicked }
}

const buttonWith =
  (selector: string, text: string): Step =>
  (container: HTMLElement): HTMLButtonElement | undefined =>
    [...container.querySelectorAll<HTMLButtonElement>(selector)].find((button) => button.textContent?.includes(text))

const event = (turn: number, label: string): EnsoContextEvent => ({
  key: `entry-${turn}`,
  kind: 'switch',
  label,
  turn,
  at: `2026-09-24T10:00:0${turn}.000Z`,
  tokens: 0,
})

test('an event opens the first request it reached; one past the last request opens the next', async () => {
  const { opened } = await clickThrough(
    (onOpen) => (
      <ContextEvents events={[event(2, 'model early'), event(4, 'model late')]} requestCount={3} onOpen={onOpen} />
    ),
    [buttonWith('ol button', 'model early'), buttonWith('ol button', 'model late')],
  )
  expect(opened).toEqual([
    [2, undefined],
    ['next', undefined],
  ])
})

const operation = (turn: number, overrides: Partial<EnsoFileOperation>): EnsoFileOperation => ({
  key: `e${turn}#0.0`,
  path: 'src/a.ts',
  kind: 'read',
  tool: 'read',
  subject: '',
  added: 0,
  removed: 0,
  hits: 0,
  image: false,
  isError: false,
  turn,
  at: `2026-09-24T10:00:0${turn}.000Z`,
  ...overrides,
})

test('an operation opens its result in the request after its turn, the next one after the last; no result, nothing', async () => {
  const operations = [
    operation(1, { subject: 'lines 1–5', resultKey: 'r1#0' }),
    operation(3, { subject: 'lines 6–9', resultKey: 'r3#0' }),
    operation(3, { key: 'e3#1.0', subject: 'lines 10–12' }),
  ]
  const { opened, clicked } = await clickThrough(
    (onOpen) => (
      <FileActivity operations={operations} upToTurn={undefined} cwd={undefined} requestCount={3} onOpen={onOpen} />
    ),
    [
      buttonWith('button[aria-expanded]', 'a.ts'),
      buttonWith('ul ol button', 'lines 1–5'),
      buttonWith('ul ol button', 'lines 6–9'),
      buttonWith('ul ol button', 'lines 10–12'),
    ],
  )
  expect(clicked.every((button) => button !== undefined)).toBe(true)
  expect(clicked.at(-1)?.disabled).toBe(true)
  expect(opened).toEqual([
    [2, { request: 2, key: 'r1#0' }],
    ['next', { request: 'next', key: 'r3#0' }],
  ])
})
