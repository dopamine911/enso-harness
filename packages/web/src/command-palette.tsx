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
import { optionKeywords } from './model-state.tsx'
import { SLASH_PROMPT_REFUSAL } from './start-session.tsx'

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
 * command with no arguments runs, and `/mode` bare opens the mode extension's select dialog, which is the
 * nicer UX). A `prompt` template or a `skill` is INSERTED — `onInsert(name)`, and the owner puts
 * `/<name> ` in the composer and focuses it — because those take arguments the user has yet to
 * type. A `host` row renders BY KIND, nothing per command (#338 slice 2): a `level` row (`/thinking`)
 * replaces the list with its options — a PAGE inside the same cmdk root, filtered by the same box;
 * Escape or Backspace on an empty filter returns to the root — and picking one is
 * `onHost(name, optionId)`. A `select` row (`/model`) closes the palette and hands the row to
 * `onOpenModelDialog`: the owner renders the `ModelSelector` dialog (the second step Claude Code's
 * `Switch model…` opens), so the palette holds no dialog state. A `view` row (`/context`, #361)
 * closes the palette and hands the row to `onOpenView`: the owner opens that view over the chat,
 * and nothing is posted. An `action` row — and any kind
 * this palette does not know, since a newer host may declare one — is `onHost(name)`. Every
 * callback fires from the menu's `onCloseAutoFocus`, AFTER the menu has closed: the menu's focus
 * trap would otherwise pull focus straight back from the textarea the owner just focused, and
 * the menu's own "return focus to the trigger" is prevented so the owner's choice of focus
 * stands. A close without a selection (Escape, click-away) fires nothing and returns focus to
 * the `/` button as the menu does by itself.
 *
 * A `host` row shows its current option's `label` on the right, dim (`Fake One`, `medium`), when
 * the row carries a `value`; a `remembered` list carries none — the server strips it, because a
 * thread with no live session has no current value — and the row still opens its step: choosing
 * the model before the first prompt is the #341 case, not an error. A `flow` row (`/login`,
 * `/logout`, slice 3) opens the same option dialog a `select` does — the choice is the same
 * gesture; what differs is what the server does with it (202: started, and the flow's questions
 * arrive as dialog cards), and that is the route's business, not the palette's.
 *
 * Empty states say WHICH empty. The server builds the thread's session when the palette asks
 * (#390), so `live` is the normal answer; `none` and `remembered` now mean that build FAILED —
 * `none` (nothing built in this process to fall back on) reads "the session could not start — no
 * commands to offer; the server log says why", and `remembered` shows the last session's rows
 * with a footer note that this thread's session could not start. A live list with zero rows
 * reads "this session registers no commands"; a filter that matches nothing reads "no command
 * matches". A sentence the server cannot back is a sentence the palette must not say (PR #343
 * review) — before #390 these two said "no thread has run yet", which a restart made routine.
 *
 * ⚠ NO RADIX MENU ITEM MAY LIVE INSIDE THIS CONTENT. The dropdown's content feeds every printable
 * key pressed anywhere inside it to its typeahead (`@radix-ui/react-menu`, `MenuContent.onKeyDown`)
 * with no guard for inputs; it is harmless only because this content registers zero menu items,
 * so the typeahead has nothing to focus. One `PromptInputActionMenuItem` here and filtering
 * would yank focus out of the filter box (PR #343 review). Arrow keys are safe on their own:
 * Radix returns before handling them unless the content itself is the target.
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
  /** A `host` command was chosen — an `action` bare, a `level`'s option with its id: `POST …/command`. */
  readonly onHost: (commandName: string, optionId?: string) => void
  /** A `select` host row was chosen: the owner opens the model dialog for it; the palette has closed. */
  readonly onOpenModelDialog: (command: RuntimeCommand) => void
  /** A `view` host row was chosen: the owner opens the view it names; the palette has closed. */
  readonly onOpenView: (command: RuntimeCommand) => void
  /** The composer is not taking input (disconnected); the `/` button follows it. */
  readonly disabled?: boolean
}

type PaletteState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'loaded'; readonly commands: EnsoThreadCommands }
  | { readonly kind: 'failed'; readonly detail: string }

const NO_COMMANDS = 'this session registers no commands'
const NO_MATCH = 'no command matches'

/** One cmdk group per source, in the order the palette shows them — ours first: it is short, and the settings are what a chip points at. */
const GROUPS: ReadonlyArray<{ readonly source: RuntimeCommand['source']; readonly heading: string }> = [
  { source: 'host', heading: 'settings' },
  { source: 'extension', heading: 'extensions' },
  { source: 'prompt', heading: 'prompts' },
  { source: 'skill', heading: 'skills' },
]

