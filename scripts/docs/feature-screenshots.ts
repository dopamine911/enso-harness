import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, relative } from 'node:path'
import { type Browser, chromium, type Locator, type Page } from '@playwright/test'
import { findRepoRoot } from '../../packages/core/src/paths.ts'
import { ENSO_DEFAULT_PERMISSION_POLICY } from '../../packages/core/src/permission-rules.ts'
import { isListening } from '../loopback.ts'
import { startFeatureModel } from './feature-model.ts'
import {
  ANSWER_ENDINGS,
  DEMO_FILES,
  DEMO_PROJECT,
  demoModelsJson,
  FEATURE_SCRIPT,
  INCIDENT_PROMPT,
  INCIDENT_SCRIPT,
  PROMPTS,
  PROMPT_LIBRARY,
  SECOND_MODEL,
} from './feature-session.ts'
import { FEATURE_SPECS } from './features/index.ts'
import { LANDING_SHOTS, LANDING_SHOTS_DIRECTORY } from './features/landing.ts'
import {
  type FeatureFacts,
  type FeatureSpec,
  type FeatureUi,
  factsPath,
  type MarkTarget,
  type SessionMoment,
  type Shot,
  type ShotFacts,
  type ThreadTab,
  withShotFacts,
} from './features/spec.ts'

/**
 * Captures the Features screenshots (#437) into `docs/features/images/`. Run it after a UI change:
 *
 *   bun run docs:screenshots [--chromium <path to a chrome binary>] [--keep] [--only <feature>[,<feature>…]]
 *
 * `--keep` leaves the scratch directory — the home, the project, the model's request log — and
 * prints where it is, for when a step fails and the page alone does not say why. `--only` plays
 * the session, then captures just the named features' shots (their spec ids: `stats`, `chat`, …),
 * for recapturing one feature after its spec changed.
 *
 * WHAT EACH SHOT IS comes from its feature's spec (`features/<id>.ts`, #482): how it is reached,
 * what it rings, what it measures. This file plays the session and carries the specs out, in the
 * registry's order (`features/index.ts`); no shot's rings, crop or quoted values are chosen here.
 *
 * WHY A SCRIPT, NOT COMMITTED SCREENSHOTS WITH A DATE. A screenshot taken by hand drifts the
 * first time a label moves, and nothing says so. This one is regenerated from the running app,
 * so after a UI change the pages are one command away from true again.
 *
 * WHY NOT THE `?fixture` PAGE. It was the first choice, and it covers the chat only: the page
 * answers every server read with a 503 by design (#404), so Context, Stats, the refusal receipt
 * and the Context Browser have nothing to show there.
 *
 * WHAT IT RUNS INSTEAD: a real session, with only the model scripted.
 *   • A throwaway `ENSO_HOME` whose pi `models.json` names one provider, `demo`, pointing at
 *     `feature-model.ts` on loopback. No other provider has a credential, so nothing here can
 *     reach a real one.
 *   • A throwaway project (`feature-session.ts`), so pi's edit lands in a temporary directory and
 *     never in this checkout.
 *   • The real dev stack (`bun run dev <project>`), driven through the page like a user: the
 *     Start dialog, the composer, the questionnaire, the permission prompt. The guards, the tools,
 *     the session file and every panel are the product's own.
 *   • Then, after every other shot, a second thread for the Incidents page (`INCIDENT_SCRIPT`),
 *     whose refusals open an incident. The home turns halting on (`config.json`), so the incident
 *     suspends tools and asks the agent for its report, as a user who turned it on would see.
 *
 * ⚠ It needs ports 5178, 5179 and 5199 FREE, and refuses to start otherwise: a dev server already
 * running is serving YOUR home, and these pages must not show it.
 *
 * ONE THEME: every shot is `enso-signal`, pinned in storage rather than inherited from the
 * default, so a change of default does not quietly restyle half the pages.
 *
 * ANNOTATIONS are drawn in the page before each shot — a numbered ring on the element a page
 * talks about — and each page's legend lists the numbers in order. They are real elements
 * found by what a reader sees, so a renamed control fails the capture instead of ringing nothing.
 */

const ROOT = findRepoRoot(import.meta.url)
const OUT = join(ROOT, 'docs/features/images')
const WEB = 'http://127.0.0.1:5178'
const MODEL_PORT = 5199
const PORTS = [5178, 5179, MODEL_PORT] as const
const THEME = 'enso-signal'
const VIEWPORT = { width: 1440, height: 900 } as const
/** A real run's replies stream in; a step waits this long at most before the capture gives up. */
const STEP_TIMEOUT_MS = 60_000

