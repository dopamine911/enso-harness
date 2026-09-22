import { EnsoThreadCommands } from '@enso/core'
import { Check } from 'typebox/value'
import type { FetchLike } from './browser-logging.ts'

/**
 * The `/` palette's one read (#338, slice 1): `GET /api/threads/:id/commands` — the slash
 * commands the thread's session registers, grouped by the server into extension commands,
 * prompt templates and skills, with a `source` that says whose list it is (`live`: this
 * thread's session; `remembered`: the last built session's, because every session registers
 * the same set and this thread has not run yet; `none`: no session has been built in this
 * process). The route writes no record, so the palette calls this on EVERY open rather than
 * caching: the list changes when a session is built, and a stale palette would offer commands
 * a thread cannot run.
 *
 * Validated with the wire's own schema (`Check`), the shape `thread-debug.tsx` reads its
 * inspection with — a payload the schema refuses is an error, not a best-effort render. A
 * non-2xx is `CommandsFetchError` with the status as data and `<status> <body>` as the
 * message: the palette shows the message VERBATIM inside itself (no toast — the failure is
 * local to the popup that asked), and a caller that wants to treat a 404 apart reads `.status`.
 * Not shared with `thread-debug.tsx`'s `InspectionFetchError`: same shape, different endpoint,
 * and neither module is the other's dependency (#144, one direction per import).
 */
export class CommandsFetchError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`${status} ${body}`)
    this.name = 'CommandsFetchError'
  }
}

/** The one place the schema's name is spelled for a miss — the palette prints this line. */
export const COMMANDS_SCHEMA_MISMATCH = "the server's commands payload did not match its schema"

/** Fetches one thread's runnable slash commands; a non-2xx is a {@link CommandsFetchError}, a schema miss an `Error`. */
export async function fetchThreadCommands(threadId: string, fetchImpl: FetchLike = fetch): Promise<EnsoThreadCommands> {
  const response = await fetchImpl(`/api/threads/${encodeURIComponent(threadId)}/commands`)
  if (!response.ok) throw new CommandsFetchError(response.status, await response.text())
  const payload: unknown = await response.json()
  if (!Check(EnsoThreadCommands, payload)) throw new Error(COMMANDS_SCHEMA_MISMATCH)
  return payload
}
