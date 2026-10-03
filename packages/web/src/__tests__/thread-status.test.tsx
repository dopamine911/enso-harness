import { expect, test } from 'bun:test'
import type { EnsoIncidentOpened, EnsoSessionIncidents, EnsoSessionUsage, EnsoToolRefusal } from '@enso/core'
import type { UIMessage } from '@tanstack/ai-client'
import { renderToStaticMarkup } from 'react-dom/server'
import { countThread, describeActivity, ThreadStatusView } from '../thread-status.tsx'

/**
 * #90 PR 1: the always-on status bar. Activity and counts are derived from the message
 * list the page already holds; cost and context from pi's session usage (#45). Tested as the
 * two pure functions plus a static render of the view, the thread-debug.test.tsx pattern.
 */

const user = (id: string, content: string): UIMessage => ({ id, role: 'user', parts: [{ type: 'text', content }] })
const assistant = (id: string, parts: UIMessage['parts']): UIMessage => ({ id, role: 'assistant', parts })
const call = (id: string, name: string): UIMessage['parts'][number] => ({
  type: 'tool-call',
  id,
  name,
  arguments: '{}',
  state: 'input-complete',
})
const result = (toolCallId: string): UIMessage['parts'][number] => ({
  type: 'tool-result',
  toolCallId,
  content: 'ok',
  state: 'complete',
})

const NO_USAGE: EnsoSessionUsage = { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, context: null }

// ── activity ─────────────────────────────────────────────────────────────────

test('not loading is idle, whatever the transcript holds', () => {
  const messages = [user('u1', 'hi'), assistant('a1', [call('c1', 'read')])]
  expect(describeActivity(messages, false)).toEqual({ kind: 'idle' })
})

// #119: after the follow ends the run flag is as of that moment — a run in flight may have
// finished, been aborted, or died with the server. The bar says the one thing it knows.
test('disconnected outranks the run flag: neither idle nor the tail is reported once the follow ended', () => {
  const midRun = [user('u1', 'hi'), assistant('a1', [call('c1', 'bash')])]
  expect(describeActivity(midRun, true, true)).toEqual({ kind: 'disconnected' })
  expect(describeActivity(midRun, false, true)).toEqual({ kind: 'disconnected' })
  expect(describeActivity(midRun, true, false)).toEqual({ kind: 'running', tool: 'bash' })
})

test('a run with no assistant output yet is working, not idle', () => {
  expect(describeActivity([user('u1', 'hi')], true)).toEqual({ kind: 'working' })
  expect(describeActivity([], true)).toEqual({ kind: 'working' })
})

// ⚠ THE DONE/PENDING RULE: a call is running until its result is paired — and pairing is
// TanStack's own selection across the whole list, not a `state` field we would have to
// keep in step with the library.
test('a tool call with no result is running <tool>; once its result lands the model is working again', () => {
  const pending = [user('u1', 'hi'), assistant('a1', [{ type: 'text', content: 'let me look' }, call('c1', 'read')])]
  expect(describeActivity(pending, true)).toEqual({ kind: 'running', tool: 'read' })
  const paired = [user('u1', 'hi'), assistant('a1', [call('c1', 'read'), result('c1')])]
  expect(describeActivity(paired, true)).toEqual({ kind: 'working' })
})

test('a thinking tail is thinking; a text tail is responding', () => {
  expect(describeActivity([user('u1', 'hi'), assistant('a1', [{ type: 'thinking', content: 'hm' }])], true)).toEqual({
    kind: 'thinking',
  })
  expect(describeActivity([user('u1', 'hi'), assistant('a1', [{ type: 'text', content: 'so' }])], true)).toEqual({
    kind: 'responding',
  })
})

// #418: joining a live run (a reload) opens a new assistant message after the stored one holding
// the pending call, and it stays empty until something streams. The bar reads past it — but never
// past a user message: an earlier turn's unanswered call is not what a new prompt is doing.
test('an empty assistant message at the tail is read past to the step behind it, never past a user message', () => {
  const joined = [user('u1', 'pick one'), assistant('a1', [call('c1', 'ask_user')]), assistant('a2', [])]
  expect(describeActivity(joined, true)).toEqual({ kind: 'running', tool: 'ask_user' })
  const newPrompt = [user('u1', 'hi'), assistant('a1', [call('c1', 'bash')]), user('u2', 'next'), assistant('a2', [])]
  expect(describeActivity(newPrompt, true)).toEqual({ kind: 'working' })
})