/**
 * pi's settings for the throwaway home: compaction keeps only the last few hundred tokens. pi
 * refuses to compact a session smaller than what it keeps (`Nothing to compact`), and its default
 * of 20k is several times this whole session. Projects are trusted (#502): the demo is the reader's
 * own project, and an undecided one runs untrusted with the engine's warning on every session.
 */
const PI_SETTINGS = { compaction: { keepRecentTokens: 300 }, defaultProjectTrust: 'always' } as const

/** The `demo` provider, served by the scripted model on `MODEL_PORT` (`feature-model.ts`). */
const MODELS_JSON = demoModelsJson(MODEL_PORT)

/**
 * Enso's own `config.json` for the throwaway home: halting on (#466), so the Incidents page's
 * thread shows an incident that suspends and asks for a report. The shared thread never reaches
 * `incident`, so for every other page it changes nothing.
 */
const ENSO_CONFIG = { security: { incidents: { halt: true } } } as const

/** A finished demo thread: its id, and the prompt that shows its transcript is on screen. */
interface DemoThread {
  readonly id: string
  readonly lastPrompt: string
}

interface Annotation {
  readonly target: Locator
  readonly label: string
}

async function waitFor(check: () => Promise<boolean>, what: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`feature-screenshots: timed out waiting for ${what}`)
}

/**
 * The few browser APIs the in-page callbacks use. The scripts project has no DOM library, and
 * pulling one in for every script to serve two callbacks would type `document` everywhere.
 */
interface BrowserElement {
  readonly dataset: Record<string, string>
  readonly style: Record<string, string>
  textContent: string | null
  append: (...children: BrowserElement[]) => void
  remove: () => void
}
interface BrowserGlobals {
  readonly document: {
    readonly body: BrowserElement
    createElement: (tag: string) => BrowserElement
    querySelectorAll: (selector: string) => Iterable<BrowserElement>
  }
}

