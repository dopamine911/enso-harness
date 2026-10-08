import {
  type EnsoEvalEvent,
  type EnsoEvalScorecard,
  type EnsoSecuritySignal,
  EnsoSessionEval,
  EVAL_KIND_GLYPHS,
  type EvalEventKind,
  runningCounters,
} from '@enso/core'
import { Fragment, useEffect, useRef, useState } from 'react'
import type { FetchLike } from './browser-logging.ts'
import { cn } from './lib/utils.ts'
import { useThreadReadable } from './model-state.tsx'
import { useReadOnUsage } from './read-on-usage.ts'
import { ANALYSIS_READING, type AnalysisOutcome, readNothingRan, readThreadAnalysis } from './route-read.ts'
import { countText } from './stats-table.tsx'
import { useStore, useThreadStores } from './store.ts'
import { missedText } from './thread-stats.tsx'
import type { RevealStatsTarget } from './transcript-reveal.ts'
import { Card, Empty, Metric, Section } from './view-parts.tsx'

/**
 * The session eval on the Stats tab (#441, the follow-up its issue named): the scorecard, the
 * agent-side signals and the timeline `GET /api/threads/:threadId/eval` answers, under the stats
 * drawer. Reads on open and whenever the thread's usage moves, the drawer's one refresh rule.
 *
 * ⚠ SAYS WHAT IT COUNTED, NEVER A VERDICT. A metric is a count the harness recorded; the panel
 * adds no colour of judgement beyond the counters the timeline already carries. An unknown — a
 * log-side count with no day file read — is `—`, never `0`. The dropped list is shown, because a
 * metric absent by decision must not read as a metric at zero.
 *
 * ⚠ THE SECURITY SIGNALS ARE LISTED, NOT ONLY COUNTED (#727). The status bar's `risk high · 2
 * signals` leads here; a count says nothing a person can judge, and one of a run's two signals was
 * a false positive (#726) nobody could see. Each says its kind, what was observed, the call it was
 * observed on and the calls it followed — each call a way to its row in the transcript (#359).
 */

export type EvalOutcome = AnalysisOutcome<EnsoSessionEval>

/** The thread's eval (stable, module-level: `useReadOnUsage` subscribes with it). */
const readThreadEval = (threadId: string, fetchImpl: FetchLike): Promise<EvalOutcome> =>
  readThreadAnalysis(threadId, 'eval', EnsoSessionEval, fetchImpl)

/** A count the log alone gives: `—` when no day was read. */
const logCount = (value: number | null): string => (value === null ? '—' : countText(value))

/** Opens a tool call's row in the transcript; absent where there is nowhere to go (a static render). */
type OpenCall = ((toolCallId: string) => void) | undefined

/** A call a signal names: a button to its row in the transcript (#727), or the bare id in a static render. */
function CallLink({ toolCallId, onOpen }: { toolCallId: string; onOpen: OpenCall }): React.ReactNode {
  const shown = <code className="font-mono">{toolCallId}</code>
  if (onOpen === undefined) return shown
  return (
    <button
      type="button"
      aria-label={`show call ${toolCallId} in the transcript`}
      className="cursor-pointer underline decoration-dotted underline-offset-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      onClick={() => onOpen(toolCallId)}
    >
      {shown}
    </button>
  )
}

function SignalItem({ signal, onOpen }: { signal: EnsoSecuritySignal; onOpen: OpenCall }): React.ReactNode {
  return (
    <li className="grid gap-0.5 border-b py-2 last:border-b-0">
      <span className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
        <b className="font-mono font-medium text-refuse">{signal.signal}</b>
        <span>
          on <CallLink toolCallId={signal.toolCallId} onOpen={onOpen} />
        </span>
        {signal.after.length === 0 ? null : (
          <span>
            after{' '}
            {signal.after.map((toolCallId, position) => (
              <Fragment key={toolCallId}>
                {position === 0 ? null : ', '}
                <CallLink toolCallId={toolCallId} onOpen={onOpen} />
              </Fragment>
            ))}
          </span>
        )}
      </span>
      <span>{signal.detail}</span>
    </li>
  )
}

/** Each security signal the session risk rests on (#727) — where the status bar's risk word lands. */
function SecuritySignals({
  signals,
  onOpen,
  missed,
  landingRef,
}: {
  signals: readonly EnsoSecuritySignal[]
  onOpen: OpenCall
  missed: string | undefined
  landingRef: React.Ref<HTMLElement> | undefined
}): React.ReactNode {
  return (
    // Focusable, not tabbable: the risk word moves focus here, so a keyboard lands where it looks.
    <section ref={landingRef} aria-label="security signals" tabIndex={-1} className="scroll-mt-4 outline-none">
      <Section title="Security signals" aside="observed · not a verdict">
        {missed === undefined ? null : (
          <p role="status" className="text-xs text-muted-foreground">
            {missed}
          </p>
        )}
        {signals.length === 0 ? (
          <Empty>no security signal observed on this branch</Empty>
        ) : (
          <ol className="grid">
            {signals.map((signal, position) => (
              <SignalItem key={`${signal.toolCallId}-${signal.signal}-${position}`} signal={signal} onOpen={onOpen} />
            ))}
          </ol>
        )}
      </Section>
    </section>
  )
}

