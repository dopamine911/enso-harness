import type { EnsoStoredThread, HostCommandOption } from '@enso/core'
import { useId, useState } from 'react'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from './components/ui/command.tsx'
import { Popover, PopoverAnchor, PopoverContent } from './components/ui/popover.tsx'

/**
 * The model picker (#880), one for the launch panel's Model chip (#877) and the started composer's
 * (the chip and the palette's `/model`, #338): the models in groups — **Recent** on top, then one
 * group per provider under its readable name — each row with the effort levels it offers.
 *
 * - **Recent**: the models of the latest threads, newest first, each once — what each thread's file
 *   last records (`EnsoStoredThread.model`, #871), so a reload keeps it and no store is added. Only
 *   models on offer now; at most `RECENT_MODELS`. Unfiltered, a recent model is not repeated in its
 *   provider's group; while filtering it is, so a match is never hidden.
 * - **Providers**: by readable name (`HostCommandOption.providerName`, pi's), the logged-in ones
 *   first. A provider not logged in (#880: one the harness set up, `session-models.ts`) is listed
 *   COLLAPSED — its name, "not logged in · N models", and how to log in — and opens to its models,
 *   which cannot be picked: the host refuses them anyway. A filter opens it to its matches.
 * - **Order within a provider** (`compareModels`): family, A–Z; then version, newest first — never
 *   the catalogue's order, which is pi's registration order.
 * - **Search**: substring-first (`rankOption`, #338 slice 3) on the id, the name and the provider —
 *   its id and its readable name. Rows that do not contain the text are hidden; within a group, an
 *   earlier appearance ranks higher. The ranking is done here, not by cmdk (`shouldFilter` off): a
 *   recent model is two rows while filtering, and cmdk identifies a row by its value.
 */

/** How many models Recent holds: "the two or three models you actually use" (#880). */
export const RECENT_MODELS = 3

/**
 * Substring-first ranking for an option list (#338 slice 3): the typed text must APPEAR in
 * the option's id, label or detail — earlier is better — or the row is hidden. cmdk's default
 * fuzzy score matched `openai` to 22 of 53 login options (any row spelling o-p-e-n-a-i in order);
 * the same reason the palette ranks names first (`command-palette.tsx`, `rankCommand`).
 */
export function rankOption(optionId: string, search: string, keywords?: readonly string[]): number {
  const needle = search.toLowerCase()
  if (needle.length === 0) return 1
  let best = 0
  for (const haystack of [optionId, ...(keywords ?? [])]) {
    const lowered = haystack.toLowerCase()
    const at = lowered.indexOf(needle)
    if (at === -1) continue
    best = Math.max(best, 1 - at / (2 * Math.max(lowered.length, 1)))
  }
  return best
}

/** The words an option is found by: its label, the provider its `detail` names, and that provider's readable name (#880). */
export function optionKeywords(option: HostCommandOption): string[] {
  return [option.label, option.detail, option.providerName].filter((word) => word !== undefined)
}

/**
 * The chosen option, in words for the accessibility tree: the check beside it is drawn by CSS
 * (`data-checked`), and the list's own `aria-selected` is cmdk's keyboard highlight, which starts on
 * the first option — so a reader was told the first model was selected whatever was chosen (found
 * by a Dogfood Arena run reading the launch panel (#877).
 */
export function ChosenMark({ chosen }: { chosen: boolean }): React.ReactNode {
  return chosen ? <span className="sr-only">, chosen</span> : null
}

/** The models of the latest threads, most recent first, each once (#880) — every one, before the catalogue is consulted. */
export function recentModelIds(stored: readonly EnsoStoredThread[]): string[] {
  const latestFirst = stored.toSorted((left, right) => right.lastActivityAt.localeCompare(left.lastActivityAt))
  const ids = new Set<string>()
  for (const thread of latestFirst) {
    if (thread.model !== undefined) ids.add(`${thread.model.provider}/${thread.model.modelId}`)
  }
  return [...ids]
}

