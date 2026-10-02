import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type BrowserContext, chromium, type Locator, type Page } from '@playwright/test'
import type { Subprocess } from 'bun'
import { redactJudgeText } from '../../packages/core/src/judge.ts'
import { knownSecretValues } from '../../packages/core/src/secrets.ts'
import { isListening } from '../loopback.ts'
import {
  type ArenaAction,
  type ArenaTarget,
  describeArenaAction,
  parseArenaAction,
  typedSecretRefusal,
} from './actions.ts'
import { collectEnsoEvidence } from './evidence.ts'
import { foldArenaManifest } from './manifest.ts'
import type { ArenaScenario } from './scenario.ts'
import { type ArenaPagePlace, type ArenaShotCause, openTimeline, pagePlace, readTimeline } from './timeline.ts'

/**
 * The arena recorder (#556): it starts Enso, owns the browser, and is the agent's only hands on
 * the UI. Everything the issue asks the evidence to survive is decided by WHERE this runs:
 *
 *   • OUTSIDE ENSO'S PROCESS. Enso is a child (`bun run dev <project>`); when it dies the
 *     recorder records the exit, keeps sampling the page (which now shows the failure), and the
 *     agent may restart it. The trace and screenshots are the recorder's, not Enso's.
 *   • THE TRACE IN CHUNKS. A Playwright trace is written only when its chunk stops, so it is
 *     stopped and restarted every `traceChunkMs`: a recorder killed outright loses one chunk,
 *     not the run. The timeline and screenshots are on disk as they happen.
 *   • ONE PAGE, ACTED ON HERE. The agent sends an action to the control endpoint; the recorder
 *     performs it on its own page, inside a named trace group, and records it. So every
 *     interaction is in the trace and on the timeline, and none can bypass either.
 *
 * Event screenshots (an error, a dialog, a navigation, a failed action, a crash) come on top of
 * the periodic sample, at most one per cause per `EVENT_SHOT_SPACING_MS`, so a burst of console
 * errors is one picture and a short-lived state is still caught.
 */

/** Where the dev stack serves — the ports `bun run dev` uses (`dev-web.ts`, `server/dev.ts`). */
const ARENA_WEB_ORIGIN = 'http://127.0.0.1:5178'
const ARENA_SERVER_ORIGIN = 'http://127.0.0.1:5179'
const STACK_PORTS = [5178, 5179] as const
const STACK_STARTUP_TIMEOUT_MS = 90_000
const EVENT_SHOT_SPACING_MS = 2000
const VIEWPORT = { width: 1440, height: 900 } as const
/** A single action's own timeout: a control that never appears fails the action, not the run. */
const ACTION_TIMEOUT_MS = 15_000

export interface ArenaRunOptions {
  readonly scenario: ArenaScenario
  readonly repoRoot: string
  /** The run's directory: timeline, screenshots, trace chunks, Enso's output, the manifest. */
  readonly runDirectory: string
  /** The fresh repository the agent works in; Enso serves it as its project. */
  readonly project: string
  /** The `ENSO_HOME` the stack runs over — the operator's, by default, for their model login. */
  readonly home: string
  readonly budgetMinutes: number
  readonly chromiumPath?: string
  readonly headed: boolean
  /** The launcher's environment, which the stack inherits with `ENSO_HOME` set to `home`. */
  readonly environment: Readonly<Record<string, string | undefined>>
}

/** The control endpoint's address, written beside the run so `bun run arena act` can find it. */
export interface ArenaControl {
  readonly port: number
  readonly pid: number
  readonly runDirectory: string
}

/** The file a live run's control address is in, inside its run directory. */
export function controlFilePath(runDirectory: string): string {
  return join(runDirectory, 'control.json')
}

async function waitForWeb(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(ARENA_WEB_ORIGIN, { signal: AbortSignal.timeout(2000) })
      if (response.ok) return true
    } catch {
      // not up yet
    }
    await Bun.sleep(500)
  }
  return false
}

/** The commit the checkout is at: the build under test, for comparing runs. */
function checkoutCommit(repoRoot: string): string | undefined {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' })
  return head.status === 0 ? head.stdout.trim() : undefined
}

/** A fresh git repository for the agent: nothing in it, so everything in it is the run's. */
function makeProject(project: string): void {
  mkdirSync(project, { recursive: true })
  spawnSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: project })
}

