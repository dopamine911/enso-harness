/**
 * The browser suite (#71, #486): drive the real chat surface in Chromium.
 *
 * Two tiers, split by cost:
 *   - default: model-free, run by hand before merging browser-surface work (in CI from #486 until
 *     #501; README.md). `/mode` is an extension command that raises a select dialog and completes
 *     without a model turn, so it exercises composer → server → pi → dialog park (#27) → answer →
 *     quick-close end to end for free; the seeded threads (`e2e-home.ts`) give long transcripts
 *     with no model at all.
 *   - `@model`: one real model turn. Costs tokens and needs a working provider identity
 *     (`.enso/pi-agent`); run by hand with `bun run e2e:model` (see README.md).
 *
 * What belongs here is what the unit DOM cannot hold: happy-dom does no layout and fires no
 * focus return, so focus, scroll and the off-screen panes are proven only in a browser. Logic
 * and folds stay in `bun test`. The chat-surface tests also leave screenshots for a PR under
 * OUTPUT_DIRECTORY/screenshots, under fixed names (README.md).
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from '@playwright/test'
import { e2eHome, SEEDED_TITLES, SEEDED_TURNS } from './e2e-home.ts'
import { OUTPUT_DIRECTORY, WEB_ORIGIN } from './playwright.config.ts'
import {
  markThreadStatus,
  recordThreadStatus,
  waitForQuestion,
  waitForRunToEnd,
  waitForRunToStart,
  waitForShownThread,
} from './thread-status.ts'

// Every test listens for the page's `enso:thread-status` from its first script on (#737,
// `thread-status.ts`): a wait for a run to end or a card to come up returns on the event.
test.beforeEach(async ({ page }) => {
  await recordThreadStatus(page)
})

const SCREENSHOT_DIRECTORY = join(OUTPUT_DIRECTORY, 'screenshots')

/** Composer markup from src/composer.tsx — the accessible names ARE the contract. */
const COMPOSER_PLACEHOLDER = 'ask pi something'
const SEND_BUTTON_NAME = 'send message'
/**
 * ⚠ `src/composer.tsx`'s own `aria-label` for the stop control. This read
 * `stop the current response` from before #116 renamed it, so the `@model` test's proof that a
 * run started matched nothing at all. `src/__tests__/thread-pane.test.tsx` reads these three
 * constants out of this file and looks for them in the rendered markup, so drift on either
 * side now fails `bun run check` rather than a manual run of this spec.
 */
const STOP_BUTTON_NAME = 'stop the run'

/**
 * `/mode` is Enso's permission-modes select ("Select permission mode:"); this label is one of
 * its options (#496).
 *
 * ⚠ Side-effect check: the chosen mode is recorded with `pi.appendEntry("active_agent", …)` into
 * the RUN'S OWN pi session file, never into `settings.json` or the policy file. Every web run is
 * a fresh session, so answering "Accept edits" here cannot flip the TUI's mode. It does leave one
 * session JSONL per run under the home's `pi-agent/sessions/`, like any other run.
 */
const MODE_COMMAND = '/mode'
const MODE_OPTION_LABEL = /accept edits/i
/** The card's title as the status bar announces it (#737): the select's own prompt, from `permission-modes`. */
const MODE_QUESTION_TITLE = /select permission mode/i
/** The line Enso's mode-lines store shows once the host reports the new mode — the observable that the answer landed. */
const MODE_ANSWERED_STATUS = /Mode: acceptEdits/

/** A real 1×1 PNG (signature, IHDR, IDAT, IEND) — the smallest file a decoder accepts; what the paste test puts on the clipboard. */
const ONE_PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

/** Same prompt the TUI receipt uses — cheap, and the answer shape is checkable by eye. */
const MODEL_PROMPT = 'Reply with exactly three words.'

/**
 * How long a run may take to settle. ⚠ Not `expect`'s 5 s default: a real model turn outlives it.
 * Measured 2026-09-23 on claude-sonnet-4-5 with thinking: 2.2–3.8 s to the first delta, settled
 * 4.3–4.4 s after acquisition, and the browser sees the run open ~1 s after the server — so the
 * `@model` test failed 2 of 3 runs on turns that completed. A model-free run settles in well under
 * a second either way. The bound of the wait's step, so a run that never ends fails by name.
 */
