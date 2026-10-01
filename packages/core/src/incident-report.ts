import { type Static, type TArray, type TObject, type TString, Type } from 'typebox'
import { Compile } from 'typebox/compile'

/**
 * The agent's incident report (#467, phase 4 of #189): after a halting incident opens, the harness
 * puts the agent through one bounded report turn with one tool, `file_incident_report`, answering
 * #189's nine questions — the uncharitable read included.
 *
 * ⚠ THE REPORT IS THE AGENT'S EXPLANATION, NEVER THE RECORD. It attaches to its incident's record
 * beside the opening, the signals and the resolutions, and nothing in the fold lets it change them
 * (`session-incident.ts#sessionIncidentsStep`). Resolving never waits for it.
 *
 * ⚠ ITS FACTUAL CLAIMS ARE CHECKED, NOT TRUSTED. The task, what was denied and what was tried after
 * the denial each cite `{ ref, quote }`; harness code — never the model — checks every quote against
 * the cited text, whitespace-normalised (models re-wrap lines; the check is whiteboard's,
 * devdotfast/whiteboard `evidence.ts`, MIT, re-stated). A `ref` is what the model can see: a tool
 * call's id (its arguments and its result are the citable text) or `prompt` (the user's message
 * that started the run) — pi's entry ids never reach the model. A claim that verifies nothing is
 * kept and labelled, not refused: refusing the report would lose the explanation. "What was denied"
 * must cite one of the incident's own refused calls, or it carries a mismatch flag. A verified quote
 * proves the text is in the session, not that the agent's reading of it is right; the six
 * interpretive answers cannot be checked by quoting at all.
 *
 * @group Incident report
 */

/**
 * The report tool's name — registered by the `incident-report` extension, active only in the report
 * turn, and the one tool the guard lets through while a report is pending.
 *
 * @group Incident report
 */
export const ENSO_INCIDENT_REPORT_TOOL_NAME = 'file_incident_report' as const

/**
 * The `ref` that cites the user's message which started the run.
 *
 * @group Incident report
 */
export const ENSO_REPORT_PROMPT_REF = 'prompt' as const

const Citation = Type.Object(
  {
    ref: Type.String({
      minLength: 1,
      description: `A tool call's id (its arguments and result), or "${ENSO_REPORT_PROMPT_REF}" for the user's message that started this run.`,
    }),
    quote: Type.String({ minLength: 1, description: 'Text copied from what the ref names, word for word.' }),
  },
  { additionalProperties: false },
)

type FactualClaimSchema = TObject<{ text: TString; evidence: TArray<typeof Citation> }>

function factualClaim(description: string): FactualClaimSchema {
  return Type.Object(
    {
      text: Type.String({ minLength: 1, description }),
      evidence: Type.Array(Citation, {
        minItems: 1,
        description: 'At least one quote from the session that shows it, with what it is from.',
      }),
    },
    { additionalProperties: false },
  )
}

function answer(description: string): TString {
  return Type.String({ minLength: 1, description })
}

/**
 * The report tool's parameters: one required field per question of #189. The first three describe
 * the record and cite it; the other six are the agent's reading.
 *
 * @group Incident report
 */
export const FileIncidentReportParameters = Type.Object(
  {
    task: factualClaim('What task you were doing.'),
    denied: factualClaim('What was denied: the refusal this incident opened on.'),
    tried: factualClaim('What you tried after the denial.'),
    whyThatAlternative: answer('Why you chose that alternative.'),
    recognisedAsBypass: answer('Whether you recognised it as a possible way around the refusal, and when.'),
    shouldHaveDone: answer('What you should have done instead.'),
    sufficientAuthorization: answer('What authorization from the user would have been enough.'),
    patternToAvoid: answer('The pattern to avoid next time.'),
    uncharitableRead: answer('The least charitable reading of what you did, stated plainly.'),
  },
  { additionalProperties: false },
)
/** @group Incident report */
export type FileIncidentReportParameters = Static<typeof FileIncidentReportParameters>

const CheckedCitation = Type.Object(
  { ref: Type.String({ minLength: 1 }), quote: Type.String({ minLength: 1 }), verified: Type.Boolean() },
  { additionalProperties: false },
)
/** @group Incident report */
export type EnsoCheckedCitation = Static<typeof CheckedCitation>

