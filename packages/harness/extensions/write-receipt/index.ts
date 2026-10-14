import { existsSync } from 'node:fs'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { ENSO_TOOL_RESULT_KEY, ENSO_WRITE_RECEIPT_KIND, type EnsoWriteReceiptProps } from '@enso/core'
import { resolvePathLikePi } from '../../core/paths.ts'

/**
 * The `write` receipt (#920): whether a write made a new file or overwrote one, which the tool card
 * says beside the path. pi's `write` answers only `Successfully wrote to <path>` with no `details`, so
 * the file is looked for when the call starts: pi awaits every `tool_execution_start` listener before
 * it prepares and runs the call (`agent-loop.js`, both execution modes). It is an observer, NOT a
 * `tool_call` participant — it decides nothing, so the guards' two-participant rule
 * (`tool-call-participants.test.ts`) is untouched. The answer rides the result's `details` as a
 * #18 descriptor the host lifts as it stands.
 *
 * Only a successful write gets one: a refused or failed write wrote nothing, and its error is the
 * card's story. The path is resolved as pi's own tools resolve it (`resolvePathLikePi`), against the
 * session's working directory. A call a guard blocked never reaches `tool_result`
 * (`docs/flows/guarded-tool-call.md`), so what the turn left unclaimed is dropped at its end.
 */
export default function writeReceipt(pi: ExtensionAPI): void {
  const existedByCall = new Map<string, boolean>()
  pi.on('tool_execution_start', (event, extensionContext) => {
    const path = (event.args as { path?: unknown } | undefined)?.path
    if (event.toolName !== 'write' || typeof path !== 'string') return
    existedByCall.set(event.toolCallId, existsSync(resolvePathLikePi(path, extensionContext.cwd)))
  })
  pi.on('tool_result', (event) => {
    const existed = existedByCall.get(event.toolCallId)
    existedByCall.delete(event.toolCallId)
    if (event.toolName !== 'write' || existed === undefined || event.isError) return undefined
    const props: EnsoWriteReceiptProps = { existed }
    return { details: { [ENSO_TOOL_RESULT_KEY]: { kind: ENSO_WRITE_RECEIPT_KIND, props } } }
  })
  pi.on('turn_end', () => existedByCall.clear())
}