/** The kinds the timeline colours as a refusal or a stop — what the operator did against the run. */
const AGAINST_THE_RUN: ReadonlySet<EvalEventKind> = new Set([
  'human-correction',
  'interrupt',
  'ask-rejected',
  'tool-denied',
  'guard-refused',
  'rule-refused',
  'provider-refused',
  'destructive',
])

const SIGNAL_ROWS = [
  ['S1_duplicateToolClusters', 'S1 duplicate tool clusters'],
  ['S3_retryAfterErrorFires', 'S3 retries after an error'],
  ['toolErrors', 'tool errors'],
  ['S5_outputCollapseSpans', 'S5 output collapse spans'],
  ['S19_timeGaps', 'S19 time gaps'],
  ['S20_rareCommandMatches', 'S20 rare command matches'],
  ['S21_authorizationDriftFires', 'S21 authorization drift'],
] as const satisfies ReadonlyArray<readonly [keyof EnsoEvalScorecard['signals'], string]>

function stamp(event: EnsoEvalEvent): string {
  return event.at === undefined ? '· · ·' : event.at.slice(11, 19)
}

function TimelineRow({
  event,
  friction,
  refusals,
}: {
  event: EnsoEvalEvent
  friction: number
  refusals: number
}): React.ReactNode {
  return (
    <li className="grid grid-cols-eval-row items-baseline gap-x-3 font-mono text-xs">
      <span className="text-muted-foreground tabular-nums">{stamp(event)}</span>
      <span className={cn('font-semibold', AGAINST_THE_RUN.has(event.kind) ? 'text-refuse' : 'text-muted-foreground')}>
        {EVAL_KIND_GLYPHS[event.kind].trim()}
      </span>
      <span className="text-muted-foreground tabular-nums">f={friction}</span>
      <span className="text-muted-foreground tabular-nums">r={refusals}</span>
      <span className="min-w-0 truncate" title={event.detail}>
        <span className="text-muted-foreground">{event.kind}</span>
        {event.words === undefined ? null : <span className="text-muted-foreground"> ({event.words}w)</span>}{' '}
        {event.detail}
        {event.outcome === undefined ? null : <span className="text-muted-foreground"> [{event.outcome}]</span>}
      </span>
    </li>
  )
}

/**
 * The eval as cards: what it counted, each security signal, the agent's signals, the timeline, and
 * what it does not measure. `onOpenCall` opens a signal's call in the transcript; `missed` says the
 * last one was not there; `signalsRef` is where the risk word lands (#727).
 */
