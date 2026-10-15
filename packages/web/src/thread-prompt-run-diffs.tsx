import {
  type EnsoPromptRun,
  type EnsoPromptRunBaseline,
  EnsoPromptRunChanges,
  type EnsoPromptRunSnapshot,
  EnsoThreadPromptRuns,
  EnsoThreadStats,
} from '@enso/core'
import { ChevronLeftIcon, ChevronRightIcon, MessagesSquareIcon } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { FetchLike } from './browser-logging.ts'
import { type ReadChangedFile, readChangedFile } from './changed-file.ts'
import { Button } from './components/ui/button.tsx'
import { useReadOnUsage } from './read-on-usage.ts'
import {
  ANALYSIS_READING,
  readSchemaRoute,
  readThreadAnalysis,
  readThreadRoute,
  type ThreadReadOutcome,
} from './route-read.ts'
import { useThreadStores } from './store.ts'
import { ChangedFiles } from './thread-changes.tsx'
import type { RevealStatsTarget } from './transcript-reveal.ts'

/**
 * The Diff Viewer (#553): a thread's prompt runs, stepped through one at a time, and the files each
 * changed — off #551's snapshots (`GET …/prompt-runs`), two of them compared in the thread's store
 * (`GET …/prompt-runs/changes`). Not the Diff tab (#452), which compares the live tree with the last
 * push. A prompt run is a prompt and everything that ran under it, up to the next prompt: it is
 * counted and labelled by its prompt, never as a turn — a turn is one model request, as Stats counts it.
 *
 * ⚠ EVERY DIFF IS TWO SNAPSHOTS, NEVER THE LIVE TREE. A prompt run's own diff is the snapshot as it
 * began against the one as the next prompt's run began; its cumulative diff, the thread's baseline
 * against that same result. The pair is read by its two hashes, so what is on screen stays what it
 * was while the thread runs on or its tree changes: only the list of prompt runs is read again, and
 * a prompt run's result appears when the next prompt's run begins.
 *
 * ⚠ NOTHING IS FABRICATED. A prompt run whose snapshot is missing, failed, unreadable or not taken
 * yet says which, and shows no files; one whose two snapshots hold the same files says it changed
 * nothing. Neither is drawn as an empty diff.
 *
 * Read-only: stepping through prompts restores nothing, forks nothing and writes nothing.
 */

/** What the view holds of the prompt runs: not read yet, nothing (a 404), the prompt runs, or why not. */
export type PromptRunsOutcome = ThreadReadOutcome<EnsoThreadPromptRuns> | typeof ANALYSIS_READING

const readThreadPromptRuns = (
  threadId: string,
  fetchImpl: FetchLike,
): Promise<ThreadReadOutcome<EnsoThreadPromptRuns>> =>
  readThreadRoute(threadId, 'prompt-runs', EnsoThreadPromptRuns, fetchImpl)

/** `prompt-run`: the prompt run's start to its result. `cumulative`: the thread's baseline to its result. */
export type PromptRunDiffMode = 'prompt-run' | 'cumulative'

/** A snapshot's short name, as git abbreviates a commit. */
const short = (hash: string): string => hash.slice(0, 8)

/**
 * What a snapshot that is no commit to compare says, in words, about its `subject`: the prompt run's
 * start (`began`), its result (`ended`), or the cumulative view's baseline — never one blamed for another.
 */
function snapshotProblem(snapshot: EnsoPromptRunSnapshot, subject: 'began' | 'ended' | 'baseline'): string | undefined {
  const which = subject === 'began' ? 'as this prompt began' : 'after this prompt'
  const files = subject === 'baseline' ? 'the baseline' : `the files ${which}`
  const named = subject === 'baseline' ? 'The baseline snapshot' : `The snapshot ${which}`
  switch (snapshot.kind) {
    case 'taken':
      return undefined
    case 'failed':
      return `No snapshot of ${files}: the run recorded that none could be taken.`
    case 'unrecorded':
      return `No snapshot of ${files} is recorded: the thread ran before snapshots were taken.`
    case 'pending':
      return "This prompt's result is not captured yet: the files are snapshotted when the next prompt's run begins."
    case 'unavailable':
      return `${named} (${short(snapshot.hash)}) cannot be read: ${snapshot.reason}`
  }
}

