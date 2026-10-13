import type { EnsoProject } from '@enso/core'
import { ChevronDownIcon, FolderIcon, FolderPlusIcon } from 'lucide-react'
import type { FetchLike } from './browser-logging.ts'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './components/ui/dropdown-menu.tsx'
import { cn } from './lib/utils.ts'
import { MENU_CONTENT, MENU_ITEM } from './menu-chrome.ts'
import { ProjectStatusBadges, useProjectSettings } from './project-status.tsx'
import { ADD_PROJECT_ROUTE, type PageRoute, PROJECTS_ROUTE } from './thread-url.ts'

/**
 * The rail's project switcher (#876), a muted line under the brand at the rail's top (#417): which
 * project is current — the one New thread starts in and the rail keeps open — and a menu to pick
 * another. The menu lists every project with
 * its trouble (folder missing, not trusted: read when the menu opens, as the Projects page reads
 * it), the threads in no listed project when there are any, and the ways to **Add project** and
 * **Manage projects**. The current one is checked, for a screen reader too: the projects are a
 * radio group.
 */

/** What reads as the threads in no listed project — the rail's section and the switcher's entry. */
export const NOT_IN_A_PROJECT = 'Not in a project'

/** One project the switcher offers — or, `project: undefined`, the threads in none. */
export interface SwitcherChoice {
  /** The rail section's key: the project's id, or the key of the threads in none. */
  readonly key: string
  readonly project: EnsoProject | undefined
  /** How many threads it holds — said for the threads in no project. */
  readonly threadCount: number
  /** Nothing to open and nothing can start there: a project whose folder is gone, with no thread. */
  readonly unavailable: boolean
}

export interface ProjectSwitcherProps {
  readonly choices: readonly SwitcherChoice[]
  /** The current project's key; undefined while the page knows none. */
  readonly currentKey: string | undefined
  /** Make the project under `key` current. Never called for the one that already is. */
  readonly onChoose: (key: string) => void
  /** Open Add project or Projects (#870, #872). */
  readonly onPage: (route: PageRoute) => void
  /** The page's `fetch`, for the trust reads; the browser's when absent. */
  readonly fetch?: FetchLike | undefined
}

function nameOf(choice: SwitcherChoice | undefined): string {
  if (choice === undefined) return 'no project yet'
  return choice.project?.title ?? NOT_IN_A_PROJECT
}

/** One entry of the menu: a project's name, path and trouble, or the threads in none with their count. */
function ChoiceLabel({ choice, trusted }: { choice: SwitcherChoice; trusted: boolean | undefined }): React.ReactNode {
  const { project } = choice
  if (project === undefined) {
    return (
      <>
        <span className="min-w-0 flex-1 truncate">{NOT_IN_A_PROJECT}</span>
        <span className="shrink-0 font-mono text-meta text-muted-foreground tabular-nums">
          {choice.threadCount}
          <span className="sr-only">{choice.threadCount === 1 ? ' thread' : ' threads'}</span>
        </span>
      </>
    )
  }
  return (
    <>
      <span className="grid min-w-0 flex-1">
        <span className="truncate">{project.title}</span>
        <span className="truncate font-mono text-meta text-muted-foreground" title={project.path}>
          {project.path}
        </span>
      </span>
      <ProjectStatusBadges project={project} trusted={trusted} />
    </>
  )
}

/** The menu's entries; mounted while it is open, so trust is read each time it opens. */
function SwitcherItems({
  choices,
  currentKey,
  onChoose,
  onPage,
  fetch: fetchImpl,
}: ProjectSwitcherProps): React.ReactNode {
  const reads = useProjectSettings(
    choices.flatMap((choice) => (choice.project === undefined ? [] : [choice.project.projectId])),
    fetchImpl,
  )
  return (
    <>
      <DropdownMenuRadioGroup
        value={currentKey ?? ''}
        onValueChange={(key) => {
          if (key !== currentKey) onChoose(key)
        }}
      >
        {choices.map((choice) => {
          const read = reads.get(choice.key)
          return (
            <DropdownMenuRadioItem
              key={choice.key}
              value={choice.key}
              disabled={choice.unavailable}
              title={choice.unavailable ? 'its folder is gone and it holds no thread' : undefined}
              // Two lines, the check before them where the prototype's is, in the primary.
              className={cn(
                MENU_ITEM,
                'min-h-13 pl-10 [&>[data-slot=dropdown-menu-radio-item-indicator]]:right-auto [&>[data-slot=dropdown-menu-radio-item-indicator]]:left-3 [&>[data-slot=dropdown-menu-radio-item-indicator]]:text-primary',
              )}
            >
              <ChoiceLabel choice={choice} trusted={read?.kind === 'ok' ? read.value.trusted : undefined} />
            </DropdownMenuRadioItem>
          )
        })}
      </DropdownMenuRadioGroup>
      <DropdownMenuSeparator />
      <DropdownMenuItem className={MENU_ITEM} onSelect={() => onPage(ADD_PROJECT_ROUTE)}>
        <FolderPlusIcon />
        Add project…
      </DropdownMenuItem>
      <DropdownMenuItem className={MENU_ITEM} onSelect={() => onPage(PROJECTS_ROUTE)}>
        <FolderIcon />
        Manage projects
      </DropdownMenuItem>
    </>
  )
}

export function ProjectSwitcher(props: ProjectSwitcherProps): React.ReactNode {
  const name = nameOf(props.choices.find((choice) => choice.key === props.currentKey))
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Project: ${name}. Switch project`}
          className="flex min-h-5 max-w-full items-center gap-1 justify-self-start rounded-xs text-xs text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring aria-expanded:text-foreground"
        >
          <span className="truncate">{name}</span>
          <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      {/* Radix names the menu by its trigger: "Project: … Switch project". */}
      <DropdownMenuContent align="start" className={cn(MENU_CONTENT, 'w-80')}>
        <SwitcherItems {...props} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
