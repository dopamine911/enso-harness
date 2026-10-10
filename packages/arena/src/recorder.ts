import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { ENSO_UI_EVENTS } from '@enso/core'
import { gitChildEnvironment } from '@enso/core/git'
import { redactJudgeText } from '@enso/core/judge'
import { isListening } from '@enso/core/loopback'
import { ensoProjectsDir, projectIdOf, projectTreesDir, realpathOrSelf } from '@enso/core/paths'
import { type Browser, type BrowserContext, type CDPSession, chromium, type Dialog, type Page } from '@playwright/test'
import {
  ARENA_REFUSED_DETAIL,
  ARENA_RUNNER_STILL_RUNNING,
  ARENA_VIEW,
  type ArenaAction,
  type ArenaPoint,
  createChangeBaseline,
  createStatusLog,
  describeArenaAction,
  dialogForChange,
  pageForChange,
  parseArenaAction,
  perceptionRefusal,
  POINT_FIELDS,
  typedSecretRefusal,
} from './actions.ts'
import { createEnsoStack } from './enso-stack.ts'
import { collectEnsoEvidence, threadIdsShown } from './evidence.ts'
import { type ArenaEvidence, foldArenaManifest } from './manifest.ts'
import { createPageLook, PAGE_CHANGES_SCRIPT, readPageMark } from './page-changes.ts'
import {
  ACTION_TIMEOUT_MS,
  type ArenaEyes,
  type ArenaFront,
  type ArenaPointer,
  type ArenaRunHands,
  type ArenaTabs,
  type ArenaWaiting,
  CHANGE_POLL_MS,
  createDialogWaiters,
  performOnControl,
  performOnPage,
  performOnRun,
  performOnTabs,
  performWait,
  performWithPointer,
  shownAfter,
} from './page-hands.ts'
import {
  type ArenaActionRun,
  type ArenaActOutcome,
  type ArenaHands,
  actOnArena,
  errorLine,
  performArenaAction,
  pointedRoleOf,
} from './perform.ts'
import { isRunning, stopProcessTree } from './process-tree.ts'
import { createRegionReads } from './read-regions.ts'
import { ARENA_GRACE_MS, type ArenaBounds, createRunControl, ensoSpendUsd } from './run-control.ts'
import { arenaSecretSource, arenaSecretValues, runHomeOf } from './run-home.ts'
import { ensoBuildOf, sampleWorkspaces, threadHistoriesIn } from './run-state.ts'
import type { ArenaScenario } from './scenario.ts'
import { type ArenaScore, writeArenaScore } from './score.ts'
import { type ArenaSecretScan, scanFilesForSecrets, scanRunForSecrets } from './secret-scan.ts'
import {
  ARENA_SHOT_EXTENSION,
  ARENA_WEB_ORIGIN,
  type ArenaActionSource,
  type ArenaEventBody,
  type ArenaPagePlace,
  type ArenaPerception,
  type ArenaShotCause,
  type ArenaTimeline,
  openTimeline,
  pagePlace,
  readTimeline,
} from './timeline.ts'
import { hearUiEvent } from './ui-status.ts'

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

/** Where the dev stack's server answers; its web origin is `ARENA_WEB_ORIGIN` (`timeline.ts`). */
const ARENA_SERVER_ORIGIN = 'http://127.0.0.1:5179'
/** The ports a run's Enso stack listens on: the web page and the server (#742: the launcher checks and waits on them). */
export const STACK_PORTS = [5178, 5179] as const
const STACK_STARTUP_TIMEOUT_MS = 90_000
const EVENT_SHOT_SPACING_MS = 2000
/** The pause before a failed screenshot's second try (#665): long enough for a reload to settle. */
const SHOT_RETRY_MS = 500
const VIEWPORT = { width: 1440, height: 900 } as const
/**
 * How old a wait's last look at the page may grow while the page's change count holds still (#740,
 * `createPageLook`): what the DOM's mutations do not show is seen within this, not within a poll.
 */