/** A rectangle on the viewport, in CSS pixels. */
interface Rectangle {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

const ANNOTATION_COLOR = '#f97316'

/**
 * Places a fixed box over the page, marked so `clearAnnotations` removes it. Every mark a shot
 * draws — a ring, a number, the region a crop takes — is one of these.
 */
async function placeBox(page: Page, rectangle: Rectangle, style: Record<string, string>, text = ''): Promise<void> {
  await page.evaluate(
    ({ rectangle, style, text }) => {
      const { document } = globalThis as unknown as BrowserGlobals
      const box = document.createElement('div')
      box.dataset.featureAnnotation = ''
      box.textContent = text
      Object.assign(box.style, {
        position: 'fixed',
        left: `${rectangle.left}px`,
        top: `${rectangle.top}px`,
        width: `${rectangle.width}px`,
        height: `${rectangle.height}px`,
        pointerEvents: 'none',
        ...style,
      })
      document.body.append(box)
    },
    { rectangle, style, text },
  )
}

async function clearAnnotations(page: Page): Promise<void> {
  await page.evaluate(() => {
    const { document } = globalThis as unknown as BrowserGlobals
    for (const element of document.querySelectorAll('[data-feature-annotation]')) element.remove()
  })
}

/** Where a locator is on the viewport, or a throw naming what was looked for. */
async function rectangleOf(target: Locator, what: string): Promise<Rectangle> {
  const box = await target.boundingBox()
  if (box === null) throw new Error(`feature-screenshots: ${what} is not on screen`)
  return { left: box.x, top: box.y, width: box.width, height: box.height }
}

/**
 * Waits until `target` stops moving. A live transcript sticks to its bottom and animates back to
 * it after a scroll, so a box measured too early rings where the element WAS.
 */
async function steady(target: Locator): Promise<void> {
  let previous = ''
  for (let reading = 0; reading < 40; reading += 1) {
    const box = JSON.stringify(await target.boundingBox())
    if (box === previous) return
    previous = box
    await target.page().waitForTimeout(150)
  }
  throw new Error('feature-screenshots: a target never stopped moving')
}

/** Rings each target and numbers it. */
async function annotate(page: Page, annotations: readonly Annotation[]): Promise<void> {
  for (const { target, label } of annotations) {
    const { left, top, width, height } = await rectangleOf(target, `annotation ${label}`)
    await placeBox(
      page,
      { left: left - 4, top: top - 4, width: width + 8, height: height + 8 },
      { border: `2px solid ${ANNOTATION_COLOR}`, borderRadius: '8px', zIndex: '2147483646' },
    )
    await placeBox(
      page,
      { left: Math.max(2, left - 16), top: Math.max(2, top - 16), width: 24, height: 24 },
      {
        borderRadius: '12px',
        background: ANNOTATION_COLOR,
        color: '#0b0b0f',
        font: '700 13px/24px system-ui, sans-serif',
        textAlign: 'center',
        zIndex: '2147483647',
      },
      label,
    )
  }
}

/**
 * The features `--only` asked for, by spec id; `undefined` for all of them. Playing the session
 * stops where some shots exist only while it waits (the Start dialog, the questions); under
 * `--only` those are not retaken, so recapturing one feature leaves every other image as it was.
 */
const ONLY: readonly string[] | undefined = process.argv.includes('--only')
  ? (process.argv[process.argv.indexOf('--only') + 1] ?? '').split(',')
  : undefined
let sessionPlaying = false

/**
 * One shot: annotate, capture, clear the annotations. The capture is the whole viewport, or the
 * smallest rectangle holding every locator in `region` — padded, so a badge at the edge of the
 * region is not cut in half. The region is cropped by screenshotting a transparent box laid over
 * it: an element screenshot takes whatever is painted inside that element's bounds. It lands in
 * `docs/features/images/<name>.png` unless `path` says otherwise (the landing's copies, #511).
 */
async function shoot(
  page: Page,
  name: string,
  annotations: readonly Annotation[],
  options: { readonly region?: readonly Locator[]; readonly path?: string } = {},
): Promise<void> {
  if (sessionPlaying && ONLY !== undefined) return
  const { region = [], path = join(OUT, `${name}.png`) } = options
  const anchor = annotations[0]?.target ?? region[0]
  if (anchor !== undefined) await steady(anchor)
  await annotate(page, annotations)
  if (region.length === 0) await page.screenshot({ path })
  else {
    const boxes = await Promise.all(region.map((locator) => rectangleOf(locator, `${name}'s region`)))
    const pad = 24
    const left = Math.max(0, Math.min(...boxes.map((box) => box.left)) - pad)
    const top = Math.max(0, Math.min(...boxes.map((box) => box.top)) - pad)
    const right = Math.min(VIEWPORT.width, Math.max(...boxes.map((box) => box.left + box.width)) + pad)
    const bottom = Math.min(VIEWPORT.height, Math.max(...boxes.map((box) => box.top + box.height)) + pad)
    await placeBox(page, { left, top, width: right - left, height: bottom - top }, { zIndex: '0' }, '')
    await page.locator('[data-feature-annotation]').last().screenshot({ path })
  }
  await clearAnnotations(page)
  process.stdout.write(`feature-screenshots: wrote ${relative(ROOT, path)}\n`)
}

/**
 * Scrolls `target` near the top of the viewport, so a region below it fits.
 *
 * ⚠ WITH THE WHEEL, as a user scrolls. A live transcript sticks to its bottom, and it releases
 * only for a scroll it takes to be the user's: a programmatic `scrollIntoView` is undone by the
 * next animation frame, and the shot rings an element that has already left.
 */
async function scrollToTop(target: Locator): Promise<void> {
  const page = target.page()
  await page.mouse.move(VIEWPORT.width / 2, VIEWPORT.height / 2)
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const { top } = await rectangleOf(target, 'the element to scroll to')
    const distance = top - 90
    if (Math.abs(distance) < 40) break
    await page.mouse.wheel(0, distance)
    await page.waitForTimeout(400)
  }
  await steady(target)
}

// --- the session: typed, sent and answered through the page, as a user would --------------

/** Sends `prompt` from the composer and waits for the answer that ends with `ending`. */
async function send(page: Page, prompt: string, ending: string): Promise<void> {
  const composer = page.getByPlaceholder('ask pi something')
  await composer.fill(prompt)
  await composer.press('Enter')
  await page.getByText(ending, { exact: false }).last().waitFor({ timeout: STEP_TIMEOUT_MS })
  await page.locator('#thread-status').getByText('idle', { exact: true }).waitFor({ timeout: STEP_TIMEOUT_MS })
}

