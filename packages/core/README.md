# `@zen/core`

**Every TypeBox schema in zen-harness lives here** — plus, since #59, the two pieces of
runtime the whole workspace shares: the `zen.config.json` loader and the path helpers.
Nothing else does.

## Why one package

Schemas were previously declared next to their consumers — `GuardPolicy` in the pi
extension, the tool-result descriptor and the pi rpc types in the web package. That is how
the same shape gets declared twice: nothing stops a second `usage` or a second
`truncation` appearing beside a different consumer, and nothing makes the duplicate
visible once it exists.

Centralising them means a shape is either here or it does not exist, so a duplicate has to
be added *next to the original* — where it is obvious.

## Why TypeBox for everything, including behaviour

A TypeBox schema **is** a JSON Schema object, so one declaration serves the TypeScript type
(`Static<>`), the HTTP contract and its OpenAPI description, and a runtime validator.

⚠ That is true of data schemas. It is **not** true of the function-bearing ones —
`PiTransport`, `PiRpcClientOptions`, `PiProcessHandle`, `PiProcessCallbacks` — which
serialise to `{"type": "function"}`, a TypeBox extension rather than standard JSON Schema.
They are still declared here as schemas, by decision: a single rule the next session can
follow without judgement beats a finer rule that is correct and needs explaining. The cost
is that those four are not usable by an OpenAPI consumer, and that is recorded beside them.

## Layout

| Module | Holds |
|---|---|
| `dialog.ts` | pi's blocking dialogs as data: the question, the answer, and the answer-validation rule (#27) |
| `guard.ts` | the Tier 0 guard policy |
| `tool-result.ts` | the two-surface tool-result descriptor (#18) |
| `observation.ts` | what a pi event becomes for a surface to render |
| `pi-rpc.ts` | pi's rpc wire protocol, and the transport seams around it |
| `web-fetch.ts` | web_fetch's config section, tool parameters, and caps (#54) |
| `web-search.ts` | web_search's optional config section (backend pin + Tavily domain filters), tool parameters, and the per-attempt deadline (#63) |
| `config.ts` | `zen.config.json`: the whole-file schema and the fail-closed loading contract (#59) |
| `paths.ts` | the workspace path helpers — `findRepoRoot` (realpath-first) and the `.zen` dirs (#59); node/bun only, tree-shaken out of the browser bundle |

`index.ts` re-exports all of it. Import from `@zen/core`, never from a module path — the
barrel is what makes "is this shape already declared?" answerable by one search.
