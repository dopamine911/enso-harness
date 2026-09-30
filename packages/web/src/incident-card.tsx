import {
  ENSO_FAMILY_TOOLS,
  ENSO_INCIDENT_CLASSIFICATIONS,
  ENSO_INCIDENT_OUTCOMES,
  ENSO_TOOL_FAMILIES,
  type EnsoIncidentClassification,
  type EnsoIncidentOutcome,
  type EnsoIncidentRecord,
  type EnsoIncidentResolution,
  type EnsoIncidentResolved,
  type EnsoSessionIncidents,
  type EnsoToolFamily,
  incidentResolutionRefusal,
  openIncidentOf,
} from '@enso/core'
import { SirenIcon } from 'lucide-react'
import { useId, useRef, useState } from 'react'
import { Button } from './components/ui/button.tsx'
import { Checkbox } from './components/ui/checkbox.tsx'
import { Field, FieldLabel, FieldLegend, FieldSet } from './components/ui/field.tsx'
import { RadioGroup, RadioGroupItem } from './components/ui/radio-group.tsx'
import type { IncidentResolveOutcome } from './follow-connection.ts'
import { useStore, useThreadStores } from './store.ts'

/**
 * A session's incident as the thread shows it (#466): what was OBSERVED, what the risk fold
 * INFERRED from it, and what that SUSPENDED — three sections, never one sentence, because the
 * signals are evidence, the level is an uncalibrated inference over them (#468), and the
 * suspension is policy (`security.incidents.halt`). Then every resolution a human recorded, and —
 * on the incident still to settle — the form that records the next.
 *
 * ⚠ THE FORM IS NOT THE AUTHORITY. It runs the same `incidentResolutionRefusal` the resolve route
 * runs, so a refusal is said before anything is posted; the server decides, and its reason is
 * shown when it refuses. The card changes only when the resolution's record arrives on the follow.
 */

/** A classification in the reader's words. One per classification: a new one fails the build here. */
const CLASSIFICATION_LABEL: Readonly<Record<EnsoIncidentClassification, string>> = {
  'false-positive': 'false positive',
  'agent-error': 'agent error',
  'policy-ambiguity': 'policy ambiguity',
  'probable-bypass': 'probable bypass',
  'confirmed-bypass': 'confirmed bypass',
}

/** An outcome in the reader's words, and what it does. */
const OUTCOME_LABEL: Readonly<Record<EnsoIncidentOutcome, string>> = {
  resume: 'resume — every tool family back',
  'resume-with-restrictions': 'resume with restrictions — the families ticked below stay suspended',
  'end-thread': 'end the thread — final: every family stays suspended, and it takes no new prompts',
}

/** The incident's heading words: open, or its last resolution's outcome. */
function stateWord(record: EnsoIncidentRecord): string {
  const last = record.resolutions.at(-1)
  if (last === undefined) return record.opened.halted ? 'open · tools suspended' : 'open · halting off'
  return last.outcome === 'end-thread' ? 'resolved · thread ended' : `resolved · ${last.outcome}`
}

/**
 * Whether this record takes a resolution now: the thread's last incident, the thread not ended,
 * and either still open or resumed with restrictions — a resolved incident is re-resolved only to
 * change what stays suspended (`incidentResolutionRefusal`'s rules), never to reopen it.
 */
function takesResolution(record: EnsoIncidentRecord, incidents: EnsoSessionIncidents): boolean {
  if (incidents.ended || incidents.incidents.at(-1) !== record) return false
  const last = record.resolutions.at(-1)
  return last === undefined || last.outcome === 'resume-with-restrictions'
}

function Section({ title, children }: { readonly title: string; readonly children: React.ReactNode }): React.ReactNode {
  const headingId = useId()
  return (
    <section aria-labelledby={headingId} className="grid gap-1.5 border-t px-3 py-2">
      <h3 id={headingId} className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
        {title}
      </h3>
      {children}
    </section>
  )
}