// ⓘ Diverges from the transcript's render-everything policy on purpose: a one-word summary
// has no word for an image or an unmatched result, and `working` is true of both — the run
// is in flight, and the part itself is still visible in the transcript.
test('a tail the summary has no word for — an image, an unmatched result — is working', () => {
  const image = assistant('a1', [{ type: 'image', source: { type: 'url', value: 'x.png' } }])
  expect(describeActivity([user('u1', 'hi'), image], true)).toEqual({ kind: 'working' })
  // A result whose call never crossed: TanStack keeps it as an unmatched `toolResult` part.
  const orphanResult = assistant('a2', [result('never-called')])
  expect(describeActivity([user('u1', 'hi'), orphanResult], true)).toEqual({ kind: 'working' })
})

// ⚠ THE TAIL READ IS PER-MESSAGE (#282). This function selects the LAST message ALONE
// (`selectMessageUI`), so it cannot see a tool call in an earlier message — the opposite of
// the transcript renderer, which must (`chat-screen.tsx`'s `message` component). This is the
// reachable shape where the two selections could disagree and do not: a result at the tail
// whose call sits in an EARLIER message is `matched` under the whole-transcript selection
// and unmatched under this one, so it is filtered in the first case and hits the catch-all
// in the second — `working` both ways. A red line here means the tail read began depending
// on cross-message pairing, and the per-message selection is no longer sound.
test('a result at the tail whose call sits in an earlier message is working (#282)', () => {
  const split = [assistant('a1', [call('c1', 'read')]), assistant('a2', [result('c1')])]
  expect(describeActivity(split, true)).toEqual({ kind: 'working' })
})

// ⚠ THE ONE ACCEPTED DIVERGENCE (#282). A result that follows another part INSIDE a message
// that does not hold its call is the single shape where the per-message read answers
// differently from the whole-transcript read it replaced: matched-and-filtered there, so the
// text behind it was the tail (`responding`); unmatched here, so the result is the tail
// (`working`). It is recorded rather than fixed because TanStack cannot produce it — the
// stream processor anchors a `tool-result` into the message holding its `tool-call`, and
// carries the call forward into the result's message when the snapshot lacks it
// (`@tanstack/ai` `reconcileSnapshotToolCalls`, post-passes (a) and (b)), so a result and
// its call are never in different messages with something between. A red line here means
// that normalisation changed and the tail read needs the transcript-wide pairing back.
test('⚠ a result behind a text part, call in an earlier message: working, not responding (#282)', () => {
  const wedged = [
    assistant('a1', [call('c1', 'read')]),
    assistant('a2', [{ type: 'text', content: 'done' }, result('c1')]),
  ]
  expect(describeActivity(wedged, true)).toEqual({ kind: 'working' })
})

// ── counts ───────────────────────────────────────────────────────────────────

test('prompts count user messages; tool calls count every call, paired or not', () => {
  const messages = [
    user('u1', 'one'),
    assistant('a1', [call('c1', 'read'), result('c1'), call('c2', 'bash')]),
    user('u2', 'two'),
    assistant('a2', [{ type: 'text', content: 'done' }]),
  ]
  expect(countThread(messages)).toEqual({ prompts: 2, toolCalls: 2, refused: 0, failed: 0 })
  expect(countThread([])).toEqual({ prompts: 0, toolCalls: 0, refused: 0, failed: 0 })
})

// #407: pi hands a refusal and a failed command over as the same error result; only the thread's
// refusals store says which is which — never the text. A guard's and the engine's alike (#523).
test('⚠ an error result something refused counts as refused — a guard, a rule, you; the same shape without a refusal counts as failed', () => {
  const errored = (toolCallId: string): UIMessage['parts'][number] => ({
    type: 'tool-result',
    toolCallId,
    content: 'bash command refused',
    state: 'error',
    error: 'bash command refused',
  })
  const messages = [
    assistant('a1', [
      call('c1', 'bash'),
      errored('c1'),
      call('c2', 'bash'),
      errored('c2'),
      call('c3', 'read'),
      result('c3'),
      call('c4', 'bash'),
      errored('c4'),
      call('c5', 'bash'),
      errored('c5'),
    ]),
  ]
  const refusals = new Map<string, EnsoToolRefusal>([
    ['c1', { by: 'guard', rule: 'secret-path' }],
    ['c4', { by: 'operator' }],
    ['c5', { by: 'rule' }],
  ])
  expect(countThread(messages, refusals)).toEqual({ prompts: 0, toolCalls: 5, refused: 3, failed: 1 })
  expect(countThread(messages)).toMatchObject({ refused: 0, failed: 4 })
})

// ── the view ─────────────────────────────────────────────────────────────────