const RUN_SETTLE_TIMEOUT_MS = 60_000

/**
 * Wait for the run started after `mark` to end: the shown pane's status bar announces `idle`
 * (#737, `waitForRunToEnd`), not a word or control sampled until it flips.
 *
 * ⚠ The stop control's absence is then the receipt, not the wait: the bar announces after the
 * commit, so the composer already says the same, and a check on it holds the composer to the
 * event. Stop, NOT send: send is rendered unconditionally (disabled when there is nothing to
 * send), so a reading of it held at every moment including mid-run (#277,
 * `test/e2e-selectors.test.ts` pins this body to STOP_BUTTON_NAME).
 */
async function waitForRunToSettle(page: Page, mark: number): Promise<void> {
  const ended = await test.step('the thread announces its run ended', () => waitForRunToEnd(page, mark), {
    timeout: RUN_SETTLE_TIMEOUT_MS,
  })
  expect(ended.status).toBe('idle')
  await expect(page.getByRole('button', { name: STOP_BUTTON_NAME })).toHaveCount(0)
}

/**
 * The composer on screen. ⚠ Not the placeholder alone: the Start dialog's prompt box has the same
 * one, and every off-screen pane keeps its own composer, `inert` and invisible (#472).
 */
function composer(page: Page): ReturnType<Page['getByPlaceholder']> {
  return page.getByPlaceholder(COMPOSER_PLACEHOLDER).filter({ visible: true })
}

/** The permission-mode select on screen — what a resumed thread's persisted mode shows on (#142). */
function modeControl(page: Page): ReturnType<Page['getByRole']> {
  return page.getByRole('combobox', { name: 'permission mode' }).filter({ visible: true })
}

/**
 * A new thread opens the Start dialog (#395). These tests drive the composer instead, so they put
 * it away: Escape closes it, and the composer stays as it is (`start-session.tsx`).
 */
async function dismissStartDialog(page: Page): Promise<void> {
  const dialog = page.getByRole('dialog', { name: 'Start a session' })
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
}

/** A new thread, with the Start dialog put away: what the model-free tests start from. */
async function openNewThread(page: Page): Promise<void> {
  await page.goto('/')
  await dismissStartDialog(page)
  await expect(composer(page)).toBeVisible()
}

/**
 * Build the thread's session with no model, by choosing `mode` in the composer's select (#604).
 *
 * ⚠ A slash command needs a running session since #484 ("a page visit builds no session"): `/mode`
 * sent in a thread that has none comes back to the composer with the Start dialog's sentence, and
 * the `/` palette lists no rows. The select is a control route (`POST …/mode`) that acquires the
 * thread — a fresh one, or a stored one cold off its file — so this builds it without a prompt
 * reaching a provider (the seeded home's `demo` points at a port nothing listens on). The `Mode:`
 * line is the host's receipt: the session is live and in that mode.
 */
async function chooseMode(page: Page, mode: string): Promise<void> {
  await modeControl(page).selectOption(mode)
  await expect(page.getByText(`Mode: ${mode}`)).toBeVisible()
}

async function typeAndSend(page: Page, message: string): Promise<void> {
  await composer(page).fill(message)
  await composer(page).press('Enter')
}

/**
 * Full-page PNG under a stable name (README.md lists them), also attached to the test so a
 * trace or HTML report links it. No console echo: the lint gate's `no-console` applies here and the
 * names are fixed, so a reader knows the path without a log line.
 */
async function captureScreenshot(page: Page, fileName: string): Promise<void> {
  mkdirSync(SCREENSHOT_DIRECTORY, { recursive: true })
  const screenshotPath = join(SCREENSHOT_DIRECTORY, `${fileName}.png`)
  await page.screenshot({ path: screenshotPath, fullPage: true })
  await test.info().attach(fileName, { path: screenshotPath, contentType: 'image/png' })
}

