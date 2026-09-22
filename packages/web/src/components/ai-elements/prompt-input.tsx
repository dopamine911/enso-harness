/**
 * Vendored from vercel/ai-elements — `packages/elements/src/prompt-input.tsx`
 * at 6a9d5b1822ffb10bba4bd97175f01edd7d8651cd. Apache-2.0. See README.md here.
 *
 * Modified — this file is a deliberate SUBSET (the composer's attachment machinery, #68/#121):
 * - kept `PromptInput` (the form: hidden file input, drop on the form, the attachments
 *   context, submit with blob→data-URL conversion), `PromptInputTextarea` (paste files,
 *   Enter submits unless the submit button is disabled, Backspace on an empty draft removes
 *   the last attachment), `PromptInputBody`, `PromptInputFooter`, `PromptInputTools`,
 *   `PromptInputButton`, and `usePromptInputAttachments`
 * - removed `PromptInputProvider` and the lifted-state variant (the owner controls the
 *   textarea's value — the queued-send take-back writes it, #75), referenced sources, the
 *   screenshot action, `globalDrop`, `syncHiddenInput`, speech, model select, the header
 * - removed `PromptInputSubmit`: upstream folds send and stop into one button by status;
 *   here send stays offered in flight (a prompt during a run queues through pi, #75) and stop
 *   is its own button (#116) — two buttons by decision, owned by `chat-screen.tsx`
 * - `add` reports EVERY refusal, with a count, even when the rest of the batch went through —
 *   upstream reported only when the whole batch failed, so a mixed drop lost files silently
 *   (PR #141 review); the selection is a pure `selectAttachments`, tested without a DOM, and
 *   runs against the held count before `setFiles` rather than inside the updater
 * - the text at submit comes from the form's `message` field and the form is NOT reset:
 *   the owner clears its controlled draft (upstream `form.reset()` fought a controlled value)
 * - `FileUIPart` from the Vercel AI SDK → local `PromptAttachment` (README rule 4);
 *   `nanoid()` → `crypto.randomUUID()`; `InputGroup*` shells → plain `div`s and this repo's
 *   `Textarea`; `@repo/shadcn-ui/...` → `@/`; removed `"use client"` (Vite SPA)
 * - `Promise.withResolvers` in `convertBlobUrlToDataUrl` (project rule)
 * - TAKEN BACK for the `/` command palette (#338): `PromptInputActionMenu`,
 *   `PromptInputActionMenuTrigger`, `PromptInputActionMenuContent`, `PromptInputActionMenuItem`
 *   (the `/` button and its dropdown, on shadcn `dropdown-menu`) and `PromptInputCommand`,
 *   `PromptInputCommandInput`, `PromptInputCommandList`, `PromptInputCommandEmpty`,
 *   `PromptInputCommandGroup`, `PromptInputCommandItem`, `PromptInputCommandSeparator` (the
 *   palette: filter box, groups, rows, empty state, on cmdk). The #68/#121 subset dropped them
 *   because that composer had no menu and no palette; #338's does, and port-before-build (#31)
 *   means they come from here, not from a hand-rolled popover. Verbatim apart from the port's
 *   own rules: `@repo/shadcn-ui/...` → `@/components/ui/<name>.tsx`, explicit `React.ReactNode`
 *   return types (biome's `useExplicitType` on the files that USE them made the shape uniform).
 *   `PromptInputActionMenuTrigger`'s default child is upstream's `PlusIcon`; the palette passes
 *   its own `SlashIcon`. The `tooltip` prop upstream's `PromptInputButton` grew is NOT taken:
 *   this port's button is `ComponentProps<typeof Button>`, so the trigger's props are the same.
 *   ⚠ `PromptInputActionMenuItem` is taken back with its group and used by nothing: the menu's
 *   content feeds every printable key inside it to Radix's typeahead, which is inert only while
 *   the content holds zero menu items. Do not put one beside a `PromptInputCommand` — see
 *   `command-palette.tsx`'s header (PR #343 review).
 * - TAKEN BACK for the composer chip (#338, slice 2): `PromptInputSelect`, `PromptInputSelectTrigger`,
 *   `PromptInputSelectContent`, `PromptInputSelectItem`, `PromptInputSelectValue` (a select in
 *   the composer chrome, on shadcn `select`; upstream uses them for its model picker, here it is
 *   the thinking level — pi's thinking is discrete levels, so a select is the truthful widget).
 *   Same rules as the palette pieces above. `PromptInputHoverCard*` stays out: nothing hovers.
 */