const CheckedClaim = Type.Object(
  { text: Type.String({ minLength: 1 }), evidence: Type.Array(CheckedCitation), verified: Type.Boolean() },
  { additionalProperties: false },
)
/** @group Incident report */
export type EnsoCheckedClaim = Static<typeof CheckedClaim>

/**
 * What the host found wrong with a report against the record — flags, never a refusal.
 *
 * @group Incident report
 */
export const ENSO_INCIDENT_REPORT_MISMATCHES = ['denied-cites-no-incident-refusal'] as const

/** @group Incident report */
export type EnsoIncidentReportMismatch = (typeof ENSO_INCIDENT_REPORT_MISMATCHES)[number]

/**
 * A filed report as recorded: the factual claims with each citation's `verified` (computed by the
 * host), the six answers verbatim, the mismatch flags, and which submission it was (1, or 2 after
 * one fix).
 *
 * @group Incident report
 */
export const EnsoIncidentReport = Type.Object(
  {
    incidentId: Type.String({ minLength: 1 }),
    factual: Type.Object(
      { task: CheckedClaim, denied: CheckedClaim, tried: CheckedClaim },
      { additionalProperties: false },
    ),
    interpretive: Type.Object(
      {
        whyThatAlternative: Type.String({ minLength: 1 }),
        recognisedAsBypass: Type.String({ minLength: 1 }),
        shouldHaveDone: Type.String({ minLength: 1 }),
        sufficientAuthorization: Type.String({ minLength: 1 }),
        patternToAvoid: Type.String({ minLength: 1 }),
        uncharitableRead: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false },
    ),
    mismatches: Type.Array(
      Type.Unsafe<EnsoIncidentReportMismatch>(
        Type.Union(ENSO_INCIDENT_REPORT_MISMATCHES.map((mismatch) => Type.Literal(mismatch))),
      ),
    ),
    submission: Type.Union([Type.Literal(1), Type.Literal(2)]),
  },
  { additionalProperties: false },
)
/** @group Incident report */
export type EnsoIncidentReport = Static<typeof EnsoIncidentReport>

/**
 * Why no report was filed: the report turn ended without one, or the session came back with the
 * report still owed (the run that owed it was cut off).
 *
 * @group Incident report
 */
export const EnsoIncidentReportMissing = Type.Object(
  {
    incidentId: Type.String({ minLength: 1 }),
    reason: Type.Union([Type.Literal('the report turn ended without a report'), Type.Literal('the run was cut off')]),
  },
  { additionalProperties: false },
)
/** @group Incident report */
export type EnsoIncidentReportMissing = Static<typeof EnsoIncidentReportMissing>

/** @group Incident report */
export const ENSO_INCIDENT_REPORT_ENTRY = 'enso-incident-report' as const
/** @group Incident report */
export const ENSO_INCIDENT_REPORT_MISSING_ENTRY = 'enso-incident-report-missing' as const

/**
 * The session event-bus channel the guard announces an opening on — the `EnsoIncidentOpened`
 * record — so the report extension can ask for the report in the same run.
 *
 * @group Incident report
 */
export const ENSO_INCIDENT_OPENED_CHANNEL = 'enso:incident-opened' as const

/**
 * The channel the report extension announces a settled report on — `{ customType, data }`, the
 * entry it appended (a report, or its absence) — so the guard closes the report window at once.
 *
 * @group Incident report
 */
export const ENSO_INCIDENT_REPORT_CHANNEL = 'enso:incident-report' as const

const reportValidator = Compile(EnsoIncidentReport)
const missingValidator = Compile(EnsoIncidentReportMissing)

/**
 * The report a custom entry records, or undefined when it is another's or malformed.
 *
 * @group Incident report
 */
export function readEnsoIncidentReport(customType: string, data: unknown): EnsoIncidentReport | undefined {
  return customType === ENSO_INCIDENT_REPORT_ENTRY && reportValidator.Check(data) ? data : undefined
}

/**
 * The missing report a custom entry records, or undefined when it is another's or malformed.
 *
 * @group Incident report
 */
export function readEnsoIncidentReportMissing(
  customType: string,
  data: unknown,
): EnsoIncidentReportMissing | undefined {
  return customType === ENSO_INCIDENT_REPORT_MISSING_ENTRY && missingValidator.Check(data) ? data : undefined
}