/** Runs a host command on the thread — what `/model` and `/compact` send from the palette. */
async function hostCommand(page: Page, threadId: string, name: string, value?: string): Promise<void> {
  const status = await page.evaluate(
    async ({ threadId, body }) => {
      const response = await fetch(`/api/threads/${threadId}/command`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      return response.status
    },
    { threadId, body: value === undefined ? { name } : { name, value } },
  )
  if (status >= 300) throw new Error(`feature-screenshots: /${name} answered ${status}`)
  await page.locator('#thread-status').getByText('idle', { exact: true }).waitFor({ timeout: STEP_TIMEOUT_MS })
}

/**
 * Plays the whole session, stopping for the shots that only exist WHILE it runs — the Start
 * dialog, the questionnaire and the permission prompt (`SessionShot`). Returns the thread's id.
 */
async function playSession(page: Page, modelLog: string): Promise<string> {
  await page.goto(WEB)
  const dialog = page.getByRole('dialog', { name: 'Start a session' })
  await dialog
    .getByText(/^Claude Sonnet 4\.5$/)
    .first()
    .click()
  await dialog.getByPlaceholder('ask pi something').fill(PROMPTS[0])
  // The library is read as the dialog opens; the Saved prompt field appears once it has been.
  await dialog.getByText('Saved prompt', { exact: true }).waitFor()
  await sessionShots(page, 'start-dialog')
  await dialog.getByRole('button', { name: 'Start session' }).click()
  await page.getByText(ANSWER_ENDINGS[0], { exact: false }).last().waitFor({ timeout: STEP_TIMEOUT_MS })
  const threadId = new URL(page.url()).searchParams.get('thread')
  if (threadId === null) throw new Error('feature-screenshots: the page names no thread after the first prompt')

  await send(page, PROMPTS[1], ANSWER_ENDINGS[1])
  await hostCommand(page, threadId, 'model', `demo/${SECOND_MODEL}`)

  // Prompt 3 asks before it acts: the questionnaire first, then the permission engine's prompt.
  const composer = page.getByPlaceholder('ask pi something')
  await composer.fill(PROMPTS[2])
  await composer.press('Enter')
  const firstTab = page.getByRole('tab', { name: 'Failure' })
  await firstTab.waitFor({ timeout: STEP_TIMEOUT_MS })
  await page.getByText('Throw at startup', { exact: true }).click()
  await page.getByText('Missing variable', { exact: true }).click()
  await page.getByText('Other', { exact: true }).click()
  await page.getByPlaceholder('Type your answer').fill('a malformed URL')
  await sessionShots(page, 'questionnaire')
  await page.getByRole('button', { name: 'Submit answers' }).click()
  const yes = page.getByRole('button', { name: 'Yes', exact: true })
  await yes.waitFor({ timeout: STEP_TIMEOUT_MS })
  await sessionShots(page, 'permission-prompt')
  await yes.click()
  await page.getByText(ANSWER_ENDINGS[2], { exact: false }).last().waitFor({ timeout: STEP_TIMEOUT_MS })
  await page.locator('#thread-status').getByText('idle', { exact: true }).waitFor({ timeout: STEP_TIMEOUT_MS })

  // The command only starts the compaction: it is done once its summary call has been answered.
  await hostCommand(page, threadId, 'compact')
  await waitFor(
    async () => existsSync(modelLog) && readFileSync(modelLog, 'utf8').includes('auxiliary'),
    'the compaction',
  )
  await page.locator('#thread-status').getByText('idle', { exact: true }).waitFor({ timeout: STEP_TIMEOUT_MS })
  await send(page, PROMPTS[3], ANSWER_ENDINGS[3])
  return threadId
}

/** Plays the Incidents page's thread (`INCIDENT_SCRIPT`) in a new thread of its own; returns its id. */
async function playIncidentThread(page: Page): Promise<string> {
  const threadId = crypto.randomUUID()
  await page.goto(`${WEB}/?thread=${threadId}`)
  const dialog = page.getByRole('dialog', { name: 'Start a session' })
  await dialog
    .getByText(/^Claude Sonnet 4\.5$/)
    .first()
    .click()
  await dialog.getByPlaceholder('ask pi something').fill(INCIDENT_PROMPT)
  await dialog.getByRole('button', { name: 'Start session' }).click()
  // A recorded report ends the run, so the thread is done once the card shows it.
  await page.getByText('The uncharitable read', { exact: true }).waitFor({ timeout: STEP_TIMEOUT_MS })
  await page.locator('#thread-status').getByText('idle', { exact: true }).waitFor({ timeout: STEP_TIMEOUT_MS })
  return threadId
}

// --- the shots taken afterwards, off the finished thread ---------------------------------------

async function openThread(page: Page, thread: DemoThread): Promise<void> {
  await page.goto(`${WEB}/?thread=${thread.id}`)
  await page.getByText(thread.lastPrompt).first().waitFor()
  // The transcript mounts, then scrolls to its end; let both settle before anything is measured.
  await page.waitForTimeout(800)
}

async function tab(page: Page, name: ThreadTab): Promise<void> {
  await page.getByRole('tab', { name, exact: true }).click()
  await page.waitForTimeout(1200)
}

/**
 * What an element reads as, whitespace folded: the form a page quotes it in. ⚠ With CSS case
 * transforms off while it reads: `innerText` applies `text-transform`, so a small-caps header would
 * be quoted as `PI IS ASKING` where the UI's text, and the reader's search, is `pi is asking`.
 * `textContent` would keep the case but run adjacent elements together (`bashcat`).
 */
async function textOf(located: Locator): Promise<string> {
  const plainCase = await located.page().addStyleTag({ content: '* { text-transform: none !important; }' })
  try {
    return (await located.innerText()).replaceAll(/\s+/g, ' ').trim()
  } finally {
    await plainCase.evaluate((node) => (node as unknown as BrowserElement).remove())
  }
}

/** Where a mark's target is, inside its `within` when it has one. The capture fails if it does not resolve. */
function locate(page: Page, target: MarkTarget): Locator {
  const scope: Page | Locator = target.within === undefined ? page : locate(page, target.within)
  if ('role' in target) {
    const exact = target.exact === undefined ? {} : { exact: target.exact }
    return scope.getByRole(target.role, { name: target.name, ...exact }).first()
  }
  if ('text' in target) return scope.getByText(target.text, { exact: target.exact ?? false }).first()
  if ('label' in target) return scope.getByLabel(target.label).first()
  if ('placeholder' in target) return scope.getByPlaceholder(target.placeholder).first()
  const row = scope.locator('details[data-enso-tool-call]').filter({ hasText: target.toolCall }).first()
  return target.summary === true ? row.locator('summary') : row
}

/**
 * What a mark's `{shown}` is, and what a click's step calls its target: the name or label it was
 * found by when that is plain text, else the text the element renders.
 */
async function shownBy(target: MarkTarget, located: Locator): Promise<string> {
  if ('role' in target && typeof target.name === 'string') return target.name
  if ('label' in target) return target.label
  if ('placeholder' in target) return target.placeholder
  return textOf(located)
}

const ORDINALS = ['first', 'second', 'third', 'fourth'] as const

/** The thread the page is on: the fork's once `forkAt` has moved to it. */
function threadOnScreen(page: Page, fallback: string): string {
  return new URL(page.url()).searchParams.get('thread') ?? fallback
}

/** The UI a shot's `go` drives: every call does what a reader would, and records it as their step. */
function featureUi(page: Page, thread: DemoThread, steps: string[]): FeatureUi {
  const threadId = thread.id
  return {
    page,
    openThread: async () => {
      steps.push('open a thread from the rail')
      await openThread(page, thread)
    },
    tab: async (name) => {
      steps.push(`choose the **${name}** tab at the top of the thread`)
      await tab(page, name)
    },
    click: async (target) => {
      const located = locate(page, target)
      steps.push(`choose **${await shownBy(target, located)}**`)
      await located.click()
      await page.waitForTimeout(800)
    },
    scrollTo: async (target) => {
      await scrollToTop(locate(page, target))
    },
    debugDrawer: async () => {
      steps.push("add `?debug` to the thread's address")
      await page.goto(`${WEB}/?debug&thread=${threadOnScreen(page, threadId)}`)
      await page.getByText('session debug').waitFor()
      await page.waitForTimeout(1200)
    },
    logPage: async () => {
      steps.push(`open \`${WEB}/debug\``)
      await page.goto(`${WEB}/debug`)
      await page.getByText('enso · logs').waitFor()
      await page.waitForTimeout(1500)
    },
    forkAt: async (promptNumber) => {
      steps.push(`choose **fork from here** under the ${ORDINALS[promptNumber - 1] ?? `#${promptNumber}`} prompt`)
      await scrollToTop(page.getByText(PROMPTS[promptNumber - 1] ?? '').last())
      // The fork buttons are one per prompt, in order.
      await page
        .getByText('fork from here')
        .nth(promptNumber - 1)
        .click()
      await page.waitForURL((url) => url.searchParams.get('thread') !== threadId)
      // The source thread's pane stays mounted, hidden: the fork's composer is the visible one.
      const composer = page.getByPlaceholder('ask pi something').filter({ visible: true })
      const prompt = PROMPTS[promptNumber - 1]
      await waitFor(async () => (await composer.inputValue()) === prompt, "the fork's prompt in its composer")
    },
  }
}

/** `captured` into its feature's facts file, beside the other shots' last capture, formatted as the gate wants it. */
function recordShotFacts(spec: FeatureSpec, captured: ShotFacts): void {
  const path = join(ROOT, factsPath(spec.id))
  const previous = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as FeatureFacts) : undefined
  writeFileSync(path, `${JSON.stringify(withShotFacts(spec, previous, captured), null, 2)}\n`)
  // In the repository's style, as `bun run format` writes it: a capture must not leave the format gate red.
  const formatted = spawnSync(process.execPath, ['--bun', 'oxfmt', factsPath(spec.id)], { cwd: ROOT, encoding: 'utf8' })
  if (formatted.status !== 0)
    throw new Error(`feature-screenshots: oxfmt refused ${factsPath(spec.id)}: ${formatted.stderr}`)
}

/**
 * One shot from its spec (#482), on the screen its `go` (or the session) reached: the marks are
 * rung where the page renders them, the image is taken, then the measured values are read, and
 * all of it lands in the feature's facts file for `feature-pages.ts` to build the page from.
 */
async function captureShot(page: Page, spec: FeatureSpec, shot: Shot, steps: readonly string[]): Promise<void> {
  if (sessionPlaying && ONLY !== undefined) return
  const targets = shot.marks.map((mark) => locate(page, mark.target))
  const shown = await Promise.all(
    shot.marks.map((mark, markIndex) => shownBy(mark.target, targets[markIndex] as Locator)),
  )
  await shoot(
    page,
    shot.image,
    targets.map((target, markIndex) => ({ target, label: String(markIndex + 1) })),
    { region: (shot.region ?? []).map((target) => locate(page, target)) },
  )
  // The landing's copy (#511): the same screen, settled by the ringed shot, with no rings.
  const landing = LANDING_SHOTS[shot.image]
  if (landing !== undefined) {
    mkdirSync(join(ROOT, LANDING_SHOTS_DIRECTORY), { recursive: true })
    await shoot(page, shot.image, [], {
      region: (landing.region ?? shot.region ?? []).map((target) => locate(page, target)),
      path: join(ROOT, LANDING_SHOTS_DIRECTORY, `${shot.image}.png`),
    })
  }
  const measured: Record<string, string> = {}
  for (const [quoted, element] of Object.entries(shot.measure ?? {})) {
    measured[quoted] = await textOf(await element(page))
    if (measured[quoted] === '') throw new Error(`feature-screenshots: ${spec.id} measured nothing for "${quoted}"`)
  }
  recordShotFacts(spec, { image: shot.image, steps, shown, measured })
  process.stdout.write(`feature-screenshots: recorded ${shot.image} in ${factsPath(spec.id)}\n`)
}

/** Every spec'd shot the session takes at `moment`, while it waits there. */
async function sessionShots(page: Page, moment: SessionMoment): Promise<void> {
  for (const spec of FEATURE_SPECS) {
    for (const shot of spec.shots)
      if ('during' in shot && shot.during === moment) await captureShot(page, spec, shot, [])
  }
}

/** A feature's shots of the finished thread: the live ones, or (`cold`) the ones after the restart. */
async function captureFeature(page: Page, spec: FeatureSpec, thread: DemoThread, cold: boolean): Promise<void> {
  for (const shot of spec.shots) {
    if ('during' in shot || (shot.cold === true) !== cold) continue
    const steps: string[] = []
    await shot.go(featureUi(page, thread, steps))
    await captureShot(page, spec, shot, steps)
  }
}

// --- running it -------------------------------------------------------------------------------

/** The dev stack over `home`, running pi in `project`. */
function startStack(home: string, project: string): ChildProcess {
  return spawn(process.execPath, ['run', 'dev', project], {
    cwd: ROOT,
    // ⚠ NOT the caller's environment, and nothing read from it: the server logs the names of
    // the secrets it keeps out of pi's (#89), and the log tail is one of the shots. What a
    // screenshot shows must not depend on — or disclose — the machine it was taken on. `PATH`
    // is this bun's own directory, which is all `bun run dev` spawns.
    env: { PATH: [dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter), HOME: home, ENSO_HOME: home },
    stdio: 'ignore',
    detached: true,
  })
}

async function stopStack(stack: ChildProcess): Promise<void> {
  // The whole process group: `bun run dev` starts the server and the web proxy as children.
  if (stack.pid !== undefined) process.kill(-stack.pid, 'SIGTERM')
  await waitFor(async () => !(await isListening(5178)) && !(await isListening(5179)), 'the dev stack to stop')
}

async function newPage(browser: Browser): Promise<Page> {
  const page = await browser.newPage({ viewport: VIEWPORT })
  await page.addInitScript((theme) => localStorage.setItem('enso:theme', theme), THEME)
  return page
}

/**
 * Runs `capture`, and on failure saves what the page showed — outside the repository — and says
 * where: the reason is usually on it. Every shot is attempted, so one renamed label does not hide
 * what else a UI change broke.
 */
async function attempt(
  browser: Browser,
  name: string,
  capture: (page: Page) => Promise<void>,
  failed: string[],
): Promise<void> {
  const page = await newPage(browser)
  try {
    await capture(page)
  } catch (error) {
    const evidence = join(tmpdir(), `enso-feature-shot-${name}.png`)
    await page.screenshot({ path: evidence }).catch(() => undefined)
    failed.push(`${name}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)} (page: ${evidence})`)
  }
  await page.close()
}

/** The features `--only` names, in the registry's order; all of them without it. A name no spec has is refused. */
function wantedFeatures(): readonly FeatureSpec[] {
  const unknown = (ONLY ?? []).filter((requested) => !FEATURE_SPECS.some((spec) => spec.id === requested))
  if (unknown.length > 0) throw new Error(`feature-screenshots: --only names no feature: ${unknown.join(', ')}`)
  return FEATURE_SPECS.filter((spec) => ONLY === undefined || ONLY.includes(spec.id))
}

/** What the finished thread's shots run in: the browser, the thread, how to restart the stack, the failures so far. */
interface FinishedThread {
  readonly browser: Browser
  readonly thread: DemoThread
  readonly restart: () => Promise<void>
  readonly failed: string[]
}

/** Every wanted feature's shots of the finished thread: the live ones, then, after a restart, the cold ones. */
async function captureFinishedThread(wanted: readonly FeatureSpec[], run: FinishedThread): Promise<void> {
  const { browser, thread, failed } = run
  for (const spec of wanted) {
    await attempt(browser, spec.id, (page) => captureFeature(page, spec, thread, false), failed)
  }
  const cold = wanted.filter((spec) => spec.shots.some((shot) => 'go' in shot && shot.cold === true))
  if (cold.length === 0) return
  // A cold thread is one no session holds: restart the stack, and the thread is read off its file.
  await run.restart()
  for (const spec of cold) {
    await attempt(browser, `${spec.id} (cold)`, (page) => captureFeature(page, spec, thread, true), failed)
  }
}

/**
 * The Incidents page's shots: its thread played, then its shots taken — after every other page's,
 * cold ones included, so no other page's rail, counts or day stats see a second thread.
 */
async function captureIncidentThread(
  wanted: readonly FeatureSpec[],
  browser: Browser,
  failed: string[],
): Promise<void> {
  if (wanted.length === 0) return
  let threadId = ''
  await attempt(
    browser,
    'incident thread',
    async (page) => {
      threadId = await playIncidentThread(page)
    },
    failed,
  )
  if (threadId === '') return
  const thread = { id: threadId, lastPrompt: INCIDENT_PROMPT }
  for (const spec of wanted) {
    await attempt(browser, spec.id, (page) => captureFeature(page, spec, thread, false), failed)
  }
}

async function main(): Promise<void> {
  // Before anything starts: a mistyped `--only` should not cost a session.
  const wanted = wantedFeatures()
  const chromiumFlag = process.argv.indexOf('--chromium')
  const executablePath = chromiumFlag >= 0 ? process.argv[chromiumFlag + 1] : undefined
  for (const port of PORTS) {
    if (await isListening(port))
      throw new Error(`feature-screenshots: port ${port} is in use — stop what is on it first`)
  }

  // A FIXED path, not a random one: the refusals name files under it (`web_fetch` names its
  // config), and a path that changes on every run changes the screenshots with it.
  const scratch = join(tmpdir(), 'enso-feature-shots')
  rmSync(scratch, { recursive: true, force: true })
  const home = join(scratch, 'home')
  const project = join(scratch, DEMO_PROJECT)
  mkdirSync(join(home, 'pi-agent'), { recursive: true })
  writeFileSync(join(home, 'pi-agent', 'models.json'), JSON.stringify(MODELS_JSON, null, 2))
  writeFileSync(join(home, 'pi-agent', 'settings.json'), JSON.stringify(PI_SETTINGS, null, 2))
  writeFileSync(join(home, 'config.json'), JSON.stringify(ENSO_CONFIG, null, 2))
  // The permission policy (#496): Enso's default, with `web_fetch` allowed. The default asks before
  // every fetch, and prompt 2's fetch is scripted to reach web_fetch's OWN allowlist refusal — what
  // Web access documents — not a permission question the script has no answer for. (Found when the
  // capture first ran after the engine switch: it waited on that question until it timed out.)
  writeFileSync(
    join(home, 'permissions.json'),
    JSON.stringify(
      {
        ...ENSO_DEFAULT_PERMISSION_POLICY,
        permission: { ...ENSO_DEFAULT_PERMISSION_POLICY.permission, web_fetch: 'allow' },
      },
      null,
      2,
    ),
  )
  mkdirSync(join(home, 'prompts'))
  for (const [file, text] of Object.entries(PROMPT_LIBRARY)) writeFileSync(join(home, 'prompts', file), text)
  for (const [path, text] of Object.entries(DEMO_FILES)) {
    mkdirSync(dirname(join(project, path)), { recursive: true })
    writeFileSync(join(project, path), text)
  }
  // A repository, so the run context records a revision — and, once pi's edit lands, `dirty`.
  const git = (...args: string[]): void => {
    const run = spawnSync('git', ['-c', 'user.name=demo', '-c', 'user.email=demo@example.invalid', ...args], {
      cwd: project,
      encoding: 'utf8',
    })
    if (run.status !== 0) throw new Error(`feature-screenshots: git ${args[0]} failed: ${run.stderr}`)
  }
  git('init', '--quiet', '--initial-branch=main')
  git('add', '--all')
  git('commit', '--quiet', '--message', 'shop-api')
  const modelLog = join(scratch, 'model.log')
  const stopModel = startFeatureModel(MODEL_PORT, [FEATURE_SCRIPT, INCIDENT_SCRIPT], modelLog)
  let stack = startStack(home, project)
  let browser: Browser | undefined
  const failed: string[] = []
  try {
    await waitFor(async () => (await isListening(5178)) && (await isListening(5179)), 'the dev stack')
    browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
    mkdirSync(OUT, { recursive: true })

    let threadId = ''
    await attempt(
      browser,
      'session',
      async (page) => {
        sessionPlaying = true
        threadId = await playSession(page, modelLog).finally(() => {
          sessionPlaying = false
        })
      },
      failed,
    )
    if (threadId === '')
      throw new Error(`feature-screenshots: the session did not finish (model log: ${modelLog})\n${failed.join('\n')}`)
    const restart = async (): Promise<void> => {
      await stopStack(stack)
      stack = startStack(home, project)
      await waitFor(async () => (await isListening(5178)) && (await isListening(5179)), 'the dev stack, again')
    }
    const shared = { id: threadId, lastPrompt: PROMPTS[3] }
    await captureFinishedThread(
      wanted.filter((spec) => spec.thread === undefined),
      { browser, thread: shared, restart, failed },
    )
    await captureIncidentThread(
      wanted.filter((spec) => spec.thread === 'incident'),
      browser,
      failed,
    )
    if (failed.length > 0) throw new Error(`feature-screenshots: ${failed.length} failed\n${failed.join('\n')}`)
  } finally {
    await browser?.close()
    await stopStack(stack).catch(() => undefined)
    stopModel()
    if (process.argv.includes('--keep')) process.stdout.write(`feature-screenshots: kept ${scratch}\n`)
    else rmSync(scratch, { recursive: true, force: true })
  }
}

if (import.meta.main) await main()
