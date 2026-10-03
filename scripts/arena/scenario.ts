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

/** What a brief names about one run: how to act on it, where its evidence is, where bugs go. */
export interface ArenaBriefContext {
  /** The exact command the agent runs, `--out` included when the run was started with one. */
  readonly act: string
  /** The run's directory, once there is a run; the review reads its evidence there. */
  readonly runDirectory?: string
  /** `owner/name` of the repository bugs are filed in, when it is known. */
  readonly repository?: string
}

/**
 * The prompt the agent under test is given (#556): three phases, in order. It USES Enso on the
 * assignment, only through the recorder; it REVIEWS the run against the recorded evidence and
 * recommends improvements; it FILES the bugs it found, after searching the existing issues.
 *
 * ⚠ THE AGENT'S ACCOUNT IS NOT PROOF (#556). The review is written against the evidence, each
 * claim citing a timeline time, a screenshot or a thread id; a bug it files says it is
 * unverified and from which run, so a person triages it. The agent certifies nothing about
 * Enso, and nothing about its own application beyond what it ran.
 *
 * It says nothing about Enso's internals, routes or source while the agent works: the agent
 * meets the interface as shipped. Only the review phase opens the run's files.
 */
export function arenaBrief(scenario: ArenaScenario, context: ArenaBriefContext): string {
  const run = context.runDirectory ?? '<run directory>'
  const repository = context.repository ?? '<the Enso repository, owner/name>'
  return `You are testing Enso, an interface for working with a coding agent, by using it as a
real user would. There are three phases, in this order: do the assignment through Enso's
interface, review your experience against what was recorded, then file the bugs you found.

# Phase 1: the assignment

${scenario.assignment}

## How you use Enso

Enso is open in a browser that a recorder controls. You act on it with one command, which
prints what happened as JSON:

    ${context.act} '<json>'

That command is your ONLY way to reach Enso. Do not read Enso's source code, do not call its
server or API directly, and do not open its files on disk: the point is to meet the interface
as it ships, and every shortcut hides the thing being tested. Your project's code is built
by working through Enso, not beside it.

Find things the way a person reading the page would: by role and accessible name, visible
text, label or placeholder. Start with \`read\`, which returns the page's accessibility tree
and URL.

    {"action":"read"}
    {"action":"click","target":{"role":"button","name":"…"}}
    {"action":"fill","target":{"placeholder":"…"},"text":"…"}
    {"action":"press","key":"Enter"}
    {"action":"goto","path":"/"}
    {"action":"hover"|"select"|"back"|"reload"|"screenshot"|"wait", …}

A target may add "exact": true and "nth": <index> when a name matches more than one element.
Everything on screen is recorded, so text that looks like a credential is refused, not typed.
Never type a key, token or password into Enso.

If Enso stops responding, note what you saw, then \`{"action":"restart-enso"}\` restarts it.

## Notes: write them when they happen, not at the end

When something is difficult, missing or confusing, say so at that moment, including what you
did instead:

    {"action":"note","note":"wish","trying":"…","happened":"…","wanted":"…"}
    {"action":"note","note":"friction","trying":"…","happened":"…"}

When you are finished, or out of time, write one retrospective note and stop the run:

    {"action":"note","note":"retrospective","trying":"the whole assignment","happened":"…"}
    {"action":"stop","reason":"…"}

The run stops on its own after ${scenario.budgetMinutes} minutes. Phases 2 and 3 come after it stops.

# Phase 2: review your experience

Wait until \`${run}/manifest.json\` exists. The recorder writes it once the run has stopped.
The run's evidence is in that directory:

- \`manifest.json\`: every screenshot, the threads the interface was in and when, your notes,
  the errors the browser saw, and which of Enso's records were collected or are missing;
- \`timeline.jsonl\`: one line per thing that happened, each with \`elapsedMs\` and the thread id;
- \`screenshots/\`: one every 30 seconds, plus one at each error, dialog, navigation, failed
  action and Enso exit;
- \`enso/\`: Enso's own output and its records for each thread;
- \`project/\`: what you built.

Your memory of the run is not the evidence: check each point against these files before you
write it down, and cite what you checked (an \`elapsedMs\`, a screenshot path, a thread id).
Write \`${run}/review.md\` with these sections:

1. **The application:** what you built, which of the five features work, and how you know
   (what you ran). Keep this separate from everything about Enso.
2. **How the work went:** a short account of the session in order, with the evidence for each
   step.
3. **Friction:** each place Enso slowed you down, confused you, failed or made you work around
   it, including ones you did not note at the time but can see in the timeline (repeated
   actions, failed actions, waiting, going back). For each, classify it as one of: an Enso
   defect; something Enso does that you could not find; your own mistake; or something you
   wanted but did not need.
4. **Recommendations:** the improvements you would make to Enso, most valuable first. Each one
   is traced to the friction above, with the evidence, and states what you would expect to
   change. Your wishes are inputs, not conclusions: say which of them the evidence supports.

# Phase 3: file the bugs

File a bug for each item in section 3 classified as an Enso defect. Do not file your own
mistakes or wishes the evidence does not support; those belong in the review only. Bugs go to
\`${repository}\`, using the GitHub CLI (\`gh\`) or whatever GitHub access you have.

1. **Search first.** Look for an existing issue, open or closed, that covers the same defect
   (for example \`gh issue list --repo ${repository} --state all --search "<words>"\`). If one
   does, add a comment there with your evidence instead of opening a new issue.
2. **Otherwise open one**, titled \`[dogfood-arena] <what goes wrong>\`, whose body has:
   - **What happened:** the steps to reproduce, as the actions you sent;
   - **Expected:** what a user would expect instead;
   - **Impact:** what it cost the assignment;
   - **Observed or inferred:** what the evidence shows, kept apart from what you believe the
     cause is;
   - **Evidence:** run \`${run}\`, with the \`elapsedMs\`, screenshot paths and thread id;
   - **Workaround:** what you did instead, if anything;
   - the line: *Filed by the agent under test in a Dogfood Arena run; not yet verified by a
     person.*
3. Never paste a credential, a key or anything secret-looking into an issue. Quote only what
   the defect needs.

Finish by adding a fifth section to \`review.md\`, **Bugs filed**, linking each issue you
opened or commented on, and listing anything you decided not to file and why.
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
export const ARENA_SCENARIOS: Readonly<Record<string, ArenaScenario>> = { [SNAKE_SCENARIO.id]: SNAKE_SCENARIO }
