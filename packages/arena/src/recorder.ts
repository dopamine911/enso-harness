import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gitChildEnvironment } from '@enso/core/git'
import { redactJudgeText } from '@enso/core/judge'
import { isListening } from '@enso/core/loopback'
import { ensoProjectsDir, projectIdOf, projectTreesDir, realpathOrSelf } from '@enso/core/paths'
import { type Browser, type BrowserContext, chromium, type Dialog, type Locator, type Page } from '@playwright/test'
import type { Subprocess } from 'bun'
import {
  ARENA_REFUSED_DETAIL,
  ARENA_RUNNER_STILL_RUNNING,
  type ArenaAction,
  type ArenaTarget,
  createChangeBaseline,
  describeArenaAction,
  dialogForChange,
  pageForChange,
  parseArenaAction,
  typedSecretRefusal,
  waitForPage,
} from './actions.ts'
import { collectEnsoEvidence, threadIdsShown } from './evidence.ts'
import { type ArenaEvidence, foldArenaManifest } from './manifest.ts'
import { ARENA_GRACE_MS, type ArenaBounds, createRunControl, ensoSpendUsd } from './run-control.ts'
import { arenaSecretSource, arenaSecretValues, reconcileLinkedFiles, runHomeOf } from './run-home.ts'
import { ensoBuildOf, sampleWorkspaces, threadHistoriesIn } from './run-state.ts'
import type { ArenaScenario } from './scenario.ts'
import { type ArenaScore, writeArenaScore } from './score.ts'
import { scanRunForSecrets } from './secret-scan.ts'
import {
  type ArenaActionSource,
  type ArenaEventBody,
  type ArenaPagePlace,
  type ArenaShotCause,
  type ArenaTimeline,
  openTimeline,
  pagePlace,
  readTimeline,
} from './timeline.ts'

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
 *   • ONE PAGE, ACTED ON HERE. The agent sends an action — through the agent runner's one tool
 *     (`agent.ts`), or to the control endpoint when no runner drives the run — and the recorder
 *     performs it on its own page, inside a named trace group, and records who sent it. So every
 *     interaction is in the trace and on the timeline, and none can bypass either.
 *   • WITH AN AGENT, NO SECOND DOOR. When a driver runs the agent, the control endpoint is not
 *     served at all: the agent's tool is the only way an action reaches the page, and the
 *     manifest's boundary checks that every action on the timeline came through it.
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
/** The pause before a failed screenshot's second try (#665): long enough for a reload to settle. */
const SHOT_RETRY_MS = 500
const VIEWPORT = { width: 1440, height: 900 } as const
/** A single action's own timeout: a control that never appears fails the action, not the run. */
const ACTION_TIMEOUT_MS = 15_000
/** How often a wait until change looks at the page (#637): a card is seen within about a second. */
const CHANGE_POLL_MS = 1000
/** The actions that do not move the page: after any other, the wait's baseline is the page it left (#637). */
const LEAVES_THE_PAGE: ReadonlySet<ArenaAction['action']> = new Set([
  'read',
  'screenshot',
  'wait',
  'note',
  'stop',
  'tabs',
])
/** How long a stopped run waits for its agent runner to finish writing before closing the page. */
const DRIVER_SETTLE_MS = 15_000

export interface ArenaRunOptions {
  readonly scenario: ArenaScenario
  readonly repoRoot: string
  /** The run's directory: timeline, screenshots, trace chunks, Enso's output, the manifest. */
  readonly runDirectory: string
  /** The fresh repository the agent works in; Enso serves it as its project. */
  readonly project: string
  /** The `ENSO_HOME` the stack runs over — the run's own `<run>/.enso` by default (#610), `--home` otherwise. */
  readonly home: string
  /**
   * The operator's home whose credentials the run home links (`prepareRunHome`, #610): the recorder
   * puts back a link a credential write replaced (#639). Absent over `--home`, which links nothing.
   */
  readonly linkedFrom?: string
  readonly budgetMinutes: number
  /** The bounds besides the budget (#609, `run-control.ts`); `maxCostUsd` only over the run's own home. */
  readonly limits: { readonly idleMinutes?: number; readonly maxRestarts: number; readonly maxCostUsd?: number }
  readonly chromiumPath?: string
  readonly headed: boolean
  /** The launcher's environment, which the stack inherits with `ENSO_HOME` set to `home`. */
  readonly environment: Readonly<Record<string, string | undefined>>
  /**
   * The agent runner (`agent.ts`), when an agent drives the run. Absent, the run is driven over
   * the control endpoint by `bun run arena act` — by whoever holds a shell, which no one checks.
   */
  readonly driver?: ArenaDriver
}

/**
 * What one action came to: its result, or why it failed or was refused — and, while the run lasts,
 * where it is: `running` with the budget left, or `grace` with the time left for the retrospective.
 */
export interface ArenaActOutcome {
  readonly ok: boolean
  readonly result?: unknown
  readonly error?: string
  readonly phase?: 'running' | 'grace'
  readonly remainingMs?: number
}

/** What the recorder hands an agent runner: its one way into the page, and the run's end. */
export interface ArenaDriverSession {
  /** Perform one action on the page, recorded as sent by the agent. */
  readonly act: (request: unknown) => Promise<ArenaActOutcome>
  /** Settles with the stop reason when the run stops, whoever stopped it: the runner must end then. */
  readonly stopped: Promise<string>
  /** Put one of the runner's own events on the timeline: what drove the run, a tool it refused. */
  readonly record: (body: ArenaEventBody) => void
  readonly runDirectory: string
}

