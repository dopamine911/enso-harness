import { afterAll, expect, test } from 'bun:test'
import type { EnsoThreadCommands, RuntimeCommand } from '@enso/core'
import { act } from 'react'
import type { createRoot as CreateRoot, Root } from 'react-dom/client'
import type { CommandPalette as CommandPaletteComponent, rankCommand as RankCommand } from '../command-palette.tsx'
import { ensureDom, releaseDom } from './dom-environment.ts'

// ⚠ A DOM before react-dom/client evaluates, and again if another mounting file has already
// released the one this module registered; `dom-environment.ts` has the measurement. Dynamic
// imports by necessity: react-dom/client probes `document` when its module evaluates, AND SO
// DOES RADIX — `@radix-ui/react-use-layout-effect` picks `useLayoutEffect` or a no-op at
// module load by `globalThis.document`, and with the no-op its Portal never mounts, so the menu
// reports `data-state="open"` and renders nothing (measured 2026-09-22, #338). A static import
// of the palette evaluates the Radix graph before this file's body can register the DOM.
ensureDom()
const { createRoot }: { createRoot: typeof CreateRoot } = await import('react-dom/client')
const {
  CommandPalette,
  rankCommand,
}: { CommandPalette: typeof CommandPaletteComponent; rankCommand: typeof RankCommand } = await import(
  '../command-palette.tsx'
)

/**
 * The `/` palette (#338), MOUNTED under happy-dom over a fetch seam: the menu (Radix
 * dropdown-menu) and the palette inside it (cmdk) both render here — the trigger opens on
 * `pointerdown` as Radix's does, the rows are cmdk's `[cmdk-item]`s, the filter is its input.
 * What these pin: one fetch PER OPEN, the grouping and the description, the filter narrowing,
 * the selection rule (extension → run, prompt/skill → insert, host by kind: level → a page then
 * `onHost`, select → the owner's dialog, #338 slice 2), the three empty/remembered sentences,
 * and a failed fetch rendered inside the palette with its status and body.
 */

afterAll(releaseDom)

const tick = (): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, 20)
  return promise
}
/** React's `act` with async work — typed so its Promise overload is the one seen (the `thread-pane.test.ts` note). */
const flush = (work: () => Promise<void>): Promise<void> => act(work)

const EVENTUALLY_DEADLINE_MS = 2000
/** Retry `probe` until it holds, flushing React between tries; the last failure is the report. */
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

const LIVE: EnsoThreadCommands = {
  threadId: 'thread-1',
  commands: [
    { name: 'mode', source: 'extension', description: 'switch the permission mode (default | plan)' },
    { name: 'plan', source: 'extension' },
    { name: 'review', source: 'prompt', description: 'review the diff' },
    { name: 'deploy', source: 'skill', description: 'ship it' },
  ],
  source: 'live',
}

/** The two host rows the server appends (#338 slice 2), as a live list carries them — with a current `value`. */
const HOST_ROWS: readonly RuntimeCommand[] = [
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
  {
    name: 'thinking',
    source: 'host',
    kind: 'level',
    description: 'set the thinking level',
    value: 'medium',
    options: ['off', 'low', 'medium', 'high'].map((level) => ({ id: level, label: level })),
  },
]
const WITH_HOST: EnsoThreadCommands = { ...LIVE, commands: [...LIVE.commands, ...HOST_ROWS] }

interface MountedPalette {
  readonly asked: string[]
  readonly runs: string[]
  readonly inserts: string[]
  /** Every `onHost` call, as `[name, optionId?]`. */
  readonly hosts: Array<[string, string | undefined]>
  /** Every `onOpenModelDialog` call's row. */
  readonly dialogs: RuntimeCommand[]
  readonly trigger: () => HTMLButtonElement
  readonly open: () => Promise<void>
  readonly close: () => Promise<void>
  readonly palette: () => HTMLElement
  readonly filter: () => HTMLInputElement
  readonly rows: () => string[]
  /** The row cmdk marks selected — the one Enter would pick. */
  readonly selectedRow: () => string | undefined
  readonly row: (label: string) => HTMLElement
  readonly unmount: () => Promise<void>
}

