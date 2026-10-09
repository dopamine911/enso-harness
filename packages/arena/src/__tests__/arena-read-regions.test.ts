import { expect, test } from 'bun:test'
import { createRegionReads } from '../read-regions.ts'

/**
 * A tree agent's `read` (#740): one region of Enso's page, whole the first time and then what changed.
 * The page is Enso's as a real run read it (Sonnet's snake run, cut short): the header is the
 * `banner`, the rail `navigation "threads"`, the thread view a `tabpanel` with the composer after it
 * outside any landmark, and the status bar `contentinfo "thread status"`.
 */

const HEADER = `- banner:
  - heading "Enso · pi runtime" [level=1]
  - text: Build a Snake game
  - tablist "what the thread view shows":
    - tab "Chat" [selected]
    - tab "Stats"
  - button "settings"`

const rail = (age: string): string => `- navigation "threads":
  - button "New Thread"
  - region "project":
    - list "open threads in project":
      - listitem:
        - button "waiting on you Build a Snake game ${age}"`

/** The transcript's earlier turns: a thread view is most of the page, and most of it stays the same. */
const EARLIER = Array.from(
  { length: 12 },
  (_, turn) => `    - paragraph: earlier reply ${turn + 1}, about the game's rules and how they were tested`,
).join('\n')

const ASKING = `- tabpanel "Chat":
  - log:
${EARLIER}
    - text: you
    - paragraph: Build a Snake game
    - text: pi
    - paragraph: I'll build it.
    - 'group "Permission Required tool : write"':
      - button "Yes"
      - button "No"
- textbox "ask pi something"
- button "send message" [disabled]`

const DONE = `- tabpanel "Chat":
  - log:
${EARLIER}
    - text: you
    - paragraph: Build a Snake game
    - text: pi
    - paragraph: I'll build it.
    - paragraph: Done, snake.html is written.
- textbox "ask pi something"
- button "send message"`

const status = (activity: string): string => `- contentinfo "thread status":
  - text: ${activity}
  - meter "context window used"`

const page = (transcript: string, options: { age?: string; activity?: string } = {}): string =>
  [HEADER, rail(options.age ?? 'now'), transcript, status(options.activity ?? 'running write')].join('\n')

const DIALOG = `- dialog "Start a session":
  - heading "Start a session" [level=2]
  - textbox "Prompt"
  - button "Start"`

test('a read without a region is the thread on screen — its view and the composer — and lists the regions', () => {
  const answer = createRegionReads().read(page(ASKING), {}, 0)
  expect(answer).toEqual({
    read: 1,
    region: 'transcript',
    regions: ['transcript', 'threads', 'status', 'header', 'page'],
    snapshot: ASKING,
  })
})

// ⚠ An open dialog blocks the page, so it is what the agent needs: Radix hides the rest of the page
// from the tree while one is open, and the default follows it there.
test('⚠ a read without a region is the open dialog when there is one', () => {
  const reads = createRegionReads()
  expect(reads.read(DIALOG, {}, 0)).toMatchObject({ region: 'dialog', regions: ['dialog', 'page'], snapshot: DIALOG })
  expect(reads.read(`${page(ASKING)}\n${DIALOG}`, {}, 1)).toMatchObject({ region: 'dialog', snapshot: DIALOG })
})

test('each region is its landmark whole, found by role and name; a page with no thread view reads whole', () => {
  const reads = createRegionReads()
  expect(reads.read(page(ASKING), { region: 'threads' }, 0)).toMatchObject({ snapshot: rail('now') })
  expect(reads.read(page(ASKING), { region: 'status' }, 0)).toMatchObject({ snapshot: status('running write') })
  expect(reads.read(page(ASKING), { region: 'header' }, 0)).toMatchObject({ snapshot: HEADER })
  expect(reads.read(page(ASKING), { region: 'page' }, 0)).toMatchObject({ snapshot: page(ASKING) })
  // The game in Preview's tab: none of Enso's landmarks, and no thread view.
  const game = '- heading "Snake" [level=1]\n- text: "Score: 0"'
  expect(reads.read(game, {}, 1)).toEqual({ read: 5, region: 'page', regions: ['page'], snapshot: game })
})