/** A model's effort range: its first and last level (`off–high`), its one level, or nothing when the host names none. */
export function effortRange(option: HostCommandOption): string | undefined {
  const levels = option.thinkingLevels ?? []
  const first = levels[0]
  const last = levels.at(-1)
  if (first === undefined || last === undefined) return undefined
  return first === last ? first : `${first}–${last}`
}

/** A name's words without the separators around them: `-Sol` is `Sol`, ` Opus ` is `Opus`. */
const words = (text: string): string => text.replace(/[\s_-]+/g, ' ').trim()

/**
 * A model name read for its order (#880): the FAMILY is the name up to its first version number,
 * the VERSION that number, the VARIANT what follows — `GPT-6.1-Sol` is `GPT` 6.1 `Sol`, `Claude
 * Opus 5.5` is `Claude Opus` 5.5, `GPT-5.4 mini` is `GPT` 5.4 `mini`. A name with no digits is all
 * family, with no version.
 */
function readName(name: string): {
  readonly family: string
  readonly version: readonly number[]
  readonly variant: string
} {
  const match = /\d+(?:\.\d+)*/.exec(name)
  if (match === null) return { family: words(name), version: [], variant: '' }
  return {
    family: words(name.slice(0, match.index)),
    version: match[0].split('.').map(Number),
    variant: words(name.slice(match.index + match[0].length)),
  }
}

/** Newer first: the higher number at the first place two versions differ; a missing place is older (6 after 6.1). */
function compareVersions(left: readonly number[], right: readonly number[]): number {
  for (let place = 0; place < Math.max(left.length, right.length); place += 1) {
    const difference = (right[place] ?? -1) - (left[place] ?? -1)
    if (difference !== 0) return difference
  }
  return 0
}

/**
 * THE ORDER WITHIN A PROVIDER (#880), pinned: by family, A–Z (case-insensitive); within a family,
 * newest version first (compared number by number: 6.1, 6, 5.6, 5.5), a name with no version after
 * the versioned ones; one version's variants A–Z (`Astra`, `Luna`, `Sol`); then by name, then by id.
 */
function compareModels(left: HostCommandOption, right: HostCommandOption): number {
  const leftName = readName(left.label)
  const rightName = readName(right.label)
  const byWords = { sensitivity: 'base' } as const
  return (
    leftName.family.localeCompare(rightName.family, undefined, byWords) ||
    compareVersions(leftName.version, rightName.version) ||
    leftName.variant.localeCompare(rightName.variant, undefined, byWords) ||
    left.label.localeCompare(right.label) ||
    left.id.localeCompare(right.id)
  )
}

/**
 * The picker's list in the prototype's `.popover` chrome (#417), laid over cmdk's through `className`:
 * the filter a bare row under its search icon, ruled off from the list; the group headings mono,
 * small and upper-case (`.pop-group`); 40px rows the accent fills when highlighted, the chosen
 * one's check in the primary.
 */
const MODEL_LIST =
  'min-h-0 flex-1 rounded-none bg-transparent p-0 **:data-[slot=command-input-wrapper]:border-b **:data-[slot=command-input-wrapper]:p-0 **:data-[slot=command-input-wrapper]:*:h-12! **:data-[slot=command-input-wrapper]:*:rounded-none! **:data-[slot=command-input-wrapper]:*:border-0 **:data-[slot=command-input-wrapper]:*:bg-transparent **:data-[slot=command-input-wrapper]:*:px-1 **:[[cmdk-group-heading]]:font-mono **:[[cmdk-group-heading]]:text-meta **:[[cmdk-group-heading]]:font-normal **:[[cmdk-group-heading]]:tracking-wider **:[[cmdk-group-heading]]:uppercase **:data-[slot=command-item]:min-h-10 **:data-[slot=command-item]:rounded-sm! **:data-[slot=command-item]:data-selected:bg-accent **:data-[slot=command-item]:[&>svg]:text-primary'

/** One row of the picker: `value` is cmdk's identity for it, unique in the list (a recent model is two rows while filtering). */
interface PickerRow {
  readonly value: string
  readonly option: HostCommandOption
}