/** The pair a prompt run's diff compares in `mode`, or why there is no diff to show. */
export type PromptRunPair =
  | { readonly kind: 'pair'; readonly from: string; readonly to: string }
  | { readonly kind: 'idle' }
  | { readonly kind: 'missing'; readonly why: string }

export function promptRunPairOf(
  promptRun: EnsoPromptRun,
  baseline: EnsoPromptRunBaseline,
  mode: PromptRunDiffMode,
): PromptRunPair {
  const endProblem = snapshotProblem(promptRun.end, 'ended')
  if (endProblem !== undefined || promptRun.end.kind !== 'taken') return { kind: 'missing', why: endProblem ?? '' }
  if (mode === 'prompt-run') {
    const startProblem = snapshotProblem(promptRun.start, 'began')
    if (startProblem !== undefined || promptRun.start.kind !== 'taken') {
      return { kind: 'missing', why: startProblem ?? '' }
    }
    if (promptRun.idle) return { kind: 'idle' }
    return { kind: 'pair', from: promptRun.start.hash, to: promptRun.end.hash }
  }
  if (baseline.kind === 'none') {
    return { kind: 'missing', why: 'No baseline: the thread records no snapshot to compare its prompts with.' }
  }
  if (baseline.snapshot.kind !== 'taken') {
    return { kind: 'missing', why: `No baseline: ${snapshotProblem(baseline.snapshot, 'baseline') ?? ''}` }
  }
  return { kind: 'pair', from: baseline.snapshot.hash, to: promptRun.end.hash }
}

/** A prompt run's mark in the list: what its own diff holds. */
function promptRunMark(promptRun: EnsoPromptRun): {
  readonly mark: string
  readonly label: string
  readonly tone: string
} {
  if (promptRun.end.kind === 'pending') {
    return { mark: '…', label: 'result not captured yet', tone: 'text-muted-foreground' }
  }
  if (promptRun.start.kind !== 'taken' || promptRun.end.kind !== 'taken') {
    return { mark: '?', label: 'snapshot missing', tone: 'text-refuse' }
  }
  if (promptRun.idle) return { mark: '○', label: 'no file changes', tone: 'text-muted-foreground' }
  return { mark: '●', label: 'files changed', tone: 'text-evidence' }
}

/** What the cumulative view's baseline is, in words. */
function baselineText(baseline: EnsoPromptRunBaseline): string {
  if (baseline.kind === 'none') return 'no baseline snapshot'
  const hash =
    baseline.snapshot.kind === 'taken' || baseline.snapshot.kind === 'unavailable' ? baseline.snapshot.hash : undefined
  const named = hash === undefined ? '' : ` (${short(hash)})`
  if (baseline.kind === 'first-snapshot') return `the thread's first snapshot${named}`
  if (baseline.fork === null) return `the snapshot this thread's tree was made from${named}`
  const parent =
    baseline.fork.parentThreadId === null ? 'its source thread' : `thread ${short(baseline.fork.parentThreadId)}`
  const prompts = baseline.fork.inheritedPrompts === 1 ? '1 prompt' : `${baseline.fork.inheritedPrompts} prompts`
  return `the snapshot this fork inherited from ${parent} after ${prompts}${named}`
}

/** What a prompt run's diff compares, in words: the two snapshots, each by its short hash. */
export function pairText(
  promptRun: EnsoPromptRun,
  baseline: EnsoPromptRunBaseline,
  pair: PromptRunPair,
  mode: PromptRunDiffMode,
): string {
  if (pair.kind !== 'pair') return ''
  const to = `the files after prompt ${promptRun.promptRun} (${short(pair.to)})`
  if (mode === 'cumulative') return `${baselineText(baseline)} → ${to}`
  // A fork's first prompt run began from what it inherited: say so, not just "as it began".
  const inherited =
    baseline.kind === 'tree' &&
    baseline.fork !== null &&
    baseline.snapshot.kind === 'taken' &&
    baseline.snapshot.hash === pair.from
  const from = inherited
    ? baselineText(baseline)
    : `the files as prompt ${promptRun.promptRun} began (${short(pair.from)})`
  return `${from} → ${to}`
}

