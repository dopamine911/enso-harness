/**
 * Vendored from vercel/ai-elements — `packages/elements/src/terminal.tsx`
 * at 6a9d5b1822ffb10bba4bd97175f01edd7d8651cd. Apache-2.0. See README.md here.
 *
 * Modified — this file is a deliberate SUBSET (the log page's shell, #144 slice 2):
 * - kept `Terminal`, `TerminalHeader`, `TerminalTitle`, `TerminalStatus`, `TerminalActions`,
 *   `TerminalContent`. Removed `TerminalCopyButton` and `TerminalClearButton`, and the
 *   `onClear` the latter read from context: a debugging surface offers no control over what
 *   it reads (#144), and the day is handed over by `GET /api/logs/bundle`, not by a button
 *   that copies whatever happened to be on screen
 * - removed the `output: string` prop and the default `<pre><Ansi>{output}</Ansi></pre>`
 *   child, and with it upstream's `ansi-to-react` dependency: the records here are structured
 *   `EnsoLogLine`s rendered as rows, never one ANSI string, so `TerminalContent` takes its
 *   children and the context carries only `isStreaming`
 * - `TerminalContent` takes a forwarded `ref` instead of owning a `containerRef`, and does no
 *   auto-scrolling. The scroll element belongs to the virtualizer, which is `@tanstack/*` and
 *   so lives outside this directory (rule 3, `test/presentation-gate.test.ts`); and the page's
 *   scroll rule is not upstream's — it follows the newest row only while the reader is pinned
 *   to the bottom, because a viewer that yanks you back mid-read is useless
 * - upstream's hardcoded `zinc` palette → this repo's theme variables (`bg-background`,
 *   `text-foreground`, `text-muted-foreground`, `border`), so the page is Kanagawa like the
 *   rest of the app rather than one dark box that ignores the light theme
 * - `@repo/shadcn-ui/...` imports → `@/` aliases; removed `"use client"` (Vite SPA)
 */

import { TerminalIcon } from "lucide-react";
import { createContext, type HTMLAttributes, useContext, useMemo } from "react";
import { cn } from "@/lib/utils.ts";

interface TerminalContextType {
	isStreaming: boolean;
}

const TerminalContext = createContext<TerminalContextType>({ isStreaming: false });

export type TerminalHeaderProps = HTMLAttributes<HTMLDivElement>;

export const TerminalHeader = ({ className, children, ...props }: TerminalHeaderProps): React.ReactNode => (
	<div className={cn("flex items-center justify-between gap-2 border-b px-4 py-2", className)} {...props}>
		{children}
	</div>
);

export type TerminalTitleProps = HTMLAttributes<HTMLDivElement>;

export const TerminalTitle = ({ className, children, ...props }: TerminalTitleProps): React.ReactNode => (
	<div className={cn("flex items-center gap-2 text-muted-foreground text-sm", className)} {...props}>
		<TerminalIcon className="size-4" />
		{children ?? "Terminal"}
	</div>
);

export type TerminalStatusProps = HTMLAttributes<HTMLDivElement>;

export const TerminalStatus = ({ className, children, ...props }: TerminalStatusProps): React.ReactNode => {
	const { isStreaming } = useContext(TerminalContext);

	if (!isStreaming) {
		return null;
	}

	return (
		<div className={cn("flex items-center gap-2 text-muted-foreground text-xs", className)} {...props}>
			{children}
		</div>
	);
};

export type TerminalActionsProps = HTMLAttributes<HTMLDivElement>;

export const TerminalActions = ({ className, children, ...props }: TerminalActionsProps): React.ReactNode => (
	<div className={cn("flex items-center gap-1", className)} {...props}>
		{children}
	</div>
);

export type TerminalContentProps = HTMLAttributes<HTMLDivElement> & {
	ref?: React.Ref<HTMLDivElement>;
};

export const TerminalContent = ({ className, children, ref, ...props }: TerminalContentProps): React.ReactNode => (
	<div className={cn("min-h-0 flex-1 overflow-auto font-mono text-sm leading-relaxed", className)} ref={ref} {...props}>
		{children}
	</div>
);

export type TerminalProps = HTMLAttributes<HTMLDivElement> & {
	isStreaming?: boolean;
};

export const Terminal = ({ isStreaming = false, className, children, ...props }: TerminalProps): React.ReactNode => {
	const contextValue = useMemo(() => ({ isStreaming }), [isStreaming]);

	return (
		<TerminalContext.Provider value={contextValue}>
			<div className={cn("flex flex-col overflow-hidden bg-background text-foreground", className)} {...props}>
				{children}
			</div>
		</TerminalContext.Provider>
	);
};