/** One group: Recent, or a provider — its readable name, whether it is logged in, and its rows in order. */
interface PickerGroup {
  readonly key: string
  readonly heading: string
  readonly loggedIn: boolean
  readonly rows: readonly PickerRow[]
}

const RECENT_KEY = 'recent'
const RECENT_HEADING = 'Recent'

/** Whether a model can be picked: a provider the host does not say is logged out. */
const pickable = (option: HostCommandOption): boolean => option.loggedIn !== false

/** The rows that contain `search`, the best match first; the given order breaks ties (`toSorted` is stable). */
function ranked(options: readonly HostCommandOption[], search: string): HostCommandOption[] {
  const scored = options.map((option) => ({ option, rank: rankOption(option.id, search, optionKeywords(option)) }))
  return scored
    .filter((scoredOption) => scoredOption.rank > 0)
    .toSorted((left, right) => right.rank - left.rank)
    .map((scoredOption) => scoredOption.option)
}

/** The provider groups, each in the pinned order: logged in first, then A–Z by readable name. */
function providerGroups(options: readonly HostCommandOption[], search: string): PickerGroup[] {
  const byProvider = new Map<string, HostCommandOption[]>()
  for (const option of options) {
    const provider = option.detail ?? ''
    byProvider.set(provider, [...(byProvider.get(provider) ?? []), option])
  }
  const groups = [...byProvider].map(([provider, members]) => {
    const first = members[0]
    return {
      key: `provider ${provider}`,
      heading: first?.providerName ?? (provider === '' ? 'Models' : provider),
      loggedIn: first === undefined || pickable(first),
      rows: ranked(members.toSorted(compareModels), search).map((option) => ({ value: option.id, option })),
    }
  })
  return groups
    .filter((group) => group.rows.length > 0)
    .toSorted(
      (left, right) => Number(right.loggedIn) - Number(left.loggedIn) || left.heading.localeCompare(right.heading),
    )
}

/** The picker's groups (#880) for `options`, the recent model ids (newest first) and the typed filter. */
export function modelGroups(
  options: readonly HostCommandOption[],
  recent: readonly string[],
  search: string,
): PickerGroup[] {
  const recentOptions = recent
    .flatMap((recentId) => options.filter((option) => option.id === recentId && pickable(option)))
    .slice(0, RECENT_MODELS)
  const filtering = search.length > 0
  const recentRows = ranked(recentOptions, search).map((option) => ({ value: `${RECENT_KEY} ${option.id}`, option }))
  const inRecent = new Set(recentOptions)
  const grouped = filtering ? options : options.filter((option) => !inRecent.has(option))
  const groups = providerGroups(grouped, search)
  return recentRows.length === 0
    ? groups
    : [{ key: RECENT_KEY, heading: RECENT_HEADING, loggedIn: true, rows: recentRows }, ...groups]
}

/** A provider's group heading: its readable name, and for one not logged in, that and how many models it has. */
function GroupHeading({ group }: { readonly group: PickerGroup }): React.ReactNode {
  if (group.loggedIn) return group.heading
  const count = group.rows.length === 1 ? '1 model' : `${group.rows.length} models`
  return (
    <>
      {group.heading} <span className="tracking-normal text-chart-3 normal-case">· not logged in · {count}</span>
    </>
  )
}

function ModelRow({
  row,
  chosen,
  onChoose,
}: {
  readonly row: PickerRow
  readonly chosen: string | undefined
  readonly onChoose: (option: HostCommandOption) => void
}): React.ReactNode {
  const { option } = row
  const range = effortRange(option)
  return (
    <CommandItem
      value={row.value}
      disabled={!pickable(option)}
      data-checked={option.id === chosen}
      onSelect={(): void => onChoose(option)}
    >
      <span className="flex-1 truncate font-medium">{option.label}</span>
      {range === undefined ? null : (
        <span className="font-mono text-meta whitespace-nowrap text-muted-foreground">{range}</span>
      )}
      <ChosenMark chosen={option.id === chosen} />
    </CommandItem>
  )
}

