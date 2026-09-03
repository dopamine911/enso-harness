# Vendored ai-elements components

**Source:** [`vercel/ai-elements`](https://github.com/vercel/ai-elements) at commit
`6a9d5b1822ffb10bba4bd97175f01edd7d8651cd` (cloned to `.inspiration/ai-elements`, gitignored).
**License:** Apache-2.0 (the upstream `LICENSE` applies to these files).
**Issue:** #31.

## Why vendored by hand rather than installed by the shadcn CLI

The registry model copies source into the consuming repo either way — vendoring from a
pinned clone just makes the provenance explicit and lets each file be **retyped as it
crosses**: upstream components import types from the Vercel AI SDK (`ai`), and this repo's
chat client is TanStack AI, so those imports are rewritten per file rather than carried as
a dependency on a second AI SDK.

## The rules for files in this directory

1. **Every file carries a provenance header**: upstream path, the pinned commit, and a
   `Modified:` list naming each local change. Without it, the next session either "cleans"
   a deliberate divergence or "updates" a file that was retyped on purpose.
2. **This is a standing fork.** Upstream updates do not merge themselves. To update a
   component: re-clone/pull `.inspiration/ai-elements`, diff against the file's pinned
   commit, re-apply the `Modified:` list, and update the header's pin.
3. **Presentation only.** State, the AG-UI protocol, interrupts/resume, the #27 dialog
   renderer, and the #18 tool-result descriptor renderer live outside this directory and
   must not migrate into it.
4. **`import ... from "ai"` never survives the crossing.** Rewrite to a local type (most
   uses are string unions like `UIMessage["role"]`) or to TanStack's part types.
