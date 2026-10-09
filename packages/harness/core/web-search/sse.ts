/**
 * A minimal SSE reader for the provider streams (#63).
 *
 * Adapted from pi-web-search 1.4.0 (github.com/ttttmr/pi-web-search), © ttttmr, MIT
 * (declared in its package.json; the repo ships no LICENSE file).
 *
 * Reads `event:`/`data:` lines, JSON-parses each event's data, and hands
 * `{ eventName, data }` to the callback. The callback may return `true` to stop reading early
 * (the OpenAI Codex stream never closes on its own after `response.completed`).
 *
 * Two cases that used to share one branch (#268). A `[DONE]` sentinel carries no data and is
 * SKIPPED — it is the protocol saying the stream is over. A `data:` payload that does not
 * parse as JSON is DATA LOSS inside a grounded answer, so it THROWS: the three callers turn
 * a stream throw into a `WebSearchProviderError` with `requestDispatched: true`, which is
 * what every other layer in this seam does with a mid-stream failure. Dropping it silently
 * returned the surviving frames as a successful `searched` outcome with no record that
 * anything was lost.
 */

export interface SseEvent {
  eventName: string
  /** The JSON-parsed event payload. Provider wire data — each caller narrows it. */
  data: unknown
}

interface SseFrameParser {
  /** Feeds one stream line; returns `true` when the callback asked to stop reading. */
  acceptLine: (line: string) => boolean
  /** Flushes the final event, which may end at EOF without the blank-line terminator. */
  finish: (remainder: string) => void
}

function createSseFrameParser(onEvent: (event: SseEvent) => boolean | undefined): SseFrameParser {
  let currentEventData = ''
  let currentEventName = ''

  const flushEvent = (): boolean => {
    if (currentEventData.length === 0) return false
    const rawData = currentEventData.trim()
    currentEventData = ''
    const eventName = currentEventName
    currentEventName = ''
    if (rawData.length === 0 || rawData === '[DONE]') return false

    let data: unknown
    try {
      data = JSON.parse(rawData)
    } catch {
      throw new Error(
        `the search stream carried an unparseable ${eventName.length > 0 ? `${eventName} ` : ''}frame of ${rawData.length} characters`,
      )
    }
    return onEvent({ eventName, data }) === true
  }

  const bufferLine = (line: string): void => {
    if (line.startsWith('data:')) {
      const data = line.slice('data:'.length).trim()
      currentEventData = currentEventData.length > 0 ? `${currentEventData}\n${data}` : data
    } else if (line.startsWith('event:')) {
      currentEventName = line.slice('event:'.length).trim()
    }
  }

  return {
    acceptLine: (line: string): boolean => {
      if (line === '' || line === '\r') return flushEvent()
      bufferLine(line)
      return false
    },
    finish: (remainder: string): void => {
      if (remainder.trim().length > 0) {
        bufferLine(remainder.trim())
      }
      flushEvent()
    },
  }
}

/** The reader calls this module makes: `getReader()`'s type lacks Bun's `readMany`, so the full interface does not fit (#816). */
type SseStreamReader = Pick<ReadableStreamDefaultReader<Uint8Array>, 'read' | 'cancel' | 'releaseLock'>

/**
 * Feeds the stream's complete lines to the parser until EOF or until the callback stops reading.
 * Returns the unterminated tail at EOF, or `undefined` when the callback stopped it.
 */
async function pumpSseLines(
  reader: SseStreamReader,
  signal: AbortSignal | undefined,
  parser: SseFrameParser,
): Promise<string | undefined> {
  const decoder = new TextDecoder()
  let lineBuffer = ''
  for (;;) {
    if (signal?.aborted === true) {
      throw new Error('the request was aborted')
    }

    const { done, value } = await reader.read()
    if (done) return lineBuffer

    lineBuffer += decoder.decode(value, { stream: true })
    const lines = lineBuffer.split('\n')
    lineBuffer = lines.pop() ?? ''

    // `some` stops at the first line whose callback asked to stop, leaving the rest unread.
    if (lines.some((line) => parser.acceptLine(line))) return undefined
  }
}

/** Cancels a stream that did not reach its end, then releases the reader either way. */
async function releaseSseReader(reader: SseStreamReader, reachedEndOfStream: boolean): Promise<void> {
  if (!reachedEndOfStream) {
    try {
      await reader.cancel()
    } catch {
      // Ignore cancellation failures while cleaning up an interrupted stream.
    }
  }
  reader.releaseLock()
}

export async function readSseEvents(
  response: Response,
  signal: AbortSignal | undefined,
  onEvent: (event: SseEvent) => boolean | undefined,
): Promise<void> {
  const responseBody = response.body
  if (responseBody === null) {
    throw new Error('the streaming response has no body')
  }

  const reader = responseBody.getReader()
  const parser = createSseFrameParser(onEvent)
  let reachedEndOfStream = false

  try {
    const remainder = await pumpSseLines(reader, signal, parser)
    reachedEndOfStream = remainder !== undefined
    // A final event may end at EOF without the blank-line terminator.
    if (remainder !== undefined) parser.finish(remainder)
  } finally {
    await releaseSseReader(reader, reachedEndOfStream)
  }
}
