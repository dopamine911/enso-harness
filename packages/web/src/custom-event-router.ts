import { ZenNotifyType } from "@zen/core";
import { Check } from "typebox/value";
import { applyZenCustomEntry } from "./mode-lines.ts";
import { pushZenNotification } from "./notifications.tsx";
import { applyZenPermissionMode, applyZenPersistedModeEntry } from "./permission-mode.tsx";
import {
	ZEN_CUSTOM_EVENT_ENTRY,
	ZEN_CUSTOM_EVENT_MODE,
	ZEN_CUSTOM_EVENT_NOTIFY,
	ZEN_CUSTOM_EVENT_USAGE,
} from "./rpc/custom-event-names.ts";
import { applyZenMessageUsage } from "./session-stats.tsx";

/**
 * The browser's ONE path from an AG-UI CUSTOM chunk to the three module-level stores
 * (mode lines, session stats, notifications). TanStack's `onCustomEvent` fires this with
 * `(chunk.name, chunk.value)` for every CUSTOM chunk — verified against its stream
 * processor (#29).
 *
 * Extracted from `chat-screen.tsx`'s chat options so it can be TESTED (#53 S1.3): as an
 * inline closure on an options object, renaming a chunk name, dropping the notify-type
 * allowlist, or swapping two `apply*` calls all left the suite green. The tests drive this
 * function directly and read the stores' snapshots.
 *
 * ⚠ Every value is read defensively, the way every wire crossing in the browser is: a
 * malformed value renders as nothing rather than throwing inside TanStack's stream loop,
 * where a throw would end the run. Chunk names this surface does not render
 * (`zen.unmapped`) fall through untouched — see the mapper for why they exist at all.
 */
export function routeZenCustomEvent(eventType: string, data: unknown): void {
	if (eventType === ZEN_CUSTOM_EVENT_ENTRY) {
		// One persisted entry, two views (#84): the transcript line (history) and the
		// current-mode store (state). Both read picc's shape through the same core helper.
		applyZenCustomEntry(data);
		applyZenPersistedModeEntry(data);
		return;
	}
	if (eventType === ZEN_CUSTOM_EVENT_MODE) {
		applyZenPermissionMode(data);
		return;
	}
	if (eventType === ZEN_CUSTOM_EVENT_USAGE) {
		applyZenMessageUsage(data);
		return;
	}
	if (eventType !== ZEN_CUSTOM_EVENT_NOTIFY) return;
	if (typeof data !== "object" || data === null) return;
	const observation = data as { message?: unknown; notifyType?: unknown };
	if (typeof observation.message !== "string") return;
	// The three declared notify types come from the schema, not a second literal list: an
	// unrecognised value degrades to an untyped notification, never a validation failure.
	const notifyType = Check(ZenNotifyType, observation.notifyType) ? observation.notifyType : undefined;
	pushZenNotification(observation.message, notifyType);
}
