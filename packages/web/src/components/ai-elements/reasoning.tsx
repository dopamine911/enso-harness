/**
 * Vendored from vercel/ai-elements — `packages/elements/src/reasoning.tsx`
 * at 6a9d5b1822ffb10bba4bd97175f01edd7d8651cd. Apache-2.0. See README.md here.
 *
 * Modified:
 * - `ReasoningContent` renders the thinking text as React-escaped plain text instead of
 *   streamdown (dropped repo-wide). It deliberately does NOT use TanStack's `ThinkingPart`:
 *   that renders plain text too, but wrapped in its own hardcoded collapsible chrome —
 *   nesting it here produced a second "Thinking..." header inside this one (fixture
 *   receipt, 2026-09-03)
 * - the "Thinking..." label uses `animate-pulse` instead of the upstream `Shimmer`
 *   component — Shimmer's only real dependency is the `motion` package, which is a large
 *   runtime for one gradient animation (the same call that dropped streamdown)
 * - `@repo/shadcn-ui/...` imports → `@/` aliases; removed `"use client"` (Vite SPA)
 * - `useControllableState`'s `onChange` is spread conditionally (this repo compiles with
 *   `exactOptionalPropertyTypes`; upstream does not)
 * - the trigger label reads `Thought for 5s` (Copilot Chat's form), and `Thought` when no
 *   duration was measured — upstream's "Thought for a few seconds" was a number it did not
 *   have (#90 PR 2)
 *
 * Behaviour kept verbatim from upstream, because it is the part worth vendoring: opens
 * itself while streaming, measures how long the thinking took, and auto-closes ONCE a
 * second after streaming ends (a user who reopened it is not fought with).
 */
