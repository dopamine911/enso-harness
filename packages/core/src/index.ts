/**
 * Every TypeBox schema in Enso.
 *
 * ⚠ Import from `@enso/core`, never from a module path inside it. The barrel is what makes
 * "is this shape already declared?" answerable with one search — which is the whole reason
 * this package exists, and it stops working the moment consumers reach past it.
 *
 * @module
 */
// ⚠ NAMED re-exports, not `export *` (noReExportAll): the barrel doubles as the public
// inventory — every shape this package declares is literally listed here. Adding an export
// to a module means adding its name here too; forgetting is caught at the consumer's import.
//
// ⚠ NOTHING `node:`-ONLY IS ON THE BARREL (#211). Tree-shaking does not save a browser
// bundle from a bare `node:fs` specifier — it is resolved at link time, before anything is
// shaken — so `paths.ts` and `secrets.ts` (and `log-process.ts` before them) are subpaths:
// `@enso/core/paths`, `@enso/core/secrets`, `@enso/core/log-process`. The barrel is what the
// browser may import; `test/browser-bundle-gate.test.ts` builds the web surface for the browser
// target and fails if a `node:` module is ever reachable from it again.

export { ASK_USER_TOOL_NAME, AskUserToolParameters } from './ask-user.ts'
export {
  ENSO_CONFIG_EXAMPLE,
  ENSO_CONFIG_FILENAME,
  EnsoConfig,
  type EnsoConfigParseResult,
  parseEnsoConfig,
} from './config.ts'
export {
  EnsoDialogAnswer,
  EnsoDialogSpec,
  EnsoOpenDialog,
  EnsoQuestion,
  EnsoQuestionAnswer,
  type EnsoQuestionnaireResult,
  isEnsoDialogSpec,
  QUESTIONNAIRE_COMPONENT_KEY,
  validateDialogAnswer,
} from './dialog.ts'
export {
  base64DecodedBytes,
  ENSO_IMAGE_MAX_BYTES,
  ENSO_IMAGE_MIME_TYPES,
  ENSO_PROMPT_BODY_MAX_BYTES,
  ENSO_PROMPT_MAX_IMAGES,
  EnsoAbortReceipt,
  EnsoFollowFrame,
  EnsoFollowObservation,
  EnsoFollowSnapshot,
  EnsoFollowStatus,
  EnsoImageMimeType,
  EnsoPromptBody,
  EnsoPromptImage,
  EnsoPromptReceipt,
  isEnsoImageMimeType,
  isWholeBase64,
} from './follow.ts'
export {
  DEFAULT_GUARD_POLICY,
  ENSO_GUARD_RULES,
  ENSO_PERSISTENCE_WRITE_DIRECTORIES,
  type EnsoGuardRule,
  GuardPolicy,
  PERSISTENCE_WRITE_BASENAMES,
  PERSISTENCE_WRITE_DIRECTORIES,
  SECRET_BASENAME_PATTERNS,
} from './guard.ts'
export {
  ENSO_LOG_ROOT,
  ENSO_REDACT_FIELDS,
  ENSO_REDACTED,
  ENSO_REDACTED_VALUE,
  EnsoBrowserLogBatch,
  type EnsoLogger,
  type EnsoLogLayer,
  EnsoLogLine,
  type EnsoLogProperties,
  ensoLogger,
  ensoLogLineOf,
  withEnsoLogContext,
} from './log.ts'
export {
  browserSection,
  buildLogBundle,
  bundleRecordsText,
  type EnsoBundleAbout,
  type EnsoBundleInputs,
  isLogBundle,
  redactionManifest,
} from './log-bundle.ts'
export {
  dayStats,
  ENSO_LOG_EVENTS,
  EnsoDayStats,
  EnsoDurationSummary,
  foldDay,
  mergeDurationSummaries,
} from './log-stats.ts'
export {
  ENSO_LOG_LEVEL_NAMES,
  ENSO_LOG_LEVEL_RANK,
  type EnsoLogFilter,
  type EnsoLogLevelName,
  EnsoLogTailFrame,
  LOG_TAIL_MAX_RECORDS,
  logLineMatches,
  logLineMessageParts,
  logLineText,
  parseLogSince,
} from './log-tail.ts'
export {
  EnsoCustomEntry,
  EnsoDialogOutcome,
  EnsoDialogSettled,
  EnsoExtensionError,
  EnsoExtensionUiRequest,
  EnsoMessageEnd,
  EnsoMessageStart,
  EnsoModelObservation,
  EnsoNotifyType,
  EnsoObservation,
  EnsoPermissionMode,
  EnsoPermissionModeRejected,
  EnsoPromptRejected,
  EnsoQueue,
  EnsoRunEnded,
  EnsoSessionUsageObservation,
  EnsoSettled,
  EnsoTextDelta,
  EnsoThinkingDelta,
  EnsoToolCall,
  EnsoToolResultObservation,
  EnsoTurnEnd,
  EnsoTurnStart,
  EnsoUiRequestOrigin,
  EnsoUnmapped,
  EnsoUsage,
} from './observation.ts'
export { EnsoPermissionModeChange, EnsoPermissionModeState } from './permission-mode.ts'
export {
  ENSO_CONTEXT_ADDITIONS_SHOWN,
  ENSO_CONTEXT_COMMAND,
  ENSO_CONTEXT_IMAGE_PREVIEW_BYTES,
  EnsoContextAddition,
  EnsoContextBody,
  EnsoContextCategory,
  EnsoContextElement,
  EnsoContextEvent,
  EnsoContextEventKind,
  EnsoContextImage,
  EnsoContextMakeup,
  EnsoContextRequest,
  EnsoContextRequestDetail,
  EnsoFileOperation,
  EnsoThreadContext,
} from './thread-context.ts'
export {
  describeThreadEvent,
  EnsoEventProvenance,
  EnsoInterruptedTail,
  EnsoStoredThread,
  EnsoThreadEvent,
  EnsoThreadEvents,
  EnsoThreadHistory,
  EnsoThreadInspection,
  EnsoThreadSummary,
  isEnsoThreadId,
  type ThreadEventColumns,
  threadEventColumns,
} from './thread-inspection.ts'
export {
  type DialogAnswer,
  EnsoContextUsage,
  EnsoHostCommandRun,
  EnsoModelChoice,
  EnsoModelState,
  EnsoPromptAdmission,
  EnsoSessionUsage,
  EnsoThreadCommands,
  HostCommandOption,
  type HostFlowOutcome,
  isRuntimeCommand,
  PromptImageContent,
  type PromptOutcome,
  type PromptRequest,
  RuntimeCommand,
  ThreadRuntime,
} from './thread-runtime.ts'
export { EnsoPromptStats, EnsoThreadStats, EnsoToolCallStats, EnsoTurnStats } from './thread-stats.ts'
export { type EnsoTimelineEntry, threadTimeline, timelineJoinKeys } from './thread-timeline.ts'
export { summarizeToolInput } from './tool-input.ts'
export {
  ENSO_TOOL_RESULT_KEY,
  EnsoToolResultDescriptor,
  EnsoTruncation,
  EnsoTruncationUnit,
  isEnsoToolResultDescriptor,
  readEnsoToolResultDescriptor,
} from './tool-result.ts'
export {
  describeTranscriptEntry,
  EnsoTranscriptCustom,
  EnsoTranscriptEntry,
  EnsoTranscriptMessage,
  EnsoTranscriptOther,
  EnsoTranscriptPart,
  EnsoTranscriptToolResult,
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
