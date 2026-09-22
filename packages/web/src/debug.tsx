// ⚠ First import, deliberately: Tailwind's layers must land before any component renders,
// and this is the ONE stylesheet — shadcn's theme variables are injected into it by the
// CLI (`components.json` points here). Do not add a second css entry point.
import './styles/global.css'
import { StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { configureBrowserLogging, pageLogLevel } from './browser-logging.ts'
import { LogTailScreen } from './debug/log-tail-screen.tsx'

/**
 * THE OBSERVATION ENTRY (#144 slice 2), deliberately thin: mount the log page, nothing else.
 * Everything importable lives in `debug/log-tail-screen.tsx` and `debug/log-tail-connection.ts`
 * so the coverage manifest can put them in the denominator — this file is excluded from the
 * import-everything discipline BY NAME, on the same contract `main.tsx` carries, and it is one
 * of the two modules allowed to touch the DOM at module scope.
 *
 * ⚠ A SEPARATE PAGE FROM THE CHAT SCREEN, on purpose. A debugging surface is observation: it
 * reads, it writes nothing, it makes no records, it offers no control. Sharing an entry with
 * the surface that prompts pi, aborts runs and answers dialogs would put that line one import
 * away from being crossed.
 */

// Logging, with ONE deliberate difference from `main.tsx`: NO `fetch`, so no shipper is built
// and this page posts nothing. Its records would otherwise be re-emitted by the server into
// the very file it is tailing — the reader's own presence, on top of whatever they opened the
// page to find (#144). The ring and the console still get everything, so a problem here is
// still visible in devtools. `?log=debug` turns the page up, as it does on the chat page.
await configureBrowserLogging({
  level: pageLogLevel(window.location.search),
  page: crypto.randomUUID().slice(0, 8),
  console: true,
})

const rootElement = document.getElementById('root')
if (rootElement === null) throw new Error('Enso: #root is missing from debug.html')
// ⚠ The root is cached across module re-evaluations, for the reason main.tsx gives: an entry
// with side effects is never a Fast Refresh boundary, and a bare `createRoot()` on a re-run
// re-roots the same container. Its OWN key — two entries, two roots, two containers; sharing
// `__ensoReactRoot` would hand this page the chat page's root after an HMR edit.
const globalWithRoot = globalThis as { __ensoDebugReactRoot?: Root }
globalWithRoot.__ensoDebugReactRoot ??= createRoot(rootElement)
const reactRoot: Root = globalWithRoot.__ensoDebugReactRoot
reactRoot.render(
  <StrictMode>
    <LogTailScreen />
  </StrictMode>,
)
