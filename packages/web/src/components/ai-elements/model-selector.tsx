/**
 * Vendored from vercel/ai-elements — `packages/elements/src/model-selector.tsx`
 * at 6a9d5b1822ffb10bba4bd97175f01edd7d8651cd. Apache-2.0. See README.md here.
 *
 * Modified — this file is a deliberate SUBSET (the `/model` second step, #338 slice 2):
 * - kept `ModelSelector` (the dialog), `ModelSelectorContent` (the dialog's content with a
 *   screen-reader title and a cmdk root inside), `ModelSelectorInput`, `ModelSelectorList`,
 *   `ModelSelectorEmpty`, `ModelSelectorGroup`, `ModelSelectorItem`, `ModelSelectorName` —
 *   what "a filter box over the models the host offers, pick one" needs and nothing more
 * - removed `ModelSelectorTrigger`: the dialog is opened by the palette's `/model` row and by
 *   the composer's model chip, both owner-controlled (`open`/`onOpenChange`), so no Radix trigger
 *   is rendered; `ModelSelectorDialog` (the `CommandDialog` shell — a second dialog shape for the
 *   same thing); `ModelSelectorShortcut` and `ModelSelectorSeparator` (unused here)
 * - removed `ModelSelectorLogo`, `ModelSelectorLogoGroup` and their provider→logo table: the
 *   logos load from `models.dev`, a network fetch from inside a presentation component, for a
 *   list whose providers are whatever pi's registry names — the `detail` column says the provider
 *   in words instead
 * - `@repo/shadcn-ui/...` → `@/components/ui/<name>.tsx`, `@/lib/utils.ts`; explicit
 *   `React.ReactNode` return types (the port's rule, see `prompt-input.tsx`); removed `"use client"`
 * - ADDED a `filter` prop on `ModelSelectorContent`, handed to the cmdk root (#338 slice 3):
 *   upstream fixes cmdk's default fuzzy score, and over 53 login options `openai` matched 22 rows
 *   (any row whose id, label or provider spelled o-p-e-n-a-i in order). The owner supplies a
 *   substring-first ranking; without the prop the cmdk default applies, as upstream.
 */
import type { ComponentProps, ReactNode } from "react";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command.tsx";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog.tsx";
import { cn } from "@/lib/utils.ts";

export type ModelSelectorProps = ComponentProps<typeof Dialog>;

export const ModelSelector = (props: ModelSelectorProps): React.ReactNode => <Dialog {...props} />;

export type ModelSelectorContentProps = ComponentProps<typeof DialogContent> & {
	title?: ReactNode;
	filter?: ComponentProps<typeof Command>["filter"];
};

export const ModelSelectorContent = ({
	className,
	children,
	title = "Model Selector",
	filter,
	...props
}: ModelSelectorContentProps): React.ReactNode => (
	<DialogContent
		aria-describedby={undefined}
		className={cn("outline! border-none! p-0 outline-border! outline-solid!", className)}
		{...props}
	>
		<DialogTitle className="sr-only">{title}</DialogTitle>
		<Command className="**:data-[slot=command-input-wrapper]:h-auto" {...(filter === undefined ? {} : { filter })}>
			{children}
		</Command>
	</DialogContent>
);

export type ModelSelectorInputProps = ComponentProps<typeof CommandInput>;

export const ModelSelectorInput = ({ className, ...props }: ModelSelectorInputProps): React.ReactNode => (
	<CommandInput className={cn("h-auto py-3.5", className)} {...props} />
);

export type ModelSelectorListProps = ComponentProps<typeof CommandList>;

export const ModelSelectorList = (props: ModelSelectorListProps): React.ReactNode => <CommandList {...props} />;

export type ModelSelectorEmptyProps = ComponentProps<typeof CommandEmpty>;

export const ModelSelectorEmpty = (props: ModelSelectorEmptyProps): React.ReactNode => <CommandEmpty {...props} />;

export type ModelSelectorGroupProps = ComponentProps<typeof CommandGroup>;

export const ModelSelectorGroup = (props: ModelSelectorGroupProps): React.ReactNode => <CommandGroup {...props} />;

export type ModelSelectorItemProps = ComponentProps<typeof CommandItem>;

export const ModelSelectorItem = (props: ModelSelectorItemProps): React.ReactNode => <CommandItem {...props} />;

export type ModelSelectorNameProps = ComponentProps<"span">;

export const ModelSelectorName = ({ className, ...props }: ModelSelectorNameProps): React.ReactNode => (
	<span className={cn("flex-1 truncate text-left", className)} {...props} />
);
