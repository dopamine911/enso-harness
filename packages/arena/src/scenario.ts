/**
 * Dogfood Arena's scenarios (#556): what the agent under test is asked to do, and the bounds the
 * recorder holds the run to. A scenario is the rerunnable half of a run — the same id against a
 * later build is the comparison — so it names the assignment and the budget, and nothing about
 * HOW the agent should meet it: the features, the approach and the failures are the agent's.
 */

/** One arena scenario: the assignment, verbatim, and the run's bounds. */
export interface ArenaScenario {
  /** The id a run directory and a manifest carry: `snake`. */
  readonly id: string
  /** What the agent is told, word for word. The bench adds how to reach the UI (`arenaBrief`), never what to build. */
  readonly assignment: string
  /** Wall-clock budget: the recorder stops the run at this many minutes, whatever state it is in. */
  readonly budgetMinutes: number
  /** The periodic screenshot's interval. Event screenshots come on top of it. */
  readonly sampleIntervalMs: number
  /** How long one trace chunk runs before it is written out, so a crash loses at most one chunk. */
  readonly traceChunkMs: number
}

/** The first arena scenario: a Snake game with five features of the agent's own choosing. */
export const SNAKE_SCENARIO: ArenaScenario = {
  id: 'snake',
  assignment: [
    'Build a playable Snake game with five additional features of your own choosing.',
    "You own the design, implementation, and testing. Use Enso's UI to manage the work.",
    'When something is difficult, missing, or confusing, record what you were trying to do,',
    'what happened, and what you wish the interface had provided.',
  ].join(' '),
  budgetMinutes: 120,
  sampleIntervalMs: 30_000,
  traceChunkMs: 5 * 60_000,
}

/**
 * Work in rounds, as a person maintains something (the Snake scenario's run is one prompt and done).
 * The assignment names outcomes, never controls: checking a round's changes, taking a round back,
 * trying another way, and the work's cost and context are what a person does over several rounds,
 * and Enso's Changes, restore, fork, Stats and Context views are where it offers them — whether
 * the agent finds them is the finding.
 */
const ITERATE_SCENARIO: ArenaScenario = {
  id: 'iterate',
  assignment: [
    'Build a small command-line to-do list app, in at least three separate rounds of requests to Enso:',
    'start minimal, and add features in later rounds. After each round, check what actually changed',
    'before you ask for the next one. Partway through, change your mind about one round: take it back',
    'and try a different approach instead. Before you finish, find out what the work cost and how much',
    "of the model's context it used. Use Enso's UI to manage the work. When something is difficult,",
    'missing, or confusing, record what you were trying to do, what happened, and what you wish the',
    'interface had provided.',
  ].join(' '),
  budgetMinutes: 120,
  sampleIntervalMs: 30_000,
  traceChunkMs: 5 * 60_000,
}

/**
 * Two approaches side by side, compared and one cleaned away: what `iterate` barely reached. Keeping
 * both is where a fork is the tool; comparing them is the Diff and Stats of two threads; cleaning up
 * is deleting a thread and its tree; and "what the model was given" is the Context view. Outcomes,
 * never controls.
 */
const COMPARE_SCENARIO: ArenaScenario = {
  id: 'compare',
  assignment: [
    'Write a small command-line Markdown-to-HTML converter. Try two different implementation',
    'approaches side by side, keeping both available at the same time, then compare them: what each',
    'one changed and what each one cost. Keep only the better one and clean up the other. Before you',
    'finish, find out exactly what the model was given in its last request: its instructions, the',
    "files, and the earlier conversation. Use Enso's UI to manage the work. When something is",
    'difficult, missing, or confusing, record what you were trying to do, what happened, and what you',
    'wish the interface had provided.',
  ].join(' '),
  budgetMinutes: 120,
  sampleIntervalMs: 30_000,
  traceChunkMs: 5 * 60_000,
}

