import { GlobalRegistrator } from '@happy-dom/global-registrator'

/**
 * A browser DOM for the tests that MOUNT React (#118) — the mounted-pane tests, which need
 * effects, `useSyncExternalStore` subscriptions and TanStack's `useChat` to actually run.
 * `renderToStaticMarkup` needs none of this and the rest of the suite stays DOM-free.
 *
 * ⚠ `react-dom/client` MUST BE LOADED AFTER THIS MODULE HAS RUN — by a dynamic import in the
 * test file, not a static one. React DOM decides at module evaluation whether the browser has
 * the `input` event (`"oninput" in document`); with no document it falls back to an IE-era
 * polyfill that tracks the focused element, and under that `onChange`/`onKeyDown` never fire
 * and its change plugin throws on every keystroke. A static side-effect import of this file
 * is NOT enough: bun evaluates node_modules imports before local side-effect imports, so a
 * statically imported react-dom/client sees no DOM. Measured 2026-09-09 (#118).
 *
 * ⚠ SCOPED TO THE IMPORTING FILE, NOT THE PROCESS. `bun test` runs every file in one process,
 * and the registrator puts `window`, `document`, `fetch`, `Response`, `Request`, `Headers` AND
 * `ReadableStream` on `globalThis` — under the server tests (a real `Bun.serve`) that would be
 * the wrong fetch and the wrong Response. So this is not a `bunfig.toml` preload: the importing
 * file calls {@link releaseDom} in its `afterAll`, which unregisters everything and gives the
 * real `fetch` back.
 */

const realFetch: typeof fetch = globalThis.fetch

GlobalRegistrator.register({ url: 'http://localhost/' })
// React's `act` warns without this — it is how a test tells React it will flush updates itself.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** Tear the DOM down and give `fetch` back — `afterAll` in every file that imports this module. */
export async function releaseDom(): Promise<void> {
  globalThis.fetch = realFetch
  await GlobalRegistrator.unregister()
}
