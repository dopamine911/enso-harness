import { THREAD_STATUS_WORDS } from '@enso/core'
import { RAIL_NAME } from './actions.ts'

/**
 * What a tree agent's `read` returns (#740): one region of the page's accessibility tree, whole the
 * first time, then only what changed since the agent's last read of it.
 *
 * Measured on Opus's snake run: every `read` was the whole page, 16 of them 313 KB, about 80% of the
 * text the model was sent back (one 110 KB), the context grew from 2.4k to 334k tokens, and the run's
 * second half cost 1.9× its first. A read of the thread on screen is most of what the agent needs, and
 * between two reads most of it is the same.
 *
 * The regions are found by role and accessible name in the snapshot the recorder already takes for
 * the wait's baseline (one snapshot, PR #646 review), never by a class: the header is the `banner`,
 * the rail Enso's `navigation "threads"`, the status bar its `contentinfo "thread status"`, a dialog
 * any `dialog` or `alertdialog`. `transcript` is what is left — the selected view's `tabpanel` and the
 * composer, which no landmark wraps — and is there only when a `tabpanel` is (another site's tab has
 * none). `page` is the whole tree.
 */

/** A region of the page `read` takes. */
type ArenaReadRegion = 'transcript' | 'dialog' | 'threads' | 'status' | 'header' | 'page'

/** Each region as the brief tells the agent, in the order an answer lists them. */
export const ARENA_READ_REGIONS: Readonly<Record<ArenaReadRegion, string>> = {
  transcript:
    'the thread on screen: its view (the Chat tab’s transcript, or the Context, Stats or Diff tab) and the composer',
  dialog: 'an open dialog',
  threads: 'the threads rail',
  status: 'the status bar under the thread',
  header: 'the header: the thread’s name, its view tabs, prompts and settings',
  page: 'all of it',
}

const REGION_NAMES = Object.keys(ARENA_READ_REGIONS) as readonly ArenaReadRegion[]
const isRegion = (name: string): name is ArenaReadRegion => REGION_NAMES.some((region) => region === name)

/** A snapshot line's node: `- button "send message"` is role `button`, name `send message`. */
interface SnapshotNode {
  readonly role: string
  readonly name?: string
}

/** A node line, quoted whole when its name holds a colon: `- 'dialog "Settings: Permissions"':`. */
const NODE_LINE = /^\s*- '?([a-z]+)(?: "((?:[^"\\]|\\.)*)")?/

function nodeOf(line: string): SnapshotNode | undefined {
  const found = NODE_LINE.exec(line)
  if (found?.[1] === undefined) return undefined
  return found[2] === undefined ? { role: found[1] } : { role: found[1], name: found[2] }
}

const indentOf = (line: string): number => line.length - line.trimStart().length

/** The regions a landmark is, by role and accessible name: each owns its line and every line under it. */
const LANDMARKS: Readonly<Record<'dialog' | 'threads' | 'status' | 'header', (node: SnapshotNode) => boolean>> = {
  dialog: (node) => node.role === 'dialog' || node.role === 'alertdialog',
  threads: (node) => node.role === 'navigation' && node.name === RAIL_NAME,
  status: (node) => node.role === 'contentinfo' && node.name === THREAD_STATUS_WORDS.region,
  header: (node) => node.role === 'banner',
}
const LANDMARK_NAMES = Object.keys(LANDMARKS) as readonly (keyof typeof LANDMARKS)[]

function landmarkOf(line: string): ArenaReadRegion | undefined {
  const node = nodeOf(line)
  return node === undefined ? undefined : LANDMARK_NAMES.find((region) => LANDMARKS[region](node))
}

/** The regions on the page, each as its lines of the snapshot, in `ARENA_READ_REGIONS` order; `page` always. */
function pageRegions(snapshot: string): ReadonlyMap<ArenaReadRegion, string> {
  const owned = new Map<ArenaReadRegion, string[]>()
  let open: { readonly region: ArenaReadRegion; readonly indent: number } | undefined
  for (const line of snapshot.split('\n')) {
    const indent = indentOf(line)
    if (open !== undefined && indent <= open.indent) open = undefined
    if (open === undefined) {
      const region = landmarkOf(line)
      if (region !== undefined) open = { region, indent }
    }
    const region = open?.region ?? 'transcript'
    const lines = owned.get(region)
    if (lines === undefined) owned.set(region, [line])
    else lines.push(line)
  }
  const rest = owned.get('transcript') ?? []
  if (!rest.some((line) => nodeOf(line)?.role === 'tabpanel')) owned.delete('transcript')
  owned.set('page', [snapshot])
  return new Map(
    REGION_NAMES.flatMap((region) => {
      const lines = owned.get(region)
      return lines === undefined ? [] : [[region, lines.join('\n')] as const]
    }),
  )
}