/**
 * How the agent under test reaches the UI: the agent runner's one tool (`tool`), or the
 * `bun run arena act` command when a person or an unrestricted agent drives the run (`command`).
 */
export type ArenaChannel = 'tool' | 'command'

/** What a brief names about one run: how to act on it, where its evidence is, where bugs go. */
export interface ArenaBriefContext {
  /** The exact `act` command, `--out` included when the run was started with one (`arenaActCommand`). */
  readonly act?: string
  /** The run's directory, once there is a run; the review reads its evidence there. */
  readonly runDirectory?: string
  /** `owner/name` of the repository bugs are filed in, when it is known. */
  readonly repository?: string
}

/** How the runner's agent acts: its one tool. */
const HOW_THE_TOOL_ACTS = `Enso is open in a browser that a recorder controls. You act on it with your one tool, \`act\`,
which takes one action object and returns what happened. It is the only tool you have: there is no
shell and no file access. Everything you do — writing code, running it, testing it — you do by
using Enso through its page, as a person at the keyboard would. Actions look like this:`

/** How an agent with a shell acts: the `act` command, its only way in by the brief's rule. */
function howTheCommandActs(act: string): string {
  return `Enso is open in a browser that a recorder controls. You act on it with one command, which prints
what happened as JSON:

    ${act} '<json>'

That command is your ONLY way to reach Enso while you work. Do not read Enso's source code, do not
call its server or API directly, and do not open its files on disk: the point is to meet the
interface as it ships, and every shortcut hides the thing being tested. <json> is one action, like
these:`
}

/**
 * What the agent under test reads before it starts: the assignment, then how to reach Enso — the
 * one way in and its moves — and how to write a note. It says nothing about Enso's internals, its
 * routes or its source: the agent meets the interface as shipped.
 *
 * Over the `command` channel the agent has a shell, so the brief goes on to the review and the bugs
 * (`arenaReviewBrief`): three phases, in order. The agent runner's `tool` channel has no shell and
 * no files, so its brief is the assignment alone, and the review is a second prompt for afterwards.
 */
export function arenaBrief(
  scenario: ArenaScenario,
  channel: ArenaChannel = 'command',
  context: ArenaBriefContext = {},
): string {
  const reviewed = channel === 'command'
  const assignment = `# ${reviewed ? 'Phase 1: the assignment' : 'Your assignment'}

${scenario.assignment}

# How you use Enso

${reviewed ? howTheCommandActs(context.act ?? arenaActCommand()) : HOW_THE_TOOL_ACTS}

    {"action":"read"}
    {"action":"click","target":{"role":"button","name":"…"}}
    {"action":"fill","target":{"placeholder":"…"},"text":"…"}
    {"action":"press","key":"Enter"}
    {"action":"goto","path":"/"}
    {"action":"hover"|"select"|"back"|"reload"|"screenshot", …}

Find things the way a person reading the page would: by role and accessible name, visible text,
label or placeholder. Start with \`read\`, which returns the page's accessibility tree and URL.
A target may add "exact": true and "nth": <index> when a name matches more than one element.
Everything on screen is recorded, so text that looks like a credential is refused, not typed.

While Enso works, wait for it to need you rather than sleeping a fixed time:

    {"action":"wait","until":"attention","ms":60000}

returns when Enso needs you or is done — \`"attention"\` says which: \`"question"\` (it asks you
something: answer it), \`"idle"\` (its run ended, finished or failed), \`"disconnected"\` (the server
went), \`"dialog"\` (a browser dialog is open). It passes over Enso merely working, so send it right
after your click. After \`ms\` (at most a minute) with none of those, it returns without
\`"attention"\`: wait again. Then \`read\` to see the page.

\`{"action":"wait","until":"change","ms":…}\` returns on any change to the page since you last saw
it, Enso's own progress included. A plain \`{"action":"wait","ms":…}\` sleeps the whole time.

# Notes — write them when they happen, not at the end

When something is difficult, missing or confusing, say so at that moment, and what you did instead:

    {"action":"note","note":"wish","trying":"…","happened":"…","wanted":"…"}
    {"action":"note","note":"friction","trying":"…","happened":"…"}

When you are finished — or out of time — write one retrospective note, then stop the run:

    {"action":"note","note":"retrospective","trying":"the whole assignment","happened":"…"}
    {"action":"stop","reason":"…"}

If Enso stops responding, \`{"action":"restart-enso"}\` restarts it; note what you saw first.

If the browser shows a native dialog (an alert, a confirm, a prompt), \`read\` says so and the page waits
for your answer: \`{"action":"accept-dialog"}\` (with "text" for a prompt) or \`{"action":"dismiss-dialog"}\`.

The run stops on its own after ${scenario.budgetMinutes} minutes. Every answer says how much time is
left (\`remainingMs\`). When it runs out, the answers say \`"phase": "grace"\`: you have one more minute,
in which only your retrospective note and \`stop\` are taken.
`
  if (!reviewed) return assignment
  return `You are testing Enso, an interface for working with a coding agent, by using it as a
real user would. There are three phases, in this order: do the assignment through Enso's
interface, review your experience against what was recorded, then file the bugs you found.
Phases 2 and 3 come after the run stops.

${assignment}
${arenaReviewBrief(context, 'self')}`
}