test('a region not on the page, or no region at all, is refused with the regions that are there', () => {
  const reads = createRegionReads()
  expect(() => reads.read(page(ASKING), { region: 'dialog' }, 0)).toThrow(
    'there is no dialog on the page now: read one of transcript, threads, status, header, page',
  )
  expect(() => reads.read(DIALOG, { region: 'sidebar' }, 0)).toThrow(
    '"sidebar" is not a region: read one of dialog, page',
  )
})

test('a second read of a region that did not change says so, and names the read it compares with', () => {
  const reads = createRegionReads()
  reads.read(page(ASKING), {}, 0)
  // The rail's clock moved and the status bar changed: neither is the thread view.
  expect(reads.read(page(ASKING, { age: '1m', activity: 'waiting' }), {}, 0)).toEqual({
    read: 2,
    region: 'transcript',
    regions: ['transcript', 'threads', 'status', 'header', 'page'],
    against: 1,
    diff: 'nothing changed since read 1',
    unchanged: true,
  })
})

test('⚠ a read of a changed region is only the changed lines, each under the unchanged lines it sits in', () => {
  const reads = createRegionReads()
  reads.read(page(ASKING), {}, 0)
  expect(reads.read(page(DONE), {}, 0)).toMatchObject({
    read: 2,
    region: 'transcript',
    against: 1,
    diff: 'what changed since read 1: "+" added, "-" removed, unmarked lines unchanged, for where',
    changes: [
      '  - tabpanel "Chat":',
      '    - log:',
      `-     - 'group "Permission Required tool : write"':`,
      '-       - button "Yes"',
      '-       - button "No"',
      '+     - paragraph: Done, snake.html is written.',
      '- - button "send message" [disabled]',
      '+ - button "send message"',
    ].join('\n'),
  })
  // Each read is compared with the one before it, not the first.
  expect(reads.read(page(DONE), {}, 0)).toMatchObject({ read: 3, against: 2, unchanged: true })
})

test('⚠ after a navigation, a reload or a tab switch every region reads whole again', () => {
  const reads = createRegionReads()
  reads.read(page(ASKING), {}, 0)
  reads.read(page(ASKING), { region: 'threads' }, 0)
  // The page in front moved on (`visit`): what the reads were compared with is another page's.
  expect(reads.read(page(DONE), {}, 1)).toMatchObject({ read: 3, snapshot: DONE })
  expect(reads.read(page(DONE), { region: 'threads' }, 1)).toMatchObject({ read: 4, snapshot: rail('now') })
  expect(reads.read(page(DONE), {}, 1)).toMatchObject({ read: 5, against: 3, unchanged: true })
})

test('"full": true reads the region whole, and the next read compares with it', () => {
  const reads = createRegionReads()
  reads.read(page(ASKING), {}, 0)
  expect(reads.read(page(ASKING), { full: true }, 0)).toMatchObject({ read: 2, snapshot: ASKING })
  expect(reads.read(page(DONE), {}, 0)).toMatchObject({ read: 3, against: 2 })
})

// ⚠ The agent keeps every read of a region since its last whole one (`agent.ts`): the chain is
// bounded by reading whole once its changes would come to more than the region itself.
test('⚠ a region whose changes since its last whole read would outweigh it reads whole instead', () => {
  const reads = createRegionReads()
  reads.read(page(ASKING), { region: 'status' }, 0)
  // The status bar is three short lines: one changed line and the diff's own words outweigh it.
  expect(reads.read(page(ASKING, { activity: 'idle' }), { region: 'status' }, 0)).toMatchObject({
    read: 2,
    snapshot: status('idle'),
  })
  // The thread view takes a few changes before its next whole read.
  const typing = (words: number): string =>
    ASKING.replace('- textbox "ask pi something"', `- textbox "ask pi something": ${'word '.repeat(words)}`)
  const answers = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((words) => reads.read(page(typing(words)), {}, 0))
  const kinds = answers.map((answer) => ('snapshot' in answer ? 'whole' : 'changes'))
  expect(kinds.slice(0, 3)).toEqual(['whole', 'changes', 'changes'])
  expect(kinds.slice(3)).toContain('whole')
})
