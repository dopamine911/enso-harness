import {
  ENSO_DEFAULT_ROLE,
  type EnsoModelsConfig,
  type EnsoRoleResolution,
  type EnsoStoredThread,
  type HostCommandOption,
  resolveModelRole,
} from '@enso/core'
import { StarIcon } from 'lucide-react'
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
import { cn } from './lib/utils.ts'
import { modelsConfigOf, modelsSettings, useModelsSettings, withToggled } from './models-settings.ts'

/**
 * The model picker (#880, #904), one for the launch panel's Model chip (#877) and the started
 * composer's (the chip and the palette's `/model`, #338): **Roles** on top, then **Favorites**,
 * then **Recent**, then one group per provider under its readable name — each model row with the
 * effort levels it offers and a star.
 *
 * - **Roles** (#904): only where the owner can run one (`onChooseRole`) and the person has set some
 *   up. Each row is the role's name, the model it resolves to NOW (`resolveModelRole` against the
 *   options on offer) and its effort — "clamped from X" when the model does not offer the level
 *   asked — and the fallback notice when the role's own model is unavailable. A refused role is
 *   listed, disabled, with its reason.
 * - **Favorites** (#904): the person's starred models (`models.favorites`), in their order. A
 *   favorite not on offer, or whose provider is not logged in, is listed disabled and marked
 *   unavailable — never dropped, so it can still be unstarred.
 * - **Recent**: the models of the latest threads, newest first, each once — what each thread's file
 *   last records (`EnsoStoredThread.model`, #871), so a reload keeps it and no store is added. Only
 *   models on offer now, not favorites; at most `RECENT_MODELS`.
 * - **Providers**: by readable name (`HostCommandOption.providerName`, pi's), the logged-in ones
 *   first. A provider not logged in (#880: one the harness set up, `session-models.ts`) is listed
 *   COLLAPSED — its name, "not logged in · N models", and how to log in — and opens to its models,
 *   which cannot be picked: the host refuses them anyway. A filter opens it to its matches.
 * - **Hidden providers** (`models.hiddenProviders`, #904) are left out of Recent and the provider
 *   groups; their models still show as favorites and as roles' targets.
 * - Unfiltered, a model in Favorites or Recent is not repeated in its provider's group; while
 *   filtering it is, so a match is never hidden.
 * - **Order within a provider** (`compareModels`): family, A–Z; then version, newest first — never
 *   the catalogue's order, which is pi's registration order.
 * - **Search**: substring-first (`rankOption`, #338 slice 3) on the id, the name and the provider —
 *   its id and its readable name; a role by its name and its model. Rows that do not contain the
 *   text are hidden; within a group, an earlier appearance ranks higher. The ranking is done here,
 *   not by cmdk (`shouldFilter` off): a model is two rows while filtering, and cmdk identifies a
 *   row by its value.
 * - **Star** (#904): each model row's toggle saves the favorites (`modelsSettings.save`) and never
 *   chooses the row. Offered only once the section is read: a save is the whole section.
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

/** One row of the picker: `value` is cmdk's identity for it, unique in the list (a model is two rows while filtering). */
interface PickerRow {
  readonly value: string
  readonly option: HostCommandOption
  /** A favorite not on offer now, or whose provider is not logged in (#904): listed, never picked. */
  readonly unavailable?: boolean
}

/** One group: Favorites, Recent, or a provider — its readable name, whether it is logged in, and its rows in order. */
interface PickerGroup {
  readonly key: string
  readonly heading: string
  readonly loggedIn: boolean
  readonly rows: readonly PickerRow[]
}

/** One role's row (#904): its name and what it resolves to now, or why it is refused. */
export interface RoleRow {
  readonly value: string
  readonly role: string
  readonly resolution: EnsoRoleResolution
}

const RECENT_KEY = 'recent'
const RECENT_HEADING = 'Recent'
const FAVORITES_KEY = 'favorite'
const FAVORITES_HEADING = 'Favorites'
const ROLES_KEY = 'role'
const ROLES_HEADING = 'Roles'

/** Whether a model can be picked: a provider the host does not say is logged out. */
const pickable = (option: HostCommandOption): boolean => option.loggedIn !== false

/** The rows that matched (`rank` above 0), the best match first; the given order breaks ties (`toSorted` is stable). */
function bestFirst<Row>(scored: readonly { readonly row: Row; readonly rank: number }[]): Row[] {
  return scored
    .filter((scoredRow) => scoredRow.rank > 0)
    .toSorted((left, right) => right.rank - left.rank)
    .map((scoredRow) => scoredRow.row)
}