/** One line of two reads compared: kept, added, or removed. */
interface LineChange {
  readonly mark: ' ' | '+' | '-'
  readonly line: string
}

/**
 * The most lines compared after the common start and end are set aside, as rows × columns: a change
 * bigger than this reads better whole, and the comparison's table stays at a few megabytes.
 */
const LARGEST_COMPARISON = 1_000_000

/** The longest common run of `before[i..]` and `after[j..]`, for every `i`, `j`: row `i`, column `j`. */
function commonLengths(before: readonly string[], after: readonly string[]): Uint32Array {
  const columns = after.length + 1
  const lengths = new Uint32Array((before.length + 1) * columns)
  for (let row = before.length - 1; row >= 0; row -= 1) {
    for (let column = after.length - 1; column >= 0; column -= 1) {
      const at = row * columns + column
      const below = lengths[at + columns] ?? 0
      const right = lengths[at + 1] ?? 0
      lengths[at] = before[row] === after[column] ? (lengths[at + columns + 1] ?? 0) + 1 : Math.max(below, right)
    }
  }
  return lengths
}

/** The middle of two reads as kept, removed and added lines — a removal before the addition that replaces it. */
function middleChanges(before: readonly string[], after: readonly string[]): LineChange[] | undefined {
  if ((before.length + 1) * (after.length + 1) > LARGEST_COMPARISON) return undefined
  const lengths = commonLengths(before, after)
  const columns = after.length + 1
  /** Whether removing `before[row]` keeps at least as long a common run as adding `after[column]`. */
  const removalFirst = (row: number, column: number): boolean =>
    (lengths[(row + 1) * columns + column] ?? 0) >= (lengths[row * columns + column + 1] ?? 0)
  const changes: LineChange[] = []
  let row = 0
  let column = 0
  while (row < before.length || column < after.length) {
    const removing = row < before.length
    const adding = column < after.length
    if (removing && adding && before[row] === after[column]) {
      changes.push({ mark: ' ', line: before[row] ?? '' })
      row += 1
      column += 1
    } else if (removing && (!adding || removalFirst(row, column))) {
      changes.push({ mark: '-', line: before[row] ?? '' })
      row += 1
    } else {
      changes.push({ mark: '+', line: after[column] ?? '' })
      column += 1
    }
  }
  return changes
}

/** Two reads compared line by line; undefined when the change is too big to compare (`LARGEST_COMPARISON`). */
function lineChanges(before: readonly string[], after: readonly string[]): LineChange[] | undefined {
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1
  let beforeEnd = before.length
  let afterEnd = after.length
  while (beforeEnd > start && afterEnd > start && before[beforeEnd - 1] === after[afterEnd - 1]) {
    beforeEnd -= 1
    afterEnd -= 1
  }
  const middle = middleChanges(before.slice(start, beforeEnd), after.slice(start, afterEnd))
  if (middle === undefined) return undefined
  const kept = (line: string): LineChange => ({ mark: ' ', line })
  return [...before.slice(0, start).map(kept), ...middle, ...before.slice(beforeEnd).map(kept)]
}

/**
 * The changed lines as the agent reads them: `+ ` added, `- ` removed, each after the unchanged lines
 * it sits under (`  `), shown once — in a tree, where a line is is the line it is indented under.
 */
function changedLines(changes: readonly LineChange[]): string {
  const shown: string[] = []
  const path: { indent: number; line: string; said: boolean }[] = []
  for (const change of changes) {
    const indent = indentOf(change.line)
    while ((path.at(-1)?.indent ?? -1) >= indent) path.pop()
    if (change.mark !== ' ') {
      for (const step of path.filter((above) => !above.said)) {
        shown.push(`  ${step.line}`)
        step.said = true
      }
      shown.push(`${change.mark} ${change.line}`)
    }
    path.push({ indent, line: change.line, said: change.mark !== ' ' })
  }
  return shown.join('\n')
}

/** What a `read` asks: a region (the default when absent), and whether to have it whole. */
interface ArenaReadRequest {
  readonly region?: string
  readonly full?: boolean
}

/** What every read answer says: its number, its region, and the regions on the page. */
interface ReadHeading {
  readonly read: number
  readonly region: ArenaReadRegion
  readonly regions: readonly ArenaReadRegion[]
}

/**
 * A read's answer: the region whole (`snapshot`), or what changed since the read it names (`against`)
 * — `changes`, or `unchanged: true` — with a line saying so (`diff`).
 */
type ArenaReadAnswer =
  | (ReadHeading & { readonly snapshot: string })
  | (ReadHeading & { readonly against: number; readonly diff: string; readonly changes: string })
  | (ReadHeading & { readonly against: number; readonly diff: string; readonly unchanged: true })