test.describe('chat surface', () => {
  test('empty state, /mode dialog, answer, settle (model-free)', async ({ page }) => {
    await openNewThread(page)
    await captureScreenshot(page, '01-empty-state')
    // The `/` palette (#338) is in the composer and opens to its filter box; Escape puts it away.
    await page.getByRole('button', { name: 'commands' }).click()
    await expect(page.getByPlaceholder('filter commands…')).toBeVisible()
    await page.keyboard.press('Escape')

    // Before a session, `/mode` is refused (#484): nothing is built, and the words go back to the
    // composer. The refusal's sentence is pinned in `start-session.test.tsx`; this holds that the
    // composer gets the words BACK through the real server — so it waits for the commands lookup the
    // send makes, after which the draft was cleared and restored (the value before it proves nothing).
    // A REQUEST issued from here on: the palette above fetched the same route, and its response may
    // still be arriving.
    const lookup = page.waitForRequest((request) =>
      /\/api\/threads\/[^/]+\/commands$/.test(new URL(request.url()).pathname),
    )
    await typeAndSend(page, MODE_COMMAND)
    expect((await (await lookup).response())?.ok()).toBe(true)
    await expect(composer(page)).toHaveValue(MODE_COMMAND)
    await expect(page.getByRole('button', { name: MODE_OPTION_LABEL })).toHaveCount(0)

    // A session built with no model; the same words, sent again, now reach pi.
    await chooseMode(page, 'plan')
    const beforeSend = await markThreadStatus(page)
    await composer(page).press('Enter')
    // The dialog parks the run (#27): the bar announces the card once it is rendered, titled by
    // the select's own words; its option buttons are then on screen to click.
    const card = await test.step('the thread announces the mode card', () => waitForQuestion(page, beforeSend))
    expect(card.question?.title).toMatch(MODE_QUESTION_TITLE)
    const modeOption = page.getByRole('button', { name: MODE_OPTION_LABEL })
    await captureScreenshot(page, '02-mode-dialog')

    const beforeAnswer = await markThreadStatus(page)
    await modeOption.click()
    await waitForRunToSettle(page, beforeAnswer)
    // The answer's receipt is the `Mode:` line the browser shows from the host's `permission-mode`, not assistant text — an
    // extension command produces no model turn, so the assistant container stays empty
    // (and Playwright reads an empty block as hidden; receipt: first run of this spec).
    await expect(page.getByText(MODE_ANSWERED_STATUS)).toBeVisible()
    await captureScreenshot(page, '03-mode-answered')
  })

  // #407: the fonts are not in the bundle — `dev-web.ts` mounts `/fonts/*` (`server/font-files.ts`)
  // and the page links the @fontsource stylesheets at boot. The unit tests cover the route and the
  // links apart; this is the wiring between them: a stylesheet answers 200 through the real server,
  // and the default theme's body face (Enso Signal: Inter) actually loads from the file it names.
  test('the fonts load from /fonts through the web server (model-free)', async ({ page }) => {
    const fontStylesheet = page.waitForResponse(
      (response) => response.url().includes('/fonts/@fontsource-variable/inter/') && response.url().endsWith('.css'),
    )
    await openNewThread(page)
    expect((await fontStylesheet).status()).toBe(200)
    const loadedFaces = await page.evaluate(async () =>
      (await document.fonts.load('1em "Inter Variable"')).map((face) => face.family),
    )
    expect(loadedFaces).toContain('Inter Variable')
  })

  test('paste an image: thumbnail, send enabled, the bytes on the wire as EnsoPromptImage (model-free)', async ({
    page,
  }) => {
    // The prompt route is answered here, not by pi: this pins the browser's half of #68 — paste
    // → attachment → `data:` URL → `images: [{mimeType, data}]` on the POST — without a model turn.
    const posted: Array<{ message: string; images?: Array<{ mimeType: string; data: string }> }> = []
    await page.route('**/api/threads/*/prompt', async (route) => {
      posted.push(route.request().postDataJSON())
      await route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({ threadId: 't', messageId: 'm1', generation: 1, queued: false }),
      })
    })
    await openNewThread(page)
    await expect(page.getByRole('button', { name: SEND_BUTTON_NAME })).toBeDisabled()

    // Ctrl+V with a PNG on the clipboard, as the browser delivers it: a `paste` whose data is a file.
    await composer(page).focus()
    await page.evaluate((base64) => {
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))
      const transfer = new DataTransfer()
      transfer.items.add(new File([bytes], 'pixel.png', { type: 'image/png' }))
      document
        .querySelector('textarea[name="message"]:not([inert] *)')
        ?.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }))
    }, ONE_PIXEL_PNG)
    const strip = page.getByLabel('attached images')
    await expect(strip.getByRole('img')).toHaveCount(1)
    // An image with no words is a prompt: send is offered on the attachment alone.
    await expect(page.getByRole('button', { name: SEND_BUTTON_NAME })).toBeEnabled()
    await captureScreenshot(page, '06-image-attached')

    await typeAndSend(page, 'what does this say?')
    await expect(strip).toHaveCount(0)
    await expect.poll(() => posted.length).toBe(1)
    expect(posted[0]?.message).toBe('what does this say?')
    expect(posted[0]?.images).toEqual([{ mimeType: 'image/png', data: ONE_PIXEL_PNG }])
    // The user's own image is in the transcript, as inline bytes.
    await expect(page.locator('img[alt="attached by the user"]')).toHaveCount(1)
    await captureScreenshot(page, '07-image-sent')
  })

  // @pins resume/url-names-thread resume/opening-mode
  test('the URL names the thread (#142): reload keeps it, back/forward walk threads, a pasted link opens cold, a bad id says so', async ({
    page,
  }) => {
    // A fresh page writes its thread's id to the URL at once.
    await openNewThread(page)
    await expect(page).toHaveURL(/\?thread=[0-9a-f-]{36}$/)
    const first = new URL(page.url()).searchParams.get('thread') ?? ''

    // A thread to come back to: choosing a mode builds its session on the server (no model, #484).
    await chooseMode(page, 'acceptEdits')

    // Reload: the same thread with its persisted mode — not a fresh one (the #68 check that
    // failed). The mode CONTROL is the receipt: the "Mode: acceptEdits" line was a live notice.
    await page.reload()
    await expect(page).toHaveURL(new RegExp(`\\?thread=${first}$`))
    await expect(modeControl(page)).toHaveValue('acceptEdits')
    await expect(page.locator("[aria-current='true']")).toHaveCount(1)
    await captureScreenshot(page, '08-thread-reloaded')

    // New Thread pushes; back returns to the first thread; forward to the second.
    await page.getByRole('button', { name: 'New Thread', exact: true }).click()
    await dismissStartDialog(page)
    await expect(page).not.toHaveURL(new RegExp(`thread=${first}$`))
    const second = new URL(page.url()).searchParams.get('thread') ?? ''
    expect(second).not.toBe(first)
    await expect(modeControl(page)).toHaveValue('default')
    await page.goBack()
    await expect(page).toHaveURL(new RegExp(`thread=${first}$`))
    await expect(modeControl(page)).toHaveValue('acceptEdits')
    await page.goForward()
    await expect(page).toHaveURL(new RegExp(`thread=${second}$`))
    await expect(modeControl(page)).toHaveValue('default')

    // A pasted link on a fresh page opens that thread cold — no page state.
    await page.goto(`/?thread=${first}`)
    await expect(modeControl(page)).toHaveValue('acceptEdits')

    // A URL that cannot name a thread: a new session, and the rail says why.
    await page.goto('/?thread=not%20a%20thread')
    // The fallback is a new thread, so its Start dialog opens, modal, over the rail's notice.
    await dismissStartDialog(page)
    await expect(page.getByRole('alert')).toContainText('is not a thread id')
    await expect(page).toHaveURL(/\?thread=[0-9a-f-]{36}$/)
    await expect(composer(page)).toBeVisible()
    await captureScreenshot(page, '09-thread-bad-id')
  })

  // @pins resume/url-names-thread
  test('⚠ New Thread during a slow boot resume wins outright: URL and pane agree, the late history is dropped (PR #143 review)', async ({
    page,
  }) => {
    // A thread to come back to, with a mode that tells it apart from a fresh one.
    await openNewThread(page)
    const first = new URL(page.url()).searchParams.get('thread') ?? ''
    await chooseMode(page, 'acceptEdits')
    await expect(modeControl(page)).toHaveValue('acceptEdits')

    // The boot's /history is slow; the user does not wait.
    await page.route('**/api/threads/*/history', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500))
      await route.continue()
    })
    await page.goto(`/?thread=${first}`)
    await expect(page.getByText('resuming…')).toBeVisible()
    await page.getByRole('button', { name: 'New Thread', exact: true }).click()
    await dismissStartDialog(page)
    const fresh = new URL(page.url()).searchParams.get('thread') ?? ''
    expect(fresh).not.toBe(first)
    await expect(modeControl(page)).toHaveValue('default')

    // The late answer for `first` arrives — and changes nothing: URL, current row, and mode
    // all still say the fresh thread. (Pre-fix: the pane flipped to `first` under a URL naming `fresh`.)
    await page.waitForTimeout(2000)
    await expect(page).toHaveURL(new RegExp(`thread=${fresh}$`))
    await expect(modeControl(page)).toHaveValue('default')
    await expect(page.locator("[aria-current='true']")).toHaveCount(1)
    await expect(page.getByText(/resuming/)).toHaveCount(0)
    await page.unroute('**/api/threads/*/history')
  })

  test('one real model turn @model', async ({ page }) => {
    await openNewThread(page)
    const beforeSend = await markThreadStatus(page)
    await typeAndSend(page, MODEL_PROMPT)
    // The bar's `running` proves the request reached the server and a run is in flight.
    await test.step('the thread announces its run started', () => waitForRunToStart(page, beforeSend), {
      timeout: RUN_SETTLE_TIMEOUT_MS,
    })
    await captureScreenshot(page, '04-model-streaming')

    await waitForRunToSettle(page, beforeSend)
    const assistantMessage = page.locator('[data-role="assistant"]').last()
    await expect(assistantMessage).toBeVisible()
    await expect(assistantMessage).not.toBeEmpty()
    await captureScreenshot(page, '05-model-settled')
  })
})

