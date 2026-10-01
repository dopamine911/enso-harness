import { expect, test } from 'bun:test'
import type { Fetch } from '@typesafe-ai/sdk'
import { ENSO_JUDGE_POLICY, type EnsoJudgeState } from '../command-judge.ts'
import { createJevJudge, JEV_MODEL, jevRequestOf } from '../jev-judge.ts'

/**
 * The Jev backend (#469) over a fake transport: where the text goes, what is asked, and that every
 * failure is an `unjudged` outcome, never a throw and never a clean judgement.
 */

const AFTER_REFUSAL: EnsoJudgeState = {
  cwd: '/w',
  policy: ENSO_JUDGE_POLICY,
  command: 'find records -delete',
  denied: { command: 'rm -rf records', reason: 'the permission engine denied bash rm -rf records' },
}
const UNREADABLE: EnsoJudgeState = {
  cwd: '/w',
  policy: ENSO_JUDGE_POLICY,
  command: 'echo cm0gLXJmIHg= | base64 -d | sh',
}

interface Sent {
  readonly url: string
  readonly authorization: string | null
  readonly body: unknown
}

/** A transport answering `status` and `body`, recording every request it was sent. */
function transport(status: number, body: unknown): { readonly sent: Sent[]; readonly fetch: Fetch } {
  const sent: Sent[] = []
  const answer: Fetch = async (url, init) => {
    sent.push({
      url,
      authorization: new Headers(init?.headers).get('authorization'),
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    })
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }
  return { sent, fetch: answer }
}

const answers = {
  risk: { type: 'noul', noul: 0.96 },
  obscured: { type: 'score', score: 0.02, confidence: 0.98, legend: {}, probabilities: {} },
  unresolved: { type: 'noul', noul: 0.12 },
  same_as_denied: { type: 'noul', noul: 0.91 },
}

// ⚠ Where the text goes is pinned, never read from the environment, and the body is exactly the
// one the replay shows the user before anything is sent.
test('⚠ one request to the pinned endpoint and model, with the key read per call, the body jevRequestOf shows', async () => {
  const wire = transport(200, { model: 'jev-1.13.0', answers, usage: { input_tokens: 690, output_tokens: 41 } })
  let key = 'k-one'
  const judge = createJevJudge({ apiKey: () => key, fetch: wire.fetch, timeoutMs: 1000 })
  expect(await judge.judge(AFTER_REFUSAL)).toEqual({
    kind: 'judged',
    model: 'jev-1.13.0',
    answers: {
      risk: { value: 0.96 },
      obscured: { value: 0.02, confidence: 0.98 },
      unresolved: { value: 0.12 },
      same_as_denied: { value: 0.91 },
    },
    usage: { inputTokens: 690, outputTokens: 41 },
  })
  key = 'k-rotated'
  await judge.judge(AFTER_REFUSAL)
  expect(wire.sent.map((request) => [request.url, request.authorization])).toEqual([
    ['https://api.typesafe.ai/v1/systemone', 'Bearer k-one'],
    ['https://api.typesafe.ai/v1/systemone', 'Bearer k-rotated'],
  ])
  // The body is jevRequestOf's, model included: the dry-run shows the user exactly this.
  expect(wire.sent[0]?.body).toEqual(JSON.parse(JSON.stringify(jevRequestOf(AFTER_REFUSAL))))
  expect(jevRequestOf(AFTER_REFUSAL).model).toBe(JEV_MODEL)
})

test('same_as_denied is asked only after a refusal', () => {
  expect(Object.keys(jevRequestOf(UNREADABLE).questions)).toEqual(['risk', 'obscured', 'unresolved'])
  expect(Object.keys(jevRequestOf(AFTER_REFUSAL).questions)).toEqual([
    'risk',
    'obscured',
    'unresolved',
    'same_as_denied',
  ])
})

// An unjudged call is recorded as such (#469), never as a clean one — and nothing is sent without a key.
test('⚠ every failure is unjudged with its reason: no key, an HTTP error (one attempt), a missing answer', async () => {
  const keyless = transport(200, {})
  expect(
    await createJevJudge({ apiKey: () => undefined, fetch: keyless.fetch, timeoutMs: 1000 }).judge(UNREADABLE),
  ).toEqual({
    kind: 'unjudged',
    reason: 'no TypeSafe key',
  })
  expect(keyless.sent).toEqual([])

  const failing = transport(500, { error: 'boom' })
  expect(await createJevJudge({ apiKey: () => 'k', fetch: failing.fetch, timeoutMs: 1000 }).judge(UNREADABLE)).toEqual({
    kind: 'unjudged',
    reason: 'TypeSafe answered 500',
  })
  // The live path retries nothing: a retry is latency the user pays.
  expect(failing.sent).toHaveLength(1)

  const partial = transport(200, {
    model: 'jev-1.13.0',
    answers: { risk: answers.risk },
    usage: { input_tokens: 1, output_tokens: 1 },
  })
  expect(await createJevJudge({ apiKey: () => 'k', fetch: partial.fetch, timeoutMs: 1000 }).judge(UNREADABLE)).toEqual({
    kind: 'unjudged',
    reason: 'the reply had no obscured answer',
  })
})