/** The options that contain `search`, the best match first. */
function ranked(options: readonly HostCommandOption[], search: string): HostCommandOption[] {
  return bestFirst(
    options.map((option) => ({ row: option, rank: rankOption(option.id, search, optionKeywords(option)) })),
  )
}

/** The roles' names in the order they are shown (#904): `default` first, then A–Z. */
export function roleNamesInOrder(models: EnsoModelsConfig): string[] {
  return Object.keys(models.roles ?? {}).toSorted(
    (left, right) =>
      Number(right === ENSO_DEFAULT_ROLE) - Number(left === ENSO_DEFAULT_ROLE) || left.localeCompare(right),
  )
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

/** The roles' rows (#904), `default` first then A–Z, each resolved against `options`; filtered by name and model. */
export function roleRows(models: EnsoModelsConfig, options: readonly HostCommandOption[], search: string): RoleRow[] {
  return bestFirst(
    roleNamesInOrder(models).map((role) => {
      const resolution = resolveModelRole(role, models, options)
      const keywords = resolution.kind === 'resolved' ? [resolution.modelName, resolution.model] : []
      return { row: { value: `${ROLES_KEY} ${role}`, role, resolution }, rank: rankOption(role, search, keywords) }
    }),
  )
}

/** The favorites' rows (#904), in the person's order: an id not on offer is still a row, named by its id and unavailable. */
function favoriteRows(
  options: readonly HostCommandOption[],
  favorites: readonly string[],
  search: string,
): PickerRow[] {
  return bestFirst(
    favorites.map((favoriteId) => {
      const offered = options.find((option) => option.id === favoriteId)
      const option = offered ?? { id: favoriteId, label: favoriteId }
      return {
        row: {
          value: `${FAVORITES_KEY} ${favoriteId}`,
          option,
          unavailable: offered === undefined || !pickable(offered),
        },
        rank: rankOption(option.id, search, optionKeywords(option)),
      }
    }),
  )
}

/**
 * The picker's model groups (#880, #904) for `options`, the recent model ids (newest first), the
 * typed filter and the person's `models` section: Favorites, Recent, then the providers not hidden.
 */
export function modelGroups(
  options: readonly HostCommandOption[],
  recent: readonly string[],
  search: string,
  models: EnsoModelsConfig = {},
): PickerGroup[] {
  const hidden = new Set(models.hiddenProviders ?? [])
  const shown = options.filter((option) => !hidden.has(option.detail ?? ''))
  const favorites = models.favorites ?? []
  const starred = new Set(favorites)
  const recentOptions = recent
    .flatMap((recentId) =>
      shown.filter((option) => option.id === recentId && pickable(option) && !starred.has(option.id)),
    )
    .slice(0, RECENT_MODELS)
  const filtering = search.length > 0
  const favorite = favoriteRows(options, favorites, search)
  const recentRows = ranked(recentOptions, search).map((option) => ({ value: `${RECENT_KEY} ${option.id}`, option }))
  const inRecent = new Set(recentOptions)
  const grouped = filtering ? shown : shown.filter((option) => !inRecent.has(option) && !starred.has(option.id))
  const leading: PickerGroup[] = []
  if (favorite.length > 0)
    leading.push({ key: FAVORITES_KEY, heading: FAVORITES_HEADING, loggedIn: true, rows: favorite })
  if (recentRows.length > 0)
    leading.push({ key: RECENT_KEY, heading: RECENT_HEADING, loggedIn: true, rows: recentRows })
  return [...leading, ...providerGroups(grouped, search)]
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

/** Starring a model (#904): the favorites as saved, and the toggle for one id. */
interface Stars {
  readonly favorites: readonly string[]
  readonly toggle: (modelId: string) => void
}

/**
 * A model row's star (#904): a toggle of its own inside the row, which never chooses the row — the
 * click and the keys that would reach cmdk's own handling (Enter commits the highlighted row) stop
 * here. Usable on a row that cannot be picked: an unavailable favorite must still be unstarrable.
 */
function StarToggle({ option, stars }: { readonly option: HostCommandOption; readonly stars: Stars }): React.ReactNode {
  const starred = stars.favorites.includes(option.id)
  return (
    <button
      type="button"
      aria-pressed={starred}
      aria-label={`${starred ? 'Unstar' : 'Star'} ${option.label}`}
      title={starred ? 'remove from Favorites' : 'add to Favorites'}
      className="pointer-events-auto -my-1 shrink-0 rounded-sm p-1 text-muted-foreground opacity-100 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none aria-pressed:text-primary"
      onPointerDown={(event: React.PointerEvent): void => event.stopPropagation()}
      onKeyDown={(event: React.KeyboardEvent): void => {
        if (event.key === 'Enter' || event.key === ' ') event.stopPropagation()
      }}
      onClick={(event: React.MouseEvent): void => {
        event.preventDefault()
        event.stopPropagation()
        stars.toggle(option.id)
      }}
    >
      <StarIcon aria-hidden="true" className={cn('size-3.5', starred && 'fill-current')} />
    </button>
  )
}

function ModelRow({
  row,
  chosen,
  onChoose,
  stars,
}: {
  readonly row: PickerRow
  readonly chosen: string | undefined
  readonly onChoose: (option: HostCommandOption) => void
  /** Undefined while the models section is not read: nothing to save a star into. */
  readonly stars: Stars | undefined
}): React.ReactNode {
  const { option } = row
  const range = effortRange(option)
  const unavailable = row.unavailable === true
  return (
    <CommandItem
      value={row.value}
      disabled={unavailable || !pickable(option)}
      data-checked={option.id === chosen}
      onSelect={(): void => onChoose(option)}
    >
      <span className="flex-1 truncate font-medium">{option.label}</span>
      {unavailable ? <span className="text-xs whitespace-nowrap text-chart-3">unavailable</span> : null}
      {range === undefined ? null : (
        <span className="font-mono text-meta whitespace-nowrap text-muted-foreground">{range}</span>
      )}
      {stars === undefined ? null : <StarToggle option={option} stars={stars} />}
      <ChosenMark chosen={option.id === chosen} />
    </CommandItem>
  )
}

/** A role's effort as its row and the launch panel's chip say it: the level, and the one asked when clamped. */
export function roleEffortText(resolution: Extract<EnsoRoleResolution, { kind: 'resolved' }>): string | undefined {
  if (resolution.effort === undefined) return undefined
  return resolution.clamped && resolution.requestedEffort !== undefined
    ? `${resolution.effort} · clamped from ${resolution.requestedEffort}`
    : resolution.effort
}

/** A role's row (#904): its name, the model it resolves to and its effort; refused, disabled with its reason. */
function RoleItem({
  row,
  chosenRole,
  onChooseRole,
}: {
  readonly row: RoleRow
  readonly chosenRole: string | undefined
  readonly onChooseRole: (role: string) => void
}): React.ReactNode {
  const { resolution } = row
  const chosen = row.role === chosenRole
  if (resolution.kind === 'refused') {
    return (
      <CommandItem value={row.value} disabled>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="font-medium">{row.role}</span>
          <span className="text-xs whitespace-normal text-refuse">{resolution.reason}</span>
        </span>
      </CommandItem>
    )
  }
  const effort = roleEffortText(resolution)
  return (
    <CommandItem value={row.value} data-checked={chosen} onSelect={(): void => onChooseRole(row.role)}>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="font-medium">{row.role}</span>
          <span className="truncate text-muted-foreground">{resolution.modelName}</span>
        </span>
        {resolution.notice === undefined ? null : (
          <span className="text-xs whitespace-normal text-chart-3">{resolution.notice}</span>
        )}
      </span>
      {effort === undefined ? null : (
        <span className="font-mono text-meta whitespace-nowrap text-muted-foreground">{effort}</span>
      )}
      <ChosenMark chosen={chosen} />
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
  /** The person's `models` section (#904): favorites, hidden providers, roles. */
  readonly models: EnsoModelsConfig
  readonly stars: Stars | undefined
  /** The chosen role, marked and highlighted first; its group shows only with `onChooseRole`. */
  readonly chosenRole: string | undefined
  readonly onChooseRole: ((role: string) => void) | undefined
  readonly filter: string
  readonly onFilter: (filter: string) => void
}

function ModelList(props: ModelListProps): React.ReactNode {
  const { options, recent, chosen, onChoose, models, stars, chosenRole, onChooseRole, filter, onFilter } = props
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  // ⚠ cmdk highlights (`aria-selected`) its first row unless told which, and Enter in the filter
  // commits the highlighted row (#846): the highlight is the chosen row's until the arrows or the
  // filter move it, and a new choice takes it back. Held with the choice it moved from, so a
  // highlight cmdk set before the choice arrived does not outlive it. A chosen model the list does
  // not show is no row to highlight: the highlight is left to cmdk, on its first row, so Enter
  // still has one to commit.
  const [moved, setMoved] = useState<{ readonly from: string; readonly value: string } | undefined>(undefined)
  const choice = `${chosenRole ?? ''} ${chosen ?? ''}`
  const roles = onChooseRole === undefined ? [] : roleRows(models, options, filter)
  const groups = modelGroups(options, recent, filter, models)
  // A group's models show always for Favorites, Recent and a logged-in provider; for one not
  // logged in, once opened or while filtering.
  const open = (group: PickerGroup): boolean => group.loggedIn || filter.length > 0 || expanded.has(group.key)
  // The chosen role's row, else the chosen model's first row on screen; none when neither shows (cmdk's first row then).
  const offered =
    roles.find((row) => row.role === chosenRole)?.value ??
    groups
      .filter(open)
      .flatMap((group) => group.rows)
      .find((row) => row.option.id === chosen && row.unavailable !== true)?.value
  const highlighted = moved !== undefined && moved.from === choice ? moved.value : offered
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
      onValueChange={(value: string): void => setMoved({ from: choice, value })}
    >
      <CommandInput placeholder="Filter models" value={filter} onValueChange={onFilter} />
      <CommandList className="max-h-84 min-h-0 flex-1 p-1">
        <CommandEmpty>no model matches</CommandEmpty>
        {onChooseRole === undefined || roles.length === 0 ? null : (
          <CommandGroup key={ROLES_KEY} heading={ROLES_HEADING}>
            {roles.map((row) => (
              <RoleItem key={row.value} row={row} chosenRole={chosenRole} onChooseRole={onChooseRole} />
            ))}
          </CommandGroup>
        )}
        {groups.map((group) => (
          <CommandGroup key={group.key} heading={<GroupHeading group={group} />}>
            {open(group) ? (
              group.rows.map((row) => (
                <ModelRow key={row.value} row={row} chosen={chosen} onChoose={onChoose} stars={stars} />
              ))
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
  /** A role was chosen (#904); the picker has closed. Without it, no Roles group is listed. */
  readonly onChooseRole?: (role: string) => void
  /** The chosen role's name (#904): marked, and highlighted before the chosen model. */
  readonly chosenRole?: string | undefined
  readonly onClose: () => void
  /** Where focus goes once the picker has closed: the chip that opened it, or the composer. */
  readonly returnFocus: () => void
}

/**
 * Starring and unstarring (#904): the star toggled on the section as the last save left it — the
 * store's saves run in turn, so two quick stars do not overwrite each other — and why a save was
 * refused, said in the picker. `undefined` while the section is not read.
 */
function useStars(): { readonly stars: Stars | undefined; readonly refusal: string | undefined } {
  const settings = useModelsSettings()
  const [refusal, setRefusal] = useState<string | undefined>(undefined)
  if (settings.kind !== 'loaded') return { stars: undefined, refusal }
  const toggle = (modelId: string): void => {
    setRefusal(undefined)
    void modelsSettings
      .save((current) => withToggled(current, 'favorites', modelId))
      .then((outcome) => {
        if (outcome.kind === 'refused') setRefusal(`the star was not saved: ${outcome.reason}`)
      })
  }
  return { stars: { favorites: settings.settings.models.favorites ?? [], toggle }, refusal }
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
  const models = modelsConfigOf(useModelsSettings())
  const { stars, refusal: starRefusal } = useStars()
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
            models={models}
            stars={stars}
            chosenRole={props.chosenRole}
            onChooseRole={
              props.onChooseRole === undefined
                ? undefined
                : (role: string): void => {
                    close()
                    props.onChooseRole?.(role)
                  }
            }
            filter={filter}
            onFilter={setFilter}
          />
        ) : (
          <ListingStatus listing={listing} />
        )}
        {starRefusal === undefined ? null : (
          <p role="alert" className="shrink-0 border-t px-3 py-2 text-xs text-refuse">
            {starRefusal}
          </p>
        )}
        {/* Under the list, as the prototype's `.pop-foot` says it (#417): what choosing does here, and what a row's range is. */}
        <p id={footId} className="shrink-0 border-t px-3 py-2 text-xs text-muted-foreground">
          {props.purpose}; each row shows the effort levels that model offers
        </p>
      </PopoverContent>
    </Popover>
  )
}
