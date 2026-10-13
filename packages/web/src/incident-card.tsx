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
  type EnsoCheckedClaim,
  type EnsoIncidentReport,
  ENSO_REPORT_PROMPT_REF,
  type EnsoSessionIncidents,
  type EnsoToolFamily,
  incidentResolutionRefusal,
  openIncidentOf,
  reportOwedOf,
  tippingCallOf,
} from '@enso/core'
import type { UIMessage } from '@tanstack/ai-client'
import { SirenIcon } from 'lucide-react'
import { createContext, useCallback, useContext, useId, useRef, useState } from 'react'
import { Button } from './components/ui/button.tsx'
import { Checkbox } from './components/ui/checkbox.tsx'
import { Field, FieldLabel, FieldLegend, FieldSet } from './components/ui/field.tsx'
import { RadioGroup, RadioGroupItem } from './components/ui/radio-group.tsx'
import type { IncidentResolveOutcome } from './follow-connection.ts'
import { cn } from './lib/utils.ts'
import { PILL } from './step-pill.ts'
import { useStore, useThreadStores } from './store.ts'
import { ringElement } from './transcript-reveal.ts'
import { LabelValues } from './view-parts.tsx'

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
    <section aria-labelledby={headingId} className="grid gap-2 border-t p-3">
      <h3 id={headingId} className="text-detail font-semibold text-muted-foreground">
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
          <LabelValues
            className={FACTS}
            rows={[
              ['signal', signal.signal],
              ['on call', signal.toolCallId],
              ['after', signal.after.length === 0 ? '—' : signal.after.join(', ')],
            ]}
          />
          <p className="text-sm break-words">{signal.detail}</p>
        </li>
      ))}
    </ul>
  )
}

/** An incident's facts, as the debug pane's label/value pairs (#417), packed tighter and a size down. */
const FACTS = 'gap-y-0.5 text-detail'

function Suspended({ record }: { readonly record: EnsoIncidentRecord }): React.ReactNode {
  const { suspended } = record.opened
  if (suspended.length === 0) {
    return <p className="text-sm">nothing suspended — halting is off (security.incidents.halt)</p>
  }
  return (
    <>
      <LabelValues
        className={FACTS}
        rows={suspended.map((family) => [family, ENSO_FAMILY_TOOLS[family].join(', ')] as const)}
      />
      {/* The opening's record, never rewritten: once resolved, what stays is the resolution's. */}
      {record.resolutions.length === 0 ? null : (
        <p className="text-xs text-muted-foreground">
          suspended when it opened — the last resolution below says what stays suspended
        </p>
      )}
    </>
  )
}

/** The six interpretive questions of #189 in the reader's words, in the report's order (#467). */
const ANSWER_LABEL: Readonly<Record<keyof EnsoIncidentReport['interpretive'], string>> = {
  whyThatAlternative: 'Why that alternative',
  recognisedAsBypass: 'Recognised as a way around it?',
  shouldHaveDone: 'What it should have done',
  sufficientAuthorization: 'Authorization that would have been enough',
  patternToAvoid: 'Pattern to avoid',
  uncharitableRead: 'The uncharitable read',
}

/**
 * One factual claim and its citations (#467). ⚠ "verified" is said in words: it means the quote is
 * in the cited text, not that the agent's reading of it is right, and colour alone would hide that.
 * The ref is not linked: the transcript's tool rows carry no per-call anchor to link to.
 */
function Claim({
  label,
  claim,
  flag,
}: {
  readonly label: string
  readonly claim: EnsoCheckedClaim
  readonly flag?: string | undefined
}): React.ReactNode {
  return (
    <li className="grid gap-0.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm break-words">{claim.text}</p>
      {flag === undefined ? null : <p className="text-xs text-refuse">{flag}</p>}
      <ul className="grid gap-0.5 pl-3">
        {claim.evidence.map((citation) => (
          <li key={`${citation.ref}:${citation.quote}`} className="text-xs break-words">
            <q>{citation.quote}</q> —{' '}
            {citation.ref === ENSO_REPORT_PROMPT_REF ? 'the prompt' : <span className="font-mono">{citation.ref}</span>}{' '}
            · {citation.verified ? 'verified' : 'unverified'}
          </li>
        ))}
      </ul>
    </li>
  )
}