import type {
	ChangeEventHandler,
	ClipboardEventHandler,
	ComponentProps,
	FormEvent,
	FormEventHandler,
	HTMLAttributes,
	KeyboardEventHandler,
	RefObject,
} from "react";
import { Children, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button.tsx";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
	CommandSeparator,
} from "@/components/ui/command.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select.tsx";
import { cn } from "@/lib/utils.ts";

/** A file the composer holds: a blob URL while attached, a `data:` URL once submitted. */
export interface PromptAttachment {
	readonly id: string;
	readonly filename: string;
	readonly mediaType: string;
	readonly url: string;
}

export interface AttachmentsContext {
	files: PromptAttachment[];
	add: (files: File[] | FileList) => void;
	remove: (id: string) => void;
	clear: () => void;
	openFileDialog: () => void;
	fileInputRef: RefObject<HTMLInputElement | null>;
}

const convertBlobUrlToDataUrl = async (url: string): Promise<string | null> => {
	try {
		const response = await fetch(url);
		const blob = await response.blob();
		const { promise, resolve } = Promise.withResolvers<string | null>();
		const reader = new FileReader();
		reader.addEventListener("loadend", () => resolve(reader.result as string));
		reader.addEventListener("error", () => resolve(null));
		reader.readAsDataURL(blob);
		return await promise;
	} catch {
		return null;
	}
};

const LocalAttachmentsContext = createContext<AttachmentsContext | null>(null);

export const usePromptInputAttachments = (): AttachmentsContext => {
	const context = useContext(LocalAttachmentsContext);
	if (!context) {
		throw new Error("usePromptInputAttachments must be used within a PromptInput");
	}
	return context;
};

export interface PromptInputMessage {
	text: string;
	files: Omit<PromptAttachment, "id">[];
}

export type PromptInputError = {
	code: "max_files" | "max_file_size" | "accept";
	message: string;
	/** How many of the batch this refusal covers — a mixed drop says "2 of 3", never nothing. */
	count: number;
};

/** True when `file.type` matches one of `accept`'s comma-separated patterns (`image/png`, `image/*`); no `accept` takes anything. */
function matchesAccept(accept: string | undefined, file: File): boolean {
	if (!accept || accept.trim() === "") {
		return true;
	}
	const patterns = accept
		.split(",")
		.map((pattern) => pattern.trim())
		.filter(Boolean);
	return patterns.some((pattern) => {
		if (pattern.endsWith("/*")) {
			// e.g: image/* -> image/
			const prefix = pattern.slice(0, -1);
			return file.type.startsWith(prefix);
		}
		return file.type === pattern;
	});
}

export interface AttachmentLimits {
	readonly accept?: string | undefined;
	readonly maxFileSize?: number | undefined;
	readonly maxFiles?: number | undefined;
	/** Attachments already held, so `maxFiles` counts across adds. */
	readonly held: number;
}

/**
 * Which of a batch attach, and every refusal with its count. Pure, so it is tested without
 * a DOM. ⚠ Upstream reported a refusal only when the WHOLE batch failed a check (a mixed
 * drop — two PNGs and a PDF — dropped the PDF silently); here each check reports what it
 * refused even when the rest went through (PR #141 review). Order of checks is upstream's:
 * kind, then size, then room.
 */
export function selectAttachments(
	fileList: readonly File[] | FileList,
	limits: AttachmentLimits,
): { readonly accepted: File[]; readonly errors: PromptInputError[] } {
	const incoming = [...fileList];
	const errors: PromptInputError[] = [];
	const accepted = incoming.filter((file) => matchesAccept(limits.accept, file));
	if (accepted.length < incoming.length) {
		errors.push({
			code: "accept",
			message: "Some files do not match the accepted types.",
			count: incoming.length - accepted.length,
		});
	}
	const sized = accepted.filter((file) => (limits.maxFileSize ? file.size <= limits.maxFileSize : true));
	if (sized.length < accepted.length) {
		errors.push({ code: "max_file_size", message: "Some files exceed the maximum size.", count: accepted.length - sized.length });
	}
	const capacity = typeof limits.maxFiles === "number" ? Math.max(0, limits.maxFiles - limits.held) : undefined;
	const capped = typeof capacity === "number" ? sized.slice(0, capacity) : sized;
	if (capped.length < sized.length) {
		errors.push({ code: "max_files", message: "Too many files. Some were not added.", count: sized.length - capped.length });
	}
	return { accepted: capped, errors };
}

