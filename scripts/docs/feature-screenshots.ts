import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { type Browser, chromium, type Locator, type Page } from '@playwright/test'
import { findRepoRoot } from '../../packages/core/src/paths.ts'
import { startFeatureModel } from './feature-model.ts'
import {
  ANSWER_ENDINGS,
  DEMO_FILES,
  DEMO_PROJECT,
  FEATURE_SCRIPT,
  FIRST_MODEL,
  PROMPTS,
  SECOND_MODEL,
} from './feature-session.ts'
import {
  type FeatureFacts,
  type FeatureSpec,
  type FeatureUi,
  factsPath,
  type MarkTarget,
  type ShotFacts,
} from './features/spec.ts'
import { STATS } from './features/stats.ts'

/**
 * Captures the Features screenshots (#437) into `docs/features/images/`. Run it after a UI change:
 *
 *   bun run docs:screenshots [--chromium <path to a chrome binary>] [--keep] [--only <shot>[,<shot>…]]
 *
 * `--keep` leaves the scratch directory — the home, the project, the model's request log — and
 * prints where it is, for when a step fails and the page alone does not say why. `--only` plays
 * the session, then captures just the named shots (function names below: `stats`, `coldThread`, …),
 * for recapturing one feature after its spec changed.
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
 *
 * ⚠ It needs ports 5178, 5179 and 5199 FREE, and refuses to start otherwise: a dev server already
 * running is serving YOUR home, and these pages must not show it.
 *
 * ONE THEME: every shot is `enso-signal`, pinned in storage rather than inherited from the
 * default, so a change of default does not quietly restyle half the pages.
 *
 * ANNOTATIONS are drawn in the page before each shot — a numbered ring on the element a page
 * talks about — and each page's legend lists the numbers in order. They are real elements
 * found by role or text, so a renamed control fails the capture instead of ringing nothing.
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
 * of 20k is several times this whole session.
 */
const PI_SETTINGS = { compaction: { keepRecentTokens: 300 } } as const

/**
 * The throwaway home's prompt library (#443), in the file shape `ENSO_HOME/prompts/<id>.md` holds:
 * an append prompt for the System prompt field and the manager, and a session prompt, without which
 * the Start dialog has no Saved prompt field to show. The session itself starts on pi's default, so
 * the scripted model answers the prompt it was written for.
 */
const PROMPT_LIBRARY = {
  'reviewer.md': [
    '---',
    'name: Reviewer',
    'description: Reads the change before it answers, and says what breaks',
    'category: append',
    '---',
    '# Reviewer',
    '',
    'Read the diff before you answer. Say what breaks first, then what to change.',
    '',
  ].join('\n'),
  'config-audit.md': [
    '---',
    'name: Config audit',
    'description: A first message for a project you have not read yet',
    'category: session',
    '---',
    'List every environment variable the app reads, and what happens when one is missing.',
    '',
  ].join('\n'),
} as const

/** The `demo` provider, as pi's `models.json` declares a provider (#437): real prices, real windows. */
const MODELS_JSON = {
  providers: {
    demo: {
      name: 'Demo',
      baseUrl: `http://127.0.0.1:${MODEL_PORT}`,
      api: 'anthropic-messages',
      // Not a credential: the scripted model reads no key. pi offers a model only once its
      // provider has one.
      apiKey: 'demo-placeholder',
      models: [
        {
          id: FIRST_MODEL,
          name: 'Claude Sonnet 4.5',
          reasoning: true,
          input: ['text', 'image'],
          contextWindow: 200_000,
          maxTokens: 64_000,
          cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
        },
        {
          id: SECOND_MODEL,
          name: 'Claude Opus 4.1',
          reasoning: true,
          input: ['text', 'image'],
          contextWindow: 200_000,
          maxTokens: 32_000,
          cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
        },
      ],
    },
  },
} as const

interface Annotation {
  readonly target: Locator
  readonly label: string
}