// ── Held only in a real browser (#486): focus, layout and the boot path, over seeded threads ──
// happy-dom does no layout and fires no focus-return event, so each of these was verified by hand
// once and held by nothing after. The threads are stored in the run's own home (`e2e-home.ts`).

const SEEDED = e2eHome().threads

/** The threads rail, by its accessible name. */
function rail(page: Page): ReturnType<Page['getByRole']> {
  return page.getByRole('navigation', { name: 'threads' })
}

/**
 * Open a seeded thread from the rail, the way a reader switches: the switch has landed when the
 * thread's bar announces it is the shown pane (#737), and its transcript has a turn drawn.
 *
 * ⚠ ANY turn, not the last one: the transcript is windowed (#739), so a thread the reader left
 * scrolled up draws only the rows around their place, and the last turn is not in the page.
 */
async function switchTo(page: Page, thread: 'first' | 'second'): Promise<void> {
  const title = SEEDED_TITLES[thread]
  const beforeClick = await markThreadStatus(page)
  await rail(page).getByText(title, { exact: true }).click()
  await test.step(`the ${thread} seeded thread announces it is shown`, () =>
    waitForShownThread(page, beforeClick, SEEDED[thread]))
  await expect(page.getByRole('log').filter({ visible: true }).getByText(`${title}, turn `).first()).toBeVisible()
}

