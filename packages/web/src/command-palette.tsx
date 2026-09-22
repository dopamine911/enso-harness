import type { EnsoThreadCommands, RuntimeCommand } from '@enso/core'
import { SlashIcon } from 'lucide-react'
import { useRef, useState } from 'react'
import type { FetchLike } from './browser-logging.ts'
import { fetchThreadCommands } from './commands-connection.ts'
import {
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputCommand,
  PromptInputCommandEmpty,
  PromptInputCommandGroup,
  PromptInputCommandInput,
  PromptInputCommandItem,
  PromptInputCommandList,
} from './components/ai-elements/prompt-input.tsx'

/**
 * The `/` command palette (#338, slice 1): Claude Code's `/` button in VS Code, as a popup
 * over the composer — a filter box, rows grouped by where the command came from, a
 * description on each row. The rows are the server's `listCommands()` as it stands, so an
 * extension command a session registers appears here with no code of ours: the palette is
 * what makes "extensions just work from the web" visible rather than claimed.
 *
 * Port before build (#31): the popup is `PromptInputActionMenu*` (shadcn `dropdown-menu`) and
 * the palette inside it is `PromptInputCommand*` (cmdk), both taken back into the ai-elements
 * port for this — arrow keys, Enter and the fuzzy filter are cmdk's, Escape and the click-away
 * are the menu's. This module owns only the STATE the port cannot: fetching the list and
 * deciding what a selection does. Nothing under `components/` reads the wire.
 *
 * Fetched on EVERY open, never cached and never polled: the route writes no record, the list
 * changes when a session is built (`remembered` → `live`), and a stale palette would offer a
 * thread commands it cannot run. A response from an earlier open that lands after a later one
 * is dropped — the open counter is the sequencer. A non-2xx renders `<status> <body>` VERBATIM
 * inside the palette, not as a toast: the failure belongs to the popup that asked.
 *
 * ⚠ THE SELECTION RULE. An `extension` command RUNS at once — `onRun(name)`, and the owner sends
 * `/<name>` as a prompt through the path the send button uses (no new POST: an extension
 * command with no arguments runs, and `/mode` bare opens picc's select dialog, which is the
 * nicer UX). A `prompt` template or a `skill` is INSERTED — `onInsert(name)`, and the owner puts
 * `/<name> ` in the composer and focuses it — because those take arguments the user has yet to
 * type. Both callbacks fire from the menu's `onCloseAutoFocus`, AFTER the menu has closed: the
 * menu's focus trap would otherwise pull focus straight back from the textarea the owner just
 * focused, and the menu's own "return focus to the trigger" is prevented so the owner's choice
 * of focus stands. A close without a selection (Escape, click-away) fires nothing and returns
 * focus to the `/` button as the menu does by itself.
 *
 * Empty states say WHICH empty: `source: 'none'` (no session built in this process yet) reads
 * "no thread has run yet — commands appear after the first prompt"; a live or remembered list
 * with zero rows reads "this session registers no commands"; a filter that matches nothing
 * reads "no command matches". `remembered` is a small footer note — the list is right for this
 * thread (every session registers the same set) but it is the last session's, and the reader
 * should know the thread has not run.
 *
 * The filter is NAME-FIRST, not cmdk's default fuzzy score. cmdk scores value and keywords as
 * one string, and on the real list `pla` ranked `/mode` ("… | plan | …" in its description)
 * above `/plan` itself, so Enter ran the wrong command (smoke, 2026-09-22). A row whose name
 * contains what was typed outranks every row that only describes it; among names, the earlier
 * the match the higher; a description-only match still shows, below them all.
 */

export interface CommandPaletteProps {
  readonly threadId: string
  /** The connection's `fetch` — injected by tests, the page's global by default. */
  readonly fetch?: FetchLike
  /** An `extension` command was chosen: send `/<name>` now. */
  readonly onRun: (commandName: string) => void
  /** A `prompt` template or a `skill` was chosen: put `/<name> ` in the composer and focus it. */
  readonly onInsert: (commandName: string) => void
  /** The composer is not taking input (disconnected); the `/` button follows it. */
  readonly disabled?: boolean
}

type PaletteState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'loaded'; readonly commands: EnsoThreadCommands }
  | { readonly kind: 'failed'; readonly detail: string }

const NO_THREAD_YET = 'no thread has run yet — commands appear after the first prompt'
const NO_COMMANDS = 'this session registers no commands'
const NO_MATCH = 'no command matches'
const REMEMBERED_NOTE = 'from the last session — this thread has not run yet'

/** One cmdk group per source, in the order the palette shows them. */
const GROUPS: ReadonlyArray<{ readonly source: RuntimeCommand['source']; readonly heading: string }> = [
  { source: 'extension', heading: 'extensions' },
  { source: 'prompt', heading: 'prompts' },
  { source: 'skill', heading: 'skills' },
]

