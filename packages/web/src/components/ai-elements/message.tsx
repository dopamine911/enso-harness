/**
 * Vendored from vercel/ai-elements — `packages/elements/src/message.tsx`
 * at 6a9d5b1822ffb10bba4bd97175f01edd7d8651cd. Apache-2.0. See README.md here.
 *
 * Modified — this file is a deliberate SUBSET (35 of 360 upstream lines):
 * - kept `Message` + `MessageContent` only. Removed `MessageResponse` (it renders via
 *   streamdown, which this repo dropped — text renders through TanStack's `TextPart`,
 *   whose sanitize-LAST chain was the reason it was adopted), the seven `MessageBranch*`
 *   components (no branch UI here), `MessageActions`/`MessageAction`, `MessageToolbar`
 * - `from` is typed as a local role union instead of `UIMessage["role"]` from the Vercel
 *   AI SDK — the upstream type resolves to a string union anyway (see README rule 4)
 * - `@repo/shadcn-ui/...` imports → `@/` aliases; removed `"use client"` (Vite SPA)
 */
import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils.ts";

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
	from: "user" | "assistant" | "system";
};

export const Message = ({ className, from, ...props }: MessageProps) => (
	<div
		className={cn(
			"group flex w-full max-w-[95%] flex-col gap-2",
			from === "user" ? "is-user ml-auto justify-end" : "is-assistant",
			className,
		)}
		{...props}
	/>
);

export type MessageContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageContent = ({ children, className, ...props }: MessageContentProps) => (
	<div
		className={cn(
			"is-user:dark flex w-fit min-w-0 max-w-full flex-col gap-2 overflow-hidden text-sm",
			"group-[.is-user]:ml-auto group-[.is-user]:rounded-lg group-[.is-user]:bg-secondary group-[.is-user]:px-4 group-[.is-user]:py-3 group-[.is-user]:text-foreground",
			"group-[.is-assistant]:text-foreground",
			className,
		)}
		{...props}
	>
		{children}
	</div>
);
