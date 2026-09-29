/**
 * Vendored from vercel/ai-elements — `packages/elements/src/artifact.tsx`
 * at 6a9d5b1822ffb10bba4bd97175f01edd7d8651cd. Apache-2.0. See README.md here.
 *
 * Modified — this file is a SUBSET (the prompt manager's editor panel, #443):
 * - kept `Artifact`, `ArtifactHeader`, `ArtifactTitle`, `ArtifactDescription`, `ArtifactActions`,
 *   `ArtifactAction`, `ArtifactContent`. Removed `ArtifactClose`: the panel sits inside a dialog
 *   that has its own close, and two close buttons for one surface is one too many
 * - `ArtifactAction` renders its label beside the icon when it has one, rather than only to screen
 *   readers: the editor's actions (save, delete) are words a person looks for, not icons to learn
 * - `@repo/shadcn-ui/...` imports → `@/` aliases; removed `"use client"` (Vite SPA); explicit
 *   return types
 */

import type { LucideIcon } from "lucide-react";
import type { ComponentProps, HTMLAttributes } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/utils.ts";

export type ArtifactProps = HTMLAttributes<HTMLDivElement>;

export const Artifact = ({ className, ...props }: ArtifactProps): React.ReactNode => (
	<div className={cn("flex flex-col overflow-hidden rounded-lg border bg-background shadow-sm", className)} {...props} />
);

export type ArtifactHeaderProps = HTMLAttributes<HTMLDivElement>;

export const ArtifactHeader = ({ className, ...props }: ArtifactHeaderProps): React.ReactNode => (
	<div className={cn("flex items-center justify-between border-b bg-muted/50 px-4 py-3", className)} {...props} />
);

export type ArtifactTitleProps = HTMLAttributes<HTMLParagraphElement>;

export const ArtifactTitle = ({ className, ...props }: ArtifactTitleProps): React.ReactNode => (
	<p className={cn("font-medium text-foreground text-sm", className)} {...props} />
);

export type ArtifactDescriptionProps = HTMLAttributes<HTMLParagraphElement>;

export const ArtifactDescription = ({ className, ...props }: ArtifactDescriptionProps): React.ReactNode => (
	<p className={cn("text-muted-foreground text-sm", className)} {...props} />
);

export type ArtifactActionsProps = HTMLAttributes<HTMLDivElement>;

export const ArtifactActions = ({ className, ...props }: ArtifactActionsProps): React.ReactNode => (
	<div className={cn("flex items-center gap-1", className)} {...props} />
);

export type ArtifactActionProps = ComponentProps<typeof Button> & {
	tooltip?: string;
	label?: string;
	icon?: LucideIcon;
};

export const ArtifactAction = ({
	tooltip,
	label,
	icon: Icon,
	children,
	className,
	size = "sm",
	variant = "ghost",
	...props
}: ArtifactActionProps): React.ReactNode => {
	const button = (
		<Button
			className={cn("h-8 gap-1.5 px-2 text-muted-foreground hover:text-foreground", className)}
			size={size}
			type="button"
			variant={variant}
			{...props}
		>
			{Icon ? <Icon className="size-4" /> : null}
			{children ?? label}
		</Button>
	);

	if (tooltip) {
		return (
			<TooltipProvider>
				<Tooltip>
					<TooltipTrigger asChild>{button}</TooltipTrigger>
					<TooltipContent>
						<p>{tooltip}</p>
					</TooltipContent>
				</Tooltip>
			</TooltipProvider>
		);
	}

	return button;
};

export type ArtifactContentProps = HTMLAttributes<HTMLDivElement>;

export const ArtifactContent = ({ className, ...props }: ArtifactContentProps): React.ReactNode => (
	<div className={cn("flex-1 overflow-auto p-4", className)} {...props} />
);
