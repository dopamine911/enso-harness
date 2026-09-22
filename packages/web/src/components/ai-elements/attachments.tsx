/**
 * Vendored from vercel/ai-elements — `packages/elements/src/attachments.tsx`
 * at 6a9d5b1822ffb10bba4bd97175f01edd7d8651cd. Apache-2.0. See README.md here.
 *
 * Modified — this file is a deliberate SUBSET (the composer's attachment strip, #68/#121):
 * - kept `Attachments`, `Attachment`, `AttachmentPreview`, `AttachmentRemove` and their
 *   contexts, in the `grid` variant's shape; the `inline`/`list` variants, `AttachmentInfo`,
 *   `getAttachmentLabel`, and the media-category switch are removed — the only attachment this
 *   composer takes is an image (`ENSO_IMAGE_MIME_TYPES`), so every preview is an `<img>`
 * - removed `AttachmentHoverCard*` (no `hover-card` primitive here; a 96 px thumbnail is
 *   the preview)
 * - `FileUIPart | SourceDocumentUIPart` from the Vercel AI SDK → `PromptAttachment` from
 *   the ported `prompt-input.tsx` (README rule 4)
 * - `@repo/shadcn-ui/...` imports → `@/` aliases; removed `"use client"` (Vite SPA)
 */
import { XIcon } from "lucide-react";
import type { ComponentProps, HTMLAttributes } from "react";
import { createContext, useCallback, useContext, useMemo } from "react";
import { Button } from "@/components/ui/button.tsx";
import { cn } from "@/lib/utils.ts";
import type { PromptAttachment } from "./prompt-input.tsx";

interface AttachmentContextValue {
	data: PromptAttachment;
	onRemove: (() => void) | undefined;
}

const AttachmentContext = createContext<AttachmentContextValue | null>(null);

export const useAttachmentContext = (): AttachmentContextValue => {
	const context = useContext(AttachmentContext);
	if (!context) {
		throw new Error("Attachment components must be used within <Attachment>");
	}
	return context;
};

export type AttachmentsProps = HTMLAttributes<HTMLDivElement>;

export const Attachments = ({ className, children, ...props }: AttachmentsProps): React.ReactNode => (
	<div className={cn("flex flex-wrap items-start gap-2", className)} {...props}>
		{children}
	</div>
);

export type AttachmentProps = HTMLAttributes<HTMLDivElement> & {
	data: PromptAttachment;
	onRemove?: () => void;
};

export const Attachment = ({ data, onRemove, className, children, ...props }: AttachmentProps): React.ReactNode => {
	const contextValue = useMemo<AttachmentContextValue>(() => ({ data, onRemove }), [data, onRemove]);
	return (
		<AttachmentContext.Provider value={contextValue}>
			<div className={cn("group relative size-24 overflow-hidden rounded-lg", className)} {...props}>
				{children}
			</div>
		</AttachmentContext.Provider>
	);
};

export type AttachmentPreviewProps = HTMLAttributes<HTMLDivElement>;

export const AttachmentPreview = ({ className, ...props }: AttachmentPreviewProps): React.ReactNode => {
	const { data } = useAttachmentContext();
	return (
		<div className={cn("flex size-full shrink-0 items-center justify-center overflow-hidden bg-muted", className)} {...props}>
			<img alt={data.filename || "Image"} className="size-full object-cover" src={data.url} />
		</div>
	);
};

export type AttachmentRemoveProps = ComponentProps<typeof Button> & {
	label?: string;
};

export const AttachmentRemove = ({
	label = "Remove",
	className,
	children,
	...props
}: AttachmentRemoveProps): React.ReactNode => {
	const { onRemove } = useAttachmentContext();

	const handleClick = useCallback(
		(event: React.MouseEvent) => {
			event.stopPropagation();
			onRemove?.();
		},
		[onRemove],
	);

	if (!onRemove) {
		return null;
	}

	return (
		<Button
			aria-label={label}
			className={cn(
				"absolute top-2 right-2 size-6 rounded-full p-0",
				"bg-background/80 backdrop-blur-sm",
				"opacity-0 transition-opacity group-hover:opacity-100",
				"hover:bg-background",
				"[&>svg]:size-3",
				className,
			)}
			onClick={handleClick}
			type="button"
			variant="ghost"
			{...props}
		>
			{children ?? <XIcon />}
			<span className="sr-only">{label}</span>
		</Button>
	);
};
