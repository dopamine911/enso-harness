# Flows

One page per control-plane sequence: what happens, in order; the invariants it demonstrates; and
the tests that pin each one (#167 item 3, under #162). A flow page is what a refactor reviewer reads
to know what must still be true afterwards — and what a fresh session reads instead of the code.

Every page has the same shape: the sequence as a diagram · the invariants, numbered · at most one
`ts` fence, sourced and drift-checked like a seam page's · **the tests that pin it**, each cited as
`<!-- test: <path>#<exact title> -->` and checked by `test/docs-gate.test.ts` — a renamed or deleted
pin fails the page that cites it · where the behaviour is stated at the code.

**Built pages (#482, pilot: prompt → run → settle).** A built page is not in the repository. `bun run
docs:flows` (and the site build) writes it from source: `@flow <id> <title>` and its paragraph at the
symbol the flow starts from, `@invariant <flow>/<name> <sentence>` at each symbol that keeps a rule,
`// @pins <flow>/<name>` above each test that holds one, and the sequence diagrams tests record with
`@enso/core/flow-trace` and `toMatchSnapshot('flow <id>: <caption>')`. To change a built page, change
the code, the comment or the test; `test/flow-pages.test.ts` refuses tags that disagree.

| Flow | What it preserves |
|---|---|
| [boot and launchers](./boot-and-launchers.md) | manifest load order (logging first, guards before any vendor), the isolation triple, the print variant's mirror, vendor links |
| [prompt → run → settle](./prompt-run-settle.md) | a prompt answers at admission; the run lives on the follow; `settled` and a released status end it; queued and rejected prompts |
| [follow: snapshot, then frames](./follow-snapshot-frames.md) | the snapshot is exact as of `asOfSeq`; held → replayed → live; a reconnect is a new snapshot |
| [dialog: ask → answer → settled](./dialog-ask-answer-settled.md) | a blocking question crosses as an observation; the answer is validated against the question; every follower hears the settle |
| [abort → clear → restore](./abort-clear-restore.md) | one abort, the queue handed back, the run ended by its settle not by the route |
| [resume](./resume.md) | a stored thread reads from its transcript alone — messages, opening mode, images — and goes live on the first prompt |
| [guarded tool call](./guarded-tool-call.md) | the additive handler, first `block` final; the precedence order; every verdict a record; a refusal reaches the browser as an error result |
| [web search call](./web-search-call.md) | current-model routing, auth resolution, the fallback, outcomes keyed on search activity, the audit line, the banner |

Prose here may surround a fence or a citation; it may not restate what one says.