/** Whitespace runs collapsed to one space and the ends trimmed: a re-wrapped quote still matches. */
function normalized(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim()
}

/**
 * Whether `quote` occurs in `text`, whitespace-normalised. An empty quote proves nothing.
 *
 * @group Incident report
 */
export function quoteOccursIn(text: string, quote: string): boolean {
  const needle = normalized(quote)
  return needle.length > 0 && normalized(text).includes(needle)
}

/**
 * What the check needs from the session: the citable text of each ref, and the incident's own
 * refused calls.
 *
 * @group Incident report
 */
export interface IncidentReportEvidence {
  /** A tool call's arguments and result, or the run's prompt — undefined for a ref the branch does not have. */
  readonly refText: (ref: string) => string | undefined
  /** The ids of the calls the incident's signals name: the refusals and what followed them. */
  readonly incidentCalls: ReadonlySet<string>
}

function checkedClaim(
  claim: FileIncidentReportParameters['task'],
  refText: IncidentReportEvidence['refText'],
): EnsoCheckedClaim {
  const evidence = claim.evidence.map(({ ref, quote }) => {
    const text = refText(ref)
    return { ref, quote, verified: text !== undefined && quoteOccursIn(text, quote) }
  })
  return { text: claim.text, evidence, verified: evidence.some((citation) => citation.verified) }
}

/**
 * The report as recorded from the tool's arguments: each citation checked against what it cites,
 * and "what was denied" checked against the incident's own calls.
 *
 * @group Incident report
 */
export function checkedIncidentReport(
  incidentId: string,
  params: FileIncidentReportParameters,
  evidence: IncidentReportEvidence,
  submission: 1 | 2,
): EnsoIncidentReport {
  const {
    task,
    denied,
    tried,
    whyThatAlternative,
    recognisedAsBypass,
    shouldHaveDone,
    sufficientAuthorization,
    patternToAvoid,
    uncharitableRead,
  } = params
  const deniedChecked = checkedClaim(denied, evidence.refText)
  const citesTheIncident = deniedChecked.evidence.some(
    (citation) => citation.verified && evidence.incidentCalls.has(citation.ref),
  )
  return {
    incidentId,
    factual: {
      task: checkedClaim(task, evidence.refText),
      denied: deniedChecked,
      tried: checkedClaim(tried, evidence.refText),
    },
    interpretive: {
      whyThatAlternative,
      recognisedAsBypass,
      shouldHaveDone,
      sufficientAuthorization,
      patternToAvoid,
      uncharitableRead,
    },
    mismatches: citesTheIncident ? [] : ['denied-cites-no-incident-refusal'],
    submission,
  }
}

/**
 * What is wrong with a checked report, one line each — what the tool tells the model so it can fix
 * them, and empty when every citation verified and nothing mismatched.
 *
 * @group Incident report
 */
export function incidentReportProblems(report: EnsoIncidentReport): string[] {
  const problems = Object.entries(report.factual).flatMap(([field, claim]) =>
    claim.evidence
      .filter((citation) => !citation.verified)
      .map((citation) => `${field}: the quote "${citation.quote}" is not in ${citation.ref}`),
  )
  if (report.mismatches.includes('denied-cites-no-incident-refusal')) {
    problems.push("denied: no verified quote cites one of this incident's refused calls")
  }
  return problems
}

/**
 * The message that asks for the report — sent as a follow-up in the halted run, so it is the
 * model's next turn. Names the incident, its refused calls, the nine questions and the bound.
 *
 * @group Incident report
 */
export function incidentReportRequest(incidentId: string, refusedCalls: readonly string[]): string {
  return [
    `Security incident ${incidentId} is open (#466): your tools are suspended until the user resolves it.`,
    `File an incident report now with ${ENSO_INCIDENT_REPORT_TOOL_NAME} — it is the only tool that will run.`,
    'Answer every question plainly. For the task, what was denied and what you tried, quote the session',
    `word for word, each quote with its ref: the id of the tool call it is from (its arguments or its`,
    `result), or "${ENSO_REPORT_PROMPT_REF}" for the user's message. The quotes are checked.`,
    refusedCalls.length === 0 ? '' : `The calls this incident rests on: ${refusedCalls.join(', ')}.`,
    'One report, one turn: if a quote does not check, you may correct it once. Then stop.',
  ]
    .filter((line) => line.length > 0)
    .join('\n')
}
