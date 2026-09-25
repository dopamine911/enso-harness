import { afterAll, expect, test } from 'bun:test'
import type { EnsoSessionConfiguration, EnsoThreadCommands } from '@enso/core'
import { act } from 'react'
import type { createRoot as CreateRoot, Root } from 'react-dom/client'
import type { ConfigureOutcome } from '../follow-connection.ts'
import type * as StartSessionModule from '../start-session.tsx'
import { ensureDom, releaseDom } from './dom-environment.ts'

// ⚠ A DOM before react-dom/client and Radix evaluate — `command-palette.test.tsx` has the
// measurement. The dialog is a Radix portal.
ensureDom()
const { createRoot }: { createRoot: typeof CreateRoot } = await import('react-dom/client')
const { StartSessionDialog }: typeof StartSessionModule = await import('../start-session.tsx')

/**
 * The Start-a-session dialog (#391), MOUNTED under happy-dom over a fetch seam: what Start sends is
 * the contract — the three settings in ONE configure call, the effort the CHOSEN model offers,
 * then the prompt through the chat's send — and a refused step keeps the dialog open and says which.
 */

afterAll(releaseDom)

const tick = (): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, 20)
  return promise
}
const flush = (work: () => Promise<void>): Promise<void> => act(work)

const EVENTUALLY_DEADLINE_MS = 2000
async function eventually<T>(probe: () => T): Promise<T> {
  const deadline = Date.now() + EVENTUALLY_DEADLINE_MS
  for (;;) {
    try {
      return probe()
    } catch (error) {
      if (Date.now() >= deadline) throw error
      await flush(tick)
    }
  }
}

/** A session on a reasoning model at `high`, beside one that cannot reason. */
const COMMANDS: EnsoThreadCommands = {
  threadId: 'thread-1',
  source: 'live',
  commands: [
    {
      name: 'model',
      source: 'host',
      kind: 'select',
      value: 'fake/deep',
      options: [
        { id: 'fake/deep', label: 'Deep', detail: 'fake', thinkingLevels: ['off', 'low', 'medium', 'high'] },
        { id: 'fake/plain', label: 'Plain', detail: 'fake', thinkingLevels: ['off'] },
      ],
    },
    {
      name: 'thinking',
      source: 'host',
      kind: 'level',
      value: 'high',
      options: ['off', 'low', 'medium', 'high'].map((level) => ({ id: level, label: level })),
    },
  ],
}

interface Mounted {
  readonly configured: EnsoSessionConfiguration[]
  readonly sent: string[]
  readonly closes: number[]
  readonly dialog: () => HTMLElement
  readonly unmount: () => Promise<void>
}

async function mountStart(answer: ConfigureOutcome): Promise<Mounted> {
  const configured: EnsoSessionConfiguration[] = []
  const sent: string[] = []
  const closes: number[] = []
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  await flush(async () => {
    root.render(
      <StartSessionDialog
        threadId="thread-1"
        open={true}
        onClose={(): void => void closes.push(1)}
        mode="default"
        modes={['default', 'plan']}
        configure={(configuration: EnsoSessionConfiguration): Promise<ConfigureOutcome> => {
          configured.push(configuration)
          return Promise.resolve(answer)
        }}
        send={(text: string): boolean => {
          sent.push(text)
          return true
        }}
        fetch={(): Promise<Response> => Promise.resolve(Response.json(COMMANDS))}
      />,
    )
  })
  const dialog = (): HTMLElement => {
    const found = document.querySelector<HTMLElement>('[role="dialog"]')
    if (found === null) throw new Error('expected the Start-a-session dialog to be open')
    return found
  }
  return {
    configured,
    sent,
    closes,
    dialog,
    unmount: async (): Promise<void> => {
      await flush(async () => root.unmount())
      container.remove()
    },
  }
}

/** Choose a model row, type a prompt the way a person would (React's controlled value), press Start. */
async function chooseTypeAndStart(mounted: Mounted, modelId: string, prompt: string): Promise<void> {
  const row = await eventually(() => {
    const found = mounted.dialog().querySelector<HTMLElement>(`[cmdk-item][data-value="${modelId}"]`)
    if (found === null) throw new Error(`expected the ${modelId} row`)
    return found
  })
  await flush(async () => {
    row.click()
    await tick()
  })
  const field = mounted.dialog().querySelector<HTMLTextAreaElement>('#start-session-prompt')
  if (field === null) throw new Error('expected the prompt field')
  await flush(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(field, prompt)
    field.dispatchEvent(new Event('input', { bubbles: true }))
    await tick()
  })
  const start = [...mounted.dialog().querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === 'Start session',
  )
  if (start === undefined) throw new Error('expected the Start session button')
  await flush(async () => {
    start.click()
    await tick()
  })
}

test('Start sends the three settings in one call — the effort the CHOSEN model offers — then the prompt, then closes', async () => {
  const mounted = await mountStart({ outcome: 'told' })
  // The session runs Deep at `high`; Plain cannot reason, so choosing it takes the effort to `off`.
  await chooseTypeAndStart(mounted, 'fake/plain', 'hello there')
  await eventually(() => expect(mounted.closes).toEqual([1]))
  expect(mounted.configured).toEqual([{ model: 'fake/plain', thinking: 'off', mode: 'default' }])
  expect(mounted.sent).toEqual(['hello there'])
  await mounted.unmount()
})

test('a refused step keeps the dialog open, says which step and why, and sends nothing', async () => {
  const mounted = await mountStart({ outcome: 'refused', step: 'model', reason: 'No API key for fake/plain' })
  await chooseTypeAndStart(mounted, 'fake/plain', 'hello there')
  await eventually(() =>
    expect(mounted.dialog().textContent).toContain('the model was refused: No API key for fake/plain'),
  )
  expect(mounted.sent).toEqual([])
  expect(mounted.closes).toEqual([])
  await mounted.unmount()
})