function Report({ report }: { readonly report: EnsoIncidentReport }): React.ReactNode {
  const deniedFlag = report.mismatches.includes('denied-cites-no-incident-refusal')
    ? "does not cite the incident's refusals"
    : undefined
  return (
    <>
      {report.submission === 2 ? <p className="text-xs text-muted-foreground">filed after one correction</p> : null}
      <ul className="grid gap-2">
        <Claim label="Task" claim={report.factual.task} />
        <Claim label="What was denied" claim={report.factual.denied} flag={deniedFlag} />
        <Claim label="What was tried" claim={report.factual.tried} />
      </ul>
      <dl className="grid gap-1.5">
        {Object.entries(ANSWER_LABEL).map(([key, question]) => (
          <div key={key}>
            <dt className="text-xs text-muted-foreground">{question}</dt>
            <dd className="text-sm break-words">{report.interpretive[key as keyof typeof ANSWER_LABEL]}</dd>
          </div>
        ))}
      </dl>
    </>
  )
}

/**
 * The agent's account of the incident (#467), its own section after the record so it is never
 * read as part of it. Nothing when no report was ever asked for (halting off, or resolved first).
 */
function Explanation({
  record,
  incidents,
}: {
  readonly record: EnsoIncidentRecord
  readonly incidents: EnsoSessionIncidents
}): React.ReactNode {
  let body: React.ReactNode
  if (record.report !== undefined) body = <Report report={record.report} />
  else if (record.reportMissing !== undefined)
    body = <p className="text-sm">no report filed — {record.reportMissing.reason}</p>
  else if (reportOwedOf(incidents) === record)
    body = <p className="text-sm">report pending — the agent is asked for one</p>
  else return null
  return (
    <Section title="The agent's explanation">
      <p className="text-xs text-muted-foreground">the agent's account of what happened — not the record</p>
      {body}
    </Section>
  )
}