export type PromptInputProps = Omit<HTMLAttributes<HTMLFormElement>, "onSubmit" | "onError"> & {
	// e.g., "image/*" or leave undefined for any
	accept?: string;
	multiple?: boolean;
	// Minimal constraints
	maxFiles?: number;
	// bytes
	maxFileSize?: number;
	onError?: (err: PromptInputError) => void;
	onSubmit: (message: PromptInputMessage, event: FormEvent<HTMLFormElement>) => void | Promise<void>;
};

export const PromptInput = ({
	className,
	accept,
	multiple,
	maxFiles,
	maxFileSize,
	onError,
	onSubmit,
	children,
	...props
}: PromptInputProps): React.ReactNode => {
	const inputRef = useRef<HTMLInputElement | null>(null);
	const formRef = useRef<HTMLFormElement | null>(null);
	const [files, setFiles] = useState<PromptAttachment[]>([]);

	// Keep a ref to files for cleanup on unmount (avoids stale closure)
	const filesRef = useRef(files);
	useEffect(() => {
		filesRef.current = files;
	}, [files]);

	const openFileDialog = useCallback(() => {
		inputRef.current?.click();
	}, []);

	const add = useCallback(
		(fileList: File[] | FileList) => {
			// Selected against what is held NOW (the ref), not inside the updater: `onError` is a
			// side effect, and React may run an updater twice.
			const { accepted, errors } = selectAttachments(fileList, {
				accept,
				maxFileSize,
				maxFiles,
				held: filesRef.current.length,
			});
			for (const error of errors) onError?.(error);
			if (accepted.length === 0) return;
			const next: PromptAttachment[] = accepted.map((file) => ({
				filename: file.name,
				id: crypto.randomUUID(),
				mediaType: file.type,
				url: URL.createObjectURL(file),
			}));
			setFiles((previous) => [...previous, ...next]);
		},
		[accept, maxFiles, maxFileSize, onError],
	);

	const remove = useCallback(
		(id: string) =>
			setFiles((previous) => {
				const found = previous.find((file) => file.id === id);
				if (found?.url) {
					URL.revokeObjectURL(found.url);
				}
				return previous.filter((file) => file.id !== id);
			}),
		[],
	);

	const clear = useCallback(
		() =>
			setFiles((previous) => {
				for (const file of previous) {
					if (file.url) {
						URL.revokeObjectURL(file.url);
					}
				}
				return [];
			}),
		[],
	);

	// Attach drop handlers on the form
	useEffect(() => {
		const form = formRef.current;
		if (!form) {
			return;
		}
		const onDragOver = (event: DragEvent): void => {
			if (event.dataTransfer?.types?.includes("Files")) {
				event.preventDefault();
			}
		};
		const onDrop = (event: DragEvent): void => {
			if (event.dataTransfer?.types?.includes("Files")) {
				event.preventDefault();
			}
			if (event.dataTransfer?.files && event.dataTransfer.files.length > 0) {
				add(event.dataTransfer.files);
			}
		};
		form.addEventListener("dragover", onDragOver);
		form.addEventListener("drop", onDrop);
		return () => {
			form.removeEventListener("dragover", onDragOver);
			form.removeEventListener("drop", onDrop);
		};
	}, [add]);

	// Cleanup blob URLs on unmount to prevent memory leaks
	useEffect(
		() => () => {
			for (const file of filesRef.current) {
				if (file.url) {
					URL.revokeObjectURL(file.url);
				}
			}
		},
		[],
	);

	const handleChange: ChangeEventHandler<HTMLInputElement> = useCallback(
		(event) => {
			if (event.currentTarget.files) {
				add(event.currentTarget.files);
			}
			// Reset input value to allow selecting files that were previously removed
			event.currentTarget.value = "";
		},
		[add],
	);

	const attachmentsContext = useMemo<AttachmentsContext>(
		() => ({ add, clear, fileInputRef: inputRef, files, openFileDialog, remove }),
		[files, add, remove, clear, openFileDialog],
	);

	const handleSubmit: FormEventHandler<HTMLFormElement> = useCallback(
		async (event) => {
			event.preventDefault();
			const formData = new FormData(event.currentTarget);
			const text = typeof formData.get("message") === "string" ? (formData.get("message") as string) : "";
			try {
				// Convert blob URLs to data URLs asynchronously
				const convertedFiles = await Promise.all(
					files.map(async ({ id: _id, ...item }) => {
						if (item.url.startsWith("blob:")) {
							const dataUrl = await convertBlobUrlToDataUrl(item.url);
							// If conversion failed, keep the original blob URL
							return { ...item, url: dataUrl ?? item.url };
						}
						return item;
					}),
				);
				await onSubmit({ files: convertedFiles, text }, event);
				clear();
			} catch {
				// Don't clear on error - user may want to retry
			}
		},
		[files, onSubmit, clear],
	);

	return (
		<LocalAttachmentsContext.Provider value={attachmentsContext}>
			<input
				accept={accept}
				aria-label="Upload files"
				className="hidden"
				multiple={multiple}
				onChange={handleChange}
				ref={inputRef}
				title="Upload files"
				type="file"
			/>
			<form className={cn("w-full", className)} onSubmit={handleSubmit} ref={formRef} {...props}>
				{children}
			</form>
		</LocalAttachmentsContext.Provider>
	);
};

