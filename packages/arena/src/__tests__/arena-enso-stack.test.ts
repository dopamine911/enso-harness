import { expect, test } from 'bun:test'
import { type ArenaStackChild, type ArenaStackOptions, createEnsoStack } from '../enso-stack.ts'
import type { ArenaEventBody } from '../timeline.ts'

/**
 * The run's Enso stack (#556, #838): what its start, its exit and its stop put on the timeline,
 * the control record and its log — over a stand-in process whose exit the test fires. That
 * `bun run dev` really starts Enso is proven by a live run.
 */

/** One started stand-in: its pid, and the exit the stack listens for. */
interface Started {
  readonly pid: number
  readonly exit: (code: number | null, signal: number | null) => void
}

interface FakeStack {
  readonly options: ArenaStackOptions
  readonly started: Started[]
  readonly steps: string[]
  readonly lines: ArenaEventBody[]
  readonly logged: string[]
  readonly stopping: { value: boolean }
}

/** A stream that hands over `chunks`, then ends. */
function streamOf(chunks: readonly string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start: (controller) => {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
      controller.close()
    },
  })
}

/** Stand-ins for the process, the web check, the tree's stop and the records, each step to one log. */
function fakeStack(overrides: Partial<ArenaStackOptions> = {}): FakeStack {
  const started: Started[] = []
  const steps: string[] = []
  const lines: ArenaEventBody[] = []
  const logged: string[] = []
  const stopping = { value: false }
  const options: ArenaStackOptions = {
    spawn: (onExit) => {
      const pid = 4100 + started.length
      started.push({ pid, exit: onExit })
      steps.push(`spawn ${pid}`)
      const child: ArenaStackChild = { pid, stdout: streamOf([]), stderr: streamOf([]) }
      return child
    },
    answered: () => {
      steps.push('wait for the page')
      return Promise.resolve(true)
    },
    stopTree: (pid) => {
      steps.push(`stop tree ${pid}`)
      return Promise.resolve([])
    },
    log: (text) => logged.push(text),
    record: (body) => {
      steps.push(`record ${body.kind}`)
      lines.push(body)
    },
    shoot: (cause) => {
      steps.push(`shoot ${cause}`)
      return Promise.resolve(undefined)
    },
    started: (pid) => steps.push(`control names ${pid}`),
    stopping: () => stopping.value,
    ...overrides,
  }
  return { options, started, steps, lines, logged, stopping }
}

test('a start names the new stack in the control record, puts it on the timeline, then answers whether its page came up', async () => {
  const down = fakeStack({ answered: () => Promise.resolve(false) })
  const stack = createEnsoStack(down.options)
  expect(await stack.start()).toBe(false)
  expect(down.steps).toEqual(['spawn 4100', 'control names 4100', 'record enso-start'])
  expect(stack.pid()).toBe(4100)
})

test('the stack’s output, both streams, goes to its log as text', async () => {
  const logged: string[] = []
  const { promise: allLogged, resolve } = Promise.withResolvers<void>()
  const { options } = fakeStack({
    spawn: () => ({
      pid: 7,
      stdout: streamOf(['vite ready\n', 'server on 5179\n']),
      stderr: streamOf(['warning: slow\n']),
    }),
    log: (text) => {
      logged.push(text)
      if (logged.length === 3) resolve()
    },
  })
  await createEnsoStack(options).start()
  await allLogged
  expect(logged.toSorted()).toEqual(['server on 5179\n', 'vite ready\n', 'warning: slow\n'])
})

test('Enso dying is an `enso-exit` line with its code, or the signal, and a screenshot; the stack is then not running', async () => {
  const cases: ReadonlyArray<readonly [number | null, number | null, string]> = [
    [1, null, '1'],
    [null, 9, '9'],
    [null, null, 'unknown'],
  ]
  for (const [code, signal, exit] of cases) {
    const { options, started, steps, lines } = fakeStack()
    const stack = createEnsoStack(options)
    await stack.start()
    started[0]?.exit(code, signal)
    expect(lines.at(-1)).toEqual({ kind: 'enso-exit', exit })
    expect(steps.slice(-2)).toEqual(['record enso-exit', 'shoot enso-exit'])
    expect(stack.pid()).toBeUndefined()
  }
})

test('⚠ a restart’s stopped stack exiting after its successor started is no crash, and the successor stays the one running', async () => {
  const { options, started, lines } = fakeStack()
  const stack = createEnsoStack(options)
  await stack.start()
  await stack.stop()
  await stack.start()
  started[0]?.exit(null, 15)
  expect(lines.map((line) => line.kind)).toEqual(['enso-start', 'enso-start'])
  expect(stack.pid()).toBe(4101)
})

test('⚠ Enso exiting while the run stops is the run’s own stop: no line, no screenshot', async () => {
  const { options, started, steps, stopping } = fakeStack()
  const stack = createEnsoStack(options)
  await stack.start()
  stopping.value = true
  started[0]?.exit(0, null)
  expect(steps).toEqual(['spawn 4100', 'control names 4100', 'record enso-start', 'wait for the page'])
})

test('a stop takes the whole tree down; what outlives it is a `recorder-error` line naming the pids (#742)', async () => {
  const clean = fakeStack()
  const stack = createEnsoStack(clean.options)
  await stack.start()
  await stack.stop()
  expect(clean.steps.at(-1)).toBe('stop tree 4100')
  expect(clean.lines.map((line) => line.kind)).toEqual(['enso-start'])
  expect(stack.pid()).toBeUndefined()

  const stuck = fakeStack({ stopTree: () => Promise.resolve([4100, 4102]) })
  const stuckStack = createEnsoStack(stuck.options)
  await stuckStack.start()
  await stuckStack.stop()
  expect(stuck.lines.at(-1)).toEqual({
    kind: 'recorder-error',
    during: 'stopping Enso',
    error: 'still running: 4100, 4102',
  })
})

test('stopping a stack that is not running stops nothing', async () => {
  const { options, started, steps } = fakeStack()
  const stack = createEnsoStack(options)
  await stack.stop()
  await stack.start()
  started[0]?.exit(1, null)
  await stack.stop()
  expect(steps.filter((step) => step.startsWith('stop tree'))).toEqual([])
})
