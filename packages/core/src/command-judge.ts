import { type Static, Type } from 'typebox'
import { Compile } from 'typebox/compile'
import { ENSO_JUDGE_SCOPE_REASONS, type EnsoJudgeContext, type EnsoJudgeScopeReason } from './session-risk.ts'

/**
 * The command judge (#469, phase 6 of #189): a second sensor on `bash`, behind one seam with
 * several backends. Off by default. It reads a command the guards' spelling checks let through and
 * answers four questions about it; it never allows or blocks by itself.
 *
 * - **The seam is the questions, not a transport.** Every backend answers `risk`, `obscured`,
 *   `unresolved` and `same_as_denied` with a value, and a confidence where it has one — so a
 *   replay compares backends on the same cases. Today both ask them through pi's classifier
 *   runtime (#535): Jev as typed questions, a local llama.cpp model from its label probabilities.
 * - **Recorded, nothing more (#469 PR1).** A judgement is an `enso-command-judgement` entry and a
 *   log line. ⚠ It feeds no risk signal and asks nothing until a replay over real sessions sets
 *   the thresholds: a signal enters the risk fold, and the fold can open and halt an incident.
 * - **Redacted before it leaves** (`@enso/core/judge`, node-only). Known secret values,
 *   secret-shaped assignments and flags, `Authorization` headers and token shapes become markers
 *   in every string the judge is sent. Paths stay: `private.env` is not a secret, and it is what
 *   the judge has to see. A file whose path looks like a secret is never read for its contents.
 * - **The barrel half is pure** — the questions, the config, the record — so the page can read a
 *   judgement; redaction and script resolution are a node-only subpath, and the backends live in
 *   the guards extension, the one place pi's libraries may be named.
 *
 * @group Command judge
 */

/**
 * The four questions every backend answers (the #189 spike's tuned set). `risk`, `unresolved` and
 * `same_as_denied` are 0–1; `obscured` is a level, 0 (spelled out) to 3 (hidden from a reader).
 * `same_as_denied` is asked only when a refusal precedes the call.
 *
 * @group Command judge
 */
export const ENSO_JUDGE_QUESTIONS = ['risk', 'obscured', 'unresolved', 'same_as_denied'] as const

/** @group Command judge */
export type EnsoJudgeQuestion = (typeof ENSO_JUDGE_QUESTIONS)[number]

/**
 * The backends `security.judge.backend` names. `off` is the default and sends nothing; `jev` sends
 * the redacted state to TypeSafe; `local` to a llama.cpp model on this machine (#532), never
 * further.
 *
 * @group Command judge
 */
export const ENSO_JUDGE_BACKENDS = ['off', 'jev', 'local'] as const

/** @group Command judge */
export type EnsoJudgeBackend = (typeof ENSO_JUDGE_BACKENDS)[number]

/**
 * The secrets-file name the `jev` backend's key is read under (`ENSO_HOME/secrets.env`), per call.
 * Settings › Security stores it there and only ever says whether it is set (#933).
 *
 * @group Command judge
 */
export const ENSO_JUDGE_KEY_NAME = 'TYPESAFE_API_KEY'

/** Hosts that are this machine, as `URL` spells them: a `local` judge sends nothing anywhere else. */
const LOCAL_JUDGE_HOSTS: Readonly<Record<string, true>> = { '127.0.0.1': true, localhost: true, '[::1]': true }

/**
 * Why `baseUrl` cannot be the `local` judge's address, or `undefined` when it can: an http(s) URL
 * on a loopback host. The one test both the guard (which judges nothing at any other address) and
 * Settings › Security (which refuses to save one, #933) apply, so the page cannot accept an
 * address the judge then ignores.
 *
 * @group Command judge
 */
export function localJudgeUrlProblem(baseUrl: string): string | undefined {
  if (!URL.canParse(baseUrl)) return `the local judge's URL is not a URL: ${baseUrl}`
  const url = new URL(baseUrl)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `the local judge's URL must be http(s), not ${url.protocol}`
  }
  if (!Object.hasOwn(LOCAL_JUDGE_HOSTS, url.hostname)) {
    return `the local judge must run on this machine (a loopback address), not ${url.hostname}`
  }
  return undefined
}

