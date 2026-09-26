// ⚠ First import, deliberately: Tailwind's layers must land before any component renders,
// and this is the ONE stylesheet — shadcn's theme variables are injected into it by the
// CLI (`components.json` points here). Do not add a second css entry point.
import './styles/global.css'
import { StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { configureBrowserLogging, pageLogLevel } from './browser-logging.ts'
import { ChatScreen } from './chat-screen.tsx'
import { applyFonts, linkFontFaces, readSavedFonts } from './fonts.ts'
import { applyTheme, pageStorage, readSavedTheme } from './theme.ts'
import { browserLogging } from './thread-stores.ts'

/**
 * THE ENTRY, deliberately thin: mount the app, nothing else. Everything importable lives
 * in chat-screen.tsx so the coverage manifest can put it in the denominator — this file
 * is the one module allowed to touch the DOM at module scope, and it is excluded from the
 * import-everything discipline BY NAME with this rationale.
 */

// The saved theme, normalised: index.html's inline script already copied the saved id before
// the first paint; an id this page no longer offers falls back to the default here.
applyTheme(readSavedTheme(pageStorage()), document.documentElement)
// The fonts (#407): every family's faces declared from their own stylesheets, unbundled — a face
// downloads only when text is set in it — and the saved per-role choice over the theme's.
linkFontFaces(document)
applyFonts(readSavedFonts(pageStorage()), document.documentElement)

// Logging first (#132): the ring the drawer reads, the shipper to the server, devtools.
// `?log=debug` turns the page up. The shipper flushes on hide, so a closing tab's last
// records go with it.
browserLogging.set(
  await configureBrowserLogging({
    fetch: (input: string, init?: RequestInit) => fetch(input, init),
    level: pageLogLevel(window.location.search),
    page: crypto.randomUUID().slice(0, 8),
    console: true,
  }),
)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') browserLogging.get()?.shipper?.flush(true)
})

const rootElement = document.getElementById('root')
if (rootElement === null) throw new Error('Enso: #root is missing from index.html')
// ⚠ The root is cached across module re-evaluations. This file cannot Fast Refresh (bun's
// dev server warns "not accepted" and full-reloads on every edit here, as vite did before
// #36 — an entry with side effects is never a refresh boundary), and a bare
// `createRoot()` here then re-roots the same container, which React reports as an error
// (seen live while verifying #29). Dev-only, but the cache is three lines and makes an
// HMR edit render through the ONE root instead of racing two.
const globalWithRoot = globalThis as { __ensoReactRoot?: ReturnType<typeof createRoot> }
globalWithRoot.__ensoReactRoot ??= createRoot(rootElement)
const reactRoot: Root = globalWithRoot.__ensoReactRoot
reactRoot.render(
  <StrictMode>
    <ChatScreen />
  </StrictMode>,
)