async function mountPalette(respond: () => Response): Promise<MountedPalette> {
  const asked: string[] = []
  const runs: string[] = []
  const inserts: string[] = []
  const hosts: Array<[string, string | undefined]> = []
  const dialogs: RuntimeCommand[] = []
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  await flush(async () => {
    root.render(
      <CommandPalette
        threadId="thread 1"
        fetch={(input: string): Promise<Response> => {
          asked.push(input)
          return Promise.resolve(respond())
        }}
        onRun={(commandName: string): void => {
          runs.push(commandName)
        }}
        onInsert={(commandName: string): void => {
          inserts.push(commandName)
        }}
        onHost={(commandName: string, optionId?: string): void => {
          hosts.push([commandName, optionId])
        }}
        onOpenModelDialog={(command: RuntimeCommand): void => {
          dialogs.push(command)
        }}
      />,
    )
  })
  const trigger = (): HTMLButtonElement => {
    const found = container.querySelector<HTMLButtonElement>('button[aria-label="commands"]')
    if (found === null) throw new Error('expected the `/` button')
    return found
  }
  const palette = (): HTMLElement => {
    const found = document.querySelector<HTMLElement>('[cmdk-root]')
    if (found === null) throw new Error('expected the palette to be open')
    return found
  }
  return {
    asked,
    runs,
    inserts,
    hosts,
    dialogs,
    trigger,
    palette,
    // Radix opens its trigger on a primary-button pointerdown, not on click.
    open: async (): Promise<void> => {
      await flush(async () => {
        trigger().dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }))
        await tick()
      })
      await eventually(palette)
    },
    close: async (): Promise<void> => {
      await flush(async () => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        await tick()
      })
      await eventually(() => expect(document.querySelector('[cmdk-root]')).toBeNull())
    },
    filter: (): HTMLInputElement => {
      const found = palette().querySelector<HTMLInputElement>('input[cmdk-input]')
      if (found === null) throw new Error('expected the filter box')
      return found
    },
    selectedRow: (): string | undefined =>
      document.querySelector<HTMLElement>('[cmdk-item][aria-selected="true"]')?.getAttribute('data-value') ?? undefined,
    rows: (): string[] =>
      [...palette().querySelectorAll<HTMLElement>('[cmdk-item]')].map((row) => row.getAttribute('data-value') ?? ''),
    row: (label: string): HTMLElement => {
      const found = [...palette().querySelectorAll<HTMLElement>('[cmdk-item]')].find(
        (candidate) => candidate.getAttribute('data-value') === label,
      )
      if (found === undefined) throw new Error(`expected a row for ${label}`)
      return found
    },
    unmount: async (): Promise<void> => {
      await flush(async () => root.unmount())
      container.remove()
    },
  }
}

/**
 * Type into cmdk's input the way a browser does: through the prototype's value setter (React's
 * value tracker wraps the instance's own), then one bubbling `input` event.
 */
function typeInto(field: HTMLInputElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (setter === undefined) throw new Error('HTMLInputElement.prototype.value has no setter')
  setter.call(field, text)
  field.dispatchEvent(new Event('input', { bubbles: true }))
}

test('opening fetches the thread-scoped route — once per open, so a second open asks again', async () => {
  const mounted = await mountPalette(() => Response.json(LIVE))
  expect(mounted.asked).toEqual([])
  await mounted.open()
  // The first keystroke filters: focus is in the filter box, not on the menu's own content.
  await eventually(() => expect(document.activeElement).toBe(mounted.filter()))
  expect(mounted.asked).toEqual(['/api/threads/thread%201/commands'])
  await mounted.close()
  await mounted.open()
  expect(mounted.asked).toEqual(['/api/threads/thread%201/commands', '/api/threads/thread%201/commands'])
  await mounted.unmount()
})

test('rows render grouped by source, as `/name`, with the description beside it', async () => {
  const mounted = await mountPalette(() => Response.json(LIVE))
  await mounted.open()
  await eventually(() => expect(mounted.rows()).toEqual(['/mode', '/plan', '/review', '/deploy']))
  const headings = [...mounted.palette().querySelectorAll<HTMLElement>('[cmdk-group-heading]')].map(
    (heading) => heading.textContent,
  )
  expect(headings).toEqual(['extensions', 'prompts', 'skills'])
  // `/mode` sits under `extensions`, and its row carries the description.
  const modeRow = mounted.row('/mode')
  expect(modeRow.closest('[cmdk-group]')?.querySelector('[cmdk-group-heading]')?.textContent).toBe('extensions')
  expect(modeRow.textContent).toContain('/mode')
  expect(modeRow.textContent).toContain('switch the permission mode')
  // No footer note: the list is this thread's own.
  expect(mounted.palette().textContent).not.toContain('from the last session')
  await mounted.unmount()
})

