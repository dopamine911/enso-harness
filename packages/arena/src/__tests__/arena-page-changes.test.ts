import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type BrowserContext, chromium, type Page } from '@playwright/test'
import { type ArenaPageWait, pageForChange, waitForChange } from '../actions.ts'
import { type ArenaPageLook, createPageLook, PAGE_CHANGES_SCRIPT, readPageMark } from '../page-changes.ts'

/**
 * A wait until change that looks at the page only when the page says it changed (#740): the
 * page-side count, the recorder's look kept against it, and a wait on a real Chromium page. The
 * browser tests need Playwright's Chromium (`bunx playwright install chromium`) and are skipped
 * where it is not installed. They run on the browser's own clock, on purpose: the wait sleeps in the
 * page and the page's changes are the page's own timers, which no fake clock in this process reaches.
 */

const hasChromium = existsSync(chromium.executablePath())
const ORIGIN = 'http://arena.test'
/** Enso's shape where it matters: the rail with a thread's age, and the page's own words beside it. */
const PAGE = `<!doctype html>
<nav aria-label="threads"><button>Write notes.md <span id="age">6s</span></button></nav>
<main>
  <button id="snooze">Snooze 1h</button>
  <label>Prompt <input id="prompt"></label>
  <p id="chat">Working…</p>
</main>`
const POLL_MS = 100
const BROWSER_TEST_MS = 20_000

interface OpenPage {
  readonly page: Page
  readonly context: BrowserContext
  readonly look: ArenaPageLook
  /** How many accessibility snapshots the look has taken. */
  readonly snapshots: () => number
  /** Where the context's trace is written as it records. */
  readonly traces: string
}

/** The page under a traced context with the counting script, as the recorder opens Enso. */
async function withPage(recheckMs: number, check: (open: OpenPage) => Promise<void>): Promise<void> {
  const traces = mkdtempSync(join(tmpdir(), 'arena-page-changes-'))
  const browser = await chromium.launch({ tracesDir: traces })
  try {
    const context = await browser.newContext()
    await context.tracing.start({ screenshots: false, snapshots: true })
    await context.tracing.startChunk()
    await context.addInitScript(PAGE_CHANGES_SCRIPT)
    await context.route(`${ORIGIN}/**`, (route) => route.fulfill({ contentType: 'text/html', body: PAGE }))
    const page = await context.newPage()
    await page.goto(ORIGIN)
    const devtools = await context.newCDPSession(page)
    let snapshots = 0
    const look = createPageLook({
      look: async () => {
        snapshots += 1
        return pageForChange(await page.locator('body').ariaSnapshot())
      },
      mark: () => readPageMark(devtools, POLL_MS * 10),
      recheckMs,
    })
    await check({ page, context, look, snapshots: () => snapshots, traces })
  } finally {
    await browser.close()
    rmSync(traces, { recursive: true, force: true })
  }
}

function waitOn(open: OpenPage, baseline: string, ms: number): Promise<ArenaPageWait> {
  return waitForChange({
    baseline,
    look: open.look.current,
    sleep: (pause) => open.page.waitForTimeout(pause),
    ms,
    pollMs: POLL_MS,
  })
}

/** How many calls of `method` the trace recorded so far: each one is a line, or two, of a chunk. */
function tracedCalls(traces: string, method: string): number {
  const lines = readdirSync(traces)
    .filter((name) => name.endsWith('.trace'))
    .flatMap((name) => readFileSync(join(traces, name), 'utf8').split('\n'))
  return lines.filter((line) => line.includes('"type":"before"') && line.includes(`"method":"${method}"`)).length
}

