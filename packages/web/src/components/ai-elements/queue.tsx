/**
 * Vendored from vercel/ai-elements — `packages/elements/src/queue.tsx`
 * at 6a9d5b1822ffb10bba4bd97175f01edd7d8651cd. Apache-2.0. See README.md here.
 *
 * Modified — this file is a deliberate SUBSET (the prompt-queue shell, #75):
 * - kept `Queue`, `QueueSection`, `QueueSectionTrigger`, `QueueSectionLabel`,
 *   `QueueSectionContent`, `QueueList`, `QueueItem`, `QueueItemIndicator`,
 *   `QueueItemContent`. Removed `QueueItemDescription`, `QueueItemActions`/`QueueItemAction`
 *   (pi's queue has no per-item cancel — a stop clears it whole and hands the texts back),
 *   `QueueItemAttachment`/`QueueItemImage`/`QueueItemFile` (attachments are #68), and the
 *   `QueueMessage`/`QueueMessagePart`/`QueueTodo` types that fed them — the queued items here
 *   are pi's texts, `string[]` on the wire (`ZenQueue`)
 * - `QueueList` renders a plain scrolling `div` instead of shadcn's `ScrollArea`, which this
 *   repo has not adopted (`components/ui/` has no scroll-area); `max-h-40 overflow-y-auto`
 *   gives the same bound
 * - `@repo/shadcn-ui/...` imports → `@/` aliases; removed `"use client"` (Vite SPA)
 */

import { ChevronDownIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible.tsx";
import { cn } from "@/lib/utils.ts";

export type QueueItemProps = ComponentProps<"li">;

export const QueueItem = ({ className, ...props }: QueueItemProps): React.ReactNode => (
	<li
		className={cn("group flex flex-col gap-1 rounded-md px-3 py-1 text-sm transition-colors hover:bg-muted", className)}
		{...props}
	/>
);

export type QueueItemIndicatorProps = ComponentProps<"span"> & {
	completed?: boolean;
};

export const QueueItemIndicator = ({ completed = false, className, ...props }: QueueItemIndicatorProps): React.ReactNode => (
	<span
		className={cn(
			"mt-0.5 inline-block size-2.5 rounded-full border",
			completed ? "border-muted-foreground/20 bg-muted-foreground/10" : "border-muted-foreground/50",
			className,
		)}
		{...props}
	/>
);

export type QueueItemContentProps = ComponentProps<"span"> & {
	completed?: boolean;
};

export const QueueItemContent = ({ completed = false, className, ...props }: QueueItemContentProps): React.ReactNode => (
	<span
		className={cn(
			"line-clamp-1 grow break-words",
			completed ? "text-muted-foreground/50 line-through" : "text-muted-foreground",
			className,
		)}
		{...props}
	/>
);

export type QueueListProps = ComponentProps<"div">;

export const QueueList = ({ children, className, ...props }: QueueListProps): React.ReactNode => (
	<div className={cn("-mb-1 mt-2 max-h-40 overflow-y-auto pr-4", className)} {...props}>
		<ul>{children}</ul>
	</div>
);

export type QueueSectionProps = ComponentProps<typeof Collapsible>;

export const QueueSection = ({ className, defaultOpen = true, ...props }: QueueSectionProps): React.ReactNode => (
	<Collapsible className={cn(className)} defaultOpen={defaultOpen} {...props} />
);

export type QueueSectionTriggerProps = ComponentProps<"button">;

export const QueueSectionTrigger = ({ children, className, ...props }: QueueSectionTriggerProps): React.ReactNode => (
	<CollapsibleTrigger asChild>
		<button
			className={cn(
				"group flex w-full items-center justify-between rounded-md bg-muted/40 px-3 py-2 text-left font-medium text-muted-foreground text-sm transition-colors hover:bg-muted",
				className,
			)}
			type="button"
			{...props}
		>
			{children}
		</button>
	</CollapsibleTrigger>
);

export type QueueSectionLabelProps = ComponentProps<"span"> & {
	count?: number;
	label: string;
	icon?: React.ReactNode;
};

export const QueueSectionLabel = ({ count, label, icon, className, ...props }: QueueSectionLabelProps): React.ReactNode => (
	<span className={cn("flex items-center gap-2", className)} {...props}>
		<ChevronDownIcon className="size-4 transition-transform group-data-[state=closed]:-rotate-90" />
		{icon}
		<span>
			{count} {label}
		</span>
	</span>
);

export type QueueSectionContentProps = ComponentProps<typeof CollapsibleContent>;

export const QueueSectionContent = ({ className, ...props }: QueueSectionContentProps): React.ReactNode => (
	<CollapsibleContent className={cn(className)} {...props} />
);

export type QueueProps = ComponentProps<"div">;

export const Queue = ({ className, ...props }: QueueProps): React.ReactNode => (
	<div
		className={cn("flex flex-col gap-2 rounded-xl border border-border bg-background px-3 pt-2 pb-2 shadow-xs", className)}
		{...props}
	/>
);
