import { expect, test } from 'bun:test'
import { ENSO_JUDGE_POLICY, type EnsoJudgeState } from '@enso/core'
import { createJevJudge, createLocalJudge, JEV_MODEL, jevRequestOf } from '../judge-backends.ts'

/**
 * The command judge's backends (#469, #535) over fake transports: where the text goes, what is
 * asked, and that every failure is an `unjudged` outcome — never a throw, never a clean judgement.
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

/** A transport answering each request with `reply(url, body)`, recording every request it was sent. */
function transport(reply: (url: string, body: unknown) => { status: number; body: unknown }): {
  readonly sent: Sent[]
  readonly fetch: typeof fetch
} {
  const sent: Sent[] = []
  const answer = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input)
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined
    sent.splice(sent.length, 0, { url, authorization: new Headers(init?.headers).get('authorization'), body })
    const { status, body: replyBody } = reply(url, body)
    return new Response(JSON.stringify(replyBody), { status, headers: { 'content-type': 'application/json' } })
  }
  return { sent, fetch: Object.assign(answer, { preconnect: fetch.preconnect }) }
}

const fixed = (status: number, body: unknown): ReturnType<typeof transport> => transport(() => ({ status, body }))

const answers = {
  risk: { type: 'noul', noul: 0.96 },
  obscured: { type: 'score', score: 0.02, confidence: 0.98, legend: {}, probabilities: {} },
  unresolved: { type: 'noul', noul: 0.12 },
  same_as_denied: { type: 'noul', noul: 0.91 },
}

// ⚠ Where the text goes is pinned, never read from the environment, and the body is exactly the
// one the replay shows the user before anything is sent.
test('⚠ jev: one request to the pinned endpoint and model, the key read per call, the body jevRequestOf shows', async () => {
  const wire = fixed(200, { model: 'jev-1.13.0', answers, usage: { input_tokens: 690, output_tokens: 41 } })
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
  // The bytes pi posts are jevRequestOf's, model included: the dry run shows the user exactly this.
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
test('⚠ jev: every failure is unjudged with its reason; an error body, which may echo the request, never is', async () => {
  const keyless = fixed(200, {})
  expect(
    await createJevJudge({ apiKey: () => undefined, fetch: keyless.fetch, timeoutMs: 1000 }).judge(UNREADABLE),
  ).toEqual({ kind: 'unjudged', reason: 'no TypeSafe key' })
  expect(keyless.sent).toEqual([])

  // A 500 is one pi would retry, and its body echoes the command.
  const failing = fixed(500, { error: `invalid state: ${UNREADABLE.command}` })
  const failed = await createJevJudge({ apiKey: () => 'k', fetch: failing.fetch, timeoutMs: 1000 }).judge(UNREADABLE)
  expect(failed).toEqual({ kind: 'unjudged', reason: 'TypeSafe answered 500' })
  // The live path retries nothing: a retry is latency the user pays.
  expect(failing.sent).toHaveLength(1)

  const partial = fixed(200, { model: 'jev-1.13.0', answers: { risk: answers.risk }, usage: {} })
  const outcome = await createJevJudge({ apiKey: () => 'k', fetch: partial.fetch, timeoutMs: 1000 }).judge(UNREADABLE)
  expect(outcome.kind).toBe('unjudged')
  expect(outcome.kind === 'unjudged' && outcome.reason).toContain('obscured')
})

/**
 * A llama.cpp router answering pi's classifier protocol: one token per label, and a fixed
 * next-token distribution — `Yes` 0.8 against `No` 0.2, level `0` 0.7 and the other three 0.1 each.
 */
function llamaServer(): ReturnType<typeof transport> {
  const tokenOf = (text: string): number => Bun.hash.crc32(text)
  const logprobs: Record<string, number> = { Yes: 0.8, No: 0.2, 0: 0.7, 1: 0.1, 2: 0.1, 3: 0.1 }
  return transport((url, body) => {
    const request = body as { content?: string; messages?: { content: string }[] }
    if (url.endsWith('/tokenize')) {
      const content = request.content ?? ''
      return {
        status: 200,
        body: { tokens: content.startsWith('\n') ? [10, tokenOf(content.slice(1))] : [tokenOf(content)] },
      }
    }
    if (url.endsWith('/apply-template')) return { status: 200, body: { prompt: request.messages?.at(-1)?.content } }
    const top = Object.entries(logprobs).map(([label, probability]) => ({
      id: tokenOf(label),
      logprob: Math.log(probability),
    }))
    return { status: 200, body: { completion_probabilities: [{ top_logprobs: top }] } }
  })
}

test("local: answers from the model's label probabilities, every request to the loopback router", async () => {
  const server = llamaServer()
  const judge = createLocalJudge({
    baseUrl: 'http://127.0.0.1:8080/v1',
    model: 'qwen',
    fetch: server.fetch,
    timeoutMs: 1000,
  })
  const outcome = await judge.judge(AFTER_REFUSAL)
  if (outcome.kind !== 'judged') throw new Error(`unjudged: ${outcome.reason}`)
  expect(outcome.model).toBe('qwen')
  expect(outcome.answers.risk?.value).toBeCloseTo(0.8)
  expect(outcome.answers.same_as_denied?.value).toBeCloseTo(0.8)
  // The expected level: 0·0.7 + (1 + 2 + 3)·0.1.
  expect(outcome.answers.obscured?.value).toBeCloseTo(0.6)
  expect(outcome.usage).toBeUndefined()
  expect(new Set(server.sent.map((request) => new URL(request.url).origin))).toEqual(new Set(['http://127.0.0.1:8080']))
})

// ⚠ #532's acceptance: with `local`, command text never leaves the machine.
test('⚠ local: a router that is not on this machine is sent nothing; every call is unjudged with why', async () => {
  for (const baseUrl of ['http://10.0.0.5:8080/v1', 'https://llama.example.com/v1', 'file:///tmp/x', 'not a url']) {
    const server = llamaServer()
    const outcome = await createLocalJudge({ baseUrl, model: 'qwen', fetch: server.fetch, timeoutMs: 1000 }).judge(
      UNREADABLE,
    )
    expect(outcome.kind).toBe('unjudged')
    expect(server.sent).toEqual([])
  }
  const remote = await createLocalJudge({ baseUrl: 'http://10.0.0.5:8080/v1', model: 'qwen', timeoutMs: 1000 }).judge(
    UNREADABLE,
  )
  expect(remote).toEqual({
    kind: 'unjudged',
    reason: 'the local judge must run on this machine (a loopback address), not 10.0.0.5',
  })
})
