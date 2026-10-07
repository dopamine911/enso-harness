import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type ArenaPerception, readJsonLines } from './timeline.ts'

/**
 * What a run's models used (#674): the agent under test's own calls and their price, and the models
 * Enso's sessions actually ran on — so runs can be set side by side by model, and a matrix can say
 * what it will cost before it starts.
 *
 * ⚠ THE PRICE IS THE MODEL'S LISTED ONE. Each call in the agent's transcript carries pi's usage and
 * its cost at the model's listed rates — what an API key would be billed, whatever account ran it. A
 * model that lists no price spends tokens at $0 (#692); its cost is unknown, never $0.
 */

/** The agent under test's own model calls, from its transcript. */
export interface ArenaAgentUsage {
  readonly calls: number
  /** Tokens sent, cached ones included: a visual agent's screenshots are most of them. */
  readonly inputTokens: number
  readonly outputTokens: number
  /** USD at the model's listed price; absent when it lists none (tokens spent, $0 charged). */
  readonly costUsd?: number
}

/** What a run's models used (#674): the agent's own calls (absent with no agent), and the models Enso ran on. */
export interface ArenaModelUse {
  readonly agent?: ArenaAgentUsage
  readonly enso: readonly string[]
}

/** One field of a parsed object, as a number; 0 when absent or not one. */
const numberAt = (value: unknown, key: string): number => {
  if (typeof value !== 'object' || value === null || !(key in value)) return 0
  const field: unknown = Reflect.get(value, key)
  return typeof field === 'number' && Number.isFinite(field) ? field : 0
}

/** The agent's calls and their price, from its transcript; undefined when it made none. */
export function agentUsageOf(transcript: readonly unknown[] | undefined): ArenaAgentUsage | undefined {
  let calls = 0
  let inputTokens = 0
  let outputTokens = 0
  let costUsd = 0
  for (const message of transcript ?? []) {
    if (typeof message !== 'object' || message === null || Reflect.get(message, 'role') !== 'assistant') continue
    const usage: unknown = Reflect.get(message, 'usage')
    if (usage === undefined) continue
    calls += 1
    inputTokens += numberAt(usage, 'input') + numberAt(usage, 'cacheRead') + numberAt(usage, 'cacheWrite')
    outputTokens += numberAt(usage, 'output')
    costUsd += numberAt(Reflect.get(usage as object, 'cost'), 'total')
  }
  if (calls === 0) return undefined
  const priced = costUsd > 0 || inputTokens + outputTokens === 0
  return { calls, inputTokens, outputTokens, ...(priced ? { costUsd } : {}) }
}

/**
 * The models Enso's sessions ran on, `provider/model`, from each thread's record of its conditions
 * (`thread-<id>-manifest.json`, `conditions.model`): what was used, not what was asked for.
 */
export function ensoModelsIn(evidenceDirectory: string, files: readonly string[]): string[] {
  const models = new Set<string>()
  for (const file of files) {
    if (!/^thread-.+-manifest\.json$/.test(file)) continue
    try {
      const record: unknown = JSON.parse(readFileSync(join(evidenceDirectory, file), 'utf8'))
      const model: unknown = Reflect.get(Reflect.get(record as object, 'conditions') ?? {}, 'model')
      const provider: unknown = Reflect.get(model ?? {}, 'provider')
      const modelId: unknown = Reflect.get(model ?? {}, 'modelId')
      if (typeof provider === 'string' && typeof modelId === 'string') models.add(`${provider}/${modelId}`)
    } catch {
      // A record that does not read names no model; the evidence rows say why it is missing.
    }
  }
  return [...models].toSorted()
}

/** What earlier runs of one agent model, in one perception, cost each: how many there were, and their mean. */
export interface ArenaCostEstimate {
  readonly runs: number
  /** Over the priced ones; absent when none was priced. */
  readonly meanCostUsd?: number
}

/** Whether a run was driven by `agent` in `perception`, by its manifest; false when there is none that reads. */
function ranAs(manifestPath: string, agent: string, perception: ArenaPerception): boolean {
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      readonly driver?: { readonly provider?: string; readonly model?: string }
      readonly perception?: ArenaPerception
    }
    const driver = `${String(manifest.driver?.provider)}/${String(manifest.driver?.model)}`
    // A manifest written before #680 names no perception: every run then read the tree.
    return driver === agent && (manifest.perception ?? 'tree') === perception
  } catch {
    return false
  }
}

/** An estimate from the runs under `runsDirectory` with this agent and perception (#674): measured, never guessed. */
export function costEstimate(runsDirectory: string, agent: string, perception: ArenaPerception): ArenaCostEstimate {
  const costs: number[] = []
  let runs = 0
  for (const runId of existsSync(runsDirectory) ? readdirSync(runsDirectory) : []) {
    const transcriptPath = join(runsDirectory, runId, 'agent', 'transcript.jsonl')
    if (!existsSync(transcriptPath) || !ranAs(join(runsDirectory, runId, 'manifest.json'), agent, perception)) continue
    runs += 1
    const cost = agentUsageOf(readJsonLines(transcriptPath))?.costUsd
    if (cost !== undefined) costs.push(cost)
  }
  const meanCostUsd = costs.length === 0 ? undefined : costs.reduce((sum, cost) => sum + cost, 0) / costs.length
  return { runs, ...(meanCostUsd === undefined ? {} : { meanCostUsd }) }
}