/** A two-snapshot read: reading, the files, or why not. */
type PairRead =
  | { readonly kind: 'reading' }
  | { readonly kind: 'read'; readonly changes: EnsoPromptRunChanges }
  | { readonly kind: 'failed'; readonly problem: string }

/** `GET …/prompt-runs/changes?from=&to=`: the files that differ between two of the thread's snapshots. */
async function readPromptRunChanges(
  threadId: string,
  pair: { readonly from: string; readonly to: string },
  fetchImpl: FetchLike,
): Promise<PairRead> {
  const query = new URLSearchParams({ from: pair.from, to: pair.to })
  const route = `/api/threads/${encodeURIComponent(threadId)}/prompt-runs/changes?${query.toString()}`
  const read = await readSchemaRoute(route, EnsoPromptRunChanges, 'prompt run changes', fetchImpl)
  if (read.kind === 'read') return { kind: 'read', changes: read.payload }
  return { kind: 'failed', problem: read.kind === 'absent' ? 'the thread is no longer held here' : read.problem }
}

/**
 * The files between `from` and `to` (`''` for no pair), read when the pair is asked for. Only the
 * last pair's answer is held: stepping back to an earlier prompt reads its pair again. A snapshot
 * never changes, so the thread running on reads nothing again here — only a new pair does.
 */
function usePairRead(from: string, to: string): PairRead {
  const stores = useThreadStores()
  const asked = `${from}..${to}`
  const [held, setHeld] = useState<{ readonly asked: string; readonly read: PairRead } | undefined>()
  useEffect(() => {
    if (from === '' || to === '') return undefined
    let current = true
    void readPromptRunChanges(stores.threadId, { from, to }, stores.fetch).then((read) => {
      if (current) setHeld({ asked, read })
    })
    return () => {
      current = false
    }
  }, [asked, from, to, stores])
  return held?.asked === asked ? held.read : { kind: 'reading' }
}

const NOTE = 'px-4 py-6 text-sm text-muted-foreground'

/** The selected prompt run's diff in `mode`: the files, or what stands in for them. */
function PromptRunDiff({
  promptRun,
  baseline,
  mode,
}: {
  readonly promptRun: EnsoPromptRun
  readonly baseline: EnsoPromptRunBaseline
  readonly mode: PromptRunDiffMode
}): React.ReactNode {
  const stores = useThreadStores()
  const pair = promptRunPairOf(promptRun, baseline, mode)
  const from = pair.kind === 'pair' ? pair.from : ''
  const to = pair.kind === 'pair' ? pair.to : ''
  const read = usePairRead(from, to)
  const readFile: ReadChangedFile = (change) => readChangedFile(stores.threadId, change, stores.fetch, { from, to })
  if (pair.kind === 'idle') {
    return (
      <p role="status" className={NOTE}>
        No files changed under this prompt: its two snapshots hold the same files.
      </p>
    )
  }
  if (pair.kind === 'missing') {
    return (
      <p role="status" className="px-4 py-6 text-sm text-refuse">
        {pair.why} No diff is shown.
      </p>
    )
  }
  if (read.kind === 'reading') return <p className={NOTE}>reading the snapshots…</p>
  if (read.kind === 'failed') {
    return <p className="px-4 py-6 text-sm text-refuse">The snapshots could not be compared: {read.problem}</p>
  }
  return (
    // Keyed by the pair: another pair's chosen file and open runs never carry over.
    <ChangedFiles
      key={`${pair.from}..${pair.to}`}
      title={mode === 'prompt-run' ? `Prompt ${promptRun.promptRun}` : `Through prompt ${promptRun.promptRun}`}
      description={<span className="text-muted-foreground">{pairText(promptRun, baseline, pair, mode)}</span>}
      files={read.changes.files}
      truncated={read.changes.truncated}
      readFile={readFile}
      nothingText={
        mode === 'prompt-run'
          ? 'No files differ between the two snapshots.'
          : 'No files differ from the baseline after this prompt.'
      }
    />
  )
}

