import { type Static, Type } from 'typebox'
import { EnsoOpenDialog } from './dialog.ts'
import { EnsoLoginInProgress, EnsoObservation } from './observation.ts'
import { EnsoPermissionModeState } from './permission-mode.ts'
import { EnsoProviderRefusal } from './provider-refusal.ts'
import { EnsoSessionIncidents } from './session-incident.ts'
import { EnsoSessionRiskChange } from './session-risk.ts'
import { EnsoInterruptedTail, EnsoStoppedAfter } from './thread-inspection.ts'
import { EnsoModelState, EnsoPromptAdmission, EnsoRecordedModel, EnsoSessionUsage } from './thread-runtime.ts'

/**
 * The server↔browser wire (#112): a thread's feed, as the follow route serves it.
 *
 * Every follow opens with exactly one `snapshot` — the thread as of `asOfSeq` — and then
 * carries only `observation` frames (each `seq` greater than the last) and `status`
 * frames (the thread's lifecycle as the server sees it). A reconnect is a new follow and
 * a new snapshot; there is no cursor to resume from, because the snapshot IS the resync
 * (deepseek-harness: one complete snapshot per generation, then only deltas).
 *
 * The payload is `EnsoObservation` — the same layer the event tails and the debug pane
 * reason in. AG-UI is not on this wire; a browser adapter derives it if a renderer wants it
 * (`docs/architecture.md`, decided constraints).
 *
 * @group Follow wire
 */
export const EnsoFollowSnapshot = Type.Object(
  {
    type: Type.Literal('snapshot'),
    threadId: Type.String(),
    /** The feed's position this snapshot is exact as of; every later observation's `seq` is greater. */
    asOfSeq: Type.Integer({ minimum: 0 }),
    /** A pi session exists for the thread on this server. False: served cold from the file, or empty. */
    live: Type.Boolean(),
    busy: Type.Boolean(),
    /** See `EnsoThreadSummary.generation`. */
    generation: Type.Integer({ minimum: 0 }),
    permissionMode: EnsoPermissionModeState,
    /** The session's risk as of this snapshot (#464); a rise arrives later as an `enso-session-risk` custom entry. */
    sessionRisk: EnsoSessionRiskChange,
    /** The session's incidents as of this snapshot (#466); an opening or a resolution arrives later as its custom entry. */
    incidents: EnsoSessionIncidents,
    /** The session's model and thinking level (#338 slice 2); `null` when the thread is not live — nothing is built to say what pi would run. */
    model: Type.Union([EnsoModelState, Type.Null()]),
    /** What a NOT-live thread's branch records it last ran on (#434); absent when live, or when the branch records neither. */
    recordedModel: Type.Optional(EnsoRecordedModel),
    /**
     * The tree pi reads and writes for this thread (#44), AS OF THIS SNAPSHOT — the live session's
     * own cwd; when the thread is not live, the stored session's (pi fixed it at creation); and
     * for a thread with neither, its project's (#395), where it will be built — or `''` when that
     * project has been removed, so it will be built nowhere (its prompt is refused). Not re-sent when a
     * session is built mid-follow. ⚠ Since #551 a new thread on a tree of its own is built in that
     * tree, not its project's directory, so until the next snapshot this still names the project;
     * `tree` below says it from the start. What makes a wrong-project session visible.
     *
     * ⚠ Adding a field here is wire-breaking for an OPEN TAB: the schema is closed, so a page and
     * server of different versions reject each other's snapshots. The page says so and asks for a
     * reload (`follow-connection.ts`) rather than going quietly stale.
     */
    cwd: Type.String(),
    /**
     * Whether this thread runs on a tree of its own (#551) — its branch records one, or, for a
     * thread not built yet, the host gives new threads in its project one. Where it is not, there
     * is no file to restore, and the page offers no restore (PR #561 review). Stable over a follow,
     * unlike `cwd`: a new thread's tree is decided before it is built.
     */
    tree: Type.Boolean(),
    /**
     * What the session has spent and how full its context is (#45), as of this snapshot — pi's
     * totals from the live session, or from the file when the thread is not live (then with no
     * `context`). Later changes arrive as `session-usage` observations, each the whole state.
     */
    usage: EnsoSessionUsage,
    /**
     * How many messages the branch holds — what says the thread has been seen with messages (#659).
     * ⚠ NOT the messages (#739): the page mounts them from `/history`, which pages a long branch, so
     * a follow that carried them too sent the whole transcript a second time on every open — 15 MB
     * twice at 5,000 turns.
     */
    messageCount: Type.Integer({ minimum: 0 }),
    /**
     * The refusal the branch's last assistant message is (#381), absent when it is none: the status
     * bar's refusal word on a resync. A refusal followed by a reply is history, not the thread's state.
     */
    trailingRefusal: Type.Optional(EnsoProviderRefusal),
    /** Every question pi is blocked on right now, oldest first (#114). Empty when not live. */
    openDialogs: Type.Array(EnsoOpenDialog),
    interrupted: Type.Optional(EnsoInterruptedTail),
    /** Where the branch's runs were stopped (#766), oldest first; absent when none was — see `EnsoStoppedAfter`. */
    stoppedAfter: Type.Optional(EnsoStoppedAfter),
    /** A login waiting on its provider (#348), which Stop can end; absent when none is. */
    login: Type.Optional(EnsoLoginInProgress),
  },
  { additionalProperties: false },
)
/** @group Follow wire */
export type EnsoFollowSnapshot = Static<typeof EnsoFollowSnapshot>