test.skipIf(!hasChromium)(
  '⚠ a still page is not looked at again, and its count is read off the trace; a change in the DOM ends the next wait',
  async () => {
    await withPage(60_000, async (open) => {
      const baseline = await open.look.now()
      expect(await waitOn(open, baseline, 6 * POLL_MS)).toMatchObject({ changed: false })
      expect(open.snapshots()).toBe(1)
      // The six count reads put nothing in the trace; the one look is its one snapshot.
      await open.context.tracing.stopChunk()
      expect(tracedCalls(open.traces, 'ariaSnapshot')).toBe(1)
      expect(tracedCalls(open.traces, 'evaluateExpression')).toBe(0)

      const done = `setTimeout(() => { document.getElementById('chat').textContent = 'Done.' }, ${3 * POLL_MS})`
      await open.page.evaluate(done)
      expect(await waitOn(open, baseline, 50 * POLL_MS)).toMatchObject({ changed: true })
      expect(open.snapshots()).toBe(2)
    })
  },
  BROWSER_TEST_MS,
)

test.skipIf(!hasChromium)(
  "⚠ the rail's ages ticking move no wait and take no look; the same words outside the rail, or the rail's own words, do",
  async () => {
    await withPage(60_000, async (open) => {
      const baseline = await open.look.now()
      // Enso's clock as React writes it: the age's text node, rewritten in place.
      await open.page.evaluate(`{
        const age = document.getElementById('age').firstChild
        const ages = ['7s', '12s', '1m', 'now']
        let tick = 0
        setInterval(() => { age.data = ages[tick++ % ages.length] }, ${POLL_MS / 2})
      }`)
      expect(await waitOn(open, baseline, 6 * POLL_MS)).toMatchObject({ changed: false })
      expect(open.snapshots()).toBe(1)

      await open.page.evaluate(`document.getElementById('snooze').firstChild.data = 'Snooze 2h'`)
      expect(await waitOn(open, baseline, 50 * POLL_MS)).toMatchObject({ changed: true })
      const snoozed = await open.look.now()
      await open.page.evaluate(`document.querySelector('nav button').firstChild.data = 'Write tests.md '`)
      expect(await waitOn(open, snoozed, 50 * POLL_MS)).toMatchObject({ changed: true })
    })
  },
  BROWSER_TEST_MS,
)

test.skipIf(!hasChromium)(
  "⚠ what the DOM does not show — a field's value set by a script — is seen at the recheck, not missed",
  async () => {
    const recheckMs = 4 * POLL_MS
    await withPage(recheckMs, async (open) => {
      const lookedAt = Date.now()
      const baseline = await open.look.now()
      await open.page.evaluate(`document.getElementById('prompt').value = 'typed by a script'`)
      expect(await waitOn(open, baseline, 50 * POLL_MS)).toMatchObject({ changed: true })
      expect(Date.now() - lookedAt).toBeGreaterThanOrEqual(recheckMs)
    })
  },
  BROWSER_TEST_MS,
)

test.skipIf(!hasChromium)(
  'a new document is looked at, whatever its count',
  async () => {
    await withPage(60_000, async (open) => {
      await open.look.now()
      await open.page.reload()
      await open.look.current()
      await open.look.current()
      expect(open.snapshots()).toBe(2)
    })
  },
  BROWSER_TEST_MS,
)

test('⚠ the last look stands while the mark holds, until the recheck; an unread mark is a look', async () => {
  let page = 'the page'
  let mark: string | undefined = 'held'
  let snapshots = 0
  let clock = 0
  const look = createPageLook({
    look: () => {
      snapshots += 1
      return Promise.resolve(page)
    },
    mark: () => Promise.resolve(mark),
    recheckMs: 1000,
    now: () => clock,
  })
  await look.now()
  page = 'what the DOM does not show'
  clock = 999
  expect(await look.current()).toBe('the page')
  clock = 1000
  expect(await look.current()).toBe('what the DOM does not show')
  expect(snapshots).toBe(2)
  mark = undefined
  await look.current()
  await look.current()
  expect(snapshots).toBe(4)
})

test('⚠ the mark is read before the look: a change while the page is being read is looked at again', async () => {
  let changes = 0
  const look = createPageLook({
    look: () => {
      changes += 1 // the page moves while it is being read
      return Promise.resolve(`look ${changes}`)
    },
    mark: () => Promise.resolve(String(changes)),
    recheckMs: 60_000,
    now: () => 0,
  })
  expect(await look.now()).toBe('look 1')
  expect(await look.current()).toBe('look 2')
})
