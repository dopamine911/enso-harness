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
	isZenDialogResumeEntry,
	isZenDialogSpec,
	validateDialogAnswer,
	ZEN_DIALOG_KEY,
	ZenDialogAnswer,
	ZenDialogResumeEntry,
	ZenDialogSpec,
} from "./dialog.ts";
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
	ZenMessageUsage,
	ZenNotifyType,
	ZenObservation,
	ZenRunEnded,
	ZenSettled,
	ZenTextDelta,
	ZenThinkingDelta,
	ZenToolCall,
	ZenToolResultObservation,
	ZenUnmapped,
	ZenUsage,
} from "./observation.ts";
export {
	isPiCommand,
	isPiLaunchConfig,
	PiCommand,
	PiImageContent,
	PiLaunchConfig,
	PiProcessCallbacks,
	PiProcessHandle,
	type PiProcessOptions,
	PiRpcClientOptions,
	type PiRpcCommand,
	type PiRpcCommandInput,
	PiRpcCommandInputSchema,
	PiRpcCommandSchema,
	type PiRpcEvent,
	PiRpcEventSchema,
	type PiRpcRecord,
	type PiRpcResponse,
	PiRpcResponseSchema,
	PiStreamingBehavior,
	PiTransport,
} from "./pi-rpc.ts";
export {
	isZenToolResultDescriptor,
	readZenToolResultDescriptor,
	ZEN_TOOL_RESULT_KEY,
	ZenToolResultDescriptor,
	ZenTruncation,
	ZenTruncationUnit,
} from "./tool-result.ts";