/** An agent runner: drives the run through `session.act` and settles with why the agent ended. */
export type ArenaDriver = (session: ArenaDriverSession) => Promise<string>

/**
 * The control endpoint's address, written beside the run so `bun run arena act` can find it. A
 * run an agent drives has no endpoint: `port` is absent, and `act` says the run is the agent's.
 * It also names what a recorder that dies leaves behind (#584 A13, #607): the home the stack runs
 * over and the stack's own process, so `arena manifest` can collect from it and stop it. The file
 * is removed at the stop, so one that outlives its recorder's `pid` marks a run that never stopped.
 */
export interface ArenaControl {
  readonly port?: number
  readonly pid: number
  readonly runDirectory: string
  readonly driver: 'agent' | 'control'
  readonly home?: string
  /** `bun run dev <project>`, the run's Enso stack — rewritten when `restart-enso` starts another. */
  readonly stackPid?: number
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

/**
 * A fresh git repository for the agent: nothing in it, so everything in it is the run's. Without the
 * inherited repository variables: under a git hook, `git init` would re-initialise the HOOK's repository.
 */
function makeProject(project: string): void {
  mkdirSync(project, { recursive: true })
  spawnSync('git', ['init', '--quiet', '--initial-branch=main'], {
    cwd: project,
    env: gitChildEnvironment(),
  })
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

/** The name a refused request gave its action, short and redacted, for the timeline line that records the refusal. */
function refusedActionName(request: unknown, redact: (text: string) => string): string {
  const named =
    typeof request === 'object' && request !== null && 'action' in request && typeof request.action === 'string'
      ? request.action
      : '(none)'
  return redact(named).slice(0, 40)
}

/** What `control.json` says: the endpoint's port, or — with an agent driving — that there is none. */
function controlRecordOf(
  control: ReturnType<typeof Bun.serve> | undefined,
  runDirectory: string,
  home: string,
): ArenaControl {
  return control === undefined
    ? { pid: process.pid, runDirectory, driver: 'agent', home }
    : { port: control.port ?? 0, pid: process.pid, runDirectory, driver: 'control', home }
}

/** An error's first line, redacted: what a timeline line or an answer says of a failure. */
function errorLine(error: unknown, redact: (text: string) => string): string {
  return redact(error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error))
}

/** What a screenshot needs of a page: Playwright's `Page`, or a test's stand-in. */
export interface ArenaShotPage {
  screenshot(options: { readonly path: string; readonly timeout: number }): Promise<unknown>
  url(): string
}

/** The run's camera: `show` it the page once there is one; `shoot` settles with the file, or undefined. */
export interface ArenaShooter {
  readonly show: (page: ArenaShotPage) => void
  readonly shoot: (cause: ArenaShotCause) => Promise<string | undefined>
}

/**
 * The run's screenshots: numbered files under `directory`, each a `screenshot` line on the
 * timeline. An event cause is taken at most once per `EVENT_SHOT_SPACING_MS`; a sample, a
 * requested shot and the final one always. Before a page is shown, nothing is taken.
 *
 * ⚠ A SHOT THAT FAILS IS A LINE (#584 A9, #607): a `recorder-error` naming the cause. Swallowed, a
 * gap in the 30 s cadence read the same as "no sample was due", and a crash's picture that could
 * not be taken looked like one never attempted. ⚠ BUT ONLY AFTER A SECOND TRY (#665): a capture
 * racing a reload fails once ("Unable to capture screenshot") and works a moment later — as one
 * error it failed a whole run. A camera that really fails fails twice and is still the line.
 */
export function createShooter(options: {
  readonly directory: string
  readonly timeline: ArenaTimeline
  readonly redact: (text: string) => string
  readonly now?: () => number
  /** The pause before the second try; injected by tests. */
  readonly sleep?: (ms: number) => Promise<void>
}): ArenaShooter {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number): Promise<void> => Bun.sleep(ms))
  let shown: ArenaShotPage | undefined
  let shotNumber = 0
  const lastShotAt = new Map<ArenaShotCause, number>()
  const shoot = async (cause: ArenaShotCause): Promise<string | undefined> => {
    const page = shown
    if (page === undefined) return undefined
    const at = now()
    if (cause !== 'sample' && cause !== 'requested' && cause !== 'final') {
      if (at - (lastShotAt.get(cause) ?? 0) < EVENT_SHOT_SPACING_MS) return undefined
    }
    lastShotAt.set(cause, at)
    const stamp = new Date(at).toISOString().replaceAll(':', '-')
    const path = join(options.directory, `${String(shotNumber).padStart(5, '0')}-${stamp}-${cause}.png`)
    shotNumber += 1
    const capture = async (): Promise<{ readonly failed: unknown } | undefined> => {
      try {
        await page.screenshot({ path, timeout: 10_000 })
        return undefined
      } catch (error) {
        return { failed: error }
      }
    }
    let outcome = await capture()
    if (outcome !== undefined) {
      await sleep(SHOT_RETRY_MS)
      outcome = await capture()
    }
    if (outcome !== undefined) {
      options.timeline.record(
        { kind: 'recorder-error', during: `screenshot (${cause})`, error: errorLine(outcome.failed, options.redact) },
        pagePlace(page.url()),
      )
      return undefined
    }
    options.timeline.record({ kind: 'screenshot', cause, path }, pagePlace(page.url()))
    return path
  }
  return {
    show: (page) => {
      shown = page
    },
    shoot,
  }
}

