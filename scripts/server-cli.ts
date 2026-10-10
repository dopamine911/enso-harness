import { readFileSync } from 'node:fs'

/**
 * What the CLIs that read the running server share (`bun run incidents`, #468; `bun run judge`,
 * #469): a usage error the caller turns into exit 2, the whole-number flag every threshold and
 * count takes, a route's JSON, the stored-thread listing a CLI reads when no thread is named, the
 * output a CLI's `run` writes to (#832), and the one catch `incidents` and `judge` run under (#838).
 */

/** Where a CLI's `run` writes: the process's own (`PROCESS_OUTPUT`) from its `main`, captures in a test. */
export interface CliOutput {
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
}

export const PROCESS_OUTPUT: CliOutput = {
  stdout: (text) => {
    process.stdout.write(text)
  },
  stderr: (text) => {
    process.stderr.write(text)
  },
}

/** A command line the CLI cannot read: the caller prints it with the usage and exits 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

/** Where `incidents` and `judge` write, and the server they read: the process's own from `main`, a capture in a test. */
export interface ServerCliIo extends CliOutput {
  readonly serverUrl: string
}

/**
 * The process's own output, and the server `serverUrl` names: the dev server's when unset. Each
 * `main` passes `process.env.ENSO_SERVER_URL` itself, so the environment inventory finds the read
 * where it happens (#838).
 */
export function processServerIo(serverUrl: string | undefined): ServerCliIo {
  return { ...PROCESS_OUTPUT, serverUrl: serverUrl ?? 'http://127.0.0.1:5179' }
}

/** A server-reading CLI's command over `io`, returning its exit code (#838). */
type ServerCommandRun = (argv: readonly string[], io: ServerCliIo) => Promise<number>

/**
 * The `run` of a CLI whose `output` reads the server (#838), with one catch for every failure:
 * the output on stdout and 0; a usage error on stderr with the usage, 2; anything else on stderr,
 * 1. Nothing reaches stdout unless the whole output was made.
 */
export function serverCommand(
  command: string,
  usage: string,
  output: (argv: readonly string[], serverUrl: string) => Promise<string>,
): ServerCommandRun {
  return async (argv, io) => {
    try {
      io.stdout(`${await output(argv, io.serverUrl)}\n`)
      return 0
    } catch (error) {
      const isUsage = error instanceof UsageError
      io.stderr(
        `${command}: ${error instanceof Error ? error.message : String(error)}${isUsage ? `\n\n${usage}` : ''}\n`,
      )
      return isUsage ? 2 : 1
    }
  }
}

/** A flag's value as a threshold or a count takes it: a whole number from 1, as `config.json` does. */
export function wholeNumber(flag: string, given: string | undefined): number {
  if (given === undefined || !/^[1-9]\d{0,5}$/.test(given)) {
    throw new UsageError(`${flag} takes a whole number from 1, not ${given ?? 'nothing'}`)
  }
  return Number(given)
}

/** A route's JSON, or the error that says what the server answered instead. */
export async function fetchJson(url: URL): Promise<unknown> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url.href} answered ${response.status}: ${await response.text()}`)
  return response.json()
}

/** Every stored thread the server lists: what a CLI reads when no thread is named. */
export async function storedThreadIds(serverUrl: string): Promise<string[]> {
  const listed = await fetchJson(new URL('/api/stored-threads', serverUrl))
  if (!Array.isArray(listed)) throw new Error('/api/stored-threads did not answer a list')
  return listed.flatMap((thread: { threadId?: unknown }) =>
    typeof thread.threadId === 'string' ? [thread.threadId] : [],
  )
}

/**
 * A JSON-lines file's records, a line that does not parse skipped: a transcript being written
 * can end in half a line, and one bad line must not hide the rest.
 */
export function readJsonLines(path: string): unknown[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as unknown]
      } catch {
        return []
      }
    })
}
