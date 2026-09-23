import { afterAll, expect, test } from 'bun:test'
import type { EnsoModelState, EnsoThreadCommands } from '@enso/core'
import { act } from 'react'
import type { createRoot as CreateRoot, Root } from 'react-dom/client'
import type * as ModelStateModule from '../model-state.tsx'
import { ensureDom, releaseDom } from './dom-environment.ts'

// ⚠ A DOM before react-dom/client and Radix evaluate — `command-palette.test.tsx` has the
// measurement. The dialog is a Radix portal; the select's trigger takes its text from a portal too.
ensureDom()
const { createRoot }: { createRoot: typeof CreateRoot } = await import('react-dom/client')
const { ModelChip, ModelChoiceDialog, ThinkingLevelSelect, MODEL_NOT_LIVE, rankOption }: typeof ModelStateModule =
  await import('../model-state.tsx')

/**
 * The composer's model controls (#338 slice 2), MOUNTED under happy-dom: the chip's two sentences
 * (a name, or the not-live one — a button either way, #341), the thinking select's presence
 * and value, and the `/model` dialog over a fetch seam — options from a FRESH `/commands` read,
 * the current one marked, a pick delivered as `(command, optionId)` after the close, and the
 * two failures said inside the dialog. The store itself is pinned by `custom-event-router.test.ts`.
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

const LIVE_MODEL: EnsoModelState = {
  model: { provider: 'fake', id: 'one', name: 'Fake One' },
  thinkingLevel: 'medium',
  availableThinkingLevels: ['off', 'low', 'medium', 'high'],
}

const COMMANDS: EnsoThreadCommands = {
  threadId: 'thread-1',
  source: 'remembered',
  commands: [
    { name: 'mode', source: 'extension' },
    {
      name: 'model',
      source: 'host',
      kind: 'select',
      description: 'switch the model',
      value: 'fake/one',
      options: [
        { id: 'fake/one', label: 'Fake One', detail: 'fake' },
        { id: 'fake/two', label: 'Fake Two', detail: 'fake' },
      ],
    },
  ],
}

interface Mounted {
  readonly container: HTMLElement
  readonly render: (node: React.ReactNode) => Promise<void>
  readonly unmount: () => Promise<void>
}

async function mount(node: React.ReactNode): Promise<Mounted> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  const render = async (next: React.ReactNode): Promise<void> => {
    await flush(async () => {
      root.render(next)
    })
  }
  await render(node)
  return {
    container,
    render,
    unmount: async (): Promise<void> => {
      await flush(async () => root.unmount())
      container.remove()
    },
  }
}

const noop = (): void => undefined

test('the chip is a button either way: the model name when live, the not-live sentence when nothing is known', async () => {
  const opens: number[] = []
  const mounted = await mount(<ModelChip state={null} onOpen={(): void => void opens.push(1)} />)
  const chip = (): HTMLButtonElement => {
    const found = mounted.container.querySelector<HTMLButtonElement>('button[aria-label="model"]')
    if (found === null) throw new Error('expected the model chip')
    return found
  }
  expect(chip().textContent).toBe(MODEL_NOT_LIVE)
  expect(chip().disabled).toBe(false)
  await flush(async () => {
    chip().click()
  })
  expect(opens).toEqual([1])
  await mounted.render(<ModelChip state={LIVE_MODEL} onOpen={noop} />)
  expect(chip().textContent).toBe('modelFake One')
  await mounted.render(<ModelChip state={{ ...LIVE_MODEL, model: null }} onOpen={noop} />)
  expect(chip().textContent).toBe('model: none')
  await mounted.unmount()
})

test('the thinking select renders nothing while not live, and the current level once it is', async () => {
  const mounted = await mount(<ThinkingLevelSelect state={null} onSelect={noop} />)
  expect(mounted.container.querySelector('[aria-label="thinking level"]')).toBeNull()
  await mounted.render(<ThinkingLevelSelect state={LIVE_MODEL} onSelect={noop} />)
  const trigger = await eventually(() => {
    const found = mounted.container.querySelector<HTMLButtonElement>('button[aria-label="thinking level"]')
    if (found === null) throw new Error('expected the thinking select')
    return found
  })
  await eventually(() => expect(trigger.textContent).toBe('medium'))
  await mounted.unmount()
})

interface MountedDialog extends Mounted {
  readonly asked: string[]
  readonly picks: Array<[string, string]>
  readonly closes: number[]
  readonly dialog: () => HTMLElement
  readonly rows: () => HTMLElement[]
}

// `command` is explicit: a default parameter would turn the closed case's `undefined` into 'model'.
async function mountDialog(respond: () => Response, command: string | undefined): Promise<MountedDialog> {
  const asked: string[] = []
  const picks: Array<[string, string]> = []
  const closes: number[] = []
  const mounted = await mount(
    <ModelChoiceDialog
      threadId="thread 1"
      command={command}
      fetch={(input: string): Promise<Response> => {
        asked.push(input)
        return Promise.resolve(respond())
      }}
      onClose={(): void => void closes.push(1)}
      onPick={(chosenCommand: string, optionId: string): void => void picks.push([chosenCommand, optionId])}
    />,
  )
  const dialog = (): HTMLElement => {
    const found = document.querySelector<HTMLElement>('[role="dialog"]')
    if (found === null) throw new Error('expected the model dialog to be open')
    return found
  }
  return {
    ...mounted,
    asked,
    picks,
    closes,
    dialog,
    rows: (): HTMLElement[] => [...dialog().querySelectorAll<HTMLElement>('[cmdk-item]')],
  }
}

test('opening the dialog reads a fresh /commands and lists the select row’s options with the current one marked', async () => {
  const mounted = await mountDialog(() => Response.json(COMMANDS), 'model')
  await eventually(() =>
    expect(mounted.rows().map((row) => row.getAttribute('data-value'))).toEqual(['fake/one', 'fake/two']),
  )
  expect(mounted.asked).toEqual(['/api/threads/thread%201/commands'])
  const [first, second] = mounted.rows()
  expect(first?.textContent).toBe('Fake Onefake')
  expect(first?.getAttribute('data-checked')).toBe('true')
  expect(second?.getAttribute('data-checked')).toBe('false')
  // The group is headed by the row's description; the sr-only title says the same.
  expect(mounted.dialog().querySelector('[cmdk-group-heading]')?.textContent).toBe('switch the model')
  await mounted.unmount()
})

test('picking an option closes first, then delivers `(command, optionId)` — the owner POSTs, nothing here does', async () => {
  const mounted = await mountDialog(() => Response.json(COMMANDS), 'model')
  const second = await eventually(() => {
    const found = mounted.rows()[1]
    if (found === undefined) throw new Error('expected the second option')
    return found
  })
  await flush(async () => {
    second.click()
    await tick()
  })
  expect(mounted.closes).toEqual([1])
  expect(mounted.picks).toEqual([['model', 'fake/two']])
  // Only the read went to the network.
  expect(mounted.asked).toEqual(['/api/threads/thread%201/commands'])
  await mounted.unmount()
})

test('a failed read, or a list without the command, is said inside the dialog', async () => {
  const failed = await mountDialog(() => new Response('pi is not here', { status: 503 }), 'model')
  await eventually(() =>
    expect(failed.dialog().querySelector('[role="alert"]')?.textContent).toBe('503 pi is not here'),
  )
  await failed.unmount()
  const missing = await mountDialog(() => Response.json({ ...COMMANDS, commands: [] }), 'model')
  await eventually(() =>
    expect(missing.dialog().querySelector('[role="alert"]')?.textContent).toBe('the host offers no /model command'),
  )
  await missing.unmount()
})

test('closed, the dialog renders nothing and reads nothing', async () => {
  const mounted = await mountDialog(() => Response.json(COMMANDS), undefined)
  await flush(tick)
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(mounted.asked).toEqual([])
  await mounted.unmount()
})

// The dialog's filter is substring-first (#338 slice 3): cmdk's default fuzzy score matched
// `openai` to 22 of 53 login options — any row spelling o-p-e-n-a-i in order. Typed text must
// appear in the id, the label or the detail, and an earlier appearance ranks higher.
test('rankOption hides a row the typed text does not appear in, and ranks an earlier appearance higher', () => {
  expect(rankOption('openai/api_key', 'openai', ['OpenAI · API key', 'not configured'])).toBeGreaterThan(0)
  expect(rankOption('opencode/api_key', 'openai', ['opencode · API key', 'not configured'])).toBe(0)
  expect(rankOption('azure-openai-responses/api_key', 'openai', ['Azure OpenAI · API key'])).toBeGreaterThan(0)
  expect(rankOption('openai/api_key', 'openai', ['OpenAI · API key'])).toBeGreaterThan(
    rankOption('azure-openai-responses/api_key', 'openai', ['Azure OpenAI · API key']),
  )
  expect(rankOption('anything', '', [])).toBe(1)
})
