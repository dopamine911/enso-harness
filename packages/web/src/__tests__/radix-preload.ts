import { GlobalRegistrator } from '@happy-dom/global-registrator'

/**
 * `bun test` preload (bunfig.toml): evaluate the modules that DECIDE BY `document` AT MODULE
 * EVALUATION while a document exists, then take the document away again (#338).
 *
 * ⚠ WHY A PRELOAD AND NOT A RULE PER FILE. `@radix-ui/react-use-layout-effect` picks
 * `React.useLayoutEffect` or a no-op by `globalThis?.document` the moment it is first imported,
 * and `bun test` runs every file in one process with one module cache. Radix is reachable from
 * `reasoning.tsx` (collapsible), `prompt-input.tsx` (the `/` palette's dropdown, #338) and so
 * from most of the page; the static-markup tests import those with no DOM up. Whichever such file
 * ran first baked the no-op in for the whole run, and every later file that MOUNTS a Radix
 * dropdown saw the trigger report `open` and the portal render nothing — `Presence` and `Portal`
 * both wait on that layout effect. Nine palette tests passed alone and failed in the suite;
 * fixing the import order in three files found two more (measured 2026-09-22). A rule that must
 * be re-discovered by the next importer is not a fix; this runs once, before any file.
 *
 * With the real hook chosen, the DOM-free tests are unaffected: `renderToStaticMarkup` never
 * runs layout effects. `@floating-ui/react-dom` (`isClient`) and `@radix-ui/primitive`
 * (`canUseDOM`) make the same decision the same way; the `radix-ui` umbrella — the door the
 * vendored components use — evaluates all three, so it is what is loaded. Naming the transitive
 * packages here would be importing what package.json does not list.
 *
 * The registrator is torn down before any test runs, so the server tests keep the real
 * `fetch`/`Response` — the reason `dom-environment.ts` is not itself a preload.
 */
GlobalRegistrator.register({ url: 'http://localhost/' })
try {
  await import('radix-ui')
} finally {
  await GlobalRegistrator.unregister()
}
