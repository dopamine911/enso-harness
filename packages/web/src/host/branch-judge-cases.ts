import { type EnsoRiskThresholds, type EnsoThreadJudgeCases, judgeContextsOfTranscript } from '@enso/core'
import { type JudgeStateInputs, judgeStateOf } from '@enso/core/judge'
import type { LogEntry } from './log-entry.ts'
import { transcriptOf } from './transcript.ts'

/**
 * The branch's judge cases (#469), for `bun run judge`: each call the judge would be asked about
 * — core's selection, the live one's — with the REDACTED state a backend would be sent, built by
 * the same `judgeStateOf` the guard uses. One function for a live session's memory and a stored
 * file, as `branch-incident-history.ts` is.
 *
 * ⚠ The scripts a command ran are read from the thread's cwd as it is NOW: a file edited or deleted
 * since the call reads as it is, or not at all — not as the agent ran it.
 */
export type BranchJudgeCases = Pick<EnsoThreadJudgeCases, 'cases'>

export interface JudgeCaseInputs extends JudgeStateInputs {
  readonly thresholds: EnsoRiskThresholds
}

/** Walk one branch, root to leaf. */
export function branchJudgeCases(branch: readonly LogEntry[], inputs: JudgeCaseInputs): BranchJudgeCases {
  return {
    cases: judgeContextsOfTranscript(transcriptOf(branch), inputs.thresholds).map((context) => ({
      toolCallId: context.toolCallId,
      scope: context.reason,
      state: judgeStateOf(context, inputs),
    })),
  }
}