const CHANGE_RECHECK_MS = 10_000
/** The page-side function the recorder exposes (#737): a UI event's name and `detail`, forwarded as it fires. */
const UI_EVENT_BINDING = '__ensoUiEvent'
/** The margin a wait on the page keeps under the idle bound (#609), so a wait in progress never trips it. */
const IDLE_BOUND_MARGIN_MS = 5000
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
  readonly budgetMinutes: number
  /** The bounds besides the budget (#609, `run-control.ts`); `maxCostUsd` only over the run's own home. */
  readonly limits: { readonly idleMinutes?: number; readonly maxRestarts: number; readonly maxCostUsd?: number }
  readonly chromiumPath?: string
  readonly headed: boolean
  /** How the agent perceives the page (#680): the accessibility tree (the default), or a screenshot after each action. */
  readonly perception?: ArenaPerception
  /** The model Enso's sessions were set to start on (#674), recorded on the run's start; the run home's settings carry it. */
  readonly ensoModel?: string
  /** The launcher's environment, which the stack inherits with `ENSO_HOME` set to `home`. */
  readonly environment: Readonly<Record<string, string | undefined>>
  /**
   * The agent runner (`agent.ts`), when an agent drives the run. Absent, the run is driven over
   * the control endpoint by `bun run arena act` — by whoever holds a shell, which no one checks.
   */
  readonly driver?: ArenaDriver
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
export function makeProject(project: string): void {
  mkdirSync(project, { recursive: true })
  // An empty template (#740): no sample hooks, 5 MB per run that nobody runs.
  spawnSync('git', ['init', '--quiet', '--initial-branch=main', '--template='], {
    cwd: project,
    env: gitChildEnvironment(),
  })
}

