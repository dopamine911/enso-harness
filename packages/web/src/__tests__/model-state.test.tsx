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
const { ModelChip, ModelChoiceDialog, EffortChip, MODEL_NOT_LIVE }: typeof ModelStateModule =
  await import('../model-state.tsx')

/**
 * The composer's model controls (#338 slice 2), MOUNTED under happy-dom: the chip's two sentences
 * (a name, or the not-live one — a button either way, #341), the Effort chip's presence
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
  source: 'live',
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

/** The Model chip: the shared chip control (#880), found by its accessible name, `Model: …`. */
function modelChip(container: HTMLElement): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>('button[aria-label^="Model"]')
  if (found === null) throw new Error('expected the model chip')
  return found
}

test('the chip is a button either way: the model and its provider when live, the not-live sentence when nothing is known', async () => {
  const opens: number[] = []
  const mounted = await mount(<ModelChip state={null} onOpen={(): void => void opens.push(1)} />)
  const named = (): string | null => modelChip(mounted.container).getAttribute('aria-label')
  expect(named()).toBe(`Model: ${MODEL_NOT_LIVE}`)
  expect(modelChip(mounted.container).disabled).toBe(false)
  // The shared chip control (#880), as Effort and Mode: the setting's name, then its value.
  expect(modelChip(mounted.container).textContent).toBe(`Model${MODEL_NOT_LIVE}`)
  await flush(async () => {
    modelChip(mounted.container).click()
  })
  expect(opens).toEqual([1])
  await mounted.render(<ModelChip state={LIVE_MODEL} onOpen={noop} />)
  expect(named()).toBe('Model: Fake One · fake')
  // ⚠ #44: the same model on ANOTHER provider is a different answer — under multi-account, a
  // failover to another account slot. Only the provider says so; the chip must change with it.
  const swapped = { ...LIVE_MODEL, model: { provider: 'fake-account-2', id: 'fake-1', name: 'Fake One' } }
  await mounted.render(<ModelChip state={swapped} onOpen={noop} />)
  expect(named()).toBe('Model: Fake One · fake-account-2')
  expect(modelChip(mounted.container).title).toContain('fake-account-2/fake-1')
  await mounted.render(<ModelChip state={{ ...LIVE_MODEL, model: null }} onOpen={noop} />)
  expect(named()).toBe('Model: none')
  await mounted.unmount()
})

test('a cold thread with a recorded model: the chip says it, marked recorded; the live state wins once there is one (#434)', async () => {
  const recorded = { model: { provider: 'anthropic', modelId: 'claude-sonnet-5' }, thinkingLevel: 'medium' }
  const mounted = await mount(<ModelChip state={null} recorded={recorded} onOpen={noop} />)
  const named = (): string | null => modelChip(mounted.container).getAttribute('aria-label')
  expect(named()).toBe('Model (recorded): claude-sonnet-5 · anthropic · medium')
  await mounted.render(<ModelChip state={null} recorded={{ model: null, thinkingLevel: 'high' }} onOpen={noop} />)
  expect(named()).toBe('Model (recorded): high')
  await mounted.render(<ModelChip state={LIVE_MODEL} recorded={recorded} onOpen={noop} />)
  expect(named()).toBe('Model: Fake One · fake')
  await mounted.render(<ModelChip state={null} recorded={null} onOpen={noop} />)
  expect(named()).toBe(`Model: ${MODEL_NOT_LIVE}`)
  await mounted.unmount()
})

test('the Effort chip renders nothing while not live, and the current level once it is', async () => {
  const mounted = await mount(<EffortChip state={null} onSelect={noop} />)
  expect(mounted.container.querySelector('[aria-label^="Effort: "]')).toBeNull()
  await mounted.render(<EffortChip state={LIVE_MODEL} onSelect={noop} />)
  const trigger = await eventually(() => {
    const found = mounted.container.querySelector<HTMLButtonElement>('button[aria-label^="Effort: "]')
    if (found === null) throw new Error('expected the Effort chip')
    return found
  })
  expect(trigger.getAttribute('aria-label')).toBe('Effort: medium')
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
      recent={[]}
      threadId="thread 1"
      command={command}
      fetch={(input: string): Promise<Response> => {
        asked.push(input)
        return Promise.resolve(respond())
      }}
      onClose={(): void => void closes.push(1)}
      returnFocus={(): void => undefined}
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
  // The current one is marked for the eye (the check, `data-checked`) and for a reader, in words.
  expect(first?.textContent).toBe('Fake One, chosen')
  expect(second?.textContent).toBe('Fake Two')
  expect(first?.getAttribute('data-checked')).toBe('true')
  expect(second?.getAttribute('data-checked')).toBe('false')
  // The model picker (#880): the group is the provider; what picking does, the row's description.
  expect(mounted.dialog().querySelector('[cmdk-group-heading]')?.textContent).toBe('fake')
  expect(mounted.dialog().textContent).toContain('switch the model')
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