/** What a chosen row does once the menu has closed (header): delivered from `onCloseAutoFocus`. */
type Choice =
  | { readonly kind: 'run'; readonly command: RuntimeCommand }
  | { readonly kind: 'insert'; readonly command: RuntimeCommand }
  | { readonly kind: 'host'; readonly command: RuntimeCommand; readonly optionId?: string }
  | { readonly kind: 'dialog'; readonly command: RuntimeCommand }
  | { readonly kind: 'view'; readonly command: RuntimeCommand }

/** The row's current option, by `value`, for the dim label on the right; the raw `value` if no option carries it. */
function currentLabel(command: RuntimeCommand): string | undefined {
  if (command.value === undefined) return undefined
  return command.options?.find((option) => option.id === command.value)?.label ?? command.value
}

/** Name-first ranking for cmdk's `filter` (header): `1` is a match at the start of the name, `0` hides the row. */
export function rankCommand(rowValue: string, search: string, keywords?: readonly string[]): number {
  const needle = search.toLowerCase()
  const nameAt = rowValue.toLowerCase().indexOf(needle)
  // `/name` — the name starts at 1; a search typed with its own `/` matches at 0 and counts as the
  // start too (else it would score above 1, by name length — PR #343 review). Later starts rank
  // lower but stay above 0.5.
  if (nameAt >= 0) return 1 - (Math.max(nameAt, 1) - 1) / (2 * rowValue.length)
  const inDescription = keywords?.some((keyword) => keyword.toLowerCase().includes(needle)) ?? false
  return inDescription ? 0.25 : 0
}

/**
 * The rows the palette lists: a live session's, every one of them; for a thread with no session,
 * NONE (#484) — the host's `catalogue` is the Start dialog's, and the slash commands belong to a
 * running session. The sentence says so where the rows would be.
 */
function listedRows(commands: EnsoThreadCommands): readonly RuntimeCommand[] {
  return commands.source === 'live' ? commands.commands : []
}

/** The sentence cmdk shows when no row is visible — which depends on WHY there is none. */
function emptyText(commands: EnsoThreadCommands): string {
  if (commands.source !== 'live') return SLASH_PROMPT_REFUSAL
  return commands.commands.length > 0 ? NO_MATCH : NO_COMMANDS
}

/** THE SELECTION RULE (header), as what the chosen row does once the menu has closed; undefined for a `level` row, which opens its page instead. */
function choiceFor(command: RuntimeCommand): Choice | undefined {
  if (command.source === 'extension') return { kind: 'run', command }
  if (command.source !== 'host') return { kind: 'insert', command }
  switch (command.kind) {
    case 'level':
      return undefined
    case 'select':
    case 'flow':
      return { kind: 'dialog', command }
    case 'view':
      return { kind: 'view', command }
    default:
      return { kind: 'host', command }
  }
}

export type ChoiceHandlers = Pick<
  CommandPaletteProps,
  'onRun' | 'onInsert' | 'onHost' | 'onOpenModelDialog' | 'onOpenView'
>

/** Hands a choice to the owner's callback for it. */
function deliver(chosen: Choice, handlers: ChoiceHandlers): void {
  switch (chosen.kind) {
    case 'run':
      handlers.onRun(chosen.command.name)
      break
    case 'insert':
      handlers.onInsert(chosen.command.name)
      break
    case 'host':
      if (chosen.optionId === undefined) handlers.onHost(chosen.command.name)
      else handlers.onHost(chosen.command.name, chosen.optionId)
      break
    case 'dialog':
      handlers.onOpenModelDialog(chosen.command)
      break
    case 'view':
      handlers.onOpenView(chosen.command)
      break
  }
}

/**
 * A bare `/<name>` typed into the composer (#388): the command's name, or undefined when the text
 * is anything else — words after it, a second line, no slash. Only a bare name is a command to
 * route; `/login` followed by words is a message.
 */
export function typedCommandName(text: string): string | undefined {
  return /^\/([a-z][\w-]*)\s*$/i.exec(text)?.[1]
}

/**
 * A typed host command does what choosing its row does (#388): `/login` opens the provider picker
 * the palette would, instead of going to pi as a prompt the server refuses — the refusal read as
 * "the run failed" and outlived the login the user then started. False for a `level` row
 * (`/thinking`), whose options live on a palette page the composer cannot open.
 */
export function runTypedHostCommand(command: RuntimeCommand, handlers: ChoiceHandlers): boolean {
  const choice = choiceFor(command)
  if (choice === undefined) return false
  deliver(choice, handlers)
  return true
}