/** The name a refused request gave its action, short and redacted, for the timeline line that records the refusal. */
export function refusedActionName(request: unknown, redact: (text: string) => string): string {
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

/**
 * How every screenshot is encoded (#740): JPEG at quality 80, a third of a PNG's size for a picture
 * no reader needs pixel-exact. The extension the files carry is `ARENA_SHOT_EXTENSION`.
 */
const ARENA_SHOT_ENCODING = { type: 'jpeg', quality: 80 } as const

/** What a screenshot needs of a page: Playwright's `Page`, or a test's stand-in. It answers with the picture's bytes. */
export interface ArenaShotPage {
  screenshot(options: {
    readonly timeout: number
    readonly type: typeof ARENA_SHOT_ENCODING.type
    readonly quality: number
  }): Promise<Uint8Array>
  url(): string
}

/**
 * The run's camera: `show` it the page once there is one; `shoot` settles with the file, or
 * undefined. `sample` is the periodic shot, given the workspaces' fingerprint at that moment.
 */
export interface ArenaShooter {
  readonly show: (page: ArenaShotPage) => void
  readonly shoot: (cause: ArenaShotCause) => Promise<string | undefined>
  readonly sample: (workspaces: string) => Promise<string | undefined>
}

/**
 * The run's screenshots: numbered files under `directory`, each a `screenshot` line on the
 * timeline. An event cause is taken at most once per `EVENT_SHOT_SPACING_MS`; a requested shot,
 * the final one and a visual agent's view (#680) always. Before a page is shown, nothing is taken.
 *
 * A SAMPLE THAT SHOWS NOTHING NEW IS A LINE, NOT A FILE (#740): when neither the picture's bytes nor
 * the workspaces' fingerprint moved since the last sample written, a `sample-skipped` line naming
 * that sample keeps the cadence readable and no file is written. 39% of samples repeated their
 * predecessor. An event shot is never skipped.
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
  /**
   * The visual agent's view (#680), as bytes: the tab in front scaled to `ARENA_VIEW`. Only the
   * recorder can take it (it needs the browser's own capture); absent, a `view` is a full shot.
   */
  readonly view?: () => Promise<Uint8Array>
  readonly sleep?: (ms: number) => Promise<void>
}): ArenaShooter {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number): Promise<void> => Bun.sleep(ms))
  let shown: ArenaShotPage | undefined
  let shotNumber = 0
  const lastShotAt = new Map<ArenaShotCause, number>()
  let lastSample: { readonly path: string; readonly picture: string; readonly workspaces: string } | undefined
  const picture = async (page: ArenaShotPage, cause: ArenaShotCause): Promise<Uint8Array | { failed: unknown }> => {
    try {
      if (cause === 'view' && options.view !== undefined) return await options.view()
      return await page.screenshot({ timeout: 10_000, ...ARENA_SHOT_ENCODING })
    } catch (error) {
      return { failed: error }
    }
  }
  const take = async (cause: ArenaShotCause, workspaces?: string): Promise<string | undefined> => {
    const page = shown
    if (page === undefined) return undefined
    const at = now()
    if (cause !== 'sample' && cause !== 'requested' && cause !== 'final' && cause !== 'view') {
      if (at - (lastShotAt.get(cause) ?? 0) < EVENT_SHOT_SPACING_MS) return undefined
    }
    lastShotAt.set(cause, at)
    let outcome = await picture(page, cause)
    if (!(outcome instanceof Uint8Array)) {
      await sleep(SHOT_RETRY_MS)
      outcome = await picture(page, cause)
    }
    if (!(outcome instanceof Uint8Array)) {
      options.timeline.record(
        { kind: 'recorder-error', during: `screenshot (${cause})`, error: errorLine(outcome.failed, options.redact) },
        pagePlace(page.url()),
      )
      return undefined
    }
    const hash = workspaces === undefined ? '' : createHash('sha256').update(outcome).digest('hex')
    if (workspaces !== undefined && lastSample?.picture === hash && lastSample.workspaces === workspaces) {
      options.timeline.record({ kind: 'sample-skipped', same: lastSample.path }, pagePlace(page.url()))
      return undefined
    }
    const stamp = new Date(at).toISOString().replaceAll(':', '-')
    const path = join(
      options.directory,
      `${String(shotNumber).padStart(5, '0')}-${stamp}-${cause}${ARENA_SHOT_EXTENSION}`,
    )
    shotNumber += 1
    writeFileSync(path, outcome)
    if (workspaces !== undefined) lastSample = { path, picture: hash, workspaces }
    options.timeline.record({ kind: 'screenshot', cause, path }, pagePlace(page.url()))
    return path
  }
  return {
    show: (page) => {
      shown = page
    },
    shoot: (cause) => take(cause),
    sample: (workspaces) => take('sample', workspaces),
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
 * model call the abort did not cut short — gets an `agent-end` line saying so:
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

/** How long each step of stopping Enso's tree waits: SIGTERM to its root, to what is left, then SIGKILL (#742). */
const STACK_STOP_GRACE_MS = 5000

/**
 * Where Playwright keeps a trace's working files until a chunk is written (#742): under the run, on
 * disk. By default they went to `os.tmpdir()`, a tmpfs here: about 43 MB of RAM per active minute,
 * kept until the browser closed and leaked by a recorder that died. Removed once the browser is closed.
 */
function traceWorkDirectory(runDirectory: string): string {
  return join(runDirectory, 'trace', '.work')
}

/** A browser with one page, tracing, its first chunk open. A failure on the way closes what it opened. */
async function openTracedPage(
  options: ArenaRunOptions,
  runId: string,
): Promise<{ readonly browser: Browser; readonly context: BrowserContext; readonly page: Page }> {
  const browser = await chromium.launch({
    headless: !options.headed,
    tracesDir: traceWorkDirectory(options.runDirectory),
    ...(options.chromiumPath === undefined ? {} : { executablePath: options.chromiumPath }),
  })
  try {
    // Reduced motion (#740): Enso's pulsing status dots stand still (`motion-safe:`), so the page repaints only when it changes.
    const context = await browser.newContext({ viewport: VIEWPORT, reducedMotion: 'reduce' })
    // ⚠ NO SCREENCAST (#736). `screenshots: true` is Chromium's continuous screencast: every repaint a
    // JPEG, ~31 fps for a whole run because Enso's status dots animate. 97% of each trace zip, 3.3 GB for a
    // 42-minute run, all of it held in memory by the stop's secret scan. Nothing reads it: the report, the
    // score and the agent read the recorder's own paced screenshots. The DOM snapshots and the network stay.
    await context.tracing.start({ screenshots: false, snapshots: true, title: `arena ${runId}` })
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

/** The longest a wait on the page runs (#737): its own cap, cut under the idle bound (#609) when there is one. */
function pageWaitCapOf(bounds: ArenaBounds): number {
  return bounds.idleMs === undefined ? Number.POSITIVE_INFINITY : Math.max(0, bounds.idleMs - IDLE_BOUND_MARGIN_MS)
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
  // A source, not a snapshot: an OAuth refresh rewrites the linked auth.json during
  // the run, and a rotated token must be redacted and scanned for like the one it replaced.
  const secrets = arenaSecretSource(options.home)
  const redact = (text: string): string => redactJudgeText(text, secrets())
  const timeline = openTimeline(join(runDirectory, 'timeline.jsonl'))
  const ensoBuild = ensoBuildOf(options.repoRoot)
  const perception = options.perception ?? 'tree'
  timeline.record({
    kind: 'run-start',
    scenario: scenario.id,
    project,
    home: options.home,
    perception,
    ...(ensoBuild === undefined ? {} : { ensoBuild }),
    // Absent when unset: the line is JSON, which leaves an undefined field out.
    ensoModel: options.ensoModel,
  })

  // ── Screenshots, over a page that does not exist until the browser is up ───────────────────
  // ⚠ Defined BEFORE Enso starts: Enso's exit handler takes one, and Enso can
  // die while the recorder is still waiting for it to answer — before there is any page.
  // The view is taken by the browser's own capture once there is a browser (#680); before, nothing asks for one.
  let captureView: () => Promise<Uint8Array> = () => Promise.reject(new Error('no browser yet'))
  const { show, shoot, sample } = createShooter({
    directory: shotsDirectory,
    timeline,
    redact,
    view: () => captureView(),
  })

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
  let stopping = false
  const enso = createEnsoStack({
    spawn: (onExit) =>
      Bun.spawn(['bun', 'run', 'dev', project], {
        cwd: options.repoRoot,
        env: { ...options.environment, ENSO_HOME: options.home },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        onExit: (_child, code, signal) => onExit(code, signal),
      }),
    answered: () => waitForWeb(STACK_STARTUP_TIMEOUT_MS),
    stopTree: (pid) => stopProcessTree(pid, STACK_STOP_GRACE_MS),
    log: (text) => appendFileSync(stackLog, redact(text)),
    record: (body) => {
      timeline.record(body)
    },
    shoot,
    started: publishControl,
    stopping: () => stopping,
  })
  if (!(await enso.start())) {
    await enso.stop()
    throw new Error(
      `Enso did not answer on ${ARENA_WEB_ORIGIN} within ${STACK_STARTUP_TIMEOUT_MS / 1000} s — see ${stackLog}`,
    )
  }

  // ── The browser, its trace and its listeners ───────────────────────────────────────────────
  // ⚠ A browser that fails to start must not leave Enso holding the dev ports:
  // every later `arena start` would refuse them until someone killed the stack by hand.
  const {
    browser,
    context,
    page: firstPage,
  } = await openTracedPage(options, runId).catch(async (error: unknown) => {
    await enso.stop()
    throw error
  })
  // ── The tabs (#675) ────────────────────────────────────────────────────────────────────────
  // Preview opens the built page in a new tab, and a link may too. The tab in front is the one
  // the agent acts on and the camera shows, as a browser shows a person the tab it opened.
  /** Every open tab by its number: Enso's first page is 0, and a number is never reused. */
  const tabs = new Map<number, Page>([[0, firstPage]])
  let nextTab = 1
  let front = 0
  /**
   * The page in front, counted (#740): it moves on each navigation of the tab in front and each change
   * of the tab in front, and a `read` after it has every region whole — what it diffed against is gone.
   */
  let pageVisit = 0
  const inFront = (): Page => tabs.get(front) ?? firstPage
  const bringToFront = (tabNumber: number): Promise<void> => {
    const tabPage = tabs.get(tabNumber)
    if (tabPage === undefined) return Promise.resolve()
    if (tabNumber !== front) pageVisit += 1
    front = tabNumber
    show(tabPage)
    return tabPage.bringToFront().catch(() => undefined)
  }
  show(firstPage)
  let chunkNumber = 0
  const chunkPaths: string[] = []
  // The chunks' scan so far (#741): each chunk is read once, as it is written, and the stop reads the rest.
  let chunkScan: ArenaSecretScan | undefined
  /**
   * Write the trace so far. ⚠ `stopChunk` ends the chunk; between chunks nothing is traced, so
   * every chunk but the last is followed by `startChunk`, so the trace covers
   * the whole run, not only its first chunk. The chunk is scanned after the
   * next one starts, so the scan adds nothing to the untraced gap; a chunk written before a value
   * joined the secret set is read again (`soughtValues`).
   */
  const writeChunk = async (then: 'continue' | 'last'): Promise<void> => {
    const path = join(traceDirectory, `trace-${String(chunkNumber).padStart(3, '0')}.zip`)
    chunkNumber += 1
    await context.tracing.stopChunk({ path })
    timeline.record({ kind: 'trace-chunk', path })
    if (then === 'continue') await context.tracing.startChunk()
    chunkPaths.push(relative(runDirectory, path))
    chunkScan = scanFilesForSecrets(runDirectory, chunkPaths, secrets(), chunkScan)
  }
  /** Where a tab is: its URL's place, and its number unless it is the first. */
  const tabPlace = (tabNumber: number, tabPage: Page): ArenaPagePlace => ({
    ...pagePlace(tabPage.url()),
    ...(tabNumber === 0 ? {} : { tab: tabNumber }),
  })
  const here = (): ArenaPagePlace => tabPlace(front, inFront())

  // A native dialog is left OPEN for the agent to answer (#609): it is part of the interface, and it
  // blocks the page until answered — `read` says it is there (a visual run's every answer does, #680),
  // and `accept-dialog`/`dismiss-dialog` answer it.
  // ⚠ Per tab: a browser shows a dialog over its own tab, so the one that blocks the
  // agent is the front tab's — a game's alert in tab 1 must not answer for Enso's tab, nor block it.
  const dialogs = new Map<number, Dialog>()
  const frontDialog = (): Dialog | undefined => dialogs.get(front)
  /** Who is waiting for a tab's next dialog: an action in flight (#691), a wait until attention (#648). */
  const dialogWaiters = createDialogWaiters()
  /** The tab in front as the page's hands reach it (`page-hands.ts`). */
  const frontHands: ArenaFront = {
    page: inFront,
    here,
    tab: () => front,
    dialog: frontDialog,
    forgetDialog: () => {
      dialogs.delete(front)
    },
    nextDialog: dialogWaiters.next,
    shoot,
    redact,
  }
  /**
   * An action raced against the front tab opening a native dialog (#691). Playwright does not finish
   * a click whose dialog is unanswered, and the arena leaves dialogs open (#609), so the click would
   * time out though it worked. The answer is the dialog, at once; the click finishes in the background
   * once the dialog is answered, and its outcome is not anyone's to report.
   */
  const untilDialogOrDone = async (work: Promise<unknown>): Promise<unknown> => {
    const nextDialog = dialogWaiters.next(front)
    try {
      const first = await Promise.race([work, nextDialog.opened])
      if (first !== 'dialog') return first
      void work.catch(() => undefined)
      const dialog = frontDialog()
      return {
        ...here(),
        ...(dialog === undefined ? {} : { dialog: { type: dialog.type(), message: redact(dialog.message()) } }),
      }
    } finally {
      nextDialog.release()
    }
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
      if (tabNumber === front) pageVisit += 1
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
      dialogWaiters.opened(tabNumber)
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
      // ⚠ The page closed the last tab itself (`window.close()`): a browser with no
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

  // ── The page's announcements (#737) ────────────────────────────────────────────────────────
  // Enso's page announces its thread's status as a DOM event (core's `ENSO_UI_EVENTS`); a script
  // installed before any page's own forwards it here (`hearUiEvent`), and a wait until attention
  // reads the log instead of the page.
  const statusLog = createStatusLog()
  const tabOf = (tabPage: Page): number | undefined => {
    for (const [tabNumber, candidate] of tabs) if (candidate === tabPage) return tabNumber
    return undefined
  }
  await context.exposeBinding(UI_EVENT_BINDING, (source, name: unknown, detail: unknown) => {
    hearUiEvent(
      { name, detail, tab: tabOf(source.page) },
      {
        log: statusLog,
        record: (body, tabNumber) => {
          timeline.record(body, tabPlace(tabNumber, source.page))
        },
        redact,
      },
    )
  })
  await context.addInitScript(
    `document.addEventListener(${JSON.stringify(ENSO_UI_EVENTS.threadStatus)}, (event) => {
      const forward = window[${JSON.stringify(UI_EVENT_BINDING)}]
      if (typeof forward === 'function') forward(event.type, event.detail)
    })`,
  )
  // The page's count of its own changes (#740, `page-changes.ts`): a wait until change looks at the
  // page again only when the count moved.
  await context.addInitScript(PAGE_CHANGES_SCRIPT)

  try {
    await firstPage.goto(ARENA_WEB_ORIGIN)
  } catch (error) {
    await browser.close().catch(() => undefined)
    await enso.stop()
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
  /** A periodic sample: the screenshot and the work at the same tick, so neither is without the other. */
  const takeSample = async (): Promise<void> => {
    const sampled = sampleWorkspaces(runDirectory, workspaces())
    timeline.record({ kind: 'workspace-sample', workspaces: sampled })
    await sample(sampled.map((workspace) => `${workspace.path}:${workspace.fingerprint}`).join('\n'))
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
  const bounds = boundsOf(options)
  const runClock = createRunControl({
    bounds,
    onGrace: () => timeline.record({ kind: 'budget-spent', graceMs: ARENA_GRACE_MS }, here()),
    onStop: resolveStop,
    readCost: () => ensoSpendUsd(options.home),
  })
  const pageWaitCap = pageWaitCapOf(bounds)
  const ticker = setInterval(() => runClock.tick(), 1000)
  browser.on('disconnected', () => resolveStop('the browser closed'))
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => resolveStop(`signal ${signal}`))

  // ── The agent's actions ────────────────────────────────────────────────────────────────────
  /** One DevTools session per tab, opened when first needed: a wait's change mark, the view, the point's element. */
  const devtools = new WeakMap<Page, CDPSession>()
  const devtoolsOf = async (tabPage: Page): Promise<CDPSession> => {
    const known = devtools.get(tabPage)
    if (known !== undefined) return known
    const session = await context.newCDPSession(tabPage)
    devtools.set(tabPage, session)
    return session
  }
  /**
   * The page as a wait sees it (#637, #648, #740): the rail's ages aside, or the native dialog
   * blocking it. ⚠ The dialog first: a page under an open dialog runs no script, and its change
   * count would not answer.
   */
  const pageLook = createPageLook({
    look: async () => pageForChange(await inFront().locator('body').ariaSnapshot({ timeout: ACTION_TIMEOUT_MS })),
    mark: async () => {
      const tabNumber = front
      const devtoolsOfFront = await devtoolsOf(inFront()).catch(() => undefined)
      const mark = devtoolsOfFront === undefined ? undefined : await readPageMark(devtoolsOfFront, CHANGE_POLL_MS)
      return mark === undefined ? undefined : `${tabNumber} ${mark}`
    },
    recheckMs: CHANGE_RECHECK_MS,
  })
  const dialogPage = (): string | undefined => {
    const dialog = frontDialog()
    return dialog === undefined ? undefined : dialogForChange(dialog.type(), dialog.message())
  }
  /** The page looked at now: after a move, the baseline of the next wait. */
  const pageNow = async (): Promise<string> => dialogPage() ?? pageLook.now()
  /** What the agent last saw: its last read, or the page right after its last move (`createChangeBaseline`). */
  const lastSeen = createChangeBaseline(pageNow)

  // ── The visual agent's eyes and hands (#680) ───────────────────────────────────────────────
  // The tab in front, as the window shows it, scaled by Chromium itself to the view's size.
  captureView = async (): Promise<Uint8Array> => {
    const session = await devtoolsOf(inFront())
    const { cssVisualViewport } = await session.send('Page.getLayoutMetrics')
    const { data } = await session.send('Page.captureScreenshot', {
      format: ARENA_SHOT_ENCODING.type,
      quality: ARENA_SHOT_ENCODING.quality,
      // The protocol's own field names, from `POINT_FIELDS`: the page's scroll offset, the whole window.
      clip: {
        [POINT_FIELDS.horizontal]: cssVisualViewport.pageX,
        [POINT_FIELDS.vertical]: cssVisualViewport.pageY,
        width: VIEWPORT.width,
        height: VIEWPORT.height,
        scale: 1 / ARENA_VIEW.scale,
      },
    })
    return Buffer.from(data, 'base64')
  }
  /**
   * What is at a window point, as the browser's accessibility tree names it: the nearest element with
   * a meaningful role, `button "Start session"`. The same words a tree agent reads, so the two kinds of
   * run can be read click for click. For the record only; the agent is never told.
   */
  const underThePoint = async (point: ArenaPoint): Promise<string> => {
    try {
      const session = await devtoolsOf(inFront())
      await session.send('DOM.getDocument', { depth: 0 })
      const { backendNodeId } = await session.send('DOM.getNodeForLocation', {
        [POINT_FIELDS.horizontal]: Math.round(point.left),
        [POINT_FIELDS.vertical]: Math.round(point.top),
        includeUserAgentShadowDOM: false,
      })
      const { nodes } = await session.send('Accessibility.getPartialAXTree', { backendNodeId, fetchRelatives: true })
      return pointedRoleOf(nodes, backendNodeId)
    } catch {
      return 'unknown'
    }
  }
  /** What the last pointer action pointed at; read into its timeline line, then cleared. */
  let pointedAt: string | undefined
  /** What a visual agent is shown with each answer (#680, #693), and what it then acts from. */
  const eyes: ArenaEyes = { perception, dialog: frontDialog, shoot, redact, pageNow, saw: lastSeen.saw }
  /** What the agent has read of each region of the page in front (#740): a later read answers with what changed. */
  const regionReads = createRegionReads()
  /**
   * `read`: a region of the tab in front as its accessibility tree, or what changed in it since its
   * last read (#740) — or the native dialog over the tab, which blocks the snapshot.
   */
  const performRead = async (action: Extract<ArenaAction, { readonly action: 'read' }>): Promise<unknown> => {
    const dialog = frontDialog()
    if (dialog !== undefined) {
      lastSeen.saw(await pageNow())
      return { ...here(), dialog: { type: dialog.type(), message: redact(dialog.message()) } }
    }
    // One snapshot: the whole page is the wait's baseline, and the region is read out of it.
    const snapshot = await inFront().locator('body').ariaSnapshot({ timeout: ACTION_TIMEOUT_MS })
    lastSeen.saw(pageForChange(snapshot))
    return { ...here(), ...regionReads.read(snapshot, action, pageVisit) }
  }
  /** What a wait on the page reads besides the tab in front (#637, #648, #737). */
  const waiting: ArenaWaiting = {
    baseline: lastSeen.baseline,
    look: async () => dialogPage() ?? pageLook.current(),
    log: statusLog,
    capMs: pageWaitCap,
    stopped,
  }
  /** The run as a note, a restart or a stop reaches it. */
  const runHands: ArenaRunHands = {
    record: (body) => {
      timeline.record(body, here())
    },
    redact,
    restart: () => runClock.restart(),
    stopEnso: () => enso.stop(),
    startEnso: () => enso.start(),
    stop: resolveStop,
  }
  const pointer: ArenaPointer = {
    under: underThePoint,
    pointed: (under) => {
      pointedAt = under
    },
  }
  const openTabs: ArenaTabs = { open: tabs, front: () => front, bringToFront, here }
  const hands: ArenaHands = {
    withPointer: (action) => performWithPointer(action, frontHands, pointer),
    onControl: (action) => performOnControl(action, frontHands),
    read: performRead,
    wait: (action) => performWait(action, frontHands, waiting),
    onTabs: (action) => performOnTabs(action, openTabs),
    onRun: (action, via) => performOnRun(action, via, runHands),
    onPage: (action) => performOnPage(action, frontHands),
  }
  const actionRun: ArenaActionRun = {
    stopReason: () => stopReason,
    describe: (action) => describeArenaAction(action, secrets()),
    // In the grace window only the retrospective and the stop are taken (#609); refused, it is a line.
    refusal: (action) =>
      perceptionRefusal(action, perception) ?? runClock.refusal(action.action) ?? typedSecretRefusal(action, secrets()),
    record: (body) => {
      timeline.record(body, here())
    },
    tracing: context.tracing,
    markStatus: () => statusLog.mark(),
    perform: (action, via) => {
      pointedAt = undefined
      return untilDialogOrDone(performArenaAction(action, via, hands))
    },
    pointedAt: () => pointedAt,
    moved: () => lastSeen.moved(),
    shownAfter: (action, moved) => shownAfter(action, moved, eyes),
    shoot,
    redact,
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
    return serialized(() => actOnArena(action, via, actionRun))
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
  publishControl(enso.pid())
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
    ...(enso.pid() === undefined ? { serverDown: 'Enso was not running when the run stopped' } : {}),
  })
  stopping = true
  await browser.close().catch(() => undefined)
  rmSync(traceWorkDirectory(runDirectory), { recursive: true, force: true })
  await enso.stop()
  // ⚠ After Enso is stopped and the last chunk written: every file the run keeps is final (#610).
  // The chunks already read are not read again (#741); everything else is.
  const secretScan = scanRunForSecrets(runDirectory, secrets(), chunkScan)
  const histories = threadHistoriesIn(join(ensoDirectory, 'evidence'))
  const manifest = foldArenaManifest({ runId, events: readTimeline(timeline.path), evidence, secretScan, histories })
  writeFileSync(join(runDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  process.stdout.write(`arena: stopped (${reason}) — ${join(runDirectory, 'manifest.json')}\n`)
  return scoreAndSay(runDirectory, redact)
}

// ── A recorder that died before its stop (#584 A13, #607) ──────────────────────────────────────
// SIGKILL, an OOM, a closed terminal: no `run-stop`, no evidence, `control.json` left behind, and
// the stack — a child the recorder never got to stop — still holding 5178/5179.

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
    // ⚠ Said, not swallowed: the control record goes regardless, so nothing later
    // would name the process still holding the ports — only a bare "port in use".
    process.stderr.write(
      `arena: the run's Enso stack (pid ${dead.stackPid}) is still running after SIGTERM and SIGKILL — it is someone else's to stop\n`,
    )
  }
  rmSync(traceWorkDirectory(runDirectory), { recursive: true, force: true })
  rmSync(controlFilePath(runDirectory), { force: true })
  return evidence
}

/** The stack's whole tree, as the recorder's own stop takes it down (#742). True when nothing of it is left. */
async function stopStack(pid: number): Promise<boolean> {
  return (await stopProcessTree(pid, STACK_STOP_GRACE_MS)).length === 0
}