test('typing in the filter narrows the rows; a miss says so', async () => {
  const mounted = await mountPalette(() => Response.json(LIVE))
  await mounted.open()
  await eventually(() => expect(mounted.rows()).toHaveLength(4))
  await flush(async () => {
    typeInto(mounted.filter(), 'rev')
    await tick()
  })
  await eventually(() => expect(mounted.rows()).toEqual(['/review']))
  // ⚠ Name before description: `/mode` DESCRIBES plan, `/plan` IS it, so both show and `/plan`
  // ranks first — cmdk's own fuzzy score put the describer first on the real list and Enter ran
  // it (smoke, 2026-09-22). cmdk applies the rank by re-appending rows, which happy-dom does not
  // reproduce, so the ORDER is pinned on `rankCommand` and the SET on the DOM; Chromium showed
  // `/plan` above `/mode` for this filter.
  await flush(async () => {
    typeInto(mounted.filter(), 'pla')
    await tick()
  })
  await eventually(() => expect(mounted.rows().toSorted()).toEqual(['/mode', '/plan']))
  const byName = rankCommand('/plan', 'pla')
  const byDescription = rankCommand('/mode', 'pla', ['switch the permission mode (default | plan)'])
  expect(byName).toBeGreaterThan(byDescription)
  expect(byDescription).toBeGreaterThan(0)
  expect(rankCommand('/deploy', 'pla', ['ship it'])).toBe(0)
  // Among names, the earlier match ranks higher: `/plan` for `p` over `/deploy` for `p`.
  expect(rankCommand('/plan', 'p')).toBeGreaterThan(rankCommand('/deploy', 'p'))
  // A search typed with its own `/` is the start of the name, not a score above 1 that would order
  // rows by name length (PR #343 review): `1` is the ceiling, and `/pl` ranks as `pl` does.
  expect(rankCommand('/plan', '/')).toBe(1)
  expect(rankCommand('/deploy', '/')).toBe(1)
  expect(rankCommand('/plan', '/pl')).toBe(rankCommand('/plan', 'pl'))
  await flush(async () => {
    typeInto(mounted.filter(), 'zzz')
    await tick()
  })
  await eventually(() => {
    expect(mounted.rows()).toEqual([])
    expect(mounted.palette().textContent).toContain('no command matches')
  })
  await mounted.unmount()
})

// ⚠ TWO LIBRARIES' KEYBOARD MODELS MEET HERE (PR #343 review): Radix's menu owns the popup and
// cmdk owns the rows. Radix hands arrow keys on unless the content itself is focused, so with focus
// in the filter they reach cmdk — the header's claim, pinned, because it is Radix-version-sensitive.
test("ArrowDown then Enter, with focus in the filter, selects the SECOND row — the keys are cmdk's", async () => {
  const mounted = await mountPalette(() => Response.json(LIVE))
  await mounted.open()
  await eventually(() => expect(mounted.rows()).toHaveLength(4))
  await flush(async () => {
    mounted.filter().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    await tick()
  })
  await eventually(() => expect(mounted.selectedRow()).toBe('/plan'))
  await flush(async () => {
    mounted.filter().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await tick()
  })
  await eventually(() => {
    expect(mounted.runs).toEqual(['plan'])
    expect(mounted.inserts).toEqual([])
  })
  await mounted.unmount()
})

test('an extension row RUNS: `onRun` with the bare name, the menu closes, nothing is inserted', async () => {
  const mounted = await mountPalette(() => Response.json(LIVE))
  await mounted.open()
  const modeRow = await eventually(() => mounted.row('/mode'))
  await flush(async () => {
    modeRow.click()
    await tick()
  })
  await eventually(() => {
    expect(mounted.runs).toEqual(['mode'])
    expect(document.querySelector('[cmdk-root]')).toBeNull()
  })
  expect(mounted.inserts).toEqual([])
  await mounted.unmount()
})

test('a prompt row INSERTS: `onInsert` with the bare name, and nothing runs', async () => {
  const mounted = await mountPalette(() => Response.json(LIVE))
  await mounted.open()
  const reviewRow = await eventually(() => mounted.row('/review'))
  await flush(async () => {
    reviewRow.click()
    await tick()
  })
  await eventually(() => expect(mounted.inserts).toEqual(['review']))
  expect(mounted.runs).toEqual([])
  await mounted.unmount()
})