export type PromptInputBodyProps = HTMLAttributes<HTMLDivElement>;

export const PromptInputBody = ({ className, ...props }: PromptInputBodyProps): React.ReactNode => (
	<div className={cn("contents", className)} {...props} />
);

export type PromptInputTextareaProps = ComponentProps<typeof Textarea>;

export const PromptInputTextarea = ({
	onChange,
	onKeyDown,
	className,
	placeholder = "What would you like to know?",
	...props
}: PromptInputTextareaProps): React.ReactNode => {
	const attachments = usePromptInputAttachments();
	const [isComposing, setIsComposing] = useState(false);

	const handleKeyDown: KeyboardEventHandler<HTMLTextAreaElement> = useCallback(
		(event) => {
			// Call the external onKeyDown handler first
			onKeyDown?.(event);
			// If the external handler prevented default, don't run internal logic
			if (event.defaultPrevented) {
				return;
			}
			if (event.key === "Enter") {
				if (isComposing || event.nativeEvent.isComposing) {
					return;
				}
				if (event.shiftKey) {
					return;
				}
				event.preventDefault();
				// Check if the submit button is disabled before submitting
				const { form } = event.currentTarget;
				const submitButton = form?.querySelector('button[type="submit"]') as HTMLButtonElement | null;
				if (submitButton?.disabled) {
					return;
				}
				form?.requestSubmit();
			}
			// Remove last attachment when Backspace is pressed and textarea is empty
			if (event.key === "Backspace" && event.currentTarget.value === "" && attachments.files.length > 0) {
				event.preventDefault();
				const lastAttachment = attachments.files.at(-1);
				if (lastAttachment) {
					attachments.remove(lastAttachment.id);
				}
			}
		},
		[onKeyDown, isComposing, attachments],
	);

	const handlePaste: ClipboardEventHandler<HTMLTextAreaElement> = useCallback(
		(event) => {
			const items = event.clipboardData?.items;
			if (!items) {
				return;
			}
			const files: File[] = [];
			for (const item of items) {
				if (item.kind === "file") {
					const file = item.getAsFile();
					if (file) {
						files.push(file);
					}
				}
			}
			if (files.length > 0) {
				event.preventDefault();
				attachments.add(files);
			}
		},
		[attachments],
	);

	const handleCompositionEnd = useCallback(() => setIsComposing(false), []);
	const handleCompositionStart = useCallback(() => setIsComposing(true), []);

	return (
		<Textarea
			className={cn("field-sizing-content max-h-48 min-h-16", className)}
			name="message"
			onChange={onChange}
			onCompositionEnd={handleCompositionEnd}
			onCompositionStart={handleCompositionStart}
			onKeyDown={handleKeyDown}
			onPaste={handlePaste}
			placeholder={placeholder}
			{...props}
		/>
	);
};

export type PromptInputFooterProps = HTMLAttributes<HTMLDivElement>;

export const PromptInputFooter = ({ className, ...props }: PromptInputFooterProps): React.ReactNode => (
	<div className={cn("flex items-center justify-between gap-1", className)} {...props} />
);

export type PromptInputToolsProps = HTMLAttributes<HTMLDivElement>;

export const PromptInputTools = ({ className, ...props }: PromptInputToolsProps): React.ReactNode => (
	<div className={cn("flex items-center gap-1", className)} {...props} />
);

export type PromptInputButtonProps = ComponentProps<typeof Button>;

export const PromptInputButton = ({
	variant = "ghost",
	className,
	size,
	...props
}: PromptInputButtonProps): React.ReactNode => {
	const newSize = size ?? (Children.count(props.children) > 1 ? "default" : "icon");
	return <Button className={cn("shrink-0 gap-1.5", className)} size={newSize} type="button" variant={variant} {...props} />;
};