function locate(page: Page, target: ArenaTarget): Locator {
  const exact = target.exact === true
  let found: Locator
  if ('role' in target) {
    found = page.getByRole(target.role as Parameters<Page['getByRole']>[0], {
      ...(target.name === undefined ? {} : { name: target.name }),
      exact,
    })
  } else if ('text' in target) found = page.getByText(target.text, { exact })
  else if ('label' in target) found = page.getByLabel(target.label, { exact })
  else found = page.getByPlaceholder(target.placeholder, { exact })
  return target.nth === undefined ? found : found.nth(target.nth)
}

/** Run one arena: start Enso and the browser, serve the agent's actions, stop on a condition, write the manifest. */
export async function runArena(options: ArenaRunOptions): Promise<void> {
  const { scenario, runDirectory, project } = options
  const runId = runDirectory.split('/').at(-1) ?? 'run'
  const shotsDirectory = join(runDirectory, 'screenshots')
  const traceDirectory = join(runDirectory, 'trace')
  const ensoDirectory = join(runDirectory, 'enso')
  for (const directory of [shotsDirectory, traceDirectory, ensoDirectory]) mkdirSync(directory, { recursive: true })

  for (const port of STACK_PORTS) {
    if (await isListening(port)) {
      throw new Error(`port ${port} is in use — stop your own \`bun run dev\`; the arena starts its own stack`)
    }
  }
  makeProject(project)
  const secretValues = knownSecretValues(options.home)
  const redact = (text: string): string => redactJudgeText(text, secretValues)
  const timeline = openTimeline(join(runDirectory, 'timeline.jsonl'))
  const commit = checkoutCommit(options.repoRoot)
  timeline.record({
    kind: 'run-start',
    scenario: scenario.id,
    project,
    ...(commit === undefined ? {} : { ensoCommit: commit }),
  })

  // ── Enso, as a child the recorder outlives ─────────────────────────────────────────────────
  const stackLog = join(ensoDirectory, 'stack.log')
  let enso: Subprocess<'ignore', 'pipe', 'pipe'> | undefined
  let stopping = false
  const pipeToLog = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    for await (const chunk of stream) appendFileSync(stackLog, redact(new TextDecoder().decode(chunk)))
  }
  const startEnso = async (): Promise<boolean> => {
    const child = Bun.spawn(['bun', 'run', 'dev', project], {
      cwd: options.repoRoot,
      env: { ...options.environment, ENSO_HOME: options.home },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      onExit: (_child, code, signal) => {
        if (enso !== child || stopping) return
        enso = undefined
        timeline.record({ kind: 'enso-exit', exit: String(code ?? signal ?? 'unknown') })
        void shoot('enso-exit')
      },
    })
    enso = child
    void pipeToLog(child.stdout)
    void pipeToLog(child.stderr)
    timeline.record({ kind: 'enso-start' })
    return waitForWeb(STACK_STARTUP_TIMEOUT_MS)
  }
  const stopEnso = async (): Promise<void> => {
    const child = enso
    enso = undefined
    if (child === undefined) return
    child.kill('SIGTERM')
    await Promise.race([child.exited, Bun.sleep(5000)])
  }
  if (!(await startEnso())) {
    await stopEnso()
    throw new Error(
      `Enso did not answer on ${ARENA_WEB_ORIGIN} within ${STACK_STARTUP_TIMEOUT_MS / 1000} s — see ${stackLog}`,
    )
  }

  // ── The browser, its trace and its listeners ───────────────────────────────────────────────
  const browser = await chromium.launch({
    headless: !options.headed,
    ...(options.chromiumPath === undefined ? {} : { executablePath: options.chromiumPath }),
  })
  const context: BrowserContext = await browser.newContext({ viewport: VIEWPORT })
  await context.tracing.start({ screenshots: true, snapshots: true, title: `arena ${runId}` })
  let chunkNumber = 0
  const writeChunk = async (): Promise<void> => {
    const path = join(traceDirectory, `trace-${String(chunkNumber).padStart(3, '0')}.zip`)
    chunkNumber += 1
    await context.tracing.stopChunk({ path })
    timeline.record({ kind: 'trace-chunk', path })
  }
  await context.tracing.startChunk()
  const page = await context.newPage()
  const here = (): ArenaPagePlace => pagePlace(page.url())

  let shotNumber = 0
  const lastShotAt = new Map<ArenaShotCause, number>()
  const shoot = async (cause: ArenaShotCause): Promise<string | undefined> => {
    const now = Date.now()
    if (cause !== 'sample' && cause !== 'requested' && cause !== 'final') {
      if (now - (lastShotAt.get(cause) ?? 0) < EVENT_SHOT_SPACING_MS) return undefined
    }
    lastShotAt.set(cause, now)
    const stamp = new Date(now).toISOString().replaceAll(':', '-')
    const path = join(shotsDirectory, `${String(shotNumber).padStart(5, '0')}-${stamp}-${cause}.png`)
    shotNumber += 1
    try {
      await page.screenshot({ path, timeout: 10_000 })
    } catch {
      return undefined
    }
    timeline.record({ kind: 'screenshot', cause, path }, here())
    return path
  }

  page.on('console', (message) => {
    if (message.type() !== 'error') return
    timeline.record({ kind: 'console-error', text: redact(message.text()) }, here())
    void shoot('console-error')
  })
  page.on('pageerror', (error) => {
    timeline.record({ kind: 'page-error', text: redact(String(error)) }, here())
    void shoot('page-error')
  })
  page.on('requestfailed', (request) => {
    timeline.record(
      {
        kind: 'request-failed',
        request: `${request.method()} ${request.url()}`,
        failure: request.failure()?.errorText ?? '',
      },
      here(),
    )
  })
  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) return
    timeline.record({ kind: 'navigation' }, here())
    void shoot('navigation')
  })
  page.on('crash', () => {
    timeline.record({ kind: 'page-crash' }, here())
  })
  // A dialog is left OPEN for the agent to answer: it is part of the interface. Only the capture is ours.
  page.on('dialog', (dialog) => {
    timeline.record({ kind: 'dialog', dialog: dialog.type(), message: redact(dialog.message()) }, here())
    void shoot('dialog')
  })

  await page.goto(ARENA_WEB_ORIGIN)

  // ── The run's clock: samples, trace chunks, the budget ─────────────────────────────────────
  let resolveStop: (reason: string) => void = () => undefined
  const stopped = new Promise<string>((resolve) => {
    resolveStop = resolve
  })
  const sampler = setInterval(() => void shoot('sample'), scenario.sampleIntervalMs)
  let queue: Promise<unknown> = Promise.resolve()
  const serialized = <Result>(work: () => Promise<Result>): Promise<Result> => {
    const next = queue.then(work, work)
    queue = next.catch(() => undefined)
    return next
  }
  const chunker = setInterval(() => void serialized(writeChunk), scenario.traceChunkMs)
  const budget = setTimeout(
    () => resolveStop(`budget: ${options.budgetMinutes} minutes`),
    options.budgetMinutes * 60_000,
  )
  browser.on('disconnected', () => resolveStop('the browser closed'))
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => resolveStop(`signal ${signal}`))

  // ── The agent's actions ────────────────────────────────────────────────────────────────────
  const perform = async (action: ArenaAction): Promise<unknown> => {
    const timeout = ACTION_TIMEOUT_MS
    switch (action.action) {
      case 'goto':
        await page.goto(new URL(action.path, ARENA_WEB_ORIGIN).toString(), { timeout })
        return here()
      case 'click':
        await locate(page, action.target).click({ timeout })
        return here()
      case 'hover':
        await locate(page, action.target).hover({ timeout })
        return here()
      case 'fill':
        await locate(page, action.target).fill(action.text, { timeout })
        return here()
      case 'select':
        await locate(page, action.target).selectOption(action.option, { timeout })
        return here()
      case 'press':
        if (action.target === undefined) await page.keyboard.press(action.key)
        else await locate(page, action.target).press(action.key, { timeout })
        return here()
      case 'read':
        return { ...here(), page: await page.locator('body').ariaSnapshot({ timeout }) }
      case 'screenshot':
        return { ...here(), screenshot: await shoot('requested') }
      case 'wait':
        await page.waitForTimeout(action.ms)
        return here()
      case 'back':
        await page.goBack({ timeout })
        return here()
      case 'reload':
        await page.reload({ timeout })
        return here()
      case 'note':
        timeline.record(
          {
            kind: 'note',
            note: action.note,
            trying: redact(action.trying),
            happened: redact(action.happened),
            ...(action.wanted === undefined ? {} : { wanted: redact(action.wanted) }),
          },
          here(),
        )
        return { recorded: action.note }
      case 'restart-enso':
        await stopEnso()
        return { restarted: await startEnso() }
      case 'stop':
        resolveStop(`the agent stopped the run${action.reason === undefined ? '' : `: ${redact(action.reason)}`}`)
        return { stopping: true }
    }
  }

  const act = async (request: unknown): Promise<{ ok: boolean; result?: unknown; error?: string }> => {
    const parsed = parseArenaAction(request)
    if (!parsed.ok) return { ok: false, error: parsed.error }
    const { action } = parsed
    return serialized(async () => {
      const detail = describeArenaAction(action, secretValues)
      const refusal = typedSecretRefusal(action, secretValues)
      if (refusal !== undefined) {
        timeline.record(
          { kind: 'action', action: action.action, detail, outcome: 'failed', error: refusal, durationMs: 0 },
          here(),
        )
        return { ok: false, error: refusal }
      }
      const began = performance.now()
      await context.tracing.group(detail)
      try {
        const result = await perform(action)
        if (action.action !== 'note') {
          timeline.record(
            {
              kind: 'action',
              action: action.action,
              detail,
              outcome: 'ok',
              durationMs: Math.round(performance.now() - began),
            },
            here(),
          )
        }
        return { ok: true, result }
      } catch (error) {
        const message = redact(error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error))
        timeline.record(
          {
            kind: 'action',
            action: action.action,
            detail,
            outcome: 'failed',
            error: message,
            durationMs: Math.round(performance.now() - began),
          },
          here(),
        )
        await shoot('action-failed')
        return { ok: false, error: message }
      } finally {
        await context.tracing.groupEnd()
      }
    })
  }

  const control = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (request: Request): Promise<Response> => {
      if (request.method !== 'POST' || new URL(request.url).pathname !== '/act') {
        return new Response('POST /act', { status: 404 })
      }
      let body: unknown
      try {
        body = await request.json()
      } catch {
        return Response.json({ ok: false, error: 'the body is not JSON' }, { status: 400 })
      }
      return Response.json(await act(body))
    },
  })
  const controlFile = controlFilePath(runDirectory)
  const controlRecord: ArenaControl = { port: control.port ?? 0, pid: process.pid, runDirectory }
  writeFileSync(controlFile, JSON.stringify(controlRecord, null, 2))
  await shoot('sample')
  process.stdout.write(`arena: run ${runId} is live — ${runDirectory}\n`)

  // ── Stop, then make the evidence whole ─────────────────────────────────────────────────────
  const reason = await stopped
  clearInterval(sampler)
  clearInterval(chunker)
  clearTimeout(budget)
  rmSync(controlFile, { force: true })
  // Not forced: the `stop` action that got here is still in flight, and its answer is owed.
  await control.stop()
  await serialized(async () => {
    if (browser.isConnected()) {
      await shoot('final')
      await writeChunk().catch(() => undefined)
    }
  })
  timeline.record({ kind: 'run-stop', reason }, browser.isConnected() ? here() : undefined)
  const events = readTimeline(timeline.path)
  const threadIds = [
    ...new Set(events.flatMap((event) => (event.page?.threadId === undefined ? [] : [event.page.threadId]))),
  ]
  const evidence =
    enso === undefined
      ? [{ kind: 'enso server', status: 'missing' as const, reason: 'Enso was not running when the run stopped' }]
      : await collectEnsoEvidence({
          serverOrigin: ARENA_SERVER_ORIGIN,
          directory: join(ensoDirectory, 'evidence'),
          threadIds,
          home: options.home,
          project,
          secretValues,
        })
  stopping = true
  await browser.close().catch(() => undefined)
  await stopEnso()
  const manifest = foldArenaManifest({ runId, events: readTimeline(timeline.path), evidence })
  writeFileSync(join(runDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  process.stdout.write(`arena: stopped (${reason}) — ${join(runDirectory, 'manifest.json')}\n`)
}