function Observed({ record }: { readonly record: EnsoIncidentRecord }): React.ReactNode {
  const { signals } = record.opened
  if (signals.length === 0) return <p className="text-sm">no signals recorded on this thread's opening</p>
  return (
    <ul className="grid gap-2">
      {signals.map((signal) => (
        <li key={`${signal.signal}:${signal.toolCallId}`} className="grid gap-0.5">
          <dl className="grid grid-cols-label-value gap-x-3 font-mono text-xs text-muted-foreground">
            <dt>signal</dt>
            <dd className="text-foreground">{signal.signal}</dd>
            <dt>on call</dt>
            <dd className="text-foreground">{signal.toolCallId}</dd>
            <dt>after</dt>
            <dd className="text-foreground">{signal.after.length === 0 ? '—' : signal.after.join(', ')}</dd>
          </dl>
          <p className="text-sm break-words">{signal.detail}</p>
        </li>
      ))}
    </ul>
  )
}

function Suspended({ record }: { readonly record: EnsoIncidentRecord }): React.ReactNode {
  const { suspended } = record.opened
  if (suspended.length === 0) {
    return <p className="text-sm">nothing suspended — halting is off (security.incidents.halt)</p>
  }
  return (
    <>
      <dl className="grid grid-cols-label-value gap-x-3 font-mono text-xs text-muted-foreground">
        {suspended.map((family) => (
          <div key={family} className="contents">
            <dt>{family}</dt>
            <dd className="text-foreground">{ENSO_FAMILY_TOOLS[family].join(', ')}</dd>
          </div>
        ))}
      </dl>
      {/* The opening's record, never rewritten: once resolved, what stays is the resolution's. */}
      {record.resolutions.length === 0 ? null : (
        <p className="text-xs text-muted-foreground">
          suspended when it opened — the last resolution below says what stays suspended
        </p>
      )}
    </>
  )
}

function Resolutions({ resolutions }: { readonly resolutions: readonly EnsoIncidentResolved[] }): React.ReactNode {
  return (
    <ol className="grid gap-1.5">
      {resolutions.map((resolution, index) => (
        // Records in order, never reordered — the position is the identity.
        <li key={index}>
          <dl className="grid grid-cols-label-value gap-x-3 font-mono text-xs text-muted-foreground">
            <dt>judged</dt>
            <dd className="text-foreground">{CLASSIFICATION_LABEL[resolution.classification]}</dd>
            <dt>outcome</dt>
            <dd className="text-foreground">{resolution.outcome}</dd>
            <dt>suspended</dt>
            <dd className="text-foreground">
              {resolution.suspended.length === 0 ? 'nothing' : resolution.suspended.join(', ')}
            </dd>
          </dl>
        </li>
      ))}
    </ol>
  )
}

/** What the card says after a post the server did not take. */
function unrecordedReason(outcome: Exclude<IncidentResolveOutcome, { outcome: 'told' }>): string {
  if (outcome.outcome === 'unreachable') return 'the server could not be reached — nothing was recorded'
  if (outcome.outcome === 'busy') return `the thread is running — resolve it once the run settles (${outcome.reason})`
  return `the server refused it: ${outcome.reason}`
}

/** The resolution the form's choices make, or undefined until a classification and an outcome are chosen. */
function resolutionOf(
  classification: EnsoIncidentClassification | undefined,
  outcome: EnsoIncidentOutcome | undefined,
  restricted: readonly EnsoToolFamily[],
): EnsoIncidentResolution | undefined {
  if (classification === undefined || outcome === undefined) return undefined
  if (outcome === 'resume-with-restrictions') return { classification, outcome, restricted: [...restricted] }
  return { classification, outcome }
}

/**
 * The resolve form: a classification, an outcome, and — for `resume-with-restrictions` — the
 * families that stay suspended. `end-thread` asks once more before it posts: it cannot be undone.
 */
