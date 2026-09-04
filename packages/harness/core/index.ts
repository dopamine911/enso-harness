/**
 * The harness's own core — path resolution and per-session guard state.
 *
 * ⚠ Schemas are NOT declared here. Every TypeBox schema in this repo lives in `@zen/core`,
 * so that a shape is either declared there or does not exist. Re-exporting them from here
 * would defeat that: a consumer could import `GuardPolicy` from two places and neither
 * import would look wrong.
 *
 * Import schemas from `@zen/core` directly. Import path helpers from here.
 */
// Named for the same reason as @zen/core's barrel: the list IS the public inventory.

export { findDeniedNetworkEgress, type NetworkEgressMatch } from "./network-egress.ts";
export {
	isInsideAnyRoot,
	isInsideRoot,
	isPersistenceWriteTarget,
	isProtectedForWrite,
	looksLikeSecret,
	realpathOfNearestExisting,
	resolveAgainstCwd,
} from "./paths.ts";
export {
	createSessionReadTracker,
	type KnownPathState,
	type SessionReadTracker,
} from "./read-tracker.ts";
export {
	extractFlatShellCommandSegments,
	type FlatShellCommandSegment,
	withoutLeadingEnvironmentAssignments,
} from "./shell-segments.ts";
export { canonicalToolName } from "./tool-identity.ts";
