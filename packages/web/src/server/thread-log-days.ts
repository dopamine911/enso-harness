import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { EnsoLogLine } from '@enso/core'
import { ensoLogDay, ensoLogFilename } from '@enso/core/log-process'
import { readLogFile } from './logs-stats-route.ts'

/**
 * A thread's records in the day files (#45, #441): which days are on disk, which local day a
 * moment falls on, and one day's lines for one thread. Shared by the stats route and the eval
 * route so the two cannot read the log differently.
 */

/** The day files present, oldest first — whatever the 14-day prune left. A missing directory has none. */
export function logDaysOnDisk(logsDir: string): string[] {
  let names: string[]
  try {
    names = readdirSync(logsDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return names.flatMap((filename) => ensoLogDay(filename) ?? []).toSorted()
}

/** The local day a moment falls on, as the day files name it. */
export function localDayOf(moment: Date): string {
  return ensoLogDay(ensoLogFilename(moment)) ?? ''
}

/** This thread's records in one day file. The raw id test first, so most lines are never parsed. */
export function threadLines(logsDir: string, day: string, threadId: string): EnsoLogLine[] {
  const { lines } = readLogFile(join(logsDir, `enso-${day}.jsonl`), (raw) => raw.includes(threadId))
  return lines.filter((line) => line.properties?.threadId === threadId)
}
