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
 * What the agent under test reads before it starts: the assignment, then how to reach Enso — the
 * one `act` command and its moves — and how to write a note. It says nothing about Enso's
 * internals, its routes or its source: the agent meets the interface as shipped.
 */
export function arenaBrief(scenario: ArenaScenario): string {
  return `# Your assignment

${scenario.assignment}

# How you use Enso

Enso is open in a browser that a recorder controls. You act on it with one command, which prints
what happened as JSON:

    bun run arena act '<json>'

Find things the way a person reading the page would: by role and accessible name, visible text,
label or placeholder. Start with \`read\`, which returns the page's accessibility tree and URL.

    {"action":"read"}
    {"action":"click","target":{"role":"button","name":"…"}}
    {"action":"fill","target":{"placeholder":"…"},"text":"…"}
    {"action":"press","key":"Enter"}
    {"action":"goto","path":"/"}
    {"action":"hover"|"select"|"back"|"reload"|"screenshot"|"wait", …}

A target may add "exact": true and "nth": <index> when a name matches more than one element.
Everything on screen is recorded, so text that looks like a credential is refused, not typed.

# Notes — write them when they happen, not at the end

When something is difficult, missing or confusing, say so at that moment:

    {"action":"note","note":"wish","trying":"…","happened":"…","wanted":"…"}
    {"action":"note","note":"friction","trying":"…","happened":"…"}

When you are finished — or out of time — write one retrospective note, then stop the run:

    {"action":"note","note":"retrospective","trying":"the whole assignment","happened":"…"}
    {"action":"stop","reason":"…"}

If Enso stops responding, \`{"action":"restart-enso"}\` restarts it; note what you saw first.

The run stops on its own after ${scenario.budgetMinutes} minutes.
`
}

/** Every scenario by id: what `bun run arena start --scenario <id>` accepts. */
export const ARENA_SCENARIOS: Readonly<Record<string, ArenaScenario>> = { [SNAKE_SCENARIO.id]: SNAKE_SCENARIO }