/** The row a collapsed provider shows instead of its models: how to log in, and choosing it opens the group. */
function CollapsedRow({
  group,
  onExpand,
}: {
  readonly group: PickerGroup
  readonly onExpand: () => void
}): React.ReactNode {
  return (
    <CommandItem value={`expand ${group.key}`} onSelect={onExpand}>
      <span className="flex-1 truncate text-muted-foreground">log in with /login to pick one</span>
      <span className="text-xs">show models</span>
    </CommandItem>
  )
}

interface ModelListProps {
  readonly options: readonly HostCommandOption[]
  readonly recent: readonly string[]
  readonly chosen: string | undefined
  readonly onChoose: (option: HostCommandOption) => void
  readonly filter: string
  readonly onFilter: (filter: string) => void
}

function ModelList({ options, recent, chosen, onChoose, filter, onFilter }: ModelListProps): React.ReactNode {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  // ⚠ cmdk highlights (`aria-selected`) its first row unless told which, and Enter in the filter
  // commits the highlighted row (#846): the highlight is the chosen model's until the arrows or the
  // filter move it, and a new choice takes it back. Held with the choice it moved from, so a
  // highlight cmdk set before the choice arrived does not outlive it. A chosen model the list does
  // not show is no row to highlight: the highlight is left to cmdk, on its first row, so Enter
  // still has one to commit.
  const [moved, setMoved] = useState<{ readonly from: string | undefined; readonly value: string } | undefined>(
    undefined,
  )
  const groups = modelGroups(options, recent, filter)
  // A group's models show always for Recent and a logged-in provider; for one not logged in, once
  // opened or while filtering.
  const open = (group: PickerGroup): boolean => group.loggedIn || filter.length > 0 || expanded.has(group.key)
  // The chosen model's first row on screen; none when it shows no row (cmdk's first row then).
  const offered = groups
    .filter(open)
    .flatMap((group) => group.rows)
    .find((row) => row.option.id === chosen)?.value
  const highlighted = moved !== undefined && moved.from === chosen ? moved.value : offered
  // Opened, a group's rows cannot be picked: the highlight stays where it was, not on a disabled row.
  const expand = (group: PickerGroup): void => setExpanded((current) => new Set([...current, group.key]))
  return (
    // ⚠ cmdk sets the input's id itself, after ours: a label `htmlFor` named nothing, and the
    // filter read as a bare `combobox`. cmdk's own label is the one it wires to the input.
    <Command
      className={MODEL_LIST}
      label="Model"
      shouldFilter={false}
      {...(highlighted === undefined ? {} : { value: highlighted })}
      onValueChange={(value: string): void => setMoved({ from: chosen, value })}
    >
      <CommandInput placeholder="Filter models" value={filter} onValueChange={onFilter} />
      <CommandList className="max-h-84 min-h-0 flex-1 p-1">
        <CommandEmpty>no model matches</CommandEmpty>
        {groups.map((group) => (
          <CommandGroup key={group.key} heading={<GroupHeading group={group} />}>
            {open(group) ? (
              group.rows.map((row) => <ModelRow key={row.value} row={row} chosen={chosen} onChoose={onChoose} />)
            ) : (
              <CollapsedRow group={group} onExpand={(): void => expand(group)} />
            )}
          </CommandGroup>
        ))}
      </CommandList>
    </Command>
  )
}

/** What the picker lists: the models, or why there are none yet. */
type ModelListing =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly detail: string }
  | { readonly kind: 'loaded'; readonly options: readonly HostCommandOption[] }