import { useControllableState } from "@radix-ui/react-use-controllable-state";
import { BrainIcon, ChevronDownIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import {
	createContext,
	memo,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible.tsx";
import { cn } from "@/lib/utils.ts";

interface ReasoningContextValue {
	isStreaming: boolean;
	isOpen: boolean;
	setIsOpen: (open: boolean) => void;
	duration: number | undefined;
}

const ReasoningContext = createContext<ReasoningContextValue | null>(null);

export const useReasoning = () => {
	const context = useContext(ReasoningContext);
	if (!context) {
		throw new Error("Reasoning components must be used within Reasoning");
	}
	return context;
};

export type ReasoningProps = ComponentProps<typeof Collapsible> & {
	isStreaming?: boolean;
	open?: boolean;
	defaultOpen?: boolean;
	onOpenChange?: (open: boolean) => void;
	duration?: number;
};

const AUTO_CLOSE_DELAY = 1000;
const MS_IN_S = 1000;

export const Reasoning = memo(
	({
		className,
		isStreaming = false,
		open,
		defaultOpen,
		onOpenChange,
		duration: durationProp,
		children,
		...props
	}: ReasoningProps) => {
		const resolvedDefaultOpen = defaultOpen ?? isStreaming;
		// Track if defaultOpen was explicitly set to false (to prevent auto-open)
		const isExplicitlyClosed = defaultOpen === false;

		// `onChange` is spread conditionally rather than passed as `onOpenChange` directly:
		// this repo compiles with `exactOptionalPropertyTypes` (upstream does not), and
		// radix's param type does not accept an explicit `undefined` for the handler.
		const [isOpen, setIsOpen] = useControllableState<boolean>({
			defaultProp: resolvedDefaultOpen,
			...(onOpenChange !== undefined ? { onChange: onOpenChange } : {}),
			prop: open,
		});
		const [duration, setDuration] = useControllableState<number | undefined>({
			defaultProp: undefined,
			prop: durationProp,
		});

		const hasEverStreamedRef = useRef(isStreaming);
		const [hasAutoClosed, setHasAutoClosed] = useState(false);
		const startTimeRef = useRef<number | null>(null);

		// Track when streaming starts and compute duration
		useEffect(() => {
			if (isStreaming) {
				hasEverStreamedRef.current = true;
				if (startTimeRef.current === null) {
					startTimeRef.current = Date.now();
				}
			} else if (startTimeRef.current !== null) {
				setDuration(Math.ceil((Date.now() - startTimeRef.current) / MS_IN_S));
				startTimeRef.current = null;
			}
		}, [isStreaming, setDuration]);

		// Auto-open when streaming starts (unless explicitly closed)
		useEffect(() => {
			if (isStreaming && !isOpen && !isExplicitlyClosed) {
				setIsOpen(true);
			}
		}, [isStreaming, isOpen, setIsOpen, isExplicitlyClosed]);

		// Auto-close when streaming ends (once only, and only if it ever streamed)
		useEffect(() => {
			if (hasEverStreamedRef.current && !isStreaming && isOpen && !hasAutoClosed) {
				const timer = setTimeout(() => {
					setIsOpen(false);
					setHasAutoClosed(true);
				}, AUTO_CLOSE_DELAY);

				return () => clearTimeout(timer);
			}
			return undefined;
		}, [isStreaming, isOpen, setIsOpen, hasAutoClosed]);

		const handleOpenChange = useCallback(
			(newOpen: boolean) => {
				setIsOpen(newOpen);
			},
			[setIsOpen],
		);

		const contextValue = useMemo(
			() => ({ duration, isOpen, isStreaming, setIsOpen }),
			[duration, isOpen, isStreaming, setIsOpen],
		);

		return (
			<ReasoningContext.Provider value={contextValue}>
				<Collapsible
					className={cn("not-prose mb-4", className)}
					onOpenChange={handleOpenChange}
					open={isOpen}
					{...props}
				>
					{children}
				</Collapsible>
			</ReasoningContext.Provider>
		);
	},
);

export type ReasoningTriggerProps = ComponentProps<typeof CollapsibleTrigger> & {
	getThinkingMessage?: (isStreaming: boolean, duration?: number) => ReactNode;
};

/**
 * Modified from upstream (#90 PR 2): `Thought for 5s` in Copilot Chat's form, and when the
 * duration is UNKNOWN — the block mounted after its streaming ended, so nothing measured
 * it — just `Thought`. Upstream said "Thought for a few seconds" there, a number it did
 * not have.
 */
const defaultGetThinkingMessage = (isStreaming: boolean, duration?: number) => {
	if (isStreaming || duration === 0) {
		return <p className="animate-pulse">Thinking...</p>;
	}
	if (duration === undefined) {
		return <p>Thought</p>;
	}
	return <p>Thought for {duration}s</p>;
};

export const ReasoningTrigger = memo(
	({
		className,
		children,
		getThinkingMessage = defaultGetThinkingMessage,
		...props
	}: ReasoningTriggerProps) => {
		const { isStreaming, isOpen, duration } = useReasoning();

		return (
			<CollapsibleTrigger
				className={cn(
					"flex w-full items-center gap-2 text-muted-foreground text-sm transition-colors hover:text-foreground",
					className,
				)}
				{...props}
			>
				{children ?? (
					<>
						<BrainIcon className="size-4" />
						{getThinkingMessage(isStreaming, duration)}
						<ChevronDownIcon
							className={cn("size-4 transition-transform", isOpen ? "rotate-180" : "rotate-0")}
						/>
					</>
				)}
			</CollapsibleTrigger>
		);
	},
);

export type ReasoningContentProps = ComponentProps<typeof CollapsibleContent> & {
	children: string;
};

export const ReasoningContent = memo(({ className, children, ...props }: ReasoningContentProps) => (
	<CollapsibleContent
		className={cn(
			"mt-4 text-sm",
			"data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 text-muted-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
			className,
		)}
		{...props}
	>
		{/* Rendered as React-escaped plain text, NOT through TanStack's `ThinkingPart`:
		    that component turned out to render plain text too, but inside its own
		    hardcoded collapsible chrome (a second "▼ Thinking..." header, off-theme
		    gray-* classes) — double chrome, found on the fixture page 2026-09-03. */}
		<div className="whitespace-pre-wrap">{children}</div>
	</CollapsibleContent>
));

Reasoning.displayName = "Reasoning";
ReasoningTrigger.displayName = "ReasoningTrigger";
ReasoningContent.displayName = "ReasoningContent";
