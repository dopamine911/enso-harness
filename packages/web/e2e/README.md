# Browser suite (Playwright)

Drives the real dev surface in Chromium, by hand: CI does not run it (it did from #486 until #501; a Chromium job on every pull request cost more than it caught). Run the model-free tier before merging a change to the browser surface. It holds what `bun test` cannot: happy-dom does no layout and fires no focus-return events, so focus, scroll positions and the off-screen panes are proven only here (#486).

## Run

```bash
bun run e2e                          # model-free tier: run it before merging browser-surface work
bun run e2e -- --grep "#370"         # one test, by a word in its title
bun run e2e:model                    # one real model turn (costs tokens, needs your login)
```

First time on a machine: `bunx playwright install chromium`. The pinned `@playwright/test` version chooses the browser build, a download of about 115 MB.

⚠ **Stop your own `bun run dev` first.** The model-free tier starts its own stack, over its own home (below), on the dev ports 5178 and 5179. A stack already running there serves *your* home, where the seeded threads are not, so the suite refuses to reuse it and Playwright says the port is in use. `bun run e2e:model` does reuse a running stack, because it needs your login.

## The seeded home

`e2e-home.ts` makes a throwaway `ENSO_HOME` for the run, and the config starts `bun run dev` over it. The model-free tier never reads or writes your real `~/.enso`. The home holds:

- **A `demo` provider** in pi's `models.json` (the Features capture's, from `scripts/docs/feature-session.ts`), pointing at port 1, where nothing listens. Model pickers have entries, and a request that should not happen is refused at once instead of reaching a real provider. No secret is needed.
- **Stored threads**, written the way pi writes them, by `packages/web/src/host/__tests__/stored-session.ts` (the host's own test helper, because only the host may import pi):
  - `first` and `second`: `SEEDED_TURNS` (25) turns each, in the checkout's project, several screens tall;
  - `outside`: one turn in a folder no project covers, which the server refuses to open (#378).

  A test reads their ids with `e2eHome().threads` and their rail titles from `SEEDED_TITLES`.

Playwright loads the config in its runner and again in every worker. The runner seeds the home once and passes its location to the workers in `ENSO_E2E_HOME`.

To add a seeded thread, add it to `seededHome` in `e2e-home.ts` with the turns a test needs, and give it a title in `SEEDED_TITLES`.

## What the model-free tier holds

| Test | Held behaviour |
|---|---|
| empty state, `/mode` refused, then dialog, answer, settle | before a session `/mode` is refused and its words come back to the composer (#484); the mode select builds the session with no model; then a dialog round trip through pi: Enso's mode select ("Accept edits"), then the `Mode: acceptEdits` line from the host's `permission-mode` (#496) |
| fonts load from `/fonts` | the web server's font route, wired to the page |
| paste an image | the image reaches the prompt POST as `EnsoPromptImage` |
| the URL names the thread | reload, back/forward, a pasted link, a malformed id (#142) |
| New Thread during a slow resume | the late history is dropped (PR #143 review) |
| Escape on `/model` or `/context` | focus returns to the composer (#367) |
| switching threads keeps a scrolled-up reader's place | an off-screen pane keeps its scroll position (#370) |
| every off-screen pane is inert and `content-visibility: hidden` | no pointer, focus or layout work for a pane off screen (#472) |
| a URL naming an unused thread id | that thread is started with no alert; one outside the projects is refused by name (#378) |
| a long prompt leaves the Start dialog in the window | at 1440×900 and 800×480, a 14-line prompt scrolls inside its capped box, the dialog is not clipped at the top, and Start session is in the window and clickable without scrolling (#679) |

Each of the four before the last was shown failing with its fix reverted (#486).

⚠ **A slash command needs a running session (#484)**, and a page visit builds none. A test that drives one first builds the thread's session with `chooseMode`: the composer's mode select is a control route that builds it with no model. All four tests that drove a slash command into a session-less thread had failed since #484, unnoticed because this suite is not in CI (#604).

## Output

`packages/web/e2e/output/` (gitignored):

- **Screenshots** in `screenshots/`:
  - `01-empty-state.png`, `02-mode-dialog.png`, `03-mode-answered.png`, `06-image-attached.png`, `07-image-sent.png`, `08-thread-reloaded.png`, `09-thread-bad-id.png` from the chat-surface tests. The image test answers the prompt route itself, so no model is involved;
  - `04-model-streaming.png` and `05-model-settled.png` from `@model`.
- **`test-results/`** holds a trace for each failed test. Open one with `bunx playwright show-trace <zip>`.

The names are fixed, so these are the paths every run writes.

## Getting screenshots into a PR

A pull request that changes what the web page shows carries screenshots, committed to the `screenshots` branch under the number of the issue it closes (`382/`; a PR with no issue uses `pr-<PR number>/`) and embedded in the description. The commands and the naming are in [the PR template](../../../.github/pull_request_template.md). Never commit them to the PR's own branch.

## Selectors are what a reader sees

The spec finds controls by their accessible names and placeholders from `src/chat-screen.tsx`. Two traps:

- **The Start dialog's prompt box has the composer's placeholder.** A new thread opens that dialog; `openNewThread` puts it away with Escape.
- **Every off-screen pane keeps its own composer and mode control**, `inert` and invisible (#472). `composer(page)` and `modeControl(page)` take the one on screen.

Renaming a label in the UI is a spec change too. The constants at the top of `chat.e2e.ts` are the one place to update, and `src/__tests__/thread-pane.test.tsx` reads them out of that file, so drift on either side fails `bun run check`.