interface ModelPickerProps {
  readonly open: boolean
  /** The Model chip the picker hangs from (#417): it opens above it, or below where there is no room. */
  readonly anchor: React.RefObject<HTMLElement | null>
  readonly listing: ModelListing
  /** The chosen model's option id: marked, and highlighted first. */
  readonly chosen: string | undefined
  /** The recent model ids, newest first (`recentModelIds`). */
  readonly recent: readonly string[]
  /** What choosing does here: the launch panel's "the session starts on it", the session's "switch the model". */
  readonly purpose: string
  /** A model was chosen; the picker has closed. */
  readonly onChoose: (option: HostCommandOption) => void
  readonly onClose: () => void
  /** Where focus goes once the picker has closed: the chip that opened it, or the composer. */
  readonly returnFocus: () => void
}

/** The listing's words while there are no models to show. */
function ListingStatus({ listing }: { readonly listing: Exclude<ModelListing, { kind: 'loaded' }> }): React.ReactNode {
  return listing.kind === 'loading' ? (
    <div role="status" className="px-2 py-3 text-sm text-muted-foreground">
      loading models…
    </div>
  ) : (
    <div role="alert" className="px-2 py-3 text-sm text-destructive">
      {listing.detail}
    </div>
  )
}

/**
 * The model picker as the prototype's `.popover` (#417): hung from the Model chip — above it, or
 * below where the window has no room — 360px wide, lifted by `shadow-pop`, no backdrop; its filter
 * cleared each time it closes. Escape and a click outside close it; a press on the chip itself does
 * not (`keepOnAnchor`), or the chip's own click would reopen what the press had just closed.
 */
export function ModelPicker(props: ModelPickerProps): React.ReactNode {
  const { open, anchor, listing, onClose, returnFocus } = props
  const [filter, setFilter] = useState('')
  const footId = useId()
  const close = (): void => {
    setFilter('')
    onClose()
  }
  // ⚠ Escape in the filter is the filter's (#638): Radix closes the popover from a capture listener
  // on the document, so the input cannot stop it — prevented here, as the command palette's pages
  // do. It clears the filter; with nothing left to clear it closes, like Escape anywhere else. The
  // filter is the picker's one `cmdk-input` (cmdk overrides any id we give it).
  const escapeFromFilter = (event: KeyboardEvent): void => {
    if (!(event.target instanceof HTMLElement) || !event.target.matches('input[cmdk-input]')) return
    if (filter.length === 0) return
    event.preventDefault()
    setFilter('')
  }
  const keepOnAnchor = (event: Event): void => {
    if (event.target instanceof Node && anchor.current?.contains(event.target) === true) event.preventDefault()
  }
  return (
    <Popover
      open={open}
      onOpenChange={(next: boolean): void => {
        if (!next) close()
      }}
    >
      <PopoverAnchor virtualRef={anchor} />
      {/* ⚠ Closed, focus goes where the owner says: Radix returns it to a trigger of its own, and
          neither the chip nor the palette is one, so a keyboard user was left on the page's body. */}
      <PopoverContent
        aria-label="Model"
        aria-describedby={footId}
        side="top"
        align="start"
        sideOffset={6}
        collisionPadding={8}
        className="max-h-(--radix-popover-content-available-height) w-popover max-w-(--radix-popover-content-available-width) gap-0 overflow-hidden p-0 shadow-pop ring-0"
        onEscapeKeyDown={escapeFromFilter}
        onPointerDownOutside={keepOnAnchor}
        onFocusOutside={keepOnAnchor}
        onCloseAutoFocus={(event: Event): void => {
          event.preventDefault()
          returnFocus()
        }}
      >
        {listing.kind === 'loaded' ? (
          <ModelList
            options={listing.options}
            recent={props.recent}
            chosen={props.chosen}
            onChoose={(option: HostCommandOption): void => {
              close()
              props.onChoose(option)
            }}
            filter={filter}
            onFilter={setFilter}
          />
        ) : (
          <ListingStatus listing={listing} />
        )}
        {/* Under the list, as the prototype's `.pop-foot` says it (#417): what choosing does here, and what a row's range is. */}
        <p id={footId} className="shrink-0 border-t px-3 py-2 text-xs text-muted-foreground">
          {props.purpose}; each row shows the effort levels that model offers
        </p>
      </PopoverContent>
    </Popover>
  )
}