function ResolveForm({
  record,
  incidents,
  resolve,
}: {
  readonly record: EnsoIncidentRecord
  readonly incidents: EnsoSessionIncidents
  readonly resolve: (incidentId: string, resolution: EnsoIncidentResolution) => Promise<IncidentResolveOutcome>
}): React.ReactNode {
  const idPrefix = useId()
  const [classification, setClassification] = useState<EnsoIncidentClassification | undefined>(undefined)
  const [outcome, setOutcome] = useState<EnsoIncidentOutcome | undefined>(undefined)
  const [restricted, setRestricted] = useState<readonly EnsoToolFamily[]>([])
  const [confirming, setConfirming] = useState(false)
  const [posting, setPosting] = useState(false)
  const [problem, setProblem] = useState<string | undefined>(undefined)
  // ⚠ A ref as well as state: two clicks in one task both read the state from before the first
  // re-render, and a second POST would record a second resolution.
  const inFlight = useRef(false)
  const { incidentId } = record.opened

  const resolution = resolutionOf(classification, outcome, restricted)

  const post = (chosen: EnsoIncidentResolution): void => {
    if (inFlight.current) return
    inFlight.current = true
    setPosting(true)
    void resolve(incidentId, chosen).then((answer) => {
      inFlight.current = false
      setPosting(false)
      setConfirming(false)
      setProblem(answer.outcome === 'told' ? undefined : unrecordedReason(answer))
    })
  }

  const submit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (resolution === undefined) return
    const refusal = incidentResolutionRefusal(incidents, incidentId, resolution)
    if (refusal !== undefined) {
      setProblem(refusal)
      return
    }
    setProblem(undefined)
    if (resolution.outcome === 'end-thread' && !confirming) {
      setConfirming(true)
      return
    }
    post(resolution)
  }

  return (
    <form onSubmit={submit} aria-label={`resolve incident ${incidentId}`} className="grid gap-3">
      <FieldSet>
        <FieldLegend variant="label">Classification</FieldLegend>
        <RadioGroup
          value={classification ?? ''}
          disabled={posting}
          onValueChange={(picked: string) => {
            setClassification(ENSO_INCIDENT_CLASSIFICATIONS.find((each) => each === picked))
            setConfirming(false)
          }}
        >
          {ENSO_INCIDENT_CLASSIFICATIONS.map((each) => (
            <Field key={each} orientation="horizontal">
              <RadioGroupItem id={`${idPrefix}-c-${each}`} value={each} />
              <FieldLabel htmlFor={`${idPrefix}-c-${each}`}>{CLASSIFICATION_LABEL[each]}</FieldLabel>
            </Field>
          ))}
        </RadioGroup>
      </FieldSet>
      <FieldSet>
        <FieldLegend variant="label">Outcome</FieldLegend>
        <RadioGroup
          value={outcome ?? ''}
          disabled={posting}
          onValueChange={(picked: string) => {
            setOutcome(ENSO_INCIDENT_OUTCOMES.find((each) => each === picked))
            setConfirming(false)
          }}
        >
          {ENSO_INCIDENT_OUTCOMES.map((each) => (
            <Field key={each} orientation="horizontal">
              <RadioGroupItem id={`${idPrefix}-o-${each}`} value={each} />
              <FieldLabel htmlFor={`${idPrefix}-o-${each}`}>{OUTCOME_LABEL[each]}</FieldLabel>
            </Field>
          ))}
        </RadioGroup>
      </FieldSet>
      {outcome === 'resume-with-restrictions' ? (
        <FieldSet>
          <FieldLegend variant="label">Stay suspended</FieldLegend>
          {ENSO_TOOL_FAMILIES.map((family) => (
            <Field key={family} orientation="horizontal">
              <Checkbox
                id={`${idPrefix}-f-${family}`}
                checked={restricted.includes(family)}
                disabled={posting}
                onCheckedChange={(checked: boolean | 'indeterminate') =>
                  setRestricted(
                    ENSO_TOOL_FAMILIES.filter((each) =>
                      each === family ? checked === true : restricted.includes(each),
                    ),
                  )
                }
              />
              <FieldLabel htmlFor={`${idPrefix}-f-${family}`}>
                {family} ({ENSO_FAMILY_TOOLS[family].join(', ')})
              </FieldLabel>
            </Field>
          ))}
        </FieldSet>
      ) : null}
      {problem === undefined ? null : (
        <p role="alert" className="text-sm text-refuse">
          {problem}
        </p>
      )}
      {confirming ? (
        <div className="grid gap-2">
          <p className="text-sm font-medium">
            Ending the thread is final: every tool family stays suspended and it takes no new prompts. It can still be
            forked.
          </p>
          <div className="flex gap-2">
            <Button type="submit" variant="destructive" disabled={posting}>
              End the thread
            </Button>
            <Button type="button" variant="outline" disabled={posting} onClick={() => setConfirming(false)}>
              Back
            </Button>
          </div>
        </div>
      ) : (
        <Button type="submit" className="justify-self-start" disabled={posting || resolution === undefined}>
          Record resolution
        </Button>
      )}
    </form>
  )
}

