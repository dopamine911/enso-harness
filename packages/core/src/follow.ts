import { type Static, Type } from 'typebox'
import { ZenOpenDialog } from './dialog.ts'
import { ZenObservation } from './observation.ts'
import { ZenPermissionModeState } from './permission-mode.ts'
import { ZenInterruptedTail } from './thread-inspection.ts'
import { ZenPromptAdmission } from './thread-runtime.ts'

/**
 * The server↔browser wire (#112): a thread's feed, as the follow route serves it.
 *
 * Every follow opens with exactly one `snapshot` — the thread as of `asOfSeq` — and then
 * carries only `observation` frames (each `seq` greater than the last) and `status`
 * frames (the thread's lifecycle as the server sees it). A reconnect is a new follow and
 * a new snapshot; there is no cursor to resume from, because the snapshot IS the resync
 * (deepseek-harness: one complete snapshot per generation, then only deltas).
 *
 * The payload is `ZenObservation` — the same layer the event tails and the debug pane
 * reason in. AG-UI is not on this wire; a browser adapter derives it if a renderer wants it
 * (`docs/architecture.md`, decided constraints).
 *
 * @group Follow wire
 */
export const ZenFollowSnapshot = Type.Object(
  {
    type: Type.Literal('snapshot'),
    threadId: Type.String(),
    /** The feed's position this snapshot is exact as of; every later observation's `seq` is greater. */
    asOfSeq: Type.Integer({ minimum: 0 }),
    /** A pi session exists for the thread on this server. False: served cold from the file, or empty. */
    live: Type.Boolean(),
    busy: Type.Boolean(),
    /** See `ZenThreadSummary.generation`. */
    generation: Type.Integer({ minimum: 0 }),
    permissionMode: ZenPermissionModeState,
    /** The branch as TanStack `UIMessage`s — `Unknown` because the shape is the renderer's, not zen's. */
    messages: Type.Array(Type.Unknown()),
    /** Every question pi is blocked on right now, oldest first (#114). Empty when not live. */
    openDialogs: Type.Array(ZenOpenDialog),
    interrupted: Type.Optional(ZenInterruptedTail),
  },
  { additionalProperties: false },
)
/** @group Follow wire */
export type ZenFollowSnapshot = Static<typeof ZenFollowSnapshot>

/** @group Follow wire */
export const ZenFollowObservation = Type.Object(
  {
    type: Type.Literal('observation'),
    seq: Type.Integer({ minimum: 1 }),
    observation: ZenObservation,
  },
  { additionalProperties: false },
)
/** @group Follow wire */
export type ZenFollowObservation = Static<typeof ZenFollowObservation>

/** @group Follow wire */
export const ZenFollowStatus = Type.Object(
  {
    type: Type.Literal('status'),
    live: Type.Boolean(),
    busy: Type.Boolean(),
    generation: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
)
/** @group Follow wire */
export type ZenFollowStatus = Static<typeof ZenFollowStatus>

/** @group Follow wire */
export const ZenFollowFrame = Type.Union([ZenFollowSnapshot, ZenFollowObservation, ZenFollowStatus])
/** @group Follow wire */
export type ZenFollowFrame = Static<typeof ZenFollowFrame>

/**
 * The image types the Anthropic wire accepts (#68).
 *
 * pi documents no limit of its own and passes the bytes through; anything outside this set
 * would be refused by the provider after the upload, with a worse message than ours.
 *
 * @group Follow wire
 */
export const ZenImageMimeType = Type.Union([
  Type.Literal('image/png'),
  Type.Literal('image/jpeg'),
  Type.Literal('image/gif'),
  Type.Literal('image/webp'),
])
/** @group Follow wire */
export type ZenImageMimeType = Static<typeof ZenImageMimeType>
/**
 * The same set as a list — the form's `accept`, the notice's wording. ⚠ Derived from the schema, not written twice.
 *
 * @group Follow wire
 */
export const ZEN_IMAGE_MIME_TYPES: readonly ZenImageMimeType[] = ZenImageMimeType.anyOf.map((literal) => literal.const)
/**
 * Narrows a mime string the browser reported (`File.type`, a `data:` URL's head) to the kinds the wire takes — no cast.
 *
 * @group Follow wire
 */
export function isZenImageMimeType(value: string): value is ZenImageMimeType {
  return (ZEN_IMAGE_MIME_TYPES as readonly string[]).includes(value)
}
/**
 * Anthropic's per-image cap, decoded bytes. Checked on the decoded size, not the base64 length.
 *
 * @group Follow wire
 */
export const ZEN_IMAGE_MAX_BYTES = 5 * 1024 * 1024
/**
 * Images on one prompt. Claude.ai's own composer stops at 20; a pasted batch rarely nears this.
 *
 * @group Follow wire
 */
export const ZEN_PROMPT_MAX_IMAGES = 20
/**
 * The most a prompt body may be on the wire: every image at its cap in base64 (4/3 of the
 * bytes, rounded up to a 4-byte group), plus room for the text.
 *
 * The route stops READING at this size rather than buffering first and refusing after.
 *
 * @group Follow wire
 */
export const ZEN_PROMPT_BODY_MAX_BYTES: number =
  ZEN_PROMPT_MAX_IMAGES * Math.ceil(ZEN_IMAGE_MAX_BYTES / 3) * 4 + 1024 * 1024

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
export const ZenPromptImage = Type.Object(
  {
    // ⚠ A spelled-out tuple, not `Type.Union(list.map(...))`: TypeBox's static type of a union
    // over a non-tuple array is `never`, which every cast in the browser then satisfied silently.
    mimeType: ZenImageMimeType,
    data: Type.String({ minLength: 1, pattern: BASE64 }),
  },
  { additionalProperties: false },
)
/** @group Follow wire */
export type ZenPromptImage = Static<typeof ZenPromptImage>

/**
 * What `POST /api/threads/:id/prompt` takes. The shape is checked here; the byte cap is checked on the decoded size by the route.
 *
 * @group Follow wire
 */
export const ZenPromptBody = Type.Object(
  {
    message: Type.String(),
    admission: Type.Optional(ZenPromptAdmission),
    images: Type.Optional(Type.Array(ZenPromptImage, { minItems: 1, maxItems: ZEN_PROMPT_MAX_IMAGES })),
  },
  { additionalProperties: false },
)
/** @group Follow wire */
export type ZenPromptBody = Static<typeof ZenPromptBody>

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
export const ZenPromptReceipt = Type.Object(
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
export type ZenPromptReceipt = Static<typeof ZenPromptReceipt>

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
export const ZenAbortReceipt = Type.Object(
  {
    threadId: Type.String(),
    restored: Type.Array(Type.String()),
  },
  { additionalProperties: false },
)
/** @group Follow wire */
export type ZenAbortReceipt = Static<typeof ZenAbortReceipt>
