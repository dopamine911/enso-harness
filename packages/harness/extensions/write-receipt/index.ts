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
 * ⚠ In a parallel batch — pi's default; `write` sets no `executionMode` — pi starts EVERY call of
 * the assistant message before running any, so the look is at the folder as it stood before the
 * whole batch, not before this call. One case is answered here: a write to a path an earlier write
 * of the same batch is still to make counts as an overwrite — pi's `withFileMutationQueue` runs
 * writes to one file in call order, so the earlier one lands first (unless it fails, which this
 * cannot know at the start). Another tool of the batch making the file (`bash` writing it) is not
 * seen: that write says "new".
 *
 * Only a successful write gets one: a refused or failed write wrote nothing, and its error is the
 * card's story. The path is resolved as pi's own tools resolve it (`resolvePathLikePi`), against the
 * session's working directory. A call a guard blocked never reaches `tool_result`
 * (`docs/flows/guarded-tool-call.md`), so what the turn left unclaimed is dropped at its end.
 */
export default function writeReceipt(pi: ExtensionAPI): void {
  const pendingByCall = new Map<string, { readonly path: string; readonly existed: boolean }>()
  pi.on('tool_execution_start', (event, extensionContext) => {
    const named = (event.args as { path?: unknown } | undefined)?.path
    if (event.toolName !== 'write' || typeof named !== 'string') return
    const path = resolvePathLikePi(named, extensionContext.cwd)
    const earlier = [...pendingByCall.values()].some((pending) => pending.path === path)
    pendingByCall.set(event.toolCallId, { path, existed: earlier || existsSync(path) })
  })
  pi.on('tool_result', (event) => {
    const pending = pendingByCall.get(event.toolCallId)
    pendingByCall.delete(event.toolCallId)
    if (event.toolName !== 'write' || pending === undefined || event.isError) return undefined
    const props: EnsoWriteReceiptProps = { existed: pending.existed }
    return { details: { [ENSO_TOOL_RESULT_KEY]: { kind: ENSO_WRITE_RECEIPT_KIND, props } } }
  })
  pi.on('turn_end', () => pendingByCall.clear())
}
