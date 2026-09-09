/**
 * Every TypeBox schema in zen-harness.
 *
 * ⚠ Import from `@zen/core`, never from a module path inside it. The barrel is what makes
 * "is this shape already declared?" answerable with one search — which is the whole reason
 * this package exists, and it stops working the moment consumers reach past it.
 */
// ⚠ NAMED re-exports, not `export *` (noReExportAll): the barrel doubles as the public
// inventory — every shape this package declares is literally listed here — and named lists
// are what lets a bundler tree-shake the web surface. Adding an export to a module means
// adding its name here too; forgetting is caught at the consumer's import, loudly.

export {
	parseZenConfig,
	ZEN_CONFIG_EXAMPLE,
	ZEN_CONFIG_FILENAME,
	ZenConfig,
	type ZenConfigParseResult,
	zenConfigPath,
} from "./config.ts";
export {
	isZenDialogSpec,
	validateDialogAnswer,
	ZenDialogAnswer,
	ZenDialogSpec,
} from "./dialog.ts";
export {
	ZenFollowFrame,
	ZenFollowObservation,
	ZenFollowSnapshot,
	ZenFollowStatus,
	ZenPromptReceipt,
} from "./follow.ts";
export {
	DEFAULT_GUARD_POLICY,
	GuardPolicy,
	PERSISTENCE_WRITE_BASENAMES,
	PERSISTENCE_WRITE_DIRECTORIES,
	SECRET_BASENAME_PATTERNS,
	ZEN_PERSISTENCE_WRITE_DIRECTORIES,
} from "./guard.ts";
export {
	ZenCustomSessionEntry,
	ZenExtensionError,
	ZenExtensionUiRequest,
	ZenMessageEnd,
	ZenMessageStart,
	ZenNotifyType,
	ZenObservation,
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
} from "./observation.ts";
export {
	fileUrlToPath,
	findRepoRoot,
	harnessPackageDir,
	isFileUrl,
	printHarnessDir,
	RepoRootNotFoundError,
	realpathOrSelf,
	rootDotenvPath,
	webPackageDir,
	zenAgentDir,
	zenSecretsPath,
} from "./paths.ts";
export {
	PICC_DEFAULT_PERMISSION_MODE,
	PICC_MODES_CUSTOM_TYPE,
	PICC_PERMISSION_MODES,
	PiPermissionModeState,
	persistedPermissionMode,
	readPiccPersistedMode,
} from "./permission-mode.ts";
export {
	isPiCommand,
	PiCommand,
	type PiDialogResponse,
	type PiEventDelivery,
	PiImageContent,
	type PiPromptOutcome,
	type PiPromptRequest,
	type PiRpcEvent,
	PiRpcEventSchema,
	PiSession,
	PiStreamingBehavior,
} from "./pi-rpc.ts";
export {
	isSecretShapedName,
	parseDotenv,
	type QuarantineReport,
	quarantineSecrets,
	readDotenvFile,
	readSecret,
} from "./secrets.ts";
export {
	describeSessionEntry,
	describeThreadEvent,
	isZenThreadId,
	type ThreadEventColumns,
	threadEventColumns,
	ZenEventProvenance,
	ZenInterruptedTail,
	ZenResumableSession,
	ZenThreadEvent,
	ZenThreadEvents,
	ZenThreadHistory,
	ZenThreadInspection,
	ZenThreadSummary,
} from "./session-inspection.ts";
export {
	isZenToolResultDescriptor,
	readZenToolResultDescriptor,
	ZEN_TOOL_RESULT_KEY,
	ZenToolResultDescriptor,
	ZenTruncation,
	ZenTruncationUnit,
} from "./tool-result.ts";
export {
	EXTERNAL_WEB_CONTENT_NOTICE,
	WEB_FETCH_MAX_RESPONSE_BYTES,
	WEB_FETCH_MAX_URL_LENGTH,
	WEB_FETCH_TIMEOUT_MS,
	WEB_FETCH_TOOL_NAME,
	WebFetchConfig,
	WebFetchToolParameters,
} from "./web-fetch.ts";
export {
	WEB_SEARCH_TIMEOUT_MS,
	WEB_SEARCH_TOOL_NAME,
	WebSearchConfig,
	WebSearchToolParameters,
} from "./web-search.ts";