// ⚠ HOST ROWS RENDER BY KIND (#338 slice 2). `settings` is OURS and FIRST; the right-hand label is
// the current option's `label`, dim, off the row's `value` — so a reader sees `Fake One` and
// `medium` without opening anything, the chip's two facts in the palette too.
test('the host group renders first as `settings`, each row with its current value on the right', async () => {
  const mounted = await mountPalette(() => Response.json(WITH_HOST))
  await mounted.open()
  await eventually(() =>
    expect(mounted.rows()).toEqual(['/model', '/thinking', '/mode', '/plan', '/review', '/deploy']),
  )
  const headings = [...mounted.palette().querySelectorAll<HTMLElement>('[cmdk-group-heading]')].map(
    (heading) => heading.textContent,
  )
  expect(headings).toEqual(['settings', 'extensions', 'prompts', 'skills'])
  expect(mounted.row('/model').textContent).toBe('/modelswitch the modelFake One')
  expect(mounted.row('/thinking').textContent).toBe('/thinkingset the thinking levelmedium')
  await mounted.unmount()
})

// A `level` row is a PAGE inside the same cmdk root: its options replace the list, the filter
// box is the same one (emptied), and Escape or Backspace-on-empty returns to the root without
// closing the menu — Claude Code's second step, minus a second popup.
test('a level row opens its options as a page; Escape returns to the root; picking one is `onHost(name, id)` and closes', async () => {
  const mounted = await mountPalette(() => Response.json(WITH_HOST))
  await mounted.open()
  const thinkingRow = await eventually(() => mounted.row('/thinking'))
  await flush(async () => {
    typeInto(mounted.filter(), 'think')
    await tick()
  })
  await eventually(() => expect(mounted.rows()).toEqual(['/thinking']))
  await flush(async () => {
    thinkingRow.click()
    await tick()
  })
  await eventually(() => expect(mounted.rows()).toEqual(['off', 'low', 'medium', 'high']))
  // The page's filter starts empty (what narrowed the root would not narrow the page), and the
  // current level is marked.
  expect(mounted.filter().value).toBe('')
  expect(mounted.row('medium').getAttribute('data-checked')).toBe('true')
  expect(mounted.row('high').getAttribute('data-checked')).toBe('false')
  expect(mounted.palette().querySelector('[cmdk-group-heading]')?.textContent).toBe('/thinking')
  // Escape: back to the root, the menu still open. (Cancelable, as a browser's keydown is: the
  // palette PREVENTS it so the dismissable layer does not read it as a close.)
  await flush(async () => {
    mounted.filter().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await tick()
  })
  await eventually(() =>
    expect(mounted.rows()).toEqual(['/model', '/thinking', '/mode', '/plan', '/review', '/deploy']),
  )
  // Backspace on an empty filter: the same way back.
  await flush(async () => {
    mounted.row('/thinking').click()
    await tick()
  })
  await eventually(() => expect(mounted.rows()).toEqual(['off', 'low', 'medium', 'high']))
  await flush(async () => {
    mounted.filter().dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }))
    await tick()
  })
  await eventually(() => expect(mounted.rows()).toHaveLength(6))
  // And the pick: the option's id with the command's name, once the menu has closed.
  await flush(async () => {
    mounted.row('/thinking').click()
    await tick()
  })
  const highRow = await eventually(() => mounted.row('high'))
  await flush(async () => {
    highRow.click()
    await tick()
  })
  await eventually(() => {
    expect(mounted.hosts).toEqual([['thinking', 'high']])
    expect(document.querySelector('[cmdk-root]')).toBeNull()
  })
  expect(mounted.runs).toEqual([])
  expect(mounted.inserts).toEqual([])
  expect(mounted.dialogs).toEqual([])
  await mounted.unmount()
})

test('a select row closes the palette and hands the row to `onOpenModelDialog`; nothing is posted by the palette', async () => {
  const mounted = await mountPalette(() => Response.json(WITH_HOST))
  await mounted.open()
  const modelRow = await eventually(() => mounted.row('/model'))
  await flush(async () => {
    modelRow.click()
    await tick()
  })
  await eventually(() => {
    expect(mounted.dialogs.map((row) => row.name)).toEqual(['model'])
    expect(mounted.dialogs[0]?.options).toEqual(HOST_ROWS[0]?.options)
    expect(document.querySelector('[cmdk-root]')).toBeNull()
  })
  expect(mounted.hosts).toEqual([])
  await mounted.unmount()
})

