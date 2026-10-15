import type { Locator, Page } from '@playwright/test'
import { FIRST_MODEL, SECOND_MODEL } from '../feature-session.ts'
import type { FeatureSpec } from './spec.ts'

/** A Trend bar: its accessible name is `request <n>, prompt <p>, <figure>[, compaction]` (`thread-context.tsx#TrendPlot`). */
const TREND_BAR = /^request (\d+), prompt /

/**
 * Pick `bar` in Trend and wait for the card under the chart to show its request: the card's
 * heading, `Request <n>`, is what a measure reads the request by.
 */
async function pickBar(page: Page, bar: Locator): Promise<Locator> {
  const request = TREND_BAR.exec((await bar.getAttribute('aria-label')) ?? '')?.[1]
  if (request === undefined) throw new Error('context: a Trend bar names no request')
  await bar.click()
  const heading = page.getByRole('heading', { name: `Request ${request}`, exact: true })
  await heading.waitFor()
  return heading
}

/** The picked request's card line `prompt <p> · <time> · <model>`, as it names the model. */
const cardModel = (page: Page): Locator =>
  page
    .getByText(/^prompt \d+ · /)
    .filter({ visible: true })
    .first()

/** The first request on the second model: every bar is picked in order until the card names it. */
async function firstOnSecondModel(page: Page): Promise<Locator> {
  const bars = page.getByRole('button', { name: TREND_BAR })
  const count = await bars.count()
  for (let barIndex = 0; barIndex < count; barIndex += 1) {
    const heading = await pickBar(page, bars.nth(barIndex))
    if ((await cardModel(page).innerText()).includes(SECOND_MODEL)) return heading
  }
  throw new Error(`context: no Trend bar is a request to ${SECOND_MODEL}`)
}

/** The picked request's `cache read <n> (<share>)`, not the Stats legend's bare `cache read`. */
const cardCacheRead = (page: Page): Locator =>
  page
    .getByText(/^cache read \S+ \(/)
    .filter({ visible: true })
    .first()

/** The Context tab (#361, #407): the Now and Trend cards, over the demo thread's model switch and compaction. */
export const CONTEXT: FeatureSpec = {
  id: 'context',
  title: 'Context',
  landingTagline: 'now · trend · composition',
  shows: [
    'Everything pi sends the model with each request is its context: the system prompt, the tool schemas, the conversation so far and every tool result. The **Context** tab shows what the next request will be made of, and how that grew request by request.',
    "It gives you two numbers, and does not choose between them:\n\n- *pi's estimate*, written with `≈`. pi counts characters and divides by four. It can be split by category, so the breakdown uses it.\n- *The provider's count*, written plain. It is exact, but only exists for a request that was sent, and comes as one total.",
    "While a model request is running, the trend draws it as a dashed bar after the others, labelled `now`. Its input is pi's estimate of the request as it was sent, and its output, hatched on top, grows as the response streams (characters ÷ 4). Under the bars it says `request 3 in progress · 7m 12s` with both figures. Both are estimates: when the request completes, the provider's count replaces the bar. On a thread whose first request is still running, that bar is the only one.",
  ],
  opens: ['{steps}.', 'Or `/context` in the chat, which opens the **Now** card and the Context Browser in a dialog.'],
  shots: [
    {
      image: 'context-now-trend',
      alt: 'The Now and Trend cards',
      go: async (ui) => {
        await ui.openThread()
        await ui.tab('Context')
      },
      marks: [
        {
          target: { text: 'pi’s context meter', exact: true },
          says: "pi's context meter: the provider's count for the last response, plus pi's estimate of what has landed since, against the model's window. On a thread with nothing running, this side shows the provider's count alone.",
        },
        {
          target: { text: 'next request · pi’s estimate (characters ÷ 4)' },
          says: "pi's estimate of the next request, as a bar split into categories: **system prompt**, **tool schemas**, **user messages**, **injected context**, **assistant messages** and **tool results**.",
        },
        {
          target: { role: 'group', name: 'bar per' },
          says: "**Trend**: one bar per model request (**Requests**) or per prompt (**Prompts**). **Total** shows each bar's whole makeup, **Change** shows what it added and removed.",
        },
        {
          target: { text: 'compaction', exact: true },
          says: 'The **compaction** mark on a bar. The bar after a compaction is short, because a summary replaced what came before.',
        },
      ],
      after: [
        'The card under the chart is the request you picked. Its **In** row lists what entered since the request before, and **Open in browser** opens it in the [Context browser](./context-browser.md).',
      ],
      measure: {
        switchRequest: firstOnSecondModel,
        switchCacheRead: cardCacheRead,
        // The bar Trend marks as the compaction's, found by its name rather than its number.
        compactionRequest: (page) => pickBar(page, page.getByRole('button', { name: /, compaction$/ }).first()),
        compactedFrom: (page) =>
          page
            .getByText(/^compacted from /)
            .filter({ visible: true })
            .first(),
      },
    },
  ],
  lookFor: [
    `Look for requests that are almost all cache *write*. In the thread above, **{switchRequest}** is the first one after the switch from \`${FIRST_MODEL}\` to \`${SECOND_MODEL}\`. Its bar is no taller than the one before it, but a new model has no cache, so the whole prefix was written again at the higher price: its card reads \`{switchCacheRead}\`. On the **Stats** tab, the same turn is a solid cache-write bar and the peak of **Cost per turn**. In the Context Browser's **Context Events**, the same request carries a \`switch\` event. Three views, one cause.`,
    'The compaction, at **{compactionRequest}**, is the other pattern. Its card says `{compactedFrom}`, and **In** shows a **compaction summary** where the conversation used to be. Its bar barely drops, and the breakdown says why: in this small thread most of the context is **tool schemas** and the **system prompt**, and a compaction summarises the conversation only. When a compaction frees less than you expected, look at what it cannot touch.',
    'Expect the two numbers to differ. The provider counts real tokens and adds its own framing around the tools; pi counts characters. Compare each number with itself from request to request, rather than one with the other.',
  ],
  limits: [
    "The breakdown divides pi's estimate, not the provider's count. A provider gives one total per request, so no split of it exists to show.",
    'An estimate is characters divided by four. It is good for comparing requests with each other, not for predicting a bill.',
    'It shows the current branch. A request on a branch you forked away from is not here.',
  ],
  see: [
    { path: 'docs/features/context-browser.md', label: 'Context browser', why: 'open any one request' },
    { path: 'docs/features/stats.md', label: 'Stats', why: 'the same requests as tokens and cost' },
    {
      path: 'docs/concepts/prompt-cache-architecture.md',
      label: 'Prompt cache architecture',
      why: 'why a model switch rewrites the cache',
    },
    {
      path: 'docs/seams/observation.md',
      label: 'Observation seam',
      also: { path: 'docs/reference/routes.md', label: 'HTTP routes' },
      why: 'where the numbers come from',
    },
  ],
}
