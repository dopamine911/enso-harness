# Session eval

## What it shows

A session eval is a thread's scorecard and timeline, computed only from what the session recorded. It counts what the person running the thread did (messages, corrections, queued prompts, interrupts, answers to questions, denials) and what the agent did (tool calls, writes, refusals, test and build runs and their outcomes). It lists the counts side by side and never combines them into a single score.

Use it to check a claim about a run ("it never needed correcting") or to compare two runs of the same task, such as the two sides of a [fork](./lineage.md).

## How to open it

It is a command, and needs the web app running (`bun run dev`):

```bash
bun run eval <thread>              # scorecard, agent-side signals, timeline
bun run eval <thread-a> <thread-b> # each, then a table comparing them
bun run eval <thread> --json       # the raw payload, for jq
bun run eval <thread> --row        # one tab-separated row, for sampling over time
bun run eval --row-header          # the row's column names
```

A thread id is the `?thread=` value in the page URL. `bun run logs` and the debug drawer show it too.

## What it looks like

The eval of the session the other pages' screenshots show, shortened:

```text
## 67e19d4e-0c66-46bd-a341-730085b29dd1 (live)

| Metric | Value |
|---|---|
| `humanMessages` | 4 |
| `corrections` | 0 |
| `askAnswered` | 1 |
| `writes` | 1 |
| `guardRefusals` | 2 |
| `refusalsTotal` | 0 |
| `permissionModes` | default |

### Timeline

00:34:25 [    5]    f=0   r=0   human            (11w)   Where does the app read its database URL? Check .env too.
00:34:25 [    9] !G f=0   r=0   guard-refused            guard refused toolu_feature_1_0: secret-read
00:34:25 [   14]    f=0   r=0   human            (9w)    Check the deploy notes, then fetch the Bun changelog.
00:34:25 [   18] !G f=0   r=0   guard-refused            guard refused toolu_feature_5_0: network-egress
00:34:26 [   24]    f=0   r=0   human            (8w)    Make the app refuse to start without DATABASE_URL.
00:34:26 [   25]  ? f=0   r=0   ask-options              2 question(s), options: [2,2]
00:34:27 [   26]  a f=0   r=0   ask-answered             menu at [25] answered
00:34:27 [   27]  w f=0   r=0   write                    edit src/config.ts
00:34:28 [   32]    f=0   r=0   human            (9w)    Summarise the change in one line for the PR.
```

Each timeline line is a time, the entry's position in the session, a marker, the two running counters, the kind of event and what it was.

## What to look for

Watch the two counters. `f=` counts friction, what the person *typed* against the run: corrections, queued prompts, confused messages and interrupts. `r=` counts refusals the person *clicked*: declined questions, and **No** on a permission prompt. They are kept apart because they move at different times. The line where either one starts climbing is where the run went wrong.

Refusals are counted by where they came from, and never added together. In the session above, `guardRefusals` is `2` and `refusalsTotal` is `0`: two calls were refused by the guards, and the person refused nothing. `refusalsTotal` counts only the person's refusals.

## What it doesn't do

- There is no page for it yet. It is a command that reads the same server route a page would.
- It gives no single score. Every number traces back to something in the session, and weighing the numbers is up to you.
- Queued prompts and interrupts come from the log, which keeps 14 days. For an older thread they read as unknown, never as `0`.
- Corrections and confusion are found with fixed word lists. They miss what the lists don't name, and a message that happens to match one can count by mistake.
- Some signals from the script it was ported from have nothing to read in pi, so they are listed under *Dropped*, not guessed.

## Go deeper

- [Glossary](../glossary.md): *session eval*, *friction*, *refusal channel* and *operator denial*.
- [HTTP routes](../reference/routes.md): `GET /api/threads/:threadId/eval`.
- [Stats](./stats.md): what the same thread cost.
- [Forks and lineage](./lineage.md): making two runs comparable in the first place.