/**
 * The review and the bugs (#556): the run's experience reviewed against its recorded evidence,
 * improvements recommended, the Enso defects filed after searching the existing issues. Part of
 * the `command` brief (`self`: the agent that did the work reviews it); on its own, the prompt for
 * after an agent-runner run (`other`: an agent with a shell reviews the runner's run, whose agent
 * had no files to do it with).
 *
 * ⚠ THE AGENT'S ACCOUNT IS NOT PROOF (#556). The review is written against the evidence, each
 * claim citing a timeline time, a screenshot or a thread id; a bug it files says it is
 * unverified and from which run, so a person triages it.
 */
export function arenaReviewBrief(context: ArenaBriefContext, reviewer: 'self' | 'other'): string {
  const run = context.runDirectory ?? '<run directory>'
  const repository = context.repository ?? '<the Enso repository, owner/name>'
  const intro =
    reviewer === 'self'
      ? ''
      : `You are reviewing a Dogfood Arena run: an agent used Enso, an interface for working with a
coding agent, through its page alone, on the assignment in \`${run}/brief.md\`. It noted wishes and
friction as it worked and wrote a retrospective; it had no files, so the review is yours. There are
two phases: review the run against what was recorded, then file the bugs it shows.

`
  // Embedded after the assignment, the review is phases 2 and 3; on its own, it is phases 1 and 2.
  const first = reviewer === 'self' ? 2 : 1
  const memory =
    reviewer === 'self'
      ? 'Your memory of the run is not the evidence'
      : "The agent's notes are its account, not the evidence"
  return `${intro}# Phase ${first}: review the experience

Wait until \`${run}/manifest.json\` exists. The recorder writes it once the run has stopped.
The run's evidence is in that directory:

- \`manifest.json\`: every screenshot, the threads the interface was in and when, the agent's
  notes, the errors the browser saw, and which of Enso's records were collected or are missing;
- \`timeline.jsonl\`: one line per thing that happened, each with \`elapsedMs\` and the thread id;
- \`screenshots/\`: one every 30 seconds, plus one at each error, dialog, navigation, failed
  action and Enso exit;
- \`enso/\`: Enso's own output and its records for each thread;
- \`project/\`: what was built.

${memory}: check each point against these files before you write it down, and cite what you
checked (an \`elapsedMs\`, a screenshot path, a thread id). Write \`${run}/review.md\` with these
sections:

1. **The application:** what was built, which of the five features work, and how you know
   (what you ran). Keep this separate from everything about Enso.
2. **How the work went:** a short account of the session in order, with the evidence for each
   step.
3. **Friction:** each place Enso slowed the work, confused, failed or forced a workaround,
   including ones nobody noted at the time but the timeline shows (repeated actions, failed
   actions, waiting, going back). Classify each as one of: an Enso defect; something Enso does
   that could not be found; the agent's own mistake; or something wanted but not needed.
4. **Recommendations:** the improvements you would make to Enso, most valuable first. Each one
   is traced to the friction above, with the evidence, and states what you would expect to
   change. The agent's wishes are inputs, not conclusions: say which of them the evidence supports.

# Phase ${first + 1}: file the bugs

File a bug for each item in section 3 classified as an Enso defect. Do not file the agent's own
mistakes or wishes the evidence does not support; those belong in the review only. Bugs go to
\`${repository}\`, using the GitHub CLI (\`gh\`) or whatever GitHub access you have.

1. **Search first.** Look for an existing issue, open or closed, that covers the same defect
   (for example \`gh issue list --repo ${repository} --state all --search "<words>"\`). If one
   does, add a comment there with your evidence instead of opening a new issue.
2. **Otherwise open one**, titled \`[dogfood-arena] <what goes wrong>\`, whose body has:
   - **What happened:** the steps to reproduce, as the actions sent;
   - **Expected:** what a user would expect instead;
   - **Impact:** what it cost the assignment;
   - **Observed or inferred:** what the evidence shows, kept apart from what you believe the
     cause is;
   - **Evidence:** run \`${run}\`, with the \`elapsedMs\`, screenshot paths and thread id;
   - **Workaround:** what was done instead, if anything;
   - the line: *Filed from a Dogfood Arena run; not yet verified by a person.*
3. Never paste a credential, a key or anything secret-looking into an issue. Quote only what
   the defect needs.

Finish by adding a fifth section to \`review.md\`, **Bugs filed**, linking each issue you
opened or commented on, and listing anything you decided not to file and why.

Then record every item of section 3, whatever its class, in \`${run}/findings.json\`, the file
the run's report reads:

    {"gaps": [{
      "title": "what goes wrong, in a line",
      "classification": "defect" | "undiscoverable" | "agent-mistake" | "not-needed",
      "reproduction": "the actions sent",
      "impact": "what it cost the assignment",
      "observed": "what the evidence shows",
      "inferred": "what you believe the cause is (leave it out if you do not know)",
      "workaround": "what was done instead (leave it out if nothing)",
      "issue": "the issue that covers it, existing or the one you filed, as owner/name#N",
      "evidence": [{"elapsedMs": 120000}, {"screenshot": "<a screenshot path from manifest.json>"}, {"threadId": "<thread id>"}]
    }]}

A defect needs its \`issue\`. \`bun run arena report ${run}\` checks every citation against the
run: a second outside it, a screenshot it did not keep, or a thread it was not in marks that gap
unverified.
`
}

/**
 * The `owner/name` a GitHub remote URL names (`https://github.com/o/n(.git)`, `git@github.com:o/n.git`),
 * or undefined for anything else: the brief then asks for the repository rather than guessing.
 */
export function githubRepositoryOf(remoteUrl: string): string | undefined {
  const named = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(remoteUrl.trim())
  return named === null ? undefined : `${named[1]}/${named[2]}`
}

/**
 * The `act` command a brief tells the agent to run: `--out` included when the run's directory is
 * not the default, since `act` finds the live run under it, quoted so a path with spaces holds.
 */
export function arenaActCommand(outDirectory?: string): string {
  if (outDirectory === undefined) return 'bun run arena act'
  return `bun run arena act --out '${outDirectory.replaceAll("'", "'\\''")}'`
}

/** Every scenario by id: what `bun run arena start --scenario <id>` accepts. */
export const ARENA_SCENARIOS: Readonly<Record<string, ArenaScenario>> = Object.fromEntries(
  [SNAKE_SCENARIO, ITERATE_SCENARIO, COMPARE_SCENARIO].map((scenario) => [scenario.id, scenario]),
)