/**
 * `config.json`'s `security.judge` (#469), user-only as the rest of `security` is: a project cannot
 * switch a judge on, or off, for the user. Scope 1 (around a guard) is the only scope until #469's
 * escalation lands. `local` names the llama.cpp router (a loopback URL) and the model the `local`
 * backend asks.
 *
 * @group Command judge
 */
export const EnsoJudgeConfig = Type.Object(
  {
    backend: Type.Optional(
      Type.Unsafe<EnsoJudgeBackend>(Type.Union(ENSO_JUDGE_BACKENDS.map((backend) => Type.Literal(backend)))),
    ),
    local: Type.Optional(
      Type.Object(
        { baseUrl: Type.String({ minLength: 1 }), model: Type.String({ minLength: 1 }) },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
)

/** @group Command judge */
export type EnsoJudgeConfig = Static<typeof EnsoJudgeConfig>

/**
 * The standing policy the judge reads the command against: Enso's own protections. The refusal
 * that precedes a call (`denied`) supplies the specifics.
 *
 * @group Command judge
 */
export const ENSO_JUDGE_POLICY =
  'An Enso coding session in `cwd`. Protected: credentials and secret files (`.env`, keys, tokens, ' +
  'cloud and SSH credentials) must not be read, printed, encoded or sent anywhere; the session, log ' +
  "and permission records under ENSO_HOME (`.enso`) and the guards' and permission engine's " +
  'configuration must not be edited, deleted or weakened; network clients (curl, wget, fetch from ' +
  'an interpreter) are refused, and web access goes through the web_fetch tool; work outside the ' +
  "project's directory, and deleting work that is not generated, needs the user's say-so. Reading, " +
  'searching, building and testing the project, and removing generated files (build output, caches), ' +
  'are ordinary work.'

/**
 * What a backend is asked about: the command, where it runs, the policy, the contents of what it
 * runs (`files`, by name), the calls before it, and the refusal it follows. Every string redacted
 * (`redactJudgeState`) before a backend sees it. One schema, so the route's payload and the
 * backend's input cannot drift apart.
 *
 * @group Command judge
 */
const EnsoJudgeState = Type.Object(
  {
    cwd: Type.String(),
    policy: Type.String(),
    command: Type.String(),
    files: Type.Optional(Type.Record(Type.String(), Type.String())),
    recentCalls: Type.Optional(
      Type.Array(
        Type.Object(
          {
            tool: Type.String(),
            command: Type.Optional(Type.String()),
            path: Type.Optional(Type.String()),
            refused: Type.Boolean(),
          },
          { additionalProperties: false },
        ),
      ),
    ),
    denied: Type.Optional(
      Type.Object({ command: Type.String(), reason: Type.String() }, { additionalProperties: false }),
    ),
  },
  { additionalProperties: false },
)
/** @group Command judge */
export type EnsoJudgeState = Static<typeof EnsoJudgeState>

const Answer = Type.Object(
  { value: Type.Number(), confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })) },
  { additionalProperties: false },
)
/** @group Command judge */
export type EnsoJudgeAnswer = Static<typeof Answer>

const Usage = Type.Object(
  { inputTokens: Type.Integer({ minimum: 0 }), outputTokens: Type.Integer({ minimum: 0 }) },
  { additionalProperties: false },
)

/**
 * What a backend answers: each question it was asked, or why it judged nothing — a timeout, an
 * error, a reply it could not read, or no key. ⚠ An unjudged call is recorded as such, never as
 * a clean one.
 *
 * @group Command judge
 */
export type EnsoJudgeOutcome =
  | {
      readonly kind: 'judged'
      readonly model: string
      readonly answers: Partial<Record<EnsoJudgeQuestion, EnsoJudgeAnswer>>
      readonly usage?: Static<typeof Usage>
    }
  | { readonly kind: 'unjudged'; readonly reason: string }

/**
 * A backend, behind the seam. `judge` never throws: a failure is an `unjudged` outcome.
 *
 * @group Command judge
 */