/**
 * Start the agent runner on its session. Its end is a stop condition — a run nobody is driving has
 * nothing more to record — and is on the timeline either way, a failure included. Settles when
 * the runner has, never rejecting.
 */
function drive(
  driver: ArenaDriver,
  session: Omit<ArenaDriverSession, 'record'>,
  timeline: ArenaTimeline,
  run: { readonly resolveStop: (reason: string) => void; readonly redact: (text: string) => string },
): Promise<void> {
  const driven = driver({
    ...session,
    record: (body) => {
      timeline.record(body)
    },
  })
  return driven.then(
    (reason) => {
      timeline.record({ kind: 'agent-end', reason })
      run.resolveStop(`the agent ended: ${reason}`)
    },
    (error: unknown) => {
      const message = run.redact(String(error))
      timeline.record({ kind: 'agent-end', reason: `the runner failed: ${message}` })
      run.resolveStop(`the agent runner failed: ${message}`)
    },
  )
}

/**
 * Wait for the runner to end after the stop, at most `settleMs`. A runner still going then — a
 * model call the abort did not cut short — gets an `agent-end` line saying so (PR #585 review):
 * without it the manifest folds with no end at all, and the score would lose the signal. If the
 * runner ends later, its own line comes after this one and the fold reads the last.
 */
export async function awaitDriverEnd(
  done: Promise<void>,
  timeline: { readonly record: (body: ArenaEventBody) => unknown },
  settleMs: number = DRIVER_SETTLE_MS,
): Promise<void> {
  const ended = await Promise.race([done.then(() => true), Bun.sleep(settleMs).then(() => false)])
  if (!ended) {
    timeline.record({
      kind: 'agent-end',
      reason: `${ARENA_RUNNER_STILL_RUNNING} ${settleMs / 1000} s after the run stopped: its end is unknown`,
    })
  }
}

/** Score the stopped run and say the verdict; a scoring failure is said on stderr and costs nothing else. */
function scoreAndSay(runDirectory: string, redact: (text: string) => string): ArenaScore | undefined {
  try {
    const score = writeArenaScore(runDirectory)
    process.stdout.write(
      `arena: score ${score.verdict.toUpperCase()} — ${score.errors} error(s), ${score.warnings} warning(s), ` +
        `UI used: ${score.uiUsed ? 'yes' : 'not shown'} — ${join(runDirectory, 'score.md')}\n`,
    )
    return score
  } catch (error) {
    process.stderr.write(`arena: the run could not be scored: ${redact(String(error))}\n`)
    return undefined
  }
}