export function CommandPalette({
  threadId,
  fetch: fetchImpl,
  onRun,
  onInsert,
  onHost,
  onOpenModelDialog,
  onOpenView,
  disabled = false,
}: CommandPaletteProps): React.ReactNode {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<PaletteState>({ kind: 'loading' })
  // The `level` row whose options replace the list (header); undefined at the root.
  const [page, setPage] = useState<RuntimeCommand | undefined>(undefined)
  // The filter's text, controlled so a page change clears it: what narrowed the root would not narrow the page.
  const [search, setSearch] = useState('')
  // Which open a response belongs to; a response from an earlier open is dropped.
  const openCount = useRef(0)
  // The row chosen before the menu closed; delivered from `onCloseAutoFocus` (header).
  const pending = useRef<Choice | undefined>(undefined)
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
    setPage(undefined)
    setSearch('')
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

  const finish = (choice: Choice): void => {
    pending.current = choice
    setOpen(false)
  }

  const enterPage = (command: RuntimeCommand): void => {
    setPage(command)
    setSearch('')
  }

  const leavePage = (): void => {
    setPage(undefined)
    setSearch('')
  }

  const choose = (command: RuntimeCommand): void => {
    const choice = choiceFor(command)
    if (choice === undefined) enterPage(command)
    else finish(choice)
  }

  const deliverChoice = (event: Event): void => {
    const chosen = pending.current
    if (chosen === undefined) return
    pending.current = undefined
    // The owner decides where focus goes next, not the menu's return-to-trigger.
    event.preventDefault()
    deliver(chosen, { onRun, onInsert, onHost, onOpenModelDialog, onOpenView })
  }

  // A page's way back (header): Escape stays inside the menu — prevented here, so the
  // dismissable layer does not close it — and Backspace with nothing to delete returns too.
  const escapeFromPage = (event: KeyboardEvent): void => {
    if (page === undefined) return
    event.preventDefault()
    leavePage()
  }
  const backspaceFromPage = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (page === undefined || event.key !== 'Backspace' || event.currentTarget.value.length > 0) return
    event.preventDefault()
    leavePage()
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
        // The trigger sits at the composer's right edge; anchored `start`, 28rem of popup ran off
        // the viewport at 1100px (Chromium smoke). `end` keeps it inside at every width the composer fits.
        align="end"
        className="w-command-palette p-0"
        onFocus={(event: React.FocusEvent<HTMLDivElement>): void => {
          if (event.target === event.currentTarget) filterRef.current?.focus()
        }}
        onCloseAutoFocus={deliverChoice}
        onEscapeKeyDown={escapeFromPage}
      >
        <PromptInputCommand label="commands" filter={rankCommand}>
          <PromptInputCommandInput
            ref={filterRef}
            value={search}
            onValueChange={setSearch}
            onKeyDown={backspaceFromPage}
            placeholder={page === undefined ? 'filter commands…' : `${page.description ?? `/${page.name}`}…`}
          />
          <PromptInputCommandList>
            {state.kind === 'loading' ? (
              <div role="status" className="px-2 py-3 text-sm text-muted-foreground">
                loading commands…
              </div>
            ) : null}
            {state.kind === 'failed' ? (
              <div role="alert" className="px-2 py-3 text-sm text-destructive">
                {state.detail}
              </div>
            ) : null}
            {state.kind === 'loaded' && page !== undefined ? (
              <>
                <PromptInputCommandEmpty>{NO_MATCH}</PromptInputCommandEmpty>
                <PromptInputCommandGroup heading={`/${page.name}`}>
                  {(page.options ?? []).map((option) => (
                    <PromptInputCommandItem
                      key={option.id}
                      value={option.id}
                      keywords={optionKeywords(option)}
                      data-checked={option.id === page.value}
                      onSelect={(): void => finish({ kind: 'host', command: page, optionId: option.id })}
                    >
                      <span className="whitespace-nowrap">{option.label}</span>
                      {option.detail === undefined ? null : (
                        <span className="truncate text-muted-foreground">{option.detail}</span>
                      )}
                    </PromptInputCommandItem>
                  ))}
                </PromptInputCommandGroup>
              </>
            ) : null}
            {state.kind === 'loaded' && page === undefined ? (
              <>
                <PromptInputCommandEmpty>{emptyText(state.commands)}</PromptInputCommandEmpty>
                {GROUPS.map(({ source, heading }) => {
                  const rows = listedRows(state.commands).filter((command) => command.source === source)
                  if (rows.length === 0) return null
                  return (
                    <PromptInputCommandGroup key={source} heading={heading}>
                      {rows.map((command) => {
                        const label = currentLabel(command)
                        return (
                          <PromptInputCommandItem
                            key={command.name}
                            value={`/${command.name}`}
                            keywords={command.description === undefined ? [] : [command.description]}
                            onSelect={(): void => choose(command)}
                          >
                            <span className="font-mono whitespace-nowrap">/{command.name}</span>
                            {command.description === undefined ? null : (
                              <span className="truncate text-muted-foreground">{command.description}</span>
                            )}
                            {label === undefined ? null : (
                              <span className="ml-auto pl-2 text-xs whitespace-nowrap text-muted-foreground">
                                {label}
                              </span>
                            )}
                          </PromptInputCommandItem>
                        )
                      })}
                    </PromptInputCommandGroup>
                  )
                })}
              </>
            ) : null}
          </PromptInputCommandList>
        </PromptInputCommand>
      </PromptInputActionMenuContent>
    </PromptInputActionMenu>
  )
}