/** Name-first ranking for cmdk's `filter` (header): `1` is an exact name, `0` hides the row. */
export function rankCommand(rowValue: string, search: string, keywords?: readonly string[]): number {
  const needle = search.toLowerCase()
  const nameAt = rowValue.toLowerCase().indexOf(needle)
  // `/name` — position 1 is the very start of the name; later starts rank lower but stay above 0.5.
  if (nameAt >= 0) return 1 - (nameAt - 1) / (2 * rowValue.length)
  const inDescription = keywords?.some((keyword) => keyword.toLowerCase().includes(needle)) ?? false
  return inDescription ? 0.25 : 0
}

/** The sentence cmdk shows when no row is visible — which depends on WHY there is none. */
function emptyText(commands: EnsoThreadCommands): typeof NO_MATCH | typeof NO_THREAD_YET | typeof NO_COMMANDS {
  if (commands.commands.length > 0) return NO_MATCH
  return commands.source === 'none' ? NO_THREAD_YET : NO_COMMANDS
}

export function CommandPalette({
  threadId,
  fetch: fetchImpl,
  onRun,
  onInsert,
  disabled = false,
}: CommandPaletteProps): React.ReactNode {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<PaletteState>({ kind: 'loading' })
  // Which open a response belongs to; a response from an earlier open is dropped.
  const openCount = useRef(0)
  // The row chosen before the menu closed; delivered from `onCloseAutoFocus` (header).
  const pending = useRef<RuntimeCommand | undefined>(undefined)
  // The filter box. A Radix menu focuses its own content on open (`onOpenAutoFocus` is not
  // exposed — a menu is roving-focus by design); whenever the content ITSELF takes focus, it is
  // handed on to the filter so the first keystroke filters — Claude Code's palette does the same.
  const filterRef = useRef<HTMLInputElement | null>(null)

  const handleOpenChange = (next: boolean): void => {
    setOpen(next)
    if (!next) return
    const opening = openCount.current + 1
    openCount.current = opening
    setState({ kind: 'loading' })
    void fetchThreadCommands(threadId, fetchImpl).then(
      (commands) => {
        if (openCount.current === opening) setState({ kind: 'loaded', commands })
      },
      (failure: unknown) => {
        if (openCount.current === opening) {
          setState({ kind: 'failed', detail: failure instanceof Error ? failure.message : String(failure) })
        }
      },
    )
  }

  const choose = (command: RuntimeCommand): void => {
    pending.current = command
    setOpen(false)
  }

  const deliverChoice = (event: Event): void => {
    const chosen = pending.current
    if (chosen === undefined) return
    pending.current = undefined
    // The owner decides where focus goes next, not the menu's return-to-trigger.
    event.preventDefault()
    if (chosen.source === 'extension') onRun(chosen.name)
    else onInsert(chosen.name)
  }

  return (
    <PromptInputActionMenu open={open} onOpenChange={handleOpenChange}>
      <PromptInputActionMenuTrigger
        aria-label="commands"
        title="commands — extension commands run, prompts and skills are inserted"
        disabled={disabled}
      >
        <SlashIcon />
      </PromptInputActionMenuTrigger>
      <PromptInputActionMenuContent
        className="w-[28rem] p-0"
        onFocus={(event: React.FocusEvent<HTMLDivElement>): void => {
          if (event.target === event.currentTarget) filterRef.current?.focus()
        }}
        onCloseAutoFocus={deliverChoice}
      >
        <PromptInputCommand label="commands" filter={rankCommand}>
          <PromptInputCommandInput ref={filterRef} placeholder="filter commands…" />
          <PromptInputCommandList>
            {state.kind === 'loading' ? (
              <div role="status" className="px-2 py-3 text-muted-foreground text-sm">
                loading commands…
              </div>
            ) : null}
            {state.kind === 'failed' ? (
              <div role="alert" className="px-2 py-3 text-destructive text-sm">
                {state.detail}
              </div>
            ) : null}
            {state.kind === 'loaded' ? (
              <>
                <PromptInputCommandEmpty>{emptyText(state.commands)}</PromptInputCommandEmpty>
                {GROUPS.map(({ source, heading }) => {
                  const rows = state.commands.commands.filter((command) => command.source === source)
                  if (rows.length === 0) return null
                  return (
                    <PromptInputCommandGroup key={source} heading={heading}>
                      {rows.map((command) => (
                        <PromptInputCommandItem
                          key={command.name}
                          value={`/${command.name}`}
                          keywords={command.description === undefined ? [] : [command.description]}
                          onSelect={(): void => choose(command)}
                        >
                          <span className="whitespace-nowrap font-mono">/{command.name}</span>
                          {command.description === undefined ? null : (
                            <span className="truncate text-muted-foreground">{command.description}</span>
                          )}
                        </PromptInputCommandItem>
                      ))}
                    </PromptInputCommandGroup>
                  )
                })}
              </>
            ) : null}
          </PromptInputCommandList>
          {state.kind === 'loaded' && state.commands.source === 'remembered' ? (
            <div className="border-t px-2 py-1.5 text-muted-foreground text-xs">{REMEMBERED_NOTE}</div>
          ) : null}
        </PromptInputCommand>
      </PromptInputActionMenuContent>
    </PromptInputActionMenu>
  )
}