export interface CommandJudge {
  readonly backend: Exclude<EnsoJudgeBackend, 'off'>
  judge(state: EnsoJudgeState, signal?: AbortSignal): Promise<EnsoJudgeOutcome>
}

/**
 * The `customType` of a judgement's record, appended by the guards extension once the backend
 * has answered.
 *
 * @group Command judge
 */
export const ENSO_COMMAND_JUDGEMENT_ENTRY = 'enso-command-judgement' as const

const Scope = Type.Unsafe<EnsoJudgeScopeReason>(
  Type.Union(ENSO_JUDGE_SCOPE_REASONS.map((reason) => Type.Literal(reason))),
)

/**
 * A judgement as recorded: the call, why it was in scope, the backend, how long it took, and the
 * answers — or why there are none. The command itself is the call's, on the branch beside it.
 *
 * @group Command judge
 */
export const EnsoCommandJudgement = Type.Union([
  Type.Object(
    {
      kind: Type.Literal('judged'),
      toolCallId: Type.String({ minLength: 1 }),
      scope: Scope,
      backend: Type.String({ minLength: 1 }),
      model: Type.String({ minLength: 1 }),
      latencyMs: Type.Integer({ minimum: 0 }),
      answers: Type.Partial(
        Type.Object({ risk: Answer, obscured: Answer, unresolved: Answer, same_as_denied: Answer }),
        { additionalProperties: false },
      ),
      usage: Type.Optional(Usage),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal('unjudged'),
      toolCallId: Type.String({ minLength: 1 }),
      scope: Scope,
      backend: Type.String({ minLength: 1 }),
      latencyMs: Type.Integer({ minimum: 0 }),
      reason: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
])
/** @group Command judge */
export type EnsoCommandJudgement = Static<typeof EnsoCommandJudgement>

const judgementValidator = Compile(EnsoCommandJudgement)

/**
 * The judgement a custom entry records, or undefined when it is another's or malformed.
 *
 * @group Command judge
 */
export function readEnsoCommandJudgement(customType: string, data: unknown): EnsoCommandJudgement | undefined {
  return customType === ENSO_COMMAND_JUDGEMENT_ENTRY && judgementValidator.Check(data) ? data : undefined
}

/**
 * One thread's judge cases for `bun run judge` (#469), from `GET /api/threads/:id/judge-cases`:
 * each call the judge would be asked about, why it is in scope, and the REDACTED state a backend
 * would be sent — the replay's input, seen before anything is sent.
 *
 * @group Command judge
 */
export const EnsoThreadJudgeCases = Type.Object(
  {
    threadId: Type.String({ minLength: 1 }),
    live: Type.Boolean(),
    cases: Type.Array(
      Type.Object(
        { toolCallId: Type.String({ minLength: 1 }), scope: Scope, state: EnsoJudgeState },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
)
/** @group Command judge */
export type EnsoThreadJudgeCases = Static<typeof EnsoThreadJudgeCases>

const threadJudgeCasesValidator = Compile(EnsoThreadJudgeCases)

/**
 * The payload as `EnsoThreadJudgeCases`, or undefined when it is not one — what the CLI reads.
 *
 * @group Command judge
 */
export function readEnsoThreadJudgeCases(payload: unknown): EnsoThreadJudgeCases | undefined {
  return threadJudgeCasesValidator.Check(payload) ? payload : undefined
}

/**
 * The record of what a backend answered for a call — the one the live guard appends.
 *
 * @group Command judge
 */
export function commandJudgementOf(
  context: Pick<EnsoJudgeContext, 'toolCallId' | 'reason'>,
  backend: string,
  latencyMs: number,
  outcome: EnsoJudgeOutcome,
): EnsoCommandJudgement {
  const base = { toolCallId: context.toolCallId, scope: context.reason, backend, latencyMs: Math.round(latencyMs) }
  if (outcome.kind === 'unjudged') return { kind: 'unjudged', ...base, reason: outcome.reason }
  return {
    kind: 'judged',
    ...base,
    model: outcome.model,
    answers: outcome.answers,
    ...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
  }
}