const render = (props: Partial<Parameters<typeof ThreadStatusView>[0]>): string =>
  renderToStaticMarkup(
    <ThreadStatusView
      activity={props.activity ?? { kind: 'idle' }}
      counts={props.counts ?? { prompts: 0, toolCalls: 0, refused: 0, failed: 0 }}
      usage={'usage' in props ? props.usage : NO_USAGE}
      cwd={props.cwd}
      projectTitle={props.projectTitle}
      onTree={props.onTree}
      refusal={props.refusal}
      refusalSource={props.refusalSource}
      risk={props.risk}
      incidents={props.incidents}
    />,
  )

// ⚠ ALWAYS VISIBLE. The #45 bar hid until the first request; this one is the place you look,
// so a fresh session must read as an empty session, not as nothing.
test('a fresh session renders idle with zeros — never an empty string', () => {
  const rendered = render({})
  expect(rendered).toContain('idle')
  expect(rendered).toContain('0 prompts')
  expect(rendered).toContain('0 tool calls')
  expect(rendered).toContain('$0.0000')
  // No context before a live session says its window: absent, not a fabricated zero.
  expect(rendered).not.toContain('context')
})

test('refused and failed are said apart, each only when there is one (#407)', () => {
  const both = render({ counts: { prompts: 1, toolCalls: 4, refused: 2, failed: 1 } })
  expect(both).toContain('2 refused')
  expect(both).toContain('1 failed')
  expect(both).toContain('by policy, not by error')
  const neither = render({ counts: { prompts: 1, toolCalls: 4, refused: 0, failed: 0 } })
  expect(neither).not.toContain('refused')
  expect(neither).not.toContain('failed')
})

// #464: the session's risk is said once it is above `low`, as observed evidence — nothing is
// blocked because of it, and the bar must not read as though something were.
test('the risk is said only above low, with its signal count, and never as a verdict', () => {
  expect(render({ risk: { level: 'low', signals: 0 } })).not.toContain('risk')
  const medium = render({ risk: { level: 'medium', signals: 1 } })
  expect(medium).toContain('risk medium · 1 signal')
  expect(medium).toContain('not a verdict')
  expect(render({ risk: { level: 'incident', signals: 5 } })).toContain('risk incident · 5 signals')
})

// #466: an incident is said in three states — halted (a human must act), open with halting off (an
// alert), and ended — and a resolved one that resumed says nothing, even with restrictions kept.
const HALTED_OPENING: EnsoIncidentOpened = {
  incidentId: 'inc-1',
  signals: [],
  halted: true,
  suspended: ['execute', 'network', 'write'],
}

test('an open halted incident requires intervention in the refusal colour; halting off only says it is open; an ended thread says so', () => {
  const halted: EnsoSessionIncidents = {
    incidents: [{ opened: HALTED_OPENING, resolutions: [] }],
    suspended: HALTED_OPENING.suspended,
    ended: false,
  }
  expect(render({ incidents: halted })).toMatch(
    /<span class="[^"]*text-refuse[^"]*"[^>]*>intervention required<\/span>/,
  )

  const alertOnly: EnsoSessionIncidents = {
    incidents: [{ opened: { ...HALTED_OPENING, halted: false, suspended: [] }, resolutions: [] }],
    suspended: [],
    ended: false,
  }
  const open = render({ incidents: alertOnly })
  expect(open).toContain('incident open')
  expect(open).not.toContain('intervention required')

  const endedResolution = {
    incidentId: 'inc-1',
    classification: 'confirmed-bypass',
    outcome: 'end-thread',
    suspended: HALTED_OPENING.suspended,
  } as const
  const ended = render({
    incidents: {
      incidents: [{ opened: HALTED_OPENING, resolutions: [endedResolution] }],
      suspended: HALTED_OPENING.suspended,
      ended: true,
    },
  })
  expect(ended).toContain('thread ended by incident resolution')
  expect(ended).not.toContain('intervention required')

  const resumed = render({
    incidents: {
      incidents: [
        {
          opened: HALTED_OPENING,
          resolutions: [{ ...endedResolution, outcome: 'resume-with-restrictions', suspended: ['network'] }],
        },
      ],
      suspended: ['network'],
      ended: false,
    },
  })
  expect(resumed).not.toContain('incident')
  expect(resumed).not.toContain('intervention')
})

test('disconnected renders as its own word, not pulsing, with the recovery in the title', () => {
  const rendered = render({ activity: { kind: 'disconnected' } })
  expect(rendered).toContain('disconnected')
  expect(rendered).not.toContain('animate-pulse')
  expect(rendered).toContain('reload and resume from the rail')
})

test('the running tool is named, and counts read as English', () => {
  const rendered = render({
    activity: { kind: 'running', tool: 'bash' },
    counts: { prompts: 1, toolCalls: 1, refused: 0, failed: 0 },
  })
  expect(rendered).toContain('running bash')
  expect(rendered).toContain('1 prompt<')
  expect(rendered).toContain('1 tool call<')
})