export interface IncidentCardProps {
  readonly record: EnsoIncidentRecord
  /** The thread's whole incident state — the form checks a resolution against it. */
  readonly incidents: EnsoSessionIncidents
  /** Post a resolution — the thread connection's `resolveIncident`. */
  readonly resolve: (incidentId: string, resolution: EnsoIncidentResolution) => Promise<IncidentResolveOutcome>
}

export function IncidentCard({ record, incidents, resolve }: IncidentCardProps): React.ReactNode {
  const titleId = useId()
  const { opened } = record
  const open = openIncidentOf(incidents) === record
  return (
    <article
      aria-labelledby={titleId}
      data-incident-id={opened.incidentId}
      className={
        open
          ? 'my-2 grid max-w-3xl overflow-hidden rounded-lg border border-refuse bg-card ledger:rounded-xs ink:border-2'
          : 'my-2 grid max-w-3xl overflow-hidden rounded-lg border bg-card ledger:rounded-xs'
      }
    >
      <header className="flex flex-wrap items-center gap-2 px-3 py-2">
        <h2
          id={titleId}
          className="inline-flex items-center gap-1.5 text-xs font-semibold tracking-wider text-refuse uppercase"
        >
          <SirenIcon aria-hidden="true" className="size-4 shrink-0" />
          Incident {opened.incidentId}
        </h2>
        <span className="font-mono text-xs text-muted-foreground">{stateWord(record)}</span>
      </header>
      {opened.inheritedFrom === undefined ? null : (
        <p className="border-t px-3 py-2 text-sm">
          Inherited: this thread came from thread {opened.inheritedFrom.threadId}, whose incident{' '}
          {opened.inheritedFrom.incidentId} was open. Each thread is resolved on its own.
        </p>
      )}
      <Section title="Observed">
        <Observed record={record} />
      </Section>
      <Section title="Inferred risk">
        <p className="text-sm">
          <span className="font-mono text-refuse">incident</span> — the risk fold's inference from the signals above, on
          thresholds that are not calibrated (#468). A level, not a verdict.
        </p>
      </Section>
      <Section title="Suspended tools">
        <Suspended record={record} />
      </Section>
      {record.resolutions.length === 0 ? null : (
        <Section title="Resolutions">
          <Resolutions resolutions={record.resolutions} />
        </Section>
      )}
      {takesResolution(record, incidents) ? (
        <Section title={open ? 'Resolve' : 'Change what stays suspended'}>
          <ResolveForm record={record} incidents={incidents} resolve={resolve} />
        </Section>
      ) : null}
      <p className="border-t px-3 py-2 font-mono text-xs text-muted-foreground">recorded in the session file</p>
    </article>
  )
}

/**
 * The thread's incidents, at the chat's tail (#466). The transcript renders messages, not the
 * session's custom entries, so an incident has no position among them to sit at; it sits where a
 * question does, below the run, where the person looking at a halted thread is.
 */
export function ThreadIncidents(): React.ReactNode {
  const stores = useThreadStores()
  const incidents = useStore(stores.incidents)
  if (incidents.incidents.length === 0) return null
  return (
    <>
      {incidents.incidents.map((record) => (
        <IncidentCard
          key={record.opened.incidentId}
          record={record}
          incidents={incidents}
          resolve={stores.connection.resolveIncident}
        />
      ))}
    </>
  )
}
