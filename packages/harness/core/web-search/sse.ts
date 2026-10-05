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
  const decoder = new TextDecoder()
  const parser = createSseFrameParser(onEvent)
  let lineBuffer = ''
  let stopRequested = false
  let reachedEndOfStream = false

  try {
    readLoop: for (;;) {
      if (signal?.aborted === true) {
        throw new Error('the request was aborted')
      }

      const { done, value } = await reader.read()
      if (done) {
        reachedEndOfStream = true
        break
      }

      lineBuffer += decoder.decode(value, { stream: true })
      const lines = lineBuffer.split('\n')
      lineBuffer = lines.pop() ?? ''

      for (const line of lines) {
        if (parser.acceptLine(line)) {
          stopRequested = true
          break readLoop
        }
      }
    }

    // A final event may end at EOF without the blank-line terminator.
    if (!stopRequested) parser.finish(lineBuffer)
  } finally {
    if (!reachedEndOfStream) {
      try {
        await reader.cancel()
      } catch {
        // Ignore cancellation failures while cleaning up an interrupted stream.
      }
    }
    reader.releaseLock()
  }
}