/** The loopback endpoint `bun run arena act` posts to: one route, `POST /act`, a JSON action. */
function serveControl(act: (body: unknown) => Promise<ArenaActOutcome>): ReturnType<typeof Bun.serve> {
  return Bun.serve({
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
}

/** A browser with one page, tracing, its first chunk open. A failure on the way closes what it opened. */
async function openTracedPage(
  options: ArenaRunOptions,
  runId: string,
): Promise<{ readonly browser: Browser; readonly context: BrowserContext; readonly page: Page }> {
  const browser = await chromium.launch({
    headless: !options.headed,
    ...(options.chromiumPath === undefined ? {} : { executablePath: options.chromiumPath }),
  })
  try {
    const context = await browser.newContext({ viewport: VIEWPORT })
    await context.tracing.start({ screenshots: true, snapshots: true, title: `arena ${runId}` })
    await context.tracing.startChunk()
    return { browser, context, page: await context.newPage() }
  } catch (error) {
    await browser.close().catch(() => undefined)
    throw error
  }
}

/** The run's bounds as the run control takes them (#609): the budget, the grace window, the limits that are on. */
function boundsOf(options: Pick<ArenaRunOptions, 'budgetMinutes' | 'limits'>): ArenaBounds {
  const { idleMinutes, maxRestarts, maxCostUsd } = options.limits
  return {
    budgetMs: options.budgetMinutes * 60_000,
    graceMs: ARENA_GRACE_MS,
    maxRestarts,
    ...(idleMinutes === undefined ? {} : { idleMs: idleMinutes * 60_000 }),
    ...(maxCostUsd === undefined ? {} : { maxCostUsd }),
  }
}

/**
 * Run one arena: start Enso and the browser, serve the agent's actions, stop on a condition, write
 * the manifest, then score the run (`score.ts`). Settles with the score — undefined only when the
 * scoring itself failed, which is said on stderr and never costs the manifest.
 */
export async function runArena(options: ArenaRunOptions): Promise<ArenaScore | undefined> {
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
  // A source, not a snapshot (PR #613 review): an OAuth refresh rewrites the linked auth.json during
  // the run, and a rotated token must be redacted and scanned for like the one it replaced.
  const secrets = arenaSecretSource(options.home)
  const redact = (text: string): string => redactJudgeText(text, secrets())
  const timeline = openTimeline(join(runDirectory, 'timeline.jsonl'))
  const ensoBuild = ensoBuildOf(options.repoRoot)
  timeline.record({
    kind: 'run-start',
    scenario: scenario.id,
    project,
    home: options.home,
    ...(ensoBuild === undefined ? {} : { ensoBuild }),
  })

  // ── Screenshots, over a page that does not exist until the browser is up ───────────────────
  // ⚠ Defined BEFORE Enso starts (PR #562 review): Enso's exit handler takes one, and Enso can
  // die while the recorder is still waiting for it to answer — before there is any page.
  const { show, shoot } = createShooter({ directory: shotsDirectory, timeline, redact })

  // ── The control record, rewritten whenever the stack it names changes ──────────────────────
  const controlFile = controlFilePath(runDirectory)
  let controlRecord: ArenaControl | undefined
  const publishControl = (stackPid: number | undefined): void => {
    if (controlRecord === undefined) return
    const record = { ...controlRecord, ...(stackPid === undefined ? {} : { stackPid }) }
    writeFileSync(controlFile, JSON.stringify(record, null, 2))
  }

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
    publishControl(child.pid)
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
  // ⚠ A browser that fails to start must not leave Enso holding the dev ports (PR #562 review):
  // every later `arena start` would refuse them until someone killed the stack by hand.
  const {
    browser,
    context,
    page: firstPage,
  } = await openTracedPage(options, runId).catch(async (error: unknown) => {
    await stopEnso()
    throw error
  })
  // ── The tabs (#675) ────────────────────────────────────────────────────────────────────────
  // Preview opens the built page in a new tab, and a link may too. The tab in front is the one
  // the agent acts on and the camera shows, as a browser shows a person the tab it opened.
  /** Every open tab by its number: Enso's first page is 0, and a number is never reused. */
  const tabs = new Map<number, Page>([[0, firstPage]])
  let nextTab = 1
  let front = 0
  const inFront = (): Page => tabs.get(front) ?? firstPage
  const bringToFront = (tabNumber: number): Promise<void> => {
    const tabPage = tabs.get(tabNumber)
    if (tabPage === undefined) return Promise.resolve()
    front = tabNumber
    show(tabPage)
    return tabPage.bringToFront().catch(() => undefined)
  }
  show(firstPage)
  let chunkNumber = 0
  /**
   * Write the trace so far. ⚠ `stopChunk` ends the chunk; between chunks nothing is traced, so
   * every chunk but the last is followed by `startChunk` (PR #562 review: the first version
   * never restarted, and traced only the run's first five minutes).
   */
  const writeChunk = async (then: 'continue' | 'last'): Promise<void> => {
    const path = join(traceDirectory, `trace-${String(chunkNumber).padStart(3, '0')}.zip`)
    chunkNumber += 1
    await context.tracing.stopChunk({ path })
    timeline.record({ kind: 'trace-chunk', path })
    if (then === 'continue') await context.tracing.startChunk()
  }
  /** Where a tab is: its URL's place, and its number unless it is the first. */
  const tabPlace = (tabNumber: number, tabPage: Page): ArenaPagePlace => ({
    ...pagePlace(tabPage.url()),
    ...(tabNumber === 0 ? {} : { tab: tabNumber }),
  })
  const here = (): ArenaPagePlace => tabPlace(front, inFront())

  // A native dialog is left OPEN for the agent to answer (#609): it is part of the interface, and it
  // blocks the page until answered — `read` says it is there, `accept-dialog`/`dismiss-dialog` answer it.
  // ⚠ Per tab (PR #684 review): a browser shows a dialog over its own tab, so the one that blocks the
  // agent is the front tab's — a game's alert in tab 1 must not answer for Enso's tab, nor block it.
  const dialogs = new Map<number, Dialog>()
  const frontDialog = (): Dialog | undefined => dialogs.get(front)
  const answerDialog = async (answer: (dialog: Dialog) => Promise<void>): Promise<ArenaPagePlace> => {
    const dialog = frontDialog()
    if (dialog === undefined) throw new Error('no dialog is open')
    dialogs.delete(front)
    await answer(dialog)
    return here()
  }
  /** One tab's listeners: each event is placed at ITS tab, and captured only when that tab is in front. */
  const watch = (tabPage: Page, tabNumber: number): void => {
    const there = (): ArenaPagePlace => tabPlace(tabNumber, tabPage)
    const shootIfInFront = (cause: ArenaShotCause): void => {
      if (tabNumber === front) void shoot(cause)
    }
    tabPage.on('console', (message) => {
      if (message.type() !== 'error') return
      timeline.record({ kind: 'console-error', text: redact(message.text()) }, there())
      shootIfInFront('console-error')
    })
    tabPage.on('pageerror', (error) => {
      timeline.record({ kind: 'page-error', text: redact(String(error)) }, there())
      shootIfInFront('page-error')
    })
    tabPage.on('requestfailed', (request) => {
      timeline.record(
        {
          kind: 'request-failed',
          request: `${request.method()} ${request.url()}`,
          failure: request.failure()?.errorText ?? '',
        },
        there(),
      )
    })
    tabPage.on('response', (response) => {
      if (response.status() < 400) return
      timeline.record(
        {
          kind: 'response-error',
          request: `${response.request().method()} ${response.url()}`,
          status: response.status(),
        },
        there(),
      )
    })
    tabPage.on('framenavigated', (frame) => {
      if (frame !== tabPage.mainFrame()) return
      timeline.record({ kind: 'navigation' }, there())
      shootIfInFront('navigation')
    })
    tabPage.on('crash', () => {
      timeline.record({ kind: 'page-crash' }, there())
      // ⚠ Taken even though a crashed page may not render (#584 A9): then it is a `recorder-error`
      // line, and the crash's missing picture is said rather than never attempted.
      shootIfInFront('page-crash')
    })
    tabPage.on('dialog', (dialog) => {
      dialogs.set(tabNumber, dialog)
      timeline.record({ kind: 'dialog', dialog: dialog.type(), message: redact(dialog.message()) }, there())
      shootIfInFront('dialog')
    })
    tabPage.on('close', () => {
      // The browser closing at the stop closes every tab: that is the run ending, not the agent.
      if (stopping) return
      tabs.delete(tabNumber)
      dialogs.delete(tabNumber)
      timeline.record({ kind: 'tab-closed', tab: tabNumber })
      if (front !== tabNumber) return
      const newest = Math.max(...tabs.keys())
      if (Number.isFinite(newest)) {
        void bringToFront(newest)
        return
      }
      // ⚠ The page closed the last tab itself (`window.close()`; PR #684 review): a browser with no
      // tab has no page to act on, so Enso opens again in a new one — its `page` listener makes it the front.
      void context
        .newPage()
        .then((reopened) => reopened.goto(ARENA_WEB_ORIGIN))
        .catch((error: unknown) => {
          timeline.record({
            kind: 'recorder-error',
            during: 'reopening Enso after the last tab closed',
            error: redact(String(error)),
          })
        })
    })
  }
  watch(firstPage, 0)
  context.on('page', (opened) => {
    if (stopping) return
    const tabNumber = nextTab
    nextTab += 1
    tabs.set(tabNumber, opened)
    watch(opened, tabNumber)
    timeline.record({ kind: 'tab-opened', tab: tabNumber, opener: front }, tabPlace(tabNumber, opened))
    void bringToFront(tabNumber)
    void opened
      .waitForLoadState()
      .catch(() => undefined)
      .then(() => (front === tabNumber ? shoot('tab-opened') : undefined))
  })

  try {
    await firstPage.goto(ARENA_WEB_ORIGIN)
  } catch (error) {
    await browser.close().catch(() => undefined)
    await stopEnso()
    throw error
  }

  // ── The run's clock: samples, trace chunks, the budget ─────────────────────────────────────
  let settleStop: (reason: string) => void = () => undefined
  const stopped = new Promise<string>((resolve) => {
    settleStop = resolve
  })
  /** Set once, by the first stop: an action that arrives after it is refused, not performed on a closing page. */
  let stopReason: string | undefined
  const resolveStop = (reason: string): void => {
    stopReason ??= reason
    settleStop(stopReason)
  }
  // The work beside each periodic screenshot (#608): the project and the run's thread trees, sampled
  // at the same tick so a screenshot and the files it shows are one moment of the filesystem timeline.
  const workspaces = (): string[] => {
    const trees = projectTreesDir(ensoProjectsDir(options.home), projectIdOf(realpathOrSelf(project)))
    const threadTrees = existsSync(trees) ? readdirSync(trees).map((threadId) => join(trees, threadId)) : []
    return [project, ...threadTrees]
  }
  /**
   * A replaced credential link put back (#639): a run-home write that renamed over a link is the
   * operator's again, before the operator's next refresh uses the revoked token. A conflict — the
   * operator's file changed after the run's — keeps the operator's, and is the recorder's error.
   * ⚠ A failure is a timeline line too, never a throw (PR #642 review): at the stop it would cost
   * the run its manifest and score, and from the sampler it would be an unhandled rejection.
   */
  const relink = (): void => {
    if (options.linkedFrom === undefined) return
    const failed = (error: string): void => {
      // Redacted like every other line the recorder writes: an error names paths today, but this is a credential file.
      timeline.record({ kind: 'recorder-error', during: 'credential relink', error: redact(error) })
    }
    try {
      for (const relinked of reconcileLinkedFiles(options.home, options.linkedFrom)) {
        if (relinked.outcome === 'operator-newer') {
          failed(
            `${relinked.path} was replaced in the run and changed in the operator's home after: the operator's stands, the run's change is dropped`,
          )
        }
      }
    } catch (error) {
      failed(error instanceof Error ? error.message : String(error))
    }
  }
  /** A periodic sample: the screenshot and the work at the same tick, so neither is without the other. */
  const takeSample = async (): Promise<void> => {
    relink()
    timeline.record({ kind: 'workspace-sample', workspaces: sampleWorkspaces(runDirectory, workspaces()) })
    await shoot('sample')
  }
  const sampler = setInterval(() => void takeSample(), scenario.sampleIntervalMs)
  let queue: Promise<unknown> = Promise.resolve()
  const serialized = <Result>(work: () => Promise<Result>): Promise<Result> => {
    const next = queue.then(work, work)
    queue = next.catch(() => undefined)
    return next
  }
  // A chunk that fails is a line on the timeline, never an unhandled rejection that ends the recorder.
  const chunker = setInterval(() => {
    serialized(() => writeChunk('continue')).catch((error: unknown) => {
      timeline.record({ kind: 'recorder-error', during: 'trace chunk', error: redact(String(error)) }, here())
    })
  }, scenario.traceChunkMs)
  // The clock and the bounds (#609): a tick a second; the budget opens a grace window for the
  // retrospective, and every bound stops the run with its own reason.
  const runClock = createRunControl({
    bounds: boundsOf(options),
    onGrace: () => timeline.record({ kind: 'budget-spent', graceMs: ARENA_GRACE_MS }, here()),
    onStop: resolveStop,
    readCost: () => ensoSpendUsd(options.home),
  })
  const ticker = setInterval(() => runClock.tick(), 1000)
  browser.on('disconnected', () => resolveStop('the browser closed'))
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => resolveStop(`signal ${signal}`))

  // ── The agent's actions ────────────────────────────────────────────────────────────────────
  /** The page as the agent sees it, for a wait on the page (#637, #648): the rail's ages aside, or the native dialog blocking it. */
  const pageNow = async (): Promise<string> => {
    const dialog = frontDialog()
    return dialog === undefined
      ? pageForChange(await inFront().locator('body').ariaSnapshot({ timeout: ACTION_TIMEOUT_MS }))
      : dialogForChange(dialog.type(), dialog.message())
  }
  /** What the agent last saw: its last read, or the page right after its last move (`createChangeBaseline`). */
  const lastSeen = createChangeBaseline(pageNow)
  /** The tab actions (#675): list the tabs, bring one to the front, close one but never the last. */
  const performOnTabs = async (
    action: Extract<ArenaAction, { action: 'tabs' | 'switch-tab' | 'close-tab' }>,
  ): Promise<unknown> => {
    if (action.action === 'tabs') {
      return {
        tabs: await Promise.all(
          [...tabs].map(async ([tabNumber, tabPage]) => ({
            tab: tabNumber,
            url: tabPage.url(),
            title: await tabPage.title().catch(() => ''),
            ...(tabNumber === front ? { front: true } : {}),
          })),
        ),
      }
    }
    const tabNumber = action.tab ?? front
    const tabPage = tabs.get(tabNumber)
    if (tabPage === undefined) throw new Error(`no tab ${tabNumber} — \`tabs\` lists them`)
    if (action.action === 'switch-tab') {
      await bringToFront(tabNumber)
      return here()
    }
    if (tabs.size === 1) throw new Error('the last tab stays open: there would be no page to act on')
    // Its `close` listener forgets it and brings the newest tab left to the front.
    await tabPage.close()
    return here()
  }
  const perform = async (action: ArenaAction, via: ArenaActionSource): Promise<unknown> => {
    const timeout = ACTION_TIMEOUT_MS
    switch (action.action) {
      case 'goto':
        await inFront().goto(new URL(action.path, ARENA_WEB_ORIGIN).toString(), { timeout })
        return here()
      case 'click':
        await locate(inFront(), action.target).click({ timeout })
        return here()
      case 'hover':
        await locate(inFront(), action.target).hover({ timeout })
        return here()
      case 'fill':
        await locate(inFront(), action.target).fill(action.text, { timeout })
        return here()
      case 'select':
        await locate(inFront(), action.target).selectOption(action.option, { timeout })
        return here()
      case 'press':
        if (action.target === undefined) await inFront().keyboard.press(action.key)
        else await locate(inFront(), action.target).press(action.key, { timeout })
        return here()
      case 'read': {
        // ⚠ An open native dialog blocks the page, the snapshot included: say the dialog instead.
        const dialog = frontDialog()
        if (dialog !== undefined) {
          lastSeen.saw(await pageNow())
          return { ...here(), dialog: { type: dialog.type(), message: redact(dialog.message()) } }
        }
        // One snapshot (PR #646 review): the page the agent reads is the wait's baseline too.
        const snapshot = await inFront().locator('body').ariaSnapshot({ timeout })
        lastSeen.saw(pageForChange(snapshot))
        return { ...here(), page: snapshot }
      }
      case 'screenshot':
        return { ...here(), screenshot: await shoot('requested') }
      case 'wait': {
        if (action.until === undefined) {
          await inFront().waitForTimeout(action.ms)
          return here()
        }
        const waited = await waitForPage({
          until: action.until,
          baseline: await lastSeen.baseline(),
          look: pageNow,
          sleep: (ms) => inFront().waitForTimeout(ms),
          ms: action.ms,
          pollMs: CHANGE_POLL_MS,
        })
        return { ...here(), ...waited }
      }
      case 'back':
        await inFront().goBack({ timeout })
        return here()
      case 'reload':
        await inFront().reload({ timeout })
        return here()
      case 'note':
        timeline.record(
          {
            kind: 'note',
            via,
            note: action.note,
            trying: redact(action.trying),
            happened: redact(action.happened),
            ...(action.wanted === undefined ? {} : { wanted: redact(action.wanted) }),
          },
          here(),
        )
        return { recorded: action.note }
      case 'restart-enso': {
        const refused = runClock.restart()
        if (refused !== undefined) throw new Error(refused)
        await stopEnso()
        return { restarted: await startEnso() }
      }
      case 'accept-dialog':
        return answerDialog((dialog) => dialog.accept(action.text))
      case 'dismiss-dialog':
        return answerDialog((dialog) => dialog.dismiss())
      case 'tabs':
      case 'switch-tab':
      case 'close-tab':
        return performOnTabs(action)
      case 'stop':
        resolveStop(`the agent stopped the run${action.reason === undefined ? '' : `: ${redact(action.reason)}`}`)
        return { stopping: true }
    }
  }

  const actOnce = async (request: unknown, via: ArenaActionSource): Promise<ArenaActOutcome> => {
    const parsed = parseArenaAction(request)
    if (!parsed.ok) {
      // ⚠ Recorded, not only answered (#584): a refused move — `goto /api/…`, a selector — is
      // what the agent tried to do, and an attempt to leave the UI is evidence. Only the action's
      // name is kept, redacted and cut short: the rest of a malformed request is not trusted.
      timeline.record(
        {
          kind: 'action',
          via,
          action: refusedActionName(request, redact),
          detail: ARENA_REFUSED_DETAIL,
          outcome: 'failed',
          error: parsed.error,
          durationMs: 0,
        },
        here(),
      )
      return { ok: false, error: parsed.error }
    }
    const { action } = parsed
    return serialized(async () => {
      if (stopReason !== undefined) return { ok: false, error: `the run has stopped (${stopReason})` }
      const detail = describeArenaAction(action, secrets())
      // In the grace window only the retrospective and the stop are taken (#609); refused, it is a line.
      const refusal = runClock.refusal(action.action) ?? typedSecretRefusal(action, secrets())
      if (refusal !== undefined) {
        timeline.record(
          { kind: 'action', via, action: action.action, detail, outcome: 'failed', error: refusal, durationMs: 0 },
          here(),
        )
        return { ok: false, error: refusal }
      }
      const began = performance.now()
      await context.tracing.group(detail)
      try {
        const result = await perform(action, via)
        if (action.action !== 'note') {
          timeline.record(
            {
              kind: 'action',
              via,
              action: action.action,
              detail,
              outcome: 'ok',
              durationMs: Math.round(performance.now() - began),
            },
            here(),
          )
        }
        if (!LEAVES_THE_PAGE.has(action.action)) await lastSeen.moved()
        return { ok: true, result }
      } catch (error) {
        const message = errorLine(error, redact)
        timeline.record(
          {
            kind: 'action',
            via,
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
  /** The run's place, on every answer while it lasts: the agent sees the end coming. */
  const withClock = (outcome: ArenaActOutcome): ArenaActOutcome => {
    const now = runClock.phase()
    return now.phase === 'over' ? outcome : { ...outcome, phase: now.phase, remainingMs: now.remainingMs }
  }

  const act = async (request: unknown, via: ArenaActionSource): Promise<ArenaActOutcome> => {
    runClock.acted()
    return withClock(await actOnce(request, via))
  }

  // ⚠ With a driver there is no endpoint (#584): a second door would let anything with
  // a shell act on the page as the agent, and the boundary is that the agent has no shell.
  const control = options.driver === undefined ? serveControl((body) => act(body, 'control')) : undefined
  controlRecord = controlRecordOf(control, runDirectory, options.home)
  publishControl(enso?.pid)
  await takeSample()
  process.stdout.write(`arena: run ${runId} is live — ${runDirectory}\n`)
  const driverDone =
    options.driver === undefined
      ? undefined
      : drive(options.driver, { act: (request) => act(request, 'agent'), stopped, runDirectory }, timeline, {
          resolveStop,
          redact,
        })

  // ── Stop, then make the evidence whole ─────────────────────────────────────────────────────
  const reason = await stopped
  clearInterval(sampler)
  clearInterval(chunker)
  clearInterval(ticker)
  rmSync(controlFile, { force: true })
  // Not forced: the `stop` action that got here is still in flight, and its answer is owed.
  await control?.stop()
  // The runner ends on `stopped`; its transcript is flushed before the page it describes closes.
  if (driverDone !== undefined) await awaitDriverEnd(driverDone, timeline)
  await serialized(async () => {
    if (browser.isConnected()) {
      await shoot('final')
      await writeChunk('last').catch((error: unknown) => {
        timeline.record({ kind: 'recorder-error', during: 'last trace chunk', error: redact(String(error)) })
      })
    }
  })
  timeline.record({ kind: 'run-stop', reason }, browser.isConnected() ? here() : undefined)
  const events = readTimeline(timeline.path)
  // ⚠ Enso down at the stop still gets every row the disk can give (#584 A1, #607): the server's
  // routes are each a `missing` row with the reason, and the snapshot store is copied all the same.
  const evidence = await collectEnsoEvidence({
    serverOrigin: ARENA_SERVER_ORIGIN,
    directory: join(ensoDirectory, 'evidence'),
    threadIds: threadIdsShown(events),
    home: options.home,
    project,
    secretValues: secrets(),
    ...(enso === undefined ? { serverDown: 'Enso was not running when the run stopped' } : {}),
  })
  stopping = true
  await browser.close().catch(() => undefined)
  await stopEnso()
  // ⚠ After Enso is stopped and the last chunk written: every file the run keeps is final (#610) —
  // and no credential write can come after the last relink (#639).
  relink()
  const secretScan = scanRunForSecrets(runDirectory, secrets())
  const histories = threadHistoriesIn(join(ensoDirectory, 'evidence'))
  const manifest = foldArenaManifest({ runId, events: readTimeline(timeline.path), evidence, secretScan, histories })
  writeFileSync(join(runDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  process.stdout.write(`arena: stopped (${reason}) — ${join(runDirectory, 'manifest.json')}\n`)
  return scoreAndSay(runDirectory, redact)
}

// ── A recorder that died before its stop (#584 A13, #607) ──────────────────────────────────────
// SIGKILL, an OOM, a closed terminal: no `run-stop`, no evidence, `control.json` left behind, and
// the stack — a child the recorder never got to stop — still holding 5178/5179.

/** Is a process with this id running? Signal 0 asks without sending anything. */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: it runs, as someone else. Only ESRCH means gone.
    return error instanceof Error && 'code' in error && error.code === 'EPERM'
  }
}

/**
 * Is `pid` the stack a run started — `bun run dev <project>`, exactly — and not a process that
 * reused the id? ⚠ The one check before anything is stopped: a pid alone is a number the system
 * hands out again, and the operator's own `bun run dev` on another project must never be touched.
 */
export function isRunStack(pid: number, project: string): boolean {
  if (!isRunning(pid)) return false
  const shown = spawnSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' })
  if (shown.status !== 0) return false
  const args = shown.stdout.trim()
  const tail = ` run dev ${project}`
  return args.endsWith(tail) && /(^|\/)bun$/.test(args.slice(0, -tail.length))
}

/** The run's control record, when the run left one that reads as one. */
export function readArenaControl(runDirectory: string): ArenaControl | undefined {
  const path = controlFilePath(runDirectory)
  if (!existsSync(path)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
  return arenaControlOf(parsed)
}

/** One field of a parsed object, `unknown` until it is checked. */
const fieldOf = (value: object, key: string): unknown => (key in value ? Reflect.get(value, key) : undefined)

/** A control record, field by field: a file on disk is not trusted to be one. */
function arenaControlOf(value: unknown): ArenaControl | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const [pid, runDirectory, driver, port, stackPid, home] = [
    'pid',
    'runDirectory',
    'driver',
    'port',
    'stackPid',
    'home',
  ].map((key) => fieldOf(value, key))
  if (typeof pid !== 'number' || typeof runDirectory !== 'string') return undefined
  if (driver !== 'agent' && driver !== 'control') return undefined
  if (!optionalOf(port, 'number') || !optionalOf(stackPid, 'number') || !optionalOf(home, 'string')) return undefined
  return {
    pid,
    runDirectory,
    driver,
    ...(port === undefined ? {} : { port }),
    ...(stackPid === undefined ? {} : { stackPid }),
    ...(home === undefined ? {} : { home }),
  }
}

function optionalOf(value: unknown, type: 'number'): value is number | undefined
function optionalOf(value: unknown, type: 'string'): value is string | undefined
function optionalOf(value: unknown, type: 'number' | 'string'): boolean {
  return value === undefined || typeof value === type
}

/**
 * A run whose recorder is gone but whose control record is not: the record, and whether its
 * stack is still up (verified, `isRunStack`). Undefined for a run that stopped, or is still live.
 */
export function deadRecorderRun(
  runDirectory: string,
): { readonly control: ArenaControl; readonly stackPid?: number } | undefined {
  const control = readArenaControl(runDirectory)
  if (control === undefined || isRunning(control.pid)) return undefined
  const project = runProjectOf(runDirectory)
  const stackPid =
    control.stackPid !== undefined && project !== undefined && isRunStack(control.stackPid, project)
      ? control.stackPid
      : undefined
  return stackPid === undefined ? { control } : { control, stackPid }
}

/** The project a run served, from its `run-start` line. */
function runProjectOf(runDirectory: string): string | undefined {
  return runStartOf(runDirectory)?.project
}

/** The `ENSO_HOME` a run ran over, as its `run-start` line recorded it (#610); undefined for a run from before. */
export function recordedRunHome(runDirectory: string): string | undefined {
  return runStartOf(runDirectory)?.home
}

function runStartOf(runDirectory: string): { readonly project: string; readonly home?: string } | undefined {
  const path = join(runDirectory, 'timeline.jsonl')
  if (!existsSync(path)) return undefined
  const start = readTimeline(path).find((event) => event.kind === 'run-start')
  return start?.kind === 'run-start' ? start : undefined
}

/**
 * Enso's evidence for a run whose recorder died before its stop, as the stop would have taken it:
 * from the stack when it is still up — then stopped, so the ports are free again — else every
 * route a `missing` row and the disk read all the same. `home` is the record's; `fallbackHome`
 * only when the recorder died before writing one. Refuses a run whose recorder is still running.
 */
export async function collectAfterRecorderDied(runDirectory: string, fallbackHome: string): Promise<ArenaEvidence[]> {
  const control = readArenaControl(runDirectory)
  if (control !== undefined && isRunning(control.pid)) {
    throw new Error(
      `the run at ${runDirectory} is live (recorder pid ${control.pid}): stop it with its \`stop\` action`,
    )
  }
  const dead = deadRecorderRun(runDirectory)
  const home = control?.home ?? runHomeOf(runDirectory, fallbackHome, recordedRunHome(runDirectory))
  const project = runProjectOf(runDirectory) ?? join(runDirectory, 'project')
  const evidence = await collectEnsoEvidence({
    serverOrigin: ARENA_SERVER_ORIGIN,
    directory: join(runDirectory, 'enso', 'evidence'),
    threadIds: threadIdsShown(readTimeline(join(runDirectory, 'timeline.jsonl'))),
    home,
    project,
    secretValues: arenaSecretValues(home),
    ...(dead?.stackPid === undefined
      ? { serverDown: 'the recorder died before its stop, and the run’s Enso stack is not running' }
      : {}),
  })
  if (dead?.stackPid !== undefined && !(await stopStack(dead.stackPid))) {
    // ⚠ Said, not swallowed (PR #612 review): the control record goes regardless, so nothing later
    // would name the process still holding the ports — only a bare "port in use".
    process.stderr.write(
      `arena: the run's Enso stack (pid ${dead.stackPid}) did not stop within 10 s of SIGTERM — stop it with \`kill ${dead.stackPid}\`\n`,
    )
  }
  rmSync(controlFilePath(runDirectory), { force: true })
  return evidence
}

/** SIGTERM, as the recorder's own stop sends, then wait until it is gone (at most 10 s). True when it went. */
async function stopStack(pid: number): Promise<boolean> {
  process.kill(pid, 'SIGTERM')
  const deadline = Date.now() + 10_000
  while (isRunning(pid) && Date.now() < deadline) await Bun.sleep(200)
  return !isRunning(pid)
}
