import { appendFileSync } from 'node:fs'

/**
 * A stand-in for Anthropic's Messages API that plays a scripted conversation (#437).
 *
 * WHY A FAKE MODEL. The Features screenshots have to show a real session: refusals the guards
 * really made, a question the `ask_user` tool really asked, a Context tab read off the file pi
 * really wrote. The only part of that which needs to be scripted is the model, so this is the
 * only part that is. pi reaches it through its own `models.json` (`baseUrl` for the built-in
 * `anthropic` provider), which keeps the built-in models, their context windows and their prices
 * — the costs on the Stats tab are pi's arithmetic, not ours.
 *
 * THE USAGE IT REPORTS is derived from each request, the way a provider's would be: the prompt
 * is its serialized length ÷ 4, and the cache read is the longest prefix it shares with any
 * earlier request TO THE SAME MODEL — a prefix cache holds many entries, so the compaction's own
 * summary call does not evict the conversation's. So a model switch really does start from a
 * cold cache, and a compaction really does keep the system prompt and tools cached — nothing is
 * hand-tuned.
 *
 * ⚠ The script is a QUEUE: each request that offers tools takes the next reply. A request that
 * offers none is an auxiliary call (pi's compaction summary), and gets `summary`. A request past
 * the end is answered with an error naming it, so a drift between the capture and the script
 * shows up as a refusal in the chat, and in `log` — never as a silent extra turn.
 */

/** One content block of a scripted reply, tagged by `kind` so a new kind is a compile error where parts are read. */
export type ScriptedPart =
  | { readonly kind: 'thinking'; readonly thinking: string }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'tool'; readonly tool: string; readonly input: Record<string, unknown> }

export interface FeatureModelScript {
  readonly replies: readonly (readonly ScriptedPart[])[]
  readonly summary: string
}

interface MessagesRequest {
  readonly model: string
  readonly system?: unknown
  readonly tools?: readonly unknown[]
  readonly messages: readonly unknown[]
}

/** The characters two strings share from the start. */
function sharedPrefix(left: string, right: string): number {
  const limit = Math.min(left.length, right.length)
  let index = 0
  while (index < limit && left.charCodeAt(index) === right.charCodeAt(index)) index += 1
  return index
}

const tokensOf = (characters: number): number => Math.ceil(characters / 4)

/** One server-sent event, in Anthropic's framing. */
function event(type: string, data: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
}

/** The content blocks of one reply, as the stream events that carry them. */
function blockEvents(parts: readonly ScriptedPart[], replyIndex: number): string[] {
  return parts.flatMap((part, index) => {
    switch (part.kind) {
      case 'thinking':
        return [
          event('content_block_start', { index, content_block: { type: 'thinking', thinking: '', signature: '' } }),
          event('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: part.thinking } }),
          event('content_block_delta', { index, delta: { type: 'signature_delta', signature: 'feature-shot' } }),
          event('content_block_stop', { index }),
        ]
      case 'text':
        return [
          event('content_block_start', { index, content_block: { type: 'text', text: '' } }),
          event('content_block_delta', { index, delta: { type: 'text_delta', text: part.text } }),
          event('content_block_stop', { index }),
        ]
      case 'tool': {
        const id = `toolu_feature_${replyIndex}_${index}`
        return [
          event('content_block_start', { index, content_block: { type: 'tool_use', id, name: part.tool, input: {} } }),
          event('content_block_delta', {
            index,
            delta: { type: 'input_json_delta', partial_json: JSON.stringify(part.input) },
          }),
          event('content_block_stop', { index }),
        ]
      }
    }
  })
}

/** Starts the model on `port`; returns a stopper. `log` receives one line per request. */
export function startFeatureModel(port: number, script: FeatureModelScript, log: string): () => void {
  let next = 0
  const promptsByModel = new Map<string, string[]>()
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port,
    async fetch(request) {
      const url = new URL(request.url)
      if (request.method !== 'POST' || !url.pathname.endsWith('/messages')) {
        appendFileSync(log, `unhandled ${request.method} ${url.pathname}\n`)
        return new Response('not found', { status: 404 })
      }
      const body = (await request.json()) as MessagesRequest
      const auxiliary = (body.tools ?? []).length === 0
      const parts: readonly ScriptedPart[] | undefined = auxiliary
        ? [{ kind: 'text', text: script.summary }]
        : script.replies[next]
      appendFileSync(log, `${auxiliary ? 'auxiliary' : `reply ${next}`} · ${body.model}\n`)
      if (parts === undefined) {
        return Response.json(
          {
            type: 'error',
            error: { type: 'invalid_request_error', message: `feature model: no reply ${next} scripted` },
          },
          { status: 400 },
        )
      }
      const replyIndex = next
      if (!auxiliary) next += 1

      // The provider's count: the whole prompt, the part a previous request to this model cached.
      const prompt = JSON.stringify({ system: body.system, tools: body.tools, messages: body.messages })
      const earlier = promptsByModel.get(body.model) ?? []
      promptsByModel.set(body.model, [...earlier, prompt])
      const total = tokensOf(prompt.length)
      const cached = Math.max(0, ...earlier.map((previous) => sharedPrefix(previous, prompt)))
      const cacheRead = tokensOf(cached)
      const input = Math.min(6, total - cacheRead)
      const cacheWrite = total - cacheRead - input
      const output = tokensOf(JSON.stringify(parts).length)
      const usesTool = parts.some((part) => part.kind === 'tool')

      const stream = [
        event('message_start', {
          message: {
            id: `msg_feature_${replyIndex}`,
            type: 'message',
            role: 'assistant',
            model: body.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: input,
              cache_creation_input_tokens: cacheWrite,
              cache_read_input_tokens: cacheRead,
              output_tokens: 1,
            },
          },
        }),
        ...blockEvents(parts, replyIndex),
        event('message_delta', {
          delta: { stop_reason: usesTool ? 'tool_use' : 'end_turn', stop_sequence: null },
          usage: { output_tokens: output },
        }),
        event('message_stop', {}),
      ].join('')
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  return () => {
    void server.stop(true)
  }
}