/** Previous or Next: one step through the prompts, off at either end. */
function StepButton({
  step,
  disabled,
  onStep,
}: {
  readonly step: 'previous' | 'next'
  readonly disabled: boolean
  readonly onStep: () => void
}): React.ReactNode {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={disabled}
      onClick={onStep}
      aria-label={`${step} prompt`}
    >
      {step === 'previous' ? <ChevronLeftIcon aria-hidden="true" /> : null}
      {step === 'previous' ? 'Previous' : 'Next'}
      {step === 'next' ? <ChevronRightIcon aria-hidden="true" /> : null}
    </Button>
  )
}

/** The prompt run on screen, its neighbours, the mode, and the way to its prompt in Chat. */
function PromptRunNavigation({
  promptRuns,
  index,
  onIndex,
  mode,
  onMode,
  onShowInChat,
  missed,
}: {
  readonly promptRuns: readonly EnsoPromptRun[]
  readonly index: number
  readonly onIndex: (index: number) => void
  readonly mode: PromptRunDiffMode
  readonly onMode: (mode: PromptRunDiffMode) => void
  readonly onShowInChat: (() => void) | undefined
  readonly missed: boolean
}): React.ReactNode {
  const promptRun = promptRuns[index]
  if (promptRun === undefined) return null
  return (
    <div className="flex flex-col gap-2 border-b px-4 py-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <StepButton step="previous" disabled={index === 0} onStep={() => onIndex(index - 1)} />
        <span className="tabular-nums" aria-live="polite">
          Prompt {promptRun.promptRun} of {promptRuns.length}
        </span>
        <StepButton step="next" disabled={index === promptRuns.length - 1} onStep={() => onIndex(index + 1)} />
        <div role="group" aria-label="what the diff compares" className="flex rounded-md border p-0.5">
          {(
            [
              ['prompt-run', 'This prompt', "the files as the prompt's run began, against the files after it"],
              ['cumulative', 'Up to this prompt', "the thread's baseline, against the files after the prompt"],
            ] as const
          ).map(([value, label, hover]) => (
            <button
              key={value}
              type="button"
              aria-pressed={mode === value}
              title={hover}
              onClick={() => onMode(value)}
              className="rounded-sm px-2 py-0.5 text-xs transition-colors hover:bg-card aria-pressed:bg-accent aria-pressed:text-accent-foreground"
            >
              {label}
            </button>
          ))}
        </div>
        {onShowInChat === undefined ? null : (
          <Button type="button" variant="ghost" size="sm" className="ml-auto" onClick={onShowInChat}>
            <MessagesSquareIcon aria-hidden="true" />
            Show in Chat
          </Button>
        )}
      </div>
      <p className="truncate text-sm text-foreground" title={promptRun.text}>
        <span className="text-muted-foreground">Prompt: </span>
        {promptRun.text === '' ? <span className="text-muted-foreground">(no text)</span> : promptRun.text}
      </p>
      {promptRun.restored ? (
        <p className="text-xs text-evidence">
          The files were restored to an earlier snapshot while this prompt ran: the diff includes the restore.
        </p>
      ) : null}
      {missed ? <p className="text-xs text-refuse">This prompt is not in the transcript on screen.</p> : null}
      <ol aria-label="prompts" className="flex flex-wrap gap-1 font-mono text-xs">
        {promptRuns.map((candidate, candidateIndex) => {
          const { mark, label, tone } = promptRunMark(candidate)
          return (
            <li key={candidate.entryId}>
              <button
                type="button"
                aria-current={candidateIndex === index ? 'true' : undefined}
                title={`prompt ${candidate.promptRun}: ${label}`}
                onClick={() => onIndex(candidateIndex)}
                className="flex items-center gap-1 rounded-sm border px-1.5 py-0.5 transition-colors hover:bg-card aria-[current=true]:bg-accent aria-[current=true]:text-accent-foreground"
              >
                <span className={tone} aria-hidden="true">
                  {mark}
                </span>
                {candidate.promptRun}
                <span className="sr-only">{label}</span>
              </button>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

/**
 * The view of the prompt runs `outcome` holds. It keeps its own selection (by the prompt's entry),
 * mode and whether Show in Chat last missed; `onShowInChat` opens Chat at a prompt and says whether
 * it found it — without one there is no button.
 */
export function ThreadPromptRunDiffsView({
  outcome,
  onShowInChat,
}: {
  readonly outcome: PromptRunsOutcome
  readonly onShowInChat?: (promptRun: EnsoPromptRun) => Promise<boolean>
}): React.ReactNode {
  const [chosen, setChosen] = useState<string | undefined>(undefined)
  const [mode, setMode] = useState<PromptRunDiffMode>('prompt-run')
  const [missed, setMissed] = useState<string | undefined>(undefined)
  if (outcome.kind === 'reading') return <p className={NOTE}>reading the prompts…</p>
  if (outcome.kind === 'none') return <p className={NOTE}>Nothing has run in this thread yet.</p>
  if (outcome.kind === 'failed') {
    return <p className="px-4 py-6 text-sm text-refuse">The prompts could not be read: {outcome.problem}</p>
  }
  const { promptRuns, baseline } = outcome.payload
  if (promptRuns.length === 0) {
    return (
      <p className={NOTE}>
        This thread has no prompts of its own yet. Its prompts will be compared with {baselineText(baseline)}.
      </p>
    )
  }
  // The chosen prompt run by its prompt's entry, so a new one arriving never moves the selection;
  // the last one whose result is captured otherwise.
  const found = promptRuns.findIndex((promptRun) => promptRun.entryId === chosen)
  const lastCaptured = promptRuns.findLastIndex((promptRun) => promptRun.end.kind !== 'pending')
  const fallback = lastCaptured === -1 ? promptRuns.length - 1 : lastCaptured
  const index = found === -1 ? fallback : found
  const promptRun = promptRuns[index] as EnsoPromptRun
  return (
    <section aria-label="Diff Viewer" className="flex h-full min-h-0 flex-col">
      <PromptRunNavigation
        promptRuns={promptRuns}
        index={index}
        onIndex={(next) => {
          setMissed(undefined)
          setChosen(promptRuns[next]?.entryId)
        }}
        mode={mode}
        onMode={setMode}
        onShowInChat={
          onShowInChat === undefined
            ? undefined
            : () => {
                void onShowInChat(promptRun).then((shown) => setMissed(shown ? undefined : promptRun.entryId))
              }
        }
        missed={missed === promptRun.entryId}
      />
      <p className="border-b px-4 py-1 text-xs text-muted-foreground">
        Files as the snapshots recorded them, whoever changed them — not the agent&apos;s edits alone. Read only:
        nothing is restored or forked.
      </p>
      <div className="min-h-0 flex-1">
        <PromptRunDiff promptRun={promptRun} baseline={baseline} mode={mode} />
      </div>
    </section>
  )
}

/**
 * The view wired to its thread: the prompt runs read on open and whenever `moment` moves (a tool
 * result settled, a run started or ended). "Show in Chat" opens the prompt by its entry — a resumed
 * thread's messages are its entries — and otherwise, as on a live run whose bubbles carry ids of
 * their own, finds it through the thread's stats by its place among every prompt (`prompt`), as the
 * Stats view does.
 */
export function ThreadPromptRunDiffs({
  moment,
  revealMessage,
  revealInTranscript,
}: {
  readonly moment: string
  readonly revealMessage: (messageId: string) => boolean
  readonly revealInTranscript: RevealStatsTarget
}): React.ReactNode {
  const outcome = useReadOnUsage<PromptRunsOutcome>(readThreadPromptRuns, ANALYSIS_READING, moment)
  const stores = useThreadStores()
  const showInChat = useCallback(
    async (promptRun: EnsoPromptRun): Promise<boolean> => {
      if (revealMessage(promptRun.entryId)) return true
      const stats = await readThreadAnalysis(stores.threadId, 'stats', EnsoThreadStats, stores.fetch)
      const target = { kind: 'prompt', prompt: promptRun.prompt } as const
      return revealInTranscript(target, stats.kind === 'read' ? stats.payload : undefined)
    },
    [stores, revealMessage, revealInTranscript],
  )
  return <ThreadPromptRunDiffsView outcome={outcome} onShowInChat={showInChat} />
}