/** Whether something is listening on `port` on loopback. */
function isListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    socket.once('connect', () => {
      socket.end()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
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
 * The shots `--only` asked for, by shot function name; `undefined` for all of them. Playing the
 * session takes screenshots of its own steps (the Start dialog, the questions); under `--only`
 * those are not retaken, so recapturing one feature leaves every other image as it was.
 */
const ONLY: readonly string[] | undefined = process.argv.includes('--only')
  ? (process.argv[process.argv.indexOf('--only') + 1] ?? '').split(',')
  : undefined
let sessionPlaying = false

/**
 * One shot: annotate, capture, clear the annotations. The capture is the whole viewport, or the
 * smallest rectangle holding every locator in `region` — padded, so a badge at the edge of the
 * region is not cut in half. The region is cropped by screenshotting a transparent box laid over
 * it: an element screenshot takes whatever is painted inside that element's bounds.
 */
async function shoot(
  page: Page,
  name: string,
  annotations: readonly Annotation[],
  region: readonly Locator[] = [],
): Promise<void> {
  if (sessionPlaying && ONLY !== undefined) return
  const anchor = annotations[0]?.target ?? region[0]
  if (anchor !== undefined) await steady(anchor)
  await annotate(page, annotations)
  const path = join(OUT, `${name}.png`)
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
  process.stdout.write(`feature-screenshots: wrote docs/features/images/${name}.png\n`)
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
 * Plays the whole session, taking the three shots that only exist WHILE it runs — the Start
 * dialog, the questionnaire and the permission prompt. Returns the thread's id.
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
  await shoot(page, 'sessions-start', [
    { target: dialog.getByText('Model', { exact: true }), label: '1' },
    { target: dialog.getByText('Effort', { exact: true }), label: '2' },
    { target: dialog.getByText('Mode', { exact: true }), label: '3' },
    { target: dialog.getByText('System prompt', { exact: true }), label: '4' },
    { target: dialog.getByText('Saved prompt', { exact: true }), label: '5' },
    { target: dialog.getByText('Prompt', { exact: true }), label: '6' },
  ])
  await dialog.getByRole('button', { name: 'Start session' }).click()
  await page.getByText(ANSWER_ENDINGS[0], { exact: false }).last().waitFor({ timeout: STEP_TIMEOUT_MS })
  const threadId = new URL(page.url()).searchParams.get('thread')
  if (threadId === null) throw new Error('feature-screenshots: the page names no thread after the first prompt')

  await send(page, PROMPTS[1], ANSWER_ENDINGS[1])
  await hostCommand(page, threadId, 'model', `demo/${SECOND_MODEL}`)

  // Prompt 3 asks before it acts: the questionnaire first, then picc's permission prompt.
  const composer = page.getByPlaceholder('ask pi something')
  await composer.fill(PROMPTS[2])
  await composer.press('Enter')
  const firstTab = page.getByRole('tab', { name: 'Failure' })
  await firstTab.waitFor({ timeout: STEP_TIMEOUT_MS })
  await page.getByText('Throw at startup', { exact: true }).click()
  await page.getByText('Missing variable', { exact: true }).click()
  await page.getByText('Other', { exact: true }).click()
  await page.getByPlaceholder('Type your answer').fill('a malformed URL')
  await shoot(page, 'questions-ask-user', [
    { target: page.getByRole('tablist').filter({ has: firstTab }), label: '1' },
    { target: page.getByPlaceholder('Type your answer'), label: '2' },
    { target: page.getByRole('button', { name: 'Submit answers' }), label: '3' },
  ])
  await page.getByRole('button', { name: 'Submit answers' }).click()
  const yes = page.getByRole('button', { name: 'Yes', exact: true })
  await yes.waitFor({ timeout: STEP_TIMEOUT_MS })
  await shoot(page, 'questions-permission-prompt', [
    { target: page.getByText('pi is asking'), label: '1' },
    { target: yes, label: '2' },
    { target: page.getByText('Cancel — decline the question'), label: '3' },
  ])
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

// --- the shots taken afterwards, off the finished thread ---------------------------------------

async function openThread(page: Page, threadId: string): Promise<void> {
  await page.goto(`${WEB}/?thread=${threadId}`)
  await page.getByText(PROMPTS[3]).first().waitFor()
  // The transcript mounts, then scrolls to its end; let both settle before anything is measured.
  await page.waitForTimeout(800)
}

async function tab(page: Page, name: 'Chat' | 'Context' | 'Stats' | 'Changes'): Promise<void> {
  await page.getByRole('tab', { name, exact: true }).click()
  await page.waitForTimeout(1200)
}

/** A tool row, by the text of what it was given: a row is a `<details>` whose summary names it. */
function toolRow(page: Page, summary: string): Locator {
  return page.locator('details[data-enso-tool-call]').filter({ hasText: summary }).first()
}

async function chat(page: Page, threadId: string): Promise<void> {
  await openThread(page, threadId)
  await scrollToTop(page.getByText(PROMPTS[0]).last())
  await shoot(page, 'chat-thread', [
    {
      target: page.getByRole('navigation', { name: 'threads' }).getByText('Where does the app read').first(),
      label: '1',
    },
    { target: page.getByText(/^Thought/).first(), label: '2' },
    { target: toolRow(page, 'DATABASE_URL').locator('summary'), label: '3' },
    { target: page.getByText('fork from here').first(), label: '4' },
    { target: page.getByRole('button', { name: 'attach an image' }), label: '5' },
    { target: page.locator('#thread-status'), label: '6' },
  ])
}

async function commandPalette(page: Page, threadId: string): Promise<void> {
  await openThread(page, threadId)
  await page.getByRole('button', { name: 'commands' }).click()
  await page.getByPlaceholder('filter commands…').waitFor()
  await page.waitForTimeout(800)
  await shoot(page, 'chat-command-palette', [{ target: page.getByPlaceholder('filter commands…'), label: '1' }])
}

async function guards(page: Page, threadId: string): Promise<void> {
  await openThread(page, threadId)
  const failed = toolRow(page, 'cat docs/deploy.md')
  const refused = page.getByLabel('bash, refused by Enso guard')
  await scrollToTop(failed)
  await shoot(
    page,
    'guards-refused-and-failed',
    [
      { target: failed.locator('summary'), label: '1' },
      { target: refused.getByText('network egress', { exact: false }).first(), label: '2' },
      { target: refused.getByText('Enso guard'), label: '3' },
    ],
    [failed, refused],
  )
  const secret = page.getByLabel('read, refused by Enso guard')
  await scrollToTop(secret)
  await shoot(
    page,
    'guards-receipt',
    [
      { target: secret.getByText('.env', { exact: true }), label: '1' },
      { target: secret.getByText(/^Reading "\.env" via read is blocked/), label: '2' },
      { target: secret.getByText('secret-read', { exact: true }), label: '3' },
    ],
    [secret],
  )
}

async function webAccess(page: Page, threadId: string): Promise<void> {
  await openThread(page, threadId)
  const call = toolRow(page, 'https://bun.sh/blog')
  await call.locator('summary').click()
  const answer = call.getByText(/^Not fetched/)
  await answer.waitFor()
  await scrollToTop(call)
  await shoot(
    page,
    'web-fetch-refusal',
    [
      { target: call.locator('summary'), label: '1' },
      { target: answer, label: '2' },
    ],
    [call],
  )
}

async function permissionModes(page: Page, threadId: string): Promise<void> {
  await openThread(page, threadId)
  const line = page.getByText('Mode: default', { exact: true }).first()
  const select = page.getByRole('combobox', { name: 'permission mode' })
  await scrollToTop(line)
  await shoot(
    page,
    'permission-modes',
    [
      { target: line, label: '1' },
      { target: select, label: '2' },
    ],
    [line, select, page.getByPlaceholder('ask pi something')],
  )
}

async function context(page: Page, threadId: string): Promise<void> {
  await openThread(page, threadId)
  await tab(page, 'Context')
  await shoot(page, 'context-now-trend', [
    { target: page.getByText('pi’s context meter', { exact: true }), label: '1' },
    { target: page.getByText('next request · pi’s estimate (characters ÷ 4)'), label: '2' },
    { target: page.getByRole('group', { name: 'bar per' }), label: '3' },
    { target: page.getByText('compaction', { exact: true }).first(), label: '4' },
  ])
}

async function contextBrowser(page: Page, threadId: string): Promise<void> {
  await openThread(page, threadId)
  await tab(page, 'Context')
  // Request 9 is the first on the second model: the turn the cache had to be written again for.
  await page.getByRole('button', { name: /^request 9, / }).click()
  await page.getByRole('button', { name: 'Open in browser' }).click()
  await scrollToTop(page.getByText('Context Browser', { exact: true }))
  await shoot(page, 'context-browser', [
    { target: page.getByRole('combobox', { name: 'the request to open' }), label: '1' },
    { target: page.getByText(/entered since request 8/), label: '2' },
    { target: page.getByText(new RegExp(`^model demo/${SECOND_MODEL}`)).first(), label: '3' },
    { target: page.getByText('File Activity', { exact: true }), label: '4' },
  ])
  // One element opened: the read of the config file, as the model received it.
  await page.locator('button[aria-expanded]').filter({ hasText: 'tool results' }).click()
  const element = page.locator('button[aria-pressed]').filter({ hasText: 'config.ts' }).first()
  await element.click()
  const toggle = page.getByRole('group', { name: 'show the text' })
  await toggle.waitFor()
  await shoot(page, 'context-browser-element', [
    { target: element, label: '1' },
    { target: toggle, label: '2' },
  ])
}

/** Where a mark's target is: by role and name, or by text it shows. The capture fails if neither resolves. */
function locate(page: Page, target: MarkTarget): Locator {
  if ('role' in target) return page.getByRole(target.role, { name: target.name }).first()
  return page.getByText(target.text, { exact: false }).first()
}

/** What a mark's `{shown}` is: the name a role target was found by, or the text a text target's element renders. */
async function shownBy(target: MarkTarget, located: Locator): Promise<string> {
  if ('role' in target) return target.name
  return (await located.innerText()).replaceAll(/\s+/g, ' ').trim()
}

/**
 * One feature from its spec (#482): each shot's `go` runs through a `FeatureUi` that records the
 * reader's steps, the marks are rung where the page renders them, the measured values are read,
 * and all of it is written to the feature's facts file for `feature-pages.ts` to build the page.
 */
async function captureFeature(page: Page, spec: FeatureSpec, threadId: string): Promise<void> {
  const shots: ShotFacts[] = []
  for (const shot of spec.shots) {
    const steps: string[] = []
    const ui: FeatureUi = {
      page,
      openThread: async () => {
        steps.push('open a thread from the rail')
        await openThread(page, threadId)
      },
      tab: async (name) => {
        steps.push(`choose the **${name}** tab at the top of the thread`)
        await tab(page, name)
      },
    }
    await shot.go(ui)
    const targets = shot.marks.map((mark) => locate(page, mark.target))
    const shown = await Promise.all(
      shot.marks.map((mark, markIndex) => shownBy(mark.target, targets[markIndex] as Locator)),
    )
    const measured: Record<string, string> = {}
    for (const [name, element] of Object.entries(shot.measure ?? {})) {
      measured[name] = (await element(page).innerText()).replaceAll(/\s+/g, ' ').trim()
      if (measured[name] === '') throw new Error(`feature-screenshots: ${spec.id} measured nothing for "${name}"`)
    }
    await shoot(
      page,
      shot.image,
      targets.map((target, markIndex) => ({ target, label: String(markIndex + 1) })),
    )
    shots.push({ image: shot.image, steps, shown, measured })
  }
  const facts: FeatureFacts = { feature: spec.id, shots }
  writeFileSync(join(ROOT, factsPath(spec.id)), `${JSON.stringify(facts, null, 2)}\n`)
  // In the repository's style, as `bun run format` writes it: a capture must not leave the format gate red.
  const formatted = spawnSync(process.execPath, ['--bun', 'oxfmt', factsPath(spec.id)], { cwd: ROOT, encoding: 'utf8' })
  if (formatted.status !== 0)
    throw new Error(`feature-screenshots: oxfmt refused ${factsPath(spec.id)}: ${formatted.stderr}`)
  process.stdout.write(`feature-screenshots: wrote ${factsPath(spec.id)}\n`)
}

async function stats(page: Page, threadId: string): Promise<void> {
  await captureFeature(page, STATS, threadId)
}

/** What changed since the last push (#452): pi's one edit, in the tree and side by side. */
async function changes(page: Page, threadId: string): Promise<void> {
  await openThread(page, threadId)
  await tab(page, 'Changes')
  const panel = page.locator('#thread-view-changes')
  await panel.getByText("required('DATABASE_URL')", { exact: false }).first().waitFor()
  await shoot(page, 'changes', [
    { target: panel.getByText('no remote to compare with', { exact: false }), label: '1' },
    { target: panel.getByRole('navigation', { name: 'changed files' }), label: '2' },
    { target: panel.getByRole('heading', { name: 'src/config.ts' }), label: '3' },
    { target: panel.getByText("required('DATABASE_URL')", { exact: false }).first(), label: '4' },
  ])
}

/** The session eval under the stats (#441): its scorecard, then its timeline. */
async function sessionEval(page: Page, threadId: string): Promise<void> {
  await openThread(page, threadId)
  await tab(page, 'Stats')
  const panel = page.getByRole('region', { name: 'session eval' })
  const title = panel.getByText('Session eval', { exact: true })
  await title.waitFor()
  await scrollToTop(title)
  await shoot(page, 'session-eval', [
    { target: title, label: '1' },
    { target: panel.getByText('corrections', { exact: true }), label: '2' },
    { target: panel.getByText('refusal channels', { exact: true }), label: '3' },
  ])
  const timeline = panel.getByText('Timeline', { exact: true })
  await scrollToTop(timeline)
  await shoot(
    page,
    'session-eval-timeline',
    [
      { target: timeline, label: '1' },
      { target: panel.getByText('f= typed against the run · r= clicked against it'), label: '2' },
    ],
    [timeline, panel.getByRole('list', { name: 'eval timeline' })],
  )
}

async function debugging(page: Page, threadId: string): Promise<void> {
  await page.goto(`${WEB}/?debug&thread=${threadId}`)
  await page.getByText('session debug').waitFor()
  await page.waitForTimeout(1200)
  await shoot(page, 'debug-drawer', [
    { target: page.getByText('session debug'), label: '1' },
    { target: page.getByRole('button', { name: 'download log bundle' }), label: '2' },
  ])
  await page.goto(`${WEB}/debug`)
  const header = page.getByText('enso · logs')
  await header.waitFor()
  await page.waitForTimeout(1500)
  await shoot(page, 'debug-log-tail', [
    { target: page.getByText('level', { exact: true }), label: '1' },
    { target: page.getByText(/download the day.s bundle/), label: '2' },
  ])
}

async function settings(page: Page, threadId: string): Promise<void> {
  await openThread(page, threadId)
  await page.getByRole('button', { name: 'settings' }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await dialog.getByText('Theme', { exact: true }).waitFor()
  await page.waitForTimeout(500)
  await shoot(page, 'settings', [
    { target: dialog.getByText('Theme', { exact: true }), label: '1' },
    { target: dialog.getByText('Body', { exact: true }), label: '2' },
    { target: dialog.getByText('kept in this browser'), label: '3' },
  ])
}

/** The prompt manager (#443), open on the library's append prompt: its size, and what the model receives with it. */
async function promptManager(page: Page, threadId: string): Promise<void> {
  await openThread(page, threadId)
  await page.getByRole('button', { name: 'prompts', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Prompts', exact: true })
  const list = dialog.getByRole('navigation', { name: 'prompts' })
  await list.getByText('Reviewer', { exact: true }).click()
  // pi renders the draft on the live thread; the breakdown is there once it has.
  const breakdown = dialog.getByRole('table', { name: 'what the model receives' })
  await breakdown.waitFor({ timeout: STEP_TIMEOUT_MS })
  await page.waitForTimeout(500)
  await shoot(page, 'prompts-manager', [
    { target: list.getByText('pi default', { exact: true }), label: '1' },
    { target: list.getByText('Append prompts', { exact: true }), label: '2' },
    { target: dialog.getByRole('button', { name: 'New', exact: true }), label: '3' },
    { target: dialog.getByRole('button', { name: 'Save', exact: true }), label: '4' },
    { target: dialog.getByLabel('prompt size'), label: '5' },
    { target: breakdown, label: '6' },
  ])
}

/**
 * Forks the thread at its third prompt, from the page, and takes the two lineage shots: the fork
 * in the rail with the prompt back in its composer, and the fork's manifest in the debug drawer.
 */
async function lineage(page: Page, threadId: string): Promise<void> {
  await openThread(page, threadId)
  const prompt = page.getByText(PROMPTS[2]).last()
  await scrollToTop(prompt)
  // The fork button under the third prompt: the third one on the page, prompts being in order.
  await page.getByText('fork from here').nth(2).click()
  // The source thread's pane stays mounted, hidden: the fork's composer is the visible one.
  const composer = page.getByPlaceholder('ask pi something').filter({ visible: true })
  await page.waitForURL((url) => url.searchParams.get('thread') !== threadId)
  await waitFor(async () => (await composer.inputValue()) === PROMPTS[2], "the fork's prompt in its composer")
  const rail = page.getByRole('navigation', { name: 'threads' })
  await shoot(page, 'lineage-fork', [
    { target: rail.getByText(/^forked from /).first(), label: '1' },
    { target: composer, label: '2' },
  ])
  const forkId = new URL(page.url()).searchParams.get('thread') ?? ''
  await page.goto(`${WEB}/?debug&thread=${forkId}`)
  const manifest = page.getByLabel('fork point')
  await manifest.waitFor()
  await scrollToTop(page.getByText('fork point', { exact: true }))
  await shoot(
    page,
    'lineage-fork-point',
    [
      { target: page.getByText('fork point', { exact: true }), label: '1' },
      { target: manifest.getByText('forked from', { exact: true }), label: '2' },
      { target: manifest.getByText('git', { exact: true }), label: '3' },
    ],
    [page.getByText('fork point', { exact: true }), manifest],
  )
}

async function coldThread(page: Page, threadId: string): Promise<void> {
  await openThread(page, threadId)
  const rail = page.getByRole('navigation', { name: 'threads' })
  await shoot(page, 'sessions-cold-thread', [
    { target: rail.getByText(DEMO_PROJECT, { exact: true }), label: '1' },
    { target: rail.getByText('Where does the app read').first(), label: '2' },
    { target: rail.getByText('Add project'), label: '3' },
    { target: page.getByText(/^model \(recorded\):/), label: '4' },
  ])
}

/** The shots of the finished thread while its session is still live, in order. */
const LIVE_SHOTS = [
  chat,
  guards,
  webAccess,
  permissionModes,
  context,
  contextBrowser,
  stats,
  sessionEval,
  changes,
  debugging,
  settings,
  promptManager,
  commandPalette,
  // ⚠ LAST of the live shots: it adds a second thread to the rail.
  lineage,
]

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

async function main(): Promise<void> {
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
  const stopModel = startFeatureModel(MODEL_PORT, FEATURE_SCRIPT, modelLog)
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
    const wanted = (name: string): boolean => ONLY === undefined || ONLY.includes(name)
    for (const shot of LIVE_SHOTS.filter((live) => wanted(live.name))) {
      await attempt(browser, shot.name, (page) => shot(page, threadId), failed)
    }

    if (wanted(coldThread.name)) {
      // A cold thread is one no session holds: restart the stack, and the thread is read off its file.
      await stopStack(stack)
      stack = startStack(home, project)
      await waitFor(async () => (await isListening(5178)) && (await isListening(5179)), 'the dev stack, again')
      await attempt(browser, coldThread.name, (page) => coldThread(page, threadId), failed)
    }
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
