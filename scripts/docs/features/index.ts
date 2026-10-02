import { CHAT } from './chat.ts'
import { CONTEXT_BROWSER } from './context-browser.ts'
import { CONTEXT } from './context.ts'
import { DIFF } from './diff.ts'
import { GUARDS_AND_RECEIPTS } from './guards-and-receipts.ts'
import { LINEAGE } from './lineage.ts'
import { LOGS_AND_DEBUGGING } from './logs-and-debugging.ts'
import { PERMISSION_MODES } from './permission-modes.ts'
import { PROMPTS } from './prompts.ts'
import { QUESTIONS_AND_DIALOGS } from './questions-and-dialogs.ts'
import { SESSION_EVAL } from './session-eval.ts'
import { SESSIONS_AND_PROJECTS } from './sessions-and-projects.ts'
import { SETTINGS } from './settings.ts'
import type { FeatureSpec } from './spec.ts'
import { STATS } from './stats.ts'
import { TERMINAL } from './terminal.ts'
import { THREAD_TREES } from './thread-trees.ts'
import { WEB_ACCESS } from './web-access.ts'

/**
 * Every Features page, each built from its spec (#482). ⚠ THE ORDER IS THE CAPTURE'S: the live
 * shots of the finished thread are taken in this order, and a shot that changes the thread for
 * the ones after it goes last. The index page's order is its own (`docs/features/README.md`).
 */
export const FEATURE_SPECS: readonly FeatureSpec[] = [
  CHAT,
  GUARDS_AND_RECEIPTS,
  WEB_ACCESS,
  PERMISSION_MODES,
  CONTEXT,
  CONTEXT_BROWSER,
  STATS,
  SESSION_EVAL,
  DIFF,
  LOGS_AND_DEBUGGING,
  SETTINGS,
  PROMPTS,
  QUESTIONS_AND_DIALOGS,
  SESSIONS_AND_PROJECTS,
  TERMINAL,
  // Before LINEAGE: it confirms nothing, so the thread is as it was; LINEAGE's fork would add a second tree.
  THREAD_TREES,
  // ⚠ LAST: its first shot forks the thread, adding a second thread to the rail, and leaves the page on the fork.
  LINEAGE,
]