/** @group Follow wire */
export const EnsoFollowObservation = Type.Object(
  {
    type: Type.Literal('observation'),
    seq: Type.Integer({ minimum: 1 }),
    observation: EnsoObservation,
  },
  { additionalProperties: false },
)
/** @group Follow wire */
export type EnsoFollowObservation = Static<typeof EnsoFollowObservation>

/** @group Follow wire */
export const EnsoFollowStatus = Type.Object(
  {
    type: Type.Literal('status'),
    live: Type.Boolean(),
    busy: Type.Boolean(),
    generation: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
)
/** @group Follow wire */
export type EnsoFollowStatus = Static<typeof EnsoFollowStatus>

/** @group Follow wire */
export const EnsoFollowFrame = Type.Union([EnsoFollowSnapshot, EnsoFollowObservation, EnsoFollowStatus])
/** @group Follow wire */
export type EnsoFollowFrame = Static<typeof EnsoFollowFrame>

/**
 * The image types the Anthropic wire accepts (#68).
 *
 * pi documents no limit of its own and passes the bytes through; anything outside this set
 * would be refused by the provider after the upload, with a worse message than ours.
 *
 * @group Follow wire
 */
export const EnsoImageMimeType = Type.Union([
  Type.Literal('image/png'),
  Type.Literal('image/jpeg'),
  Type.Literal('image/gif'),
  Type.Literal('image/webp'),
])
/** @group Follow wire */
export type EnsoImageMimeType = Static<typeof EnsoImageMimeType>
/**
 * The same set as a list — the form's `accept`, the notice's wording. ⚠ Derived from the schema, not written twice.
 *
 * @group Follow wire
 */
export const ENSO_IMAGE_MIME_TYPES: readonly EnsoImageMimeType[] = EnsoImageMimeType.anyOf.map(
  (literal) => literal.const,
)
/**
 * Narrows a mime string the browser reported (`File.type`, a `data:` URL's head) to the kinds the wire takes — no cast.
 *
 * @group Follow wire
 */
export function isEnsoImageMimeType(value: string): value is EnsoImageMimeType {
  return (ENSO_IMAGE_MIME_TYPES as readonly string[]).includes(value)
}
/**
 * Anthropic's per-image cap, decoded bytes. Checked on the decoded size, not the base64 length.
 *
 * @group Follow wire
 */
export const ENSO_IMAGE_MAX_BYTES = 5 * 1024 * 1024
/**
 * Images on one prompt. Claude.ai's own composer stops at 20; a pasted batch rarely nears this.
 *
 * @group Follow wire
 */
export const ENSO_PROMPT_MAX_IMAGES = 20
/**
 * The most a prompt body may be on the wire: every image at its cap in base64 (4/3 of the
 * bytes, rounded up to a 4-byte group), plus room for the text.
 *
 * The route stops READING at this size rather than buffering first and refusing after.
 *
 * @group Follow wire
 */
export const ENSO_PROMPT_BODY_MAX_BYTES: number =
  ENSO_PROMPT_MAX_IMAGES * Math.ceil(ENSO_IMAGE_MAX_BYTES / 3) * 4 + 1024 * 1024

/**
 * The base64 alphabet with trailing `=` padding — what `btoa` and `FileReader.readAsDataURL`
 * produce. Never a `data:` URI. ⚠ Deliberately NOT the grouped grammar
 * `(?:[…]{4})*(?:[…]{2}==|[…]{3}=)?`: on a 5 MB image the grouped form costs ~300 ms of
 * event-loop time in V8, this one ~4 ms, and for a length that is a multiple of four the two
 * accept exactly the same strings. The length check is `isWholeBase64`, applied by the
 * reader beside the byte cap (PR #140 review, measured).
 */
const BASE64 = '^[A-Za-z0-9+/]*={0,2}$'

/**
 * With `BASE64`, strict standard base64: whole 4-character groups, the last padded to four.
 *
 * Refused as "not base64" rather than decoded leniently into a truncated image.
 *
 * @group Follow wire
 */
export function isWholeBase64(data: string): boolean {
  return data.length % 4 === 0
}

/**
 * One image on a prompt (#68): the bytes, base64, and what they are.
 *
 * Not TanStack's `ImagePart` — that union admits a `url` source, and a server-side fetch is
 * egress the guards do not cover (`web_fetch`'s allowlist is the only sanctioned fetch path,
 * #54), so the browser resolves every attachment to bytes before it crosses and a URL cannot
 * arrive.
 *
 * @group Follow wire
 */
export const EnsoPromptImage = Type.Object(
  {
    // ⚠ A spelled-out tuple, not `Type.Union(list.map(...))`: TypeBox's static type of a union
    // over a non-tuple array is `never`, which every cast in the browser then satisfied silently.
    mimeType: EnsoImageMimeType,
    data: Type.String({ minLength: 1, pattern: BASE64 }),
  },
  { additionalProperties: false },
)
/** @group Follow wire */
export type EnsoPromptImage = Static<typeof EnsoPromptImage>

/**
 * What `POST /api/threads/:id/prompt` takes. The shape is checked here; the byte cap is checked on the decoded size by the route.
 *
 * @group Follow wire
 */
export const EnsoPromptBody = Type.Object(
  {
    message: Type.String(),
    admission: Type.Optional(EnsoPromptAdmission),
    images: Type.Optional(Type.Array(EnsoPromptImage, { minItems: 1, maxItems: ENSO_PROMPT_MAX_IMAGES })),
  },
  { additionalProperties: false },
)
/** @group Follow wire */
export type EnsoPromptBody = Static<typeof EnsoPromptBody>

/**
 * Decoded size of a base64 string, without decoding it: three bytes per four characters, less the padding.
 *
 * @group Follow wire
 */
export function base64DecodedBytes(data: string): number {
  let padding = 0
  if (data.endsWith('==')) padding = 2
  else if (data.endsWith('=')) padding = 1
  return Math.floor((data.length * 3) / 4) - padding
}

/**
 * What `POST /api/threads/:id/prompt` answers with: ADMISSION, not a result.
 *
 * A run is not one prompt's reply — interrupting prompts, enqueued ones and retries can all
 * land inside it — so the receipt names the message and the acquisition it took or queued
 * behind, and the follow carries everything after (deepseek-harness: `followup()` returns
 * void).
 *
 * @group Follow wire
 */
export const EnsoPromptReceipt = Type.Object(
  {
    threadId: Type.String(),
    /** Minted at admission — the identity a client correlates this message by. */
    messageId: Type.String(),
    /** The acquisition this prompt took, or the one it queued behind. */
    generation: Type.Integer({ minimum: 0 }),
    /** The thread was busy: pi queued the message behind the run in flight (#75). */
    queued: Type.Boolean(),
  },
  { additionalProperties: false },
)
/** @group Follow wire */
export type EnsoPromptReceipt = Static<typeof EnsoPromptReceipt>

/**
 * What `POST /api/threads/:id/abort` answers with when pi was told (#116, #75): the prompts
 * that were WAITING behind the stopped run, in order, the interrupting ones first — cleared from the
 * queue and handed back so the stopping tab can put them in its composer (pi's TUI does the
 * same).
 *
 * Never delivered silently on the next turn, never dropped. Empty when nothing waited. The
 * run's own end still arrives on the follow.
 *
 * @group Follow wire
 */
export const EnsoAbortReceipt = Type.Object(
  {
    threadId: Type.String(),
    restored: Type.Array(Type.String()),
  },
  { additionalProperties: false },
)
/** @group Follow wire */
export type EnsoAbortReceipt = Static<typeof EnsoAbortReceipt>