// A `flow` row (#338 slice 3) is the same gesture as a `select`: the options dialog opens and the
// palette posts nothing — what the server does with the choice (start a login) is the route's.
test('a flow row opens the options dialog exactly as a select row does, with no value on the right', async () => {
  const loginRow: RuntimeCommand = {
    name: 'login',
    source: 'host',
    kind: 'flow',
    description: 'log in to a provider',
    options: [{ id: 'anthropic/oauth', label: 'Anthropic · subscription', detail: 'not configured' }],
  }
  const mounted = await mountPalette(() => Response.json({ ...WITH_HOST, commands: [...WITH_HOST.commands, loginRow] }))
  await mounted.open()
  const row = await eventually(() => mounted.row('/login'))
  expect(row.textContent).toBe('/loginlog in to a provider')
  await flush(async () => {
    row.click()
    await tick()
  })
  await eventually(() => expect(mounted.dialogs.map((chosen) => chosen.name)).toEqual(['login']))
  expect(mounted.hosts).toEqual([])
  await mounted.unmount()
})

// The #341 case: a thread with no live session gets the `remembered` list, whose host rows the
// server strips `value` from. No right-hand label — and the row STILL opens its page, because
// choosing before the first prompt is what the rows are for.
test('a remembered host row without a value shows no label and still opens its page', async () => {
  const stripped = HOST_ROWS.map(({ value: _current, ...row }) => row)
  const mounted = await mountPalette(() =>
    Response.json({ ...LIVE, commands: [...LIVE.commands, ...stripped], source: 'remembered' }),
  )
  await mounted.open()
  const thinkingRow = await eventually(() => mounted.row('/thinking'))
  expect(thinkingRow.textContent).toBe('/thinkingset the thinking level')
  expect(mounted.row('/model').textContent).toBe('/modelswitch the model')
  await flush(async () => {
    thinkingRow.click()
    await tick()
  })
  await eventually(() => expect(mounted.rows()).toEqual(['off', 'low', 'medium', 'high']))
  expect([...mounted.palette().querySelectorAll('[cmdk-item][data-checked="true"]')]).toHaveLength(0)
  await mounted.unmount()
})

// An `action` row runs bare (slice 4's `/compact`), and so does a host row with NO kind — the
// palette's fallthrough. (A kind the schema does not list cannot arrive: `fetchThreadCommands`
// refuses the payload whole, so "unknown kind" is a code path the wire never reaches.)
test('an action row — or a host row with no kind — is `onHost(name)` bare', async () => {
  const rows: RuntimeCommand[] = [
    { name: 'compact', source: 'host', kind: 'action', description: 'compact the context' },
    { name: 'kindless', source: 'host' },
  ]
  const mounted = await mountPalette(() => Response.json({ ...LIVE, commands: rows }))
  await mounted.open()
  const compactRow = await eventually(() => mounted.row('/compact'))
  await flush(async () => {
    compactRow.click()
    await tick()
  })
  await eventually(() => expect(mounted.hosts).toEqual([['compact', undefined]]))
  await mounted.open()
  const kindlessRow = await eventually(() => mounted.row('/kindless'))
  await flush(async () => {
    kindlessRow.click()
    await tick()
  })
  await eventually(() =>
    expect(mounted.hosts).toEqual([
      ['compact', undefined],
      ['kindless', undefined],
    ]),
  )
  await mounted.unmount()
})

test("`source: 'none'` says no thread has run yet", async () => {
  const mounted = await mountPalette(() => Response.json({ threadId: 'thread 1', commands: [], source: 'none' }))
  await mounted.open()
  await eventually(() =>
    expect(mounted.palette().textContent).toContain('no thread has run yet — commands appear after the first prompt'),
  )
  await mounted.unmount()
})

test('a live list with no rows says the session registers no commands', async () => {
  const mounted = await mountPalette(() => Response.json({ threadId: 'thread 1', commands: [], source: 'live' }))
  await mounted.open()
  await eventually(() => expect(mounted.palette().textContent).toContain('this session registers no commands'))
  expect(mounted.palette().textContent).not.toContain('no thread has run yet')
  await mounted.unmount()
})

test("`source: 'remembered'` shows the rows and a footer note that the thread has no live session", async () => {
  const mounted = await mountPalette(() => Response.json({ ...LIVE, source: 'remembered' }))
  await mounted.open()
  await eventually(() => {
    expect(mounted.rows()).toHaveLength(4)
    expect(mounted.palette().textContent).toContain('from the last session — this thread has no live session')
  })
  await mounted.unmount()
})

test('a failed fetch renders `<status> <body>` inside the palette', async () => {
  const mounted = await mountPalette(() => new Response('pi is not here', { status: 500 }))
  await mounted.open()
  await eventually(() =>
    expect(mounted.palette().querySelector('[role="alert"]')?.textContent).toBe('500 pi is not here'),
  )
  expect(mounted.rows()).toEqual([])
  await mounted.unmount()
})
