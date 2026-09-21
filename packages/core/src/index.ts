/**
 * Every TypeBox schema in zen-harness.
 *
 * ⚠ Import from `@zen/core`, never from a module path inside it. The barrel is what makes
 * "is this shape already declared?" answerable with one search — which is the whole reason
 * this package exists, and it stops working the moment consumers reach past it.
 */
// ⚠ NAMED re-exports, not `export *` (noReExportAll): the barrel doubles as the public
// inventory — every shape this package declares is literally listed here. Adding an export
// to a module means adding its name here too; forgetting is caught at the consumer's import.
//
// ⚠ NOTHING `node:`-ONLY IS ON THE BARREL (#211). Tree-shaking does not save a browser
// bundle from a bare `node:fs` specifier — it is resolved at link time, before anything is
// shaken — so `paths.ts` and `secrets.ts` (and `log-process.ts` before them) are subpaths:
// `@zen/core/paths`, `@zen/core/secrets`, `@zen/core/log-process`. The barrel is what the
// browser may import; `test/browser-bundle-gate.test.ts` builds the web surface for the browser
// target and fails if a `node:` module is ever reachable from it again.

export {
  parseZenConfig,
  ZEN_CONFIG_EXAMPLE,
  ZEN_CONFIG_FILENAME,
  ZenConfig,
  type ZenConfigParseResult,
} from './config.ts'
export {
  isZenDialogSpec,
  validateDialogAnswer,
  ZenDialogAnswer,
  ZenDialogSpec,
  ZenOpenDialog,
} from './dialog.ts'
export {
  base64DecodedBytes,
  isWholeBase64,
  isZenImageMimeType,
  ZEN_IMAGE_MAX_BYTES,
  ZEN_IMAGE_MIME_TYPES,
  ZEN_PROMPT_BODY_MAX_BYTES,
  ZEN_PROMPT_MAX_IMAGES,
  ZenAbortReceipt,
  ZenFollowFrame,
  ZenFollowObservation,
  ZenFollowSnapshot,
  ZenFollowStatus,
  ZenImageMimeType,
  ZenPromptBody,
  ZenPromptImage,
  ZenPromptReceipt,
} from './follow.ts'
export {
  DEFAULT_GUARD_POLICY,
  GuardPolicy,
  PERSISTENCE_WRITE_BASENAMES,
  PERSISTENCE_WRITE_DIRECTORIES,
  SECRET_BASENAME_PATTERNS,
  ZEN_PERSISTENCE_WRITE_DIRECTORIES,
} from './guard.ts'
export {
  withZenLogContext,
  ZEN_LOG_ROOT,
  ZEN_REDACT_FIELDS,
  ZEN_REDACTED,
  ZEN_REDACTED_VALUE,
  ZenBrowserLogBatch,
  type ZenLogger,
  type ZenLogLayer,
  ZenLogLine,
  type ZenLogProperties,
  zenLogger,
  zenLogLineOf,
} from './log.ts'
export {
  browserSection,
  buildLogBundle,
  bundleRecordsText,
  isLogBundle,
  redactionManifest,
  type ZenBundleAbout,
  type ZenBundleInputs,
} from './log-bundle.ts'
export {
  ZenCustomEntry,
  ZenDialogOutcome,
  ZenDialogSettled,
  ZenExtensionError,
  ZenExtensionUiRequest,
  ZenMessageEnd,
  ZenMessageStart,
  ZenNotifyType,
  ZenObservation,
  ZenPermissionMode,
  ZenPermissionModeRejected,
  ZenPromptRejected,
  ZenQueue,
  ZenRunEnded,
  ZenSettled,
  ZenTextDelta,
  ZenThinkingDelta,
  ZenToolCall,
  ZenToolResultObservation,
  ZenTurnEnd,
  ZenTurnStart,
  ZenUiRequestOrigin,
  ZenUnmapped,
  ZenUsage,
} from './observation.ts'
export { ZenPermissionModeChange, ZenPermissionModeState } from './permission-mode.ts'
export {
  describeThreadEvent,
  isZenThreadId,
  type ThreadEventColumns,
  threadEventColumns,
  ZenEventProvenance,
  ZenInterruptedTail,
  ZenStoredThread,
  ZenThreadEvent,
  ZenThreadEvents,
  ZenThreadHistory,
  ZenThreadInspection,
  ZenThreadSummary,
} from './thread-inspection.ts'
export {
  type DialogAnswer,
  isRuntimeCommand,
  PromptImageContent,
  type PromptOutcome,
  type PromptRequest,
  RuntimeCommand,
  ThreadRuntime,
  ZenPromptAdmission,
} from './thread-runtime.ts'
export {
  isZenToolResultDescriptor,
  readZenToolResultDescriptor,
  ZEN_TOOL_RESULT_KEY,
  ZenToolResultDescriptor,
  ZenTruncation,
  ZenTruncationUnit,
} from './tool-result.ts'
export {
  describeTranscriptEntry,
  ZenTranscriptCustom,
  ZenTranscriptEntry,
  ZenTranscriptMessage,
  ZenTranscriptOther,
  ZenTranscriptPart,
  ZenTranscriptToolResult,
} from './transcript.ts'
export {
  EXTERNAL_WEB_CONTENT_NOTICE,
  WEB_FETCH_MAX_RESPONSE_BYTES,
  WEB_FETCH_MAX_URL_LENGTH,
  WEB_FETCH_TIMEOUT_MS,
  WEB_FETCH_TOOL_NAME,
  WebFetchConfig,
  WebFetchToolParameters,
} from './web-fetch.ts'
export {
  WEB_SEARCH_TIMEOUT_MS,
  WEB_SEARCH_TOOL_NAME,
  WebSearchConfig,
  WebSearchToolParameters,
} from './web-search.ts'