/** A region's last read: its number, its lines as the agent was shown them, and what its changes since its last whole read came to. */
interface RegionMemory {
  readonly read: number
  readonly snapshot: string
  readonly changesSinceWhole: number
}

/** The region a read means by default: an open dialog, else the thread on screen, else the page. */
const DEFAULT_REGION_ORDER: readonly ArenaReadRegion[] = ['dialog', 'transcript']

/** The region a read means: the one asked for, or the default (`DEFAULT_REGION_ORDER`, then the page). */
function chosenRegion(regions: ReadonlyMap<ArenaReadRegion, string>, asked: string | undefined): ArenaReadRegion {
  if (asked === undefined) return DEFAULT_REGION_ORDER.find((region) => regions.has(region)) ?? 'page'
  if (isRegion(asked) && regions.has(asked)) return asked
  const present = [...regions.keys()].join(', ')
  const why = isRegion(asked) ? `there is no ${asked} on the page now` : `"${asked}" is not a region`
  throw new Error(`${why}: read one of ${present}`)
}

/** A read's answer and what the region remembers of it. */
function answered(
  heading: ReadHeading,
  snapshot: string,
  previous: RegionMemory | undefined,
  full: boolean,
): { readonly answer: ArenaReadAnswer; readonly memory: RegionMemory } {
  const whole = {
    answer: { ...heading, snapshot },
    memory: { read: heading.read, snapshot, changesSinceWhole: 0 },
  }
  if (full || previous === undefined) return whole
  const against = previous.read
  if (previous.snapshot === snapshot) {
    const diff = `nothing changed since read ${against}`
    const memory = { read: heading.read, snapshot, changesSinceWhole: previous.changesSinceWhole + diff.length }
    return { answer: { ...heading, against, diff, unchanged: true }, memory }
  }
  const changes = lineChanges(previous.snapshot.split('\n'), snapshot.split('\n'))
  if (changes === undefined) return whole
  const diff = `what changed since read ${against}: "+" added, "-" removed, unmarked lines unchanged, for where`
  const shown = changedLines(changes)
  const changesSinceWhole = previous.changesSinceWhole + diff.length + shown.length
  // ⚠ The chain's cost bounds it: the agent keeps every read since the region's last whole one (`agent.ts`).
  if (changesSinceWhole > snapshot.length) return whole
  return {
    answer: { ...heading, against, diff, changes: shown },
    memory: { read: heading.read, snapshot, changesSinceWhole },
  }
}

/** The recorder's reads, remembered per region (`createRegionReads`). */
interface ArenaRegionReads {
  /**
   * Answer a read of `snapshot`, the whole page's tree. `visit` counts the page in front: it moves on
   * each navigation of the tab in front and each change of tab, and every region then reads whole.
   * Throws when the region asked for is not on the page, naming the ones that are.
   */
  readonly read: (snapshot: string, request: ArenaReadRequest, visit: number) => ArenaReadAnswer
}

/**
 * Reads that answer with what changed (#740). A region's first read on a page is whole; each later
 * one is what changed since its last read, as lines, or `unchanged`. It is whole again when `full`
 * asks, after a navigation or a tab change (`visit`), when the change is too big to compare, and when
 * the changes since its last whole read would come to more than the region whole — so the reads the
 * agent keeps of a region, the last whole one and the changes after it, never pass about twice it.
 */
export function createRegionReads(): ArenaRegionReads {
  let reads = 0
  let visitRemembered: number | undefined
  const remembered = new Map<ArenaReadRegion, RegionMemory>()
  return {
    read: (snapshot, request, visit) => {
      if (visit !== visitRemembered) {
        remembered.clear()
        visitRemembered = visit
      }
      const regions = pageRegions(snapshot)
      const region = chosenRegion(regions, request.region)
      reads += 1
      const heading: ReadHeading = { read: reads, region, regions: [...regions.keys()] }
      const { answer, memory } = answered(
        heading,
        regions.get(region) ?? '',
        remembered.get(region),
        request.full === true,
      )
      remembered.set(region, memory)
      return answer
    },
  }
}

/** What the agent runner keeps of a read answer to shape the model's context (`agent.ts`): its number, region and base. */
export interface ArenaReadMark {
  readonly read: number
  readonly region: string
  /** The read a diff is against; absent when the read was whole. */
  readonly against?: number
}

/** A read answer's mark, or undefined when `value` is not a read answer. */
export function readMarkOf(value: unknown): ArenaReadMark | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  if (!('read' in value) || !('region' in value)) return undefined
  const { read, region } = value
  if (typeof read !== 'number' || typeof region !== 'string') return undefined
  const against = 'against' in value && typeof value.against === 'number' ? value.against : undefined
  return against === undefined ? { read, region } : { read, region, against }
}