function Resolutions({ resolutions }: { readonly resolutions: readonly EnsoIncidentResolved[] }): React.ReactNode {
  return (
    <ol className="grid gap-1.5">
      {resolutions.map((resolution, index) => (
        // Append-only (core `resolve` only ever pushes), never reordered or filtered, and every row carries the
        // same `incidentId` — the position is the only identity a resolution has.
        // react-doctor-disable-next-line no-array-index-as-key
        <li key={index}>
          <LabelValues
            className={FACTS}
            rows={[
              ['judged', CLASSIFICATION_LABEL[resolution.classification]],
              ['outcome', resolution.outcome],
              ['suspended', resolution.suspended.length === 0 ? 'nothing' : resolution.suspended.join(', ')],
            ]}
          />
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

/** One question of the form: a legend and one radio per option, each with its label. */
function RadioChoice<Option extends string>({
  legend,
  options,
  labels,
  chosen,
  disabled,
  idPrefix,
  onPick,
}: {
  readonly legend: string
  readonly options: readonly Option[]
  readonly labels: Readonly<Record<Option, string>>
  readonly chosen: Option | undefined
  readonly disabled: boolean
  readonly idPrefix: string
  readonly onPick: (picked: Option | undefined) => void
}): React.ReactNode {
  return (
    <FieldSet>
      <FieldLegend variant="label">{legend}</FieldLegend>
      <RadioGroup
        value={chosen ?? ''}
        disabled={disabled}
        onValueChange={(picked: string) => onPick(options.find((each) => each === picked))}
      >
        {options.map((each) => (
          <Field key={each} orientation="horizontal">
            <RadioGroupItem id={`${idPrefix}-${each}`} value={each} />
            <FieldLabel htmlFor={`${idPrefix}-${each}`}>{labels[each]}</FieldLabel>
          </Field>
        ))}
      </RadioGroup>
    </FieldSet>
  )
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
      <RadioChoice
        legend="Classification"
        options={ENSO_INCIDENT_CLASSIFICATIONS}
        labels={CLASSIFICATION_LABEL}
        chosen={classification}
        disabled={posting}
        idPrefix={`${idPrefix}-c`}
        onPick={(picked) => {
          setClassification(picked)
          setConfirming(false)
        }}
      />
      <RadioChoice
        legend="Outcome"
        options={ENSO_INCIDENT_OUTCOMES}
        labels={OUTCOME_LABEL}
        chosen={outcome}
        disabled={posting}
        idPrefix={`${idPrefix}-o`}
        onPick={(picked) => {
          setOutcome(picked)
          setConfirming(false)
        }}
      />
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

/**
 * The incident a reveal from the tail pointer waits on (#588): its card, drawn only once the windowed
 * list scrolls its message into view, rings itself as it mounts and clears this. Provided by the
 * thread's layout; none outside a pane.
 */
export const IncidentRevealContext = createContext<{ current: string | undefined } | null>(null)

export function IncidentCard({ record, incidents, resolve }: IncidentCardProps): React.ReactNode {
  const titleId = useId()
  const { opened } = record
  const open = openIncidentOf(incidents) === record
  const pendingReveal = useContext(IncidentRevealContext)
  const ringIfRevealed = useCallback(
    (element: HTMLElement | null) => {
      if (element === null || pendingReveal?.current !== opened.incidentId) return
      pendingReveal.current = undefined
      ringElement(element)
    },
    [pendingReveal, opened.incidentId],
  )
  return (
    <article
      ref={ringIfRevealed}
      aria-labelledby={titleId}
      data-incident-id={opened.incidentId}
      // The transcript's card language (#417): a step row's 40px header with the state as a pill —
      // in the refusal colour while it is the open one — then its sections under hairlines.
      className={
        open
          ? 'my-3 grid overflow-hidden rounded-lg border border-refuse bg-card ledger:rounded-xs ink:border-2'
          : 'my-3 grid overflow-hidden rounded-lg border bg-card ledger:rounded-xs'
      }
    >
      <header className="flex min-h-10 flex-wrap items-center gap-2 px-3 py-2">
        <h2 id={titleId} className="inline-flex items-center gap-2 text-detail font-semibold text-refuse">
          <SirenIcon aria-hidden="true" className="size-4 shrink-0" />
          Incident {opened.incidentId}
        </h2>
        <span className={cn(PILL, 'ml-auto', open ? 'text-refuse' : 'text-muted-foreground')}>{stateWord(record)}</span>
      </header>
      {opened.inheritedFrom === undefined ? null : (
        <p className="border-t p-3 text-sm">
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
      <Explanation record={record} incidents={incidents} />
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
      <p className="border-t px-3 py-2 font-mono text-meta text-muted-foreground">recorded in the session file</p>
    </article>
  )
}

/** The open incident of a halted thread whose card reads above the tail, and the row it follows. */
export interface IncidentPointer {
  readonly incidentId: string
  /** The position, in the loaded transcript, of the message the card follows. */
  readonly row: number
}

/**
 * The thread's incident cards by where they read (#588), as `placeLines` places its lines (#382):
 * each after the message holding its tipping call, the rest at the tail.
 */
export interface PlacedIncidents {
  readonly after: ReadonlyMap<string, readonly EnsoIncidentRecord[]>
  readonly tail: readonly EnsoIncidentRecord[]
  readonly pointer: IncidentPointer | undefined
}

const NOTHING_PLACED: PlacedIncidents = { after: new Map(), tail: [], pointer: undefined }

/** Where each tipping call is in the loaded transcript: its message's id and position. */
function tippingCallHolders(
  records: readonly EnsoIncidentRecord[],
  messages: readonly UIMessage[],
): ReadonlyMap<string, { readonly messageId: string; readonly row: number }> {
  const wanted = new Set<string>()
  for (const record of records) {
    const call = tippingCallOf(record.opened.signals)
    if (call !== undefined) wanted.add(call)
  }
  const holders = new Map<string, { readonly messageId: string; readonly row: number }>()
  for (const [row, message] of messages.entries()) {
    for (const part of message.parts) {
      if (part.type === 'tool-call' && wanted.has(part.id)) holders.set(part.id, { messageId: message.id, row })
    }
  }
  return holders
}

/**
 * Each incident card after the message whose parts hold its tipping call — the record's own
 * `signals`, live (`sessionIncidentsStep`) and on reload (the snapshot's fold) alike, so no message
 * id is persisted for it. A card whose call the loaded transcript does not hold reads at the tail:
 * an inherited incident (no signals), a call compacted away, or one on a page not loaded yet — it
 * moves up once "Load earlier" brings that page, as a waiting line does.
 *
 * DECISION (#588): the OPEN incident of a HALTED thread also keeps a pointer at the tail (`pointer`),
 * just above the composer, while its card reads further up — a long transcript must never hide why
 * the thread is suspended. A resolved incident, or an alert-only one (halting off), has none, nor
 * does a card that already reads at the tail.
 *
 * ⚠ Placed from the messages, not the selection's id set: the call can stream into a message the
 * set already holds, and the record can land in the same render as that chunk.
 */
export function placeIncidents(state: EnsoSessionIncidents, messages: readonly UIMessage[]): PlacedIncidents {
  if (state.incidents.length === 0) return NOTHING_PLACED
  const holders = tippingCallHolders(state.incidents, messages)
  const open = openIncidentOf(state)
  const after = new Map<string, EnsoIncidentRecord[]>()
  const tail: EnsoIncidentRecord[] = []
  let pointer: IncidentPointer | undefined
  for (const record of state.incidents) {
    const call = tippingCallOf(record.opened.signals)
    const holder = call === undefined ? undefined : holders.get(call)
    if (holder === undefined) {
      tail.push(record)
      continue
    }
    const placed = after.get(holder.messageId)
    if (placed === undefined) after.set(holder.messageId, [record])
    else placed.push(record)
    if (record === open && record.opened.halted) pointer = { incidentId: record.opened.incidentId, row: holder.row }
  }
  return { after, tail, pointer }
}

/** Incident cards (#466), where `placeIncidents` put them: after a message, or at the tail. */
export function IncidentCards({ records }: { records: readonly EnsoIncidentRecord[] }): React.ReactNode {
  const stores = useThreadStores()
  const incidents = useStore(stores.incidents)
  if (records.length === 0) return null
  return (
    <>
      {records.map((record) => (
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

/**
 * The tail's word for a halted thread's open incident whose card reads further up (#588): what
 * the thread waits on, and a button that brings the card into view.
 */
export function OpenIncidentPointer({
  pointer,
  reveal,
}: {
  pointer: IncidentPointer | undefined
  reveal: (pointer: IncidentPointer) => void
}): React.ReactNode {
  if (pointer === undefined) return null
  return (
    <p
      data-incident-pointer={pointer.incidentId}
      className="my-3 flex flex-wrap items-center gap-2 rounded-lg border border-refuse bg-card px-3 py-2 text-sm ledger:rounded-xs"
    >
      <SirenIcon aria-hidden="true" className="size-4 shrink-0 text-refuse" />
      <span>
        Incident {pointer.incidentId} is open and halted this thread: its tool families stay suspended until it is
        resolved, on its card above.
      </span>
      <Button type="button" variant="outline" size="sm" onClick={() => reveal(pointer)}>
        Show the incident
      </Button>
    </p>
  )
}
