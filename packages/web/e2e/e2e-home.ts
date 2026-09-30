import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensoAgentDir, findRepoRoot } from '@enso/core/paths'
import { demoModelsJson } from '../../../scripts/docs/feature-session.ts'
import { writeStoredSession } from '../src/host/__tests__/stored-session.ts'

/**
 * The browser suite's own `ENSO_HOME` (#486): a throwaway home the dev stack is started over, with
 * threads already stored in it, so the suite has long transcripts to scroll and switch between
 * with no model, and never reads or writes the operator's real home.
 *
 *   • pi's `models.json` declares the `demo` provider (`feature-session.ts`), with nothing
 *     listening on its port: a model list has entries, and no prompt can reach a provider.
 *   • Two stored threads of `SEEDED_TURNS` turns each, written the way pi writes them
 *     (`host/__tests__/stored-session.ts`) in the project the dev stack serves, the checkout.
 *
 * ⚠ ONE HOME PER RUN, FOUND BY ITS ENVIRONMENT VARIABLE. Playwright loads the config in its
 * runner and again in every worker; the runner makes the home and exports where it is, and a
 * worker (which inherits the variable) reads it back instead of seeding a second one.
 */

/** Where the run's home is, as JSON, for the workers the runner starts. */
const E2E_HOME_VARIABLE = 'ENSO_E2E_HOME'
/** Turns per seeded thread: enough that a transcript is several screens tall at the suite's viewport. */
export const SEEDED_TURNS = 25

/**
 * Where the `demo` provider points: port 1, privileged and never served, so a request that
 * should not happen is refused at once and never reaches a real provider. Not the Features
 * capture's own port (`MODEL_PORT`, 5199): a capture running at the same time would answer there
 * with its scripted model, and a stray request would pass instead of failing (PR #494 review).
 */
const REFUSED_PORT = 1

export interface E2eHome {
  /** The `ENSO_HOME` the dev stack runs over. */
  readonly home: string
  /** Stored threads by what a test needs of them; their first prompts are `SEEDED_TITLES`. */
  readonly threads: {
    /** Two long threads in the checkout's project, the one the dev stack serves. */
    readonly first: string
    readonly second: string
    /** A thread whose session ran in a folder no project covers: the server refuses to open it (#378). */
    readonly outside: string
  }
}

/** Each seeded thread's first prompt: its title in the rail. */
export const SEEDED_TITLES = {
  first: 'First seeded thread',
  second: 'Second seeded thread',
  outside: 'A thread outside the projects',
} as const

/** A reply several lines tall, numbered, so a scrolled position is a place a reader could name. */
function reply(title: string, turn: number): string {
  return Array.from(
    { length: 6 },
    (_unused, paragraph) =>
      `${title}, turn ${turn}, paragraph ${paragraph + 1}: a stored answer long enough to take room on screen.`,
  ).join('\n\n')
}

/** A stored thread of `turnCount` turns, in `cwd`: its id. */
function seedThread(cwd: string, title: string, turnCount: number): string {
  const threadId = randomUUID()
  const turns = Array.from({ length: turnCount }, (_unused, turn): readonly [string, string] => [
    turn === 0 ? title : `${title}: question ${turn + 1}`,
    reply(title, turn + 1),
  ])
  writeStoredSession({ cwd, threadId, turns })
  return threadId
}

function seededHome(): E2eHome {
  const home = mkdtempSync(join(tmpdir(), 'enso-e2e-'))
  const agentDir = ensoAgentDir(home)
  mkdirSync(agentDir, { recursive: true })
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify(demoModelsJson(REFUSED_PORT), null, 2))
  // The writer files a session where pi would: under the agent dir this names (stored-session.ts).
  process.env.PI_CODING_AGENT_DIR = agentDir
  const project = findRepoRoot(import.meta.url)
  // With no `projects.roots` declared, the launch folder is the only project; this folder is none.
  const elsewhere = join(home, 'elsewhere')
  mkdirSync(elsewhere)
  return {
    home,
    threads: {
      first: seedThread(project, SEEDED_TITLES.first, SEEDED_TURNS),
      second: seedThread(project, SEEDED_TITLES.second, SEEDED_TURNS),
      outside: seedThread(elsewhere, SEEDED_TITLES.outside, 1),
    },
  }
}

/** The run's seeded home: made by the runner's first call, read back everywhere after. */
export function e2eHome(): E2eHome {
  const known = process.env[E2E_HOME_VARIABLE]
  if (known !== undefined) return JSON.parse(known) as E2eHome
  const made = seededHome()
  process.env[E2E_HOME_VARIABLE] = JSON.stringify(made)
  return made
}

/**
 * How the config starts the dev stack. The `@model` tier needs the operator's own login, said by
 * `bun run e2e:model` setting `ENSO_E2E_MODEL=1`: it keeps their home and may reuse their running
 * stack. The model-free tier gets the seeded home, and never a running stack, which would serve
 * the operator's home instead. ⚠ The tier is never guessed from the arguments: reading
 * "`--grep` was passed" sent a filtered model-free run (`bun run e2e -- --grep scroll`) to the
 * operator's home once.
 */
export function e2eStack(): { readonly reuseRunningStack: boolean; readonly environment: Record<string, string> } {
  const modelTier = process.env.ENSO_E2E_MODEL === '1'
  const environment = Object.fromEntries(
    Object.entries({ ...process.env, ...(modelTier ? {} : { ENSO_HOME: e2eHome().home }) }).flatMap(([key, value]) =>
      value === undefined ? [] : [[key, value]],
    ),
  )
  return { reuseRunningStack: modelTier, environment }
}
