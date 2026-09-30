import type { Page } from '@playwright/test'
import { LOG_KEEP_DAYS } from '../../../packages/core/src/log-process.ts'
import { SECOND_MODEL } from '../feature-session.ts'
import type { FeatureSpec } from './spec.ts'

/** A metric tile's value: the `<dd>` right after its `<dt>label</dt>` (`view-parts.tsx#Metric`), the label matched exactly. */
const metric = (label: string) => (page: Page) =>
  page
    .locator(`dt:text-is(${JSON.stringify(label)})`)
    .first()
    .locator('xpath=following-sibling::dd[1]')

/** The Stats page (#45, #407), from the demo session's finished thread. */
export const STATS: FeatureSpec = {
  id: 'stats',
  title: 'Stats',
  shows: [
    "The **Stats** tab analyses one thread: what it cost, how the cache behaved, which parts of the conversation were expensive, and which tools did the most. Every figure comes from pi's own session file, so a thread from last month gives the same answer as one from a minute ago.",
  ],
  alsoOpens: ['A point on a chart, a call or a prompt in a list opens that spot in the chat.'],
  shots: [
    {
      image: 'stats',
      alt: 'The Stats tab',
      go: async (ui) => {
        await ui.openThread()
        await ui.tab('Stats')
      },
      marks: [
        {
          target: { text: 'refused by a guard — not failures' },
          says: '**failures**, and under it the refusals, counted apart: `{shown}`.',
        },
        {
          target: { role: 'heading', name: 'Tokens' },
          says: "**{shown}**: each turn's **cache read**, **cache write**, **cache miss** and **output**, as a stacked bar.",
        },
        { target: { role: 'heading', name: 'Cost per turn' }, says: '**{shown}**, with the median beside the title.' },
        {
          target: { role: 'heading', name: 'Costliest calls' },
          says: '**{shown}**: the tool calls ranked by input, output, time or failures.',
        },
      ],
      measure: {
        totalCost: metric('total cost'),
        failures: metric('failures'),
        offBranch: (page) => page.getByText('not attributed', { exact: false }).first().locator('b'),
      },
    },
  ],
  afterShots:
    "Further down: **Cumulative usage by tool**, **Distribution**, **Costliest prompts** and **Latency**, then the thread's [Session eval](./session-eval.md).",
  lookFor: [
    'The thread above cost {totalCost}. Three things stand out.',
    `The first turn after the switch to \`${SECOND_MODEL}\` is one solid cache-write bar in **Tokens**, and the peak of **Cost per turn**: the new model had no cache, so the whole prefix was written again, at that model's price. Nearly every other turn is almost all cache read. If you see a lone cache-write bar in a thread of your own, look for a model switch or a compaction just before it. [Context Events](./context-browser.md) names which.`,
    'The line under the metrics, {offBranch} `not attributed to a turn on this branch`, is the compaction. Its summary was a model call of its own, but not a turn of the conversation, so the tab names the cost instead of hiding it in a turn.',
    "**failures** reads `{failures}`, not counting the refusals. pi records a guard's refusal as an error, just like a real failure. Enso keeps a record of each refusal, so the tab counts the failed `cat` as a failure and the refused calls apart. A refusal is the guard working, not the tool breaking.",
  ],
  limits: [
    'It covers the current branch only. Cost spent on a branch you forked away from, or on a compaction, is named as not attributed to a turn, rather than spread over the ones you see.',
    `Times come from the log, which keeps ${LOG_KEEP_DAYS} days. An older thread still has every token and cost figure, but its **Latency** says no day file covers it.`,
    "Tool figures are in characters, not tokens. A tool's cost is the tokens its result adds to later requests, which the **Context** tab shows.",
  ],
  see: [
    { path: 'docs/features/context.md', label: 'Context', why: 'the same requests, by what they were made of' },
    { path: 'docs/features/guards-and-receipts.md', label: 'Guards and receipts', why: 'what a refusal is' },
    { path: 'docs/seams/observation.md', label: 'Observation seam', why: 'where the numbers come from' },
    { path: 'docs/seams/logging.md', label: 'Logging seam', why: 'where the times come from' },
    { path: 'docs/concepts/prompt-cache-architecture.md', label: 'Prompt cache architecture' },
  ],
}