export type PromptInputActionMenuProps = ComponentProps<typeof DropdownMenu>;
export const PromptInputActionMenu = (props: PromptInputActionMenuProps): React.ReactNode => <DropdownMenu {...props} />;

export type PromptInputActionMenuTriggerProps = PromptInputButtonProps;

export const PromptInputActionMenuTrigger = ({
	className,
	children,
	...props
}: PromptInputActionMenuTriggerProps): React.ReactNode => (
	<DropdownMenuTrigger asChild>
		<PromptInputButton className={className} {...props}>
			{children ?? <PlusIcon className="size-4" />}
		</PromptInputButton>
	</DropdownMenuTrigger>
);

export type PromptInputActionMenuContentProps = ComponentProps<typeof DropdownMenuContent>;
export const PromptInputActionMenuContent = ({
	className,
	...props
}: PromptInputActionMenuContentProps): React.ReactNode => (
	<DropdownMenuContent align="start" className={cn(className)} {...props} />
);

export type PromptInputActionMenuItemProps = ComponentProps<typeof DropdownMenuItem>;
export const PromptInputActionMenuItem = ({ className, ...props }: PromptInputActionMenuItemProps): React.ReactNode => (
	<DropdownMenuItem className={cn(className)} {...props} />
);

export type PromptInputCommandProps = ComponentProps<typeof Command>;

export const PromptInputCommand = ({ className, ...props }: PromptInputCommandProps): React.ReactNode => (
	<Command className={cn(className)} {...props} />
);

export type PromptInputCommandInputProps = ComponentProps<typeof CommandInput>;

export const PromptInputCommandInput = ({ className, ...props }: PromptInputCommandInputProps): React.ReactNode => (
	<CommandInput className={cn(className)} {...props} />
);

export type PromptInputCommandListProps = ComponentProps<typeof CommandList>;

export const PromptInputCommandList = ({ className, ...props }: PromptInputCommandListProps): React.ReactNode => (
	<CommandList className={cn(className)} {...props} />
);

export type PromptInputCommandEmptyProps = ComponentProps<typeof CommandEmpty>;

export const PromptInputCommandEmpty = ({ className, ...props }: PromptInputCommandEmptyProps): React.ReactNode => (
	<CommandEmpty className={cn(className)} {...props} />
);

export type PromptInputCommandGroupProps = ComponentProps<typeof CommandGroup>;

export const PromptInputCommandGroup = ({ className, ...props }: PromptInputCommandGroupProps): React.ReactNode => (
	<CommandGroup className={cn(className)} {...props} />
);

export type PromptInputCommandItemProps = ComponentProps<typeof CommandItem>;

export const PromptInputCommandItem = ({ className, ...props }: PromptInputCommandItemProps): React.ReactNode => (
	<CommandItem className={cn(className)} {...props} />
);

export type PromptInputCommandSeparatorProps = ComponentProps<typeof CommandSeparator>;

export const PromptInputCommandSeparator = ({
	className,
	...props
}: PromptInputCommandSeparatorProps): React.ReactNode => <CommandSeparator className={cn(className)} {...props} />;

export type PromptInputSelectProps = ComponentProps<typeof Select>;

export const PromptInputSelect = (props: PromptInputSelectProps): React.ReactNode => <Select {...props} />;

export type PromptInputSelectTriggerProps = ComponentProps<typeof SelectTrigger>;

export const PromptInputSelectTrigger = ({ className, ...props }: PromptInputSelectTriggerProps): React.ReactNode => (
	<SelectTrigger
		className={cn(
			"border-none bg-transparent font-medium text-muted-foreground shadow-none transition-colors",
			"hover:bg-accent hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground",
			className,
		)}
		{...props}
	/>
);

export type PromptInputSelectContentProps = ComponentProps<typeof SelectContent>;

export const PromptInputSelectContent = ({ className, ...props }: PromptInputSelectContentProps): React.ReactNode => (
	<SelectContent className={cn(className)} {...props} />
);

export type PromptInputSelectItemProps = ComponentProps<typeof SelectItem>;

export const PromptInputSelectItem = ({ className, ...props }: PromptInputSelectItemProps): React.ReactNode => (
	<SelectItem className={cn(className)} {...props} />
);

export type PromptInputSelectValueProps = ComponentProps<typeof SelectValue>;

export const PromptInputSelectValue = ({ className, ...props }: PromptInputSelectValueProps): React.ReactNode => (
	<SelectValue className={cn(className)} {...props} />
);