/** The shown pane's transcript scroller: the `role="log"` root's scrolling child, outside every inert pane. */
async function transcriptScroll(page: Page): Promise<{ top: number; bottomGap: number }> {
  return page.evaluate(() => {
    const log = [...document.querySelectorAll<HTMLElement>('[role="log"]')].find(
      (candidate) => candidate.closest('[inert]') === null,
    )
    const scroller = [...(log?.children ?? [])].find(
      (child): child is HTMLElement => child instanceof HTMLElement && child.scrollHeight > child.clientHeight,
    )
    if (scroller === undefined) throw new Error('the shown transcript has no scroller')
    return { top: scroller.scrollTop, bottomGap: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight }
  })
}

/** Is focus in the shown pane's composer, not on `<body>` or in a pane off screen? */
function focusIsInTheComposer(page: Page): Promise<boolean> {
  return page.evaluate((placeholder) => {
    const focused = document.activeElement
    return (
      focused instanceof HTMLTextAreaElement &&
      focused.placeholder === placeholder &&
      focused.closest('[inert]') === null &&
      focused.closest('[role="dialog"]') === null
    )
  }, COMPOSER_PLACEHOLDER)
}

test.describe('seeded threads (#486)', () => {
  // #367 (#471): the palette hands focus off before either dialog opens, so Radix's own return
  // target is nothing; both dialogs put it back in the composer from `onCloseAutoFocus`.
  test('⚠ Escape on /model or /context from the palette puts focus back in the composer (#367)', async ({ page }) => {
    await page.goto(`/?thread=${SEEDED.first}`)
    await expect(composer(page)).toBeVisible()
    // The palette lists a thread's commands only once it has a session (#484); a seeded thread
    // opens cold, so one is built first, with no model.
    await chooseMode(page, 'plan')
    for (const [command, dialogName] of [
      ['model', /model/i],
      ['context', /context/i],
    ] as const) {
      await page.getByRole('button', { name: 'commands' }).filter({ visible: true }).click()
      await page.getByPlaceholder('filter commands…').fill(command)
      // Clicked once listed, not Enter: the rows come from the server, and an Enter before they
      // arrive chooses nothing.
      await page.getByRole('option', { name: new RegExp(`^/${command}\\b`) }).click()
      const dialog = page.getByRole('dialog', { name: dialogName })
      await expect(dialog).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
      await expect.poll(() => focusIsInTheComposer(page), { message: `focus after /${command}` }).toBe(true)
    }
  })

  // #370 (#472): an off-screen pane stays laid out, so a reader who scrolled up finds the same place.
  test("⚠ switching threads keeps a scrolled-up reader's place, and a thread at the bottom stays at the bottom (#370)", async ({
    page,
  }) => {
    await page.goto(`/?thread=${SEEDED.first}`)
    await expect(page.getByText(`${SEEDED_TITLES.first}, turn ${SEEDED_TURNS}, paragraph 6`)).toBeVisible()
    await switchTo(page, 'second')
    // A thread opens at its bottom; the scroll there is smooth, so this waits for it to arrive.
    await expect.poll(async () => (await transcriptScroll(page)).bottomGap).toBeLessThanOrEqual(2)
    await switchTo(page, 'first')
    // Scroll up in the first, as a reader does: the wheel over the transcript.
    const transcript = page.getByRole('log').filter({ visible: true })
    await transcript.hover()
    await page.mouse.wheel(0, -2400)
    await expect.poll(async () => (await transcriptScroll(page)).bottomGap).toBeGreaterThan(1000)
    const scrolledTo = (await transcriptScroll(page)).top

    await switchTo(page, 'second')
    // The second was left at its bottom, and is still there.
    expect((await transcriptScroll(page)).bottomGap).toBeLessThanOrEqual(2)
    await switchTo(page, 'first')
    expect((await transcriptScroll(page)).top).toBe(scrolledTo)
  })

  // #472: every pane but the shown one is laid out invisibly, skipped by style and layout, and
  // unreachable by pointer and focus.
  test("⚠ every off-screen pane is inert and content-visibility: hidden, and a point on the transcript is the shown pane's (#472)", async ({
    page,
  }) => {
    await page.goto(`/?thread=${SEEDED.first}`)
    await switchTo(page, 'second')
    await switchTo(page, 'first')
    const panes = await page.evaluate(() => {
      // One status bar per pane: the pane is the bar's outermost positioned wrapper.
      const bars = [...document.querySelectorAll<HTMLElement>('footer[aria-label="thread status"]')]
      return bars.map((bar) => {
        const inertPane = bar.closest<HTMLElement>('[inert]')
        return inertPane === null
          ? { shown: true }
          : { shown: false, visibility: getComputedStyle(inertPane).contentVisibility }
      })
    })
    expect(panes.length).toBeGreaterThanOrEqual(2)
    expect(panes.filter((pane) => pane.shown)).toHaveLength(1)
    for (const pane of panes.filter((candidate) => !candidate.shown))
      expect(pane).toEqual({ shown: false, visibility: 'hidden' })

    const box = await page.getByRole('log').filter({ visible: true }).boundingBox()
    if (box === null) throw new Error('the shown transcript has no box')
    const hit = await page.evaluate(
      ({ left, top }) => {
        const element = document.elementFromPoint(left, top)
        return {
          inInertPane: element?.closest('[inert]') !== null,
          inShownLog: element?.closest('[role="log"]') !== null,
        }
      },
      { left: box.x + box.width / 2, top: box.y + box.height / 2 },
    )
    expect(hit).toEqual({ inInertPane: false, inShownLog: true })
  })

  // #378 (#478): the URL's own unused id is started, not reported; a thread the server refuses is said.
  test('⚠ a URL naming an unused thread id starts that thread with no alert; one outside the projects is refused by name (#378)', async ({
    page,
  }) => {
    const unused = randomUUID()
    await page.goto(`/?thread=${unused}`)
    await expect(page.getByRole('dialog', { name: 'Start a session' })).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`\\?thread=${unused}$`))
    // `role=alert` by CSS: the modal dialog hides the rail from an accessibility-tree query.
    await expect(page.locator('[role="alert"]')).toHaveCount(0)

    await page.goto(`/?thread=${SEEDED.outside}`)
    await expect(page.locator('[role="alert"]').filter({ hasText: 'could not open the thread:' })).toHaveCount(1)
  })

  // #679: the Start dialog grew with its prompt until Start session was below the window, and the
  // dialog could not scroll, so a click on it timed out. A prompt far past the box's cap, in the
  // window the arena found it in and in a small one.
  test('⚠ a long prompt leaves the Start dialog in the window and Start session clickable, at 1440×900 and in a small window (#679)', async ({
    page,
  }) => {
    const longPrompt = Array.from(
      { length: 14 },
      (_unused, line) =>
        `Line ${line + 1}: build and test a polished playable browser Snake game with neon arcade design and five features.`,
    ).join('\n')
    for (const size of [
      { width: 1440, height: 900 },
      { width: 800, height: 480 },
    ]) {
      await page.setViewportSize(size)
      await page.goto('/')
      const dialog = page.getByRole('dialog', { name: 'Start a session' })
      const prompt = dialog.locator('#start-session-prompt')
      await prompt.fill(longPrompt)
      // The box stopped growing and scrolls inside itself.
      expect(await prompt.evaluate((field) => field.scrollHeight > field.clientHeight), `${size.height}px`).toBe(true)
      // Not clipped at the top either: the dialog starts inside the window.
      expect((await dialog.boundingBox())?.y, `${size.height}px`).toBeGreaterThanOrEqual(0)
      // In the window as it stands: unlike a click, `toBeInViewport` scrolls nothing into view.
      const start = dialog.getByRole('button', { name: 'Start session' })
      await expect(start).toBeInViewport({ ratio: 1 })
      // Nothing over it: a trial click runs the actionability checks, the hit test included, and
      // sends nothing, so no session is started against the refused `demo` provider.
      await start.click({ trial: true })
    }
  })

  // #713, from two arena runs: in a sandbox under Enso's origin, a built page had no `localStorage`
  // and its root-relative `/app.mjs` missed, so it showed broken. Each thread's preview is an origin
  // of its own now: the page runs as it would anywhere, and still cannot reach Enso (#717).
  test('⚠ a preview page runs on its own origin — a root-relative module, localStorage — and still cannot reach Enso (#713)', async ({
    page,
  }) => {
    const errors: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text())
    })
    const listing = (await (await page.request.get(`/api/threads/${SEEDED.modules}/tree`)).json()) as {
      readonly previewOrigin?: string
    }
    const previewOrigin = listing.previewOrigin ?? 'no origin'
    expect(previewOrigin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    await page.goto(`${previewOrigin}/index.html`)
    await expect(page.locator('#status')).toHaveText('both modules ran, best 12')
    expect(errors).toEqual([])

    // Its origin is its own, its files are its to read, and a request it sends Enso's control plane
    // to escalate a fresh thread builds nothing: the server refuses another origin (#717).
    const freshThread = randomUUID()
    const reached = await page.evaluate(
      async ({ ensoOrigin, threadId }) => {
        const ownFile = await fetch('/app.mjs').then(
          (response) => `read ${response.status}`,
          () => 'refused',
        )
        await fetch(`${ensoOrigin}/api/threads/${threadId}/mode`, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: JSON.stringify({ mode: 'bypassPermissions' }),
        }).catch(() => undefined)
        return { origin: window.origin, ownFile }
      },
      { ensoOrigin: WEB_ORIGIN, threadId: freshThread },
    )
    expect(reached).toEqual({ origin: previewOrigin, ownFile: 'read 200' })
    expect((await page.request.get(`/api/threads/${freshThread}`)).status()).toBe(404)
  })
})
