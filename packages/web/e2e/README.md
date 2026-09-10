# Web smoke (manual, Playwright)

Drives the real dev surface end to end and leaves screenshots behind for a PR. Not part of
`bun test` or the gate — run it by hand when a change touches the web surface. Tracking:
#71.

## Run

```bash
bun run e2e          # model-free tier: /mode dialog round trip, an image paste, the thread URL, seven screenshots
bun run e2e:model    # one real model turn (costs tokens, needs .zen/pi-agent identity)
```

First time on a machine: `bunx playwright install chromium` (the pinned `@playwright/test`
version chooses the browser build; the download is ~115 MB).

The config starts `bun run dev` itself and reuses an already-running one, so either start
the dev servers yourself or let the harness do it. It waits for `http://127.0.0.1:5178`.

## Output

`packages/web/e2e/output/` (gitignored):

- `screenshots/01-empty-state.png`, `02-mode-dialog.png`, `03-mode-answered.png`,
  `06-image-attached.png`, `07-image-sent.png`, `08-thread-reloaded.png`, `09-thread-bad-id.png`
  from the default tier (the image test answers the prompt route itself, so no model is involved);
  `04-model-streaming.png`, `05-model-settled.png` from `@model`.
- `test-results/` holds a trace on failure — open with `bunx playwright show-trace <zip>`.

The names are fixed, so the paths above are the paths every run writes.

## Getting screenshots into a PR

`gh pr create` / `gh pr comment` cannot upload images. Drag the PNGs into the PR
description or a comment in the GitHub web UI; GitHub hosts them. Do not commit them.

## Selectors are the composer's accessible names

The spec finds the composer by its placeholder and the send/stop buttons by their
`aria-label` from `src/chat-screen.tsx`, and messages by `data-role`. Renaming any of
those in the UI is a spec change too — the constants at the top of `chat.e2e.ts` are the
single place to update.