export function ThreadEvalView({
  outcome,
  onOpenCall,
  missed,
  signalsRef,
}: {
  readonly outcome: EvalOutcome
  readonly onOpenCall?: OpenCall
  readonly missed?: string | undefined
  readonly signalsRef?: React.Ref<HTMLElement> | undefined
}): React.ReactNode {
  if (outcome.kind === 'reading') return <p className="p-3 text-xs text-muted-foreground">reading the thread's eval…</p>
  if (outcome.kind === 'failed') return <p className="p-3 text-xs text-muted-foreground">no eval: {outcome.problem}</p>
  const evaluated = outcome.payload
  const { scorecard: card } = evaluated
  const logRead = evaluated.logDays.length > 0
  const rows = runningCounters(evaluated.events)
  return (
    <section aria-label="session eval" className="@container grid grid-cols-1 gap-4 p-4 pt-0">
      <Card
        title="Session eval"
        sub={`${countText(evaluated.events.length)} events · ${evaluated.live ? 'live' : 'from the file'} · mechanical, no composite`}
      >
        {logRead ? null : (
          <p role="status" className="text-sm text-muted-foreground">
            no day file covers this thread — queued prompts and interrupts are unknown, not zero
          </p>
        )}
        <dl className="grid grid-cols-2 gap-2 @3xl:grid-cols-4">
          <Metric label="human messages" value={countText(card.humanMessages)} />
          <Metric label="corrections" value={countText(card.corrections)} danger={card.corrections > 0} />
          <Metric
            label="queued prompts"
            value={logCount(card.queuedMessages)}
            note={card.longestQueuedRun === null ? undefined : `longest run ${countText(card.longestQueuedRun)}`}
          />
          <Metric label="interrupts" value={logCount(card.interrupts)} danger={(card.interrupts ?? 0) > 0} />
          <Metric
            label="asks declined"
            value={`${countText(card.askRejected)} / ${countText(card.askCalls)}`}
            danger={card.askRejected > 0}
          />
          {/* The glossary's "refusal channel": who refused. NOT the scorecard's `refusalsTotal` — that is `r=`, what the operator clicked. */}
          <Metric
            label="refusal channels"
            value={countText(card.guardRefusals + card.ruleRefusals + card.operatorDenials + card.providerRefusals)}
            note={`guard ${countText(card.guardRefusals)} · rule ${countText(card.ruleRefusals)} · operator ${countText(card.operatorDenials)} · provider ${countText(card.providerRefusals)}`}
          />
          {/* #464: observed evidence, never a verdict — and its thresholds are uncalibrated (#468). */}
          <Metric
            label="session risk"
            value={card.riskLevel}
            danger={card.riskLevel === 'high' || card.riskLevel === 'incident'}
            note={`${countText(card.securitySignals)} signal(s) observed · not a verdict`}
          />
          <Metric
            label="gate runs"
            value={countText(card.gateRuns)}
            danger={card.gateFailed > 0}
            note={
              card.gateRuns === 0
                ? undefined
                : `${countText(card.gatePassed)} passed · ${countText(card.gateFailed)} failed`
            }
          />
          <Metric
            label="per human message"
            value={`${card.assistantPerHuman} · ${card.toolCallsPerHuman} · ${card.writesPerHuman}`}
            note="replies · tool calls · writes"
          />
        </dl>
        <p className="text-xs text-muted-foreground">
          modes {card.permissionModes.length === 0 ? '—' : card.permissionModes.join(' → ')}
          {card.firstCorrectionAt === null ? null : ` · first correction ${card.firstCorrectionAt.slice(11, 19)}`}
        </p>
      </Card>
      <SecuritySignals signals={card.riskSignals} onOpen={onOpenCall} missed={missed} landingRef={signalsRef} />
      <div className="grid grid-cols-1 items-start gap-4 @4xl:grid-cols-2">
        <Section title="Agent-side signals" aside="per kind, unweighted">
          <dl className="grid grid-cols-label-value gap-x-3 gap-y-1">
            {SIGNAL_ROWS.map(([key, label]) => (
              <SignalRow key={key} label={label} value={card.signals[key]} />
            ))}
            <dt className="text-muted-foreground">S20 families</dt>
            <dd className="font-mono text-xs">
              {card.signals.S20_families.length === 0 ? '—' : card.signals.S20_families.join(', ')}
            </dd>
          </dl>
          {card.signals.S21_events.length === 0 ? null : (
            <ul className="grid gap-1 text-xs">
              {card.signals.S21_events.map((fire) => (
                <li key={fire.eventIndex} className="text-muted-foreground">
                  <b className="font-medium text-refuse">S21</b> {fire.action} after “{fire.humanText.slice(0, 80)}” (
                  {countText(fire.unattendedRun)} unattended)
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section title="Not measured" aside="no pi fact">
          <ul className="grid gap-1 text-xs text-muted-foreground">
            {card.dropped.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </Section>
      </div>
      <Section title="Timeline" aside="f= typed against the run · r= clicked against it">
        {rows.length === 0 ? (
          <Empty>nothing recorded on this branch yet</Empty>
        ) : (
          <ol aria-label="eval timeline" className="grid gap-0.5">
            {rows.map(({ event, friction, refusals }, index) => (
              <TimelineRow
                // An eval event has no id: several share one transcript `index` (a message's asks and
                // gates) and log-side ones carry none. Rows are stateless and the list is time-ordered,
                // never reordered by the user, so the position is the only identity there is.
                // react-doctor-disable-next-line no-array-index-as-key
                key={`${event.index ?? 'log'}-${index}`}
                event={event}
                friction={friction}
                refusals={refusals}
              />
            ))}
          </ol>
        )}
      </Section>
    </section>
  )
}

function SignalRow({ label, value }: { label: string; value: number }): React.ReactNode {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn('font-mono tabular-nums', value > 0 ? 'text-foreground' : 'text-muted-foreground')}>
        {countText(value)}
      </dd>
    </>
  )
}

/**
 * The eval wired to its thread: read on open and whenever the thread's usage moves
 * (`read-on-usage.ts`). `onNavigate` is the pane's, as the stats drawer's: a signal's call opens
 * Chat at its row. Asked by the risk word (`landOnRiskSignals`), it lands on the signals once read.
 */
export function ThreadEvalDrawer({ onNavigate }: { readonly onNavigate?: RevealStatsTarget }): React.ReactNode {
  const outcome = useReadOnUsage<EvalOutcome>(useThreadReadable() ? readThreadEval : readNothingRan, ANALYSIS_READING)
  const landing = useThreadStores().landOnRiskSignals
  const land = useStore(landing)
  const signalsRef = useRef<HTMLElement>(null)
  const [missed, setMissed] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (!land || outcome.kind === 'reading') return
    // Lowered on a failed read too: the next visit to Stats opens at the top, not here.
    landing.set(false)
    // Instant, not smooth: the stats drawer above may still be reading, and the browser's scroll
    // anchoring holds a settled position in place as it grows — not one still on its way there.
    signalsRef.current?.scrollIntoView({ block: 'start' })
    // Focused where it was scrolled to, so a keyboard lands where the eye does — not scrolled again.
    signalsRef.current?.focus({ preventScroll: true })
  }, [land, landing, outcome])
  const openCall =
    onNavigate === undefined
      ? undefined
      : (toolCallId: string): void => {
          const target = { kind: 'tool-call', toolCallId } as const
          setMissed(onNavigate(target) ? undefined : missedText(target))
        }
  return <ThreadEvalView outcome={outcome} onOpenCall={openCall} missed={missed} signalsRef={signalsRef} />
}