// #45: before the follow's first snapshot the page does not know what was spent — `$0.0000`
// there was the resumed-thread bug (a thread that had spent, shown as free).
test('cost before the first snapshot is unknown, not zero', () => {
  const rendered = render({ usage: undefined })
  expect(rendered).toContain('$—')
  expect(rendered).not.toContain('$0.0000')
})

// The meter is pi's figure over pi's window: the percent it reports, the tokens in the title.
test("context is pi's percent of its window, with the token count, clamped in the meter", () => {
  const usage: EnsoSessionUsage = {
    ...NO_USAGE,
    cost: 0.0132,
    context: { tokens: 68_400, window: 200_000, percent: 34.2 },
  }
  const rendered = render({ usage })
  expect(rendered).toContain('$0.0132')
  expect(rendered).toContain('34% · ≈68.4K / 200K')
  expect(rendered).toContain('68,400 of 200,000 tokens')
  expect(rendered).toContain('value="34"')
  const over = render({ usage: { ...usage, context: { tokens: 210_000, window: 200_000, percent: 105 } } })
  expect(over).toContain('105%')
  expect(over).toContain('value="100"')
})

// pi says `tokens: null` after a compaction until the next response; a guessed number would lie.
test('context after a compaction says unknown over the window, with no meter', () => {
  const rendered = render({ usage: { ...NO_USAGE, context: { tokens: null, window: 200_000, percent: null } } })
  expect(rendered).toContain('context ? / 200K')
  expect(rendered).not.toContain('<meter')
})

// #44: the project, as a reader names it — the directory's own name on the bar, the full path on
// hover (two checkouts of one repo share a name; the path tells them apart). Before the first
// snapshot there is nothing to say, so nothing is said.
test('the project is the directory name with the full path in its title; absent until a snapshot says', () => {
  expect(render({})).not.toContain('project')
  const rendered = render({ cwd: '/home/dev/work/zen-harness-foundation/' })
  expect(rendered).toContain('project zen-harness-foundation<')
  expect(rendered).toContain(
    'title="the tree pi reads and writes for this thread: /home/dev/work/zen-harness-foundation/"',
  )
})

// #551: a thread on its own tree runs in `…/trees/<thread-id>` — the directory's name is an id, not
// the project. The page's project title names it; the tree's path stays on hover.
test("on a thread's tree the bar names its project's title, with the tree's path in its title", () => {
  const tree = '/home/dev/.enso/projects/0123456789abcdef/trees/a4d027f5-c6f9-4c39-a77e-bb75005e4da7'
  const rendered = render({ cwd: tree, projectTitle: 'zen-harness-foundation' })
  expect(rendered).toContain('project zen-harness-foundation<')
  expect(rendered).toContain(`title="the tree pi reads and writes for this thread: ${tree}"`)
})

// #576 review: on by default, a thread's edits land in its own tree, not the user's checkout — said
// on the bar itself, never only on hover; a thread in the checkout says nothing of the kind.
test('a thread on its own tree says, on the bar, that its edits are not in the checkout; one in the checkout does not', () => {
  const tree = '/home/dev/.enso/projects/0123456789abcdef/trees/a4d027f5-c6f9-4c39-a77e-bb75005e4da7'
  const onTree = render({ cwd: tree, projectTitle: 'zen-harness-foundation', onTree: true })
  expect(onTree).toContain('>own tree, not your checkout<')
  expect(render({ cwd: '/home/dev/work/zen-harness-foundation/', onTree: false })).not.toContain('own tree')
})

// #395, PR #399 review: the server's empty directory means a new thread's project was removed —
// it will be built nowhere. Said as such, not as a project with no name.
test('an empty directory says the project was removed, not an unnamed project', () => {
  const rendered = render({ cwd: '' })
  expect(rendered).toContain('project removed<')
  expect(rendered).not.toContain('the tree pi reads and writes')
})

// #340: beside `idle · $0.0000` the bar says a refusal's class while nothing has got through —
// "nothing ran", not "free" — and says nothing when there is none.
test('a refusal renders its class word beside the activity; none renders nothing extra', () => {
  const refused = render({ refusal: 'rate-limited' })
  expect(refused).toContain('>rate-limited<')
  expect(refused).toContain('the provider refused the last request')
  expect(render({})).not.toContain('refused the last request')
  // #387: the word names who refused, so it is never read as Enso's policy.
  const named = render({ refusal: 'rate-limited', refusalSource: 'Anthropic' })
  expect(named).toContain('>Anthropic: rate-limited<')
  expect(named).toContain('Anthropic refused the last request')
})
