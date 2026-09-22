# `@enso/core`

**Every TypeBox schema in Enso lives here** — plus, since #59, the two pieces of
runtime the whole workspace shares: the `enso.config.json` loader and the path helpers.
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

⚠ That is true of data schemas. It is **not** true of the function-bearing one —
`ThreadRuntime`, the thread runtime contract (#69) — which serialises to
`{"type": "function"}`, a TypeBox extension rather than standard JSON Schema. It is still
declared here as a schema, by decision: a single rule the next session can follow without
judgement beats a finer rule that is correct and needs explaining. The cost is that it is
not usable by an OpenAPI consumer, and that is recorded beside it. (Until #69 PR 3 there
were four such schemas; the subprocess transport they described is deleted.)

## Layout

| Module | Holds |
|---|---|
| `dialog.ts` | pi's blocking dialogs as data: the question, the answer, and the answer-validation rule (#27) |
| `guard.ts` | the Tier 0 guard policy |
| `tool-result.ts` | the two-surface tool-result descriptor (#18) |
| `observation.ts` | what a pi event becomes for a surface to render |
| `thread-runtime.ts` | the thread runtime contract the host implements, and the runtime event shape (the rpc-mode vocabulary the host reproduces in-process) |
| `web-fetch.ts` | web_fetch's config section, tool parameters, and caps (#54) |
| `web-search.ts` | web_search's optional config section (backend pin + Tavily domain filters), tool parameters, and the per-attempt deadline (#63) |
| `config.ts` | `enso.config.json`: the whole-file schema and the fail-closed loading contract (#59) |
| `paths.ts` | the workspace path helpers — `findRepoRoot` (realpath-first) and the `.enso` dirs (#59); node/bun only, tree-shaken out of the browser bundle |

`index.ts` re-exports all of it. Import from `@enso/core`, never from a module path — the
barrel is what makes "is this shape already declared?" answerable by one search.
