import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { costEstimate } from '../usage.ts'

/**
 * What a matrix says a run will cost before it starts (#674): the mean of what earlier runs of the
 * same agent model, in the same perception, cost — measured from their transcripts, never guessed.
 */

/** One assistant call in a transcript, priced at `costUsd` (0: a model that lists no price, #692). */
const call = (costUsd: number): object => ({
  role: 'assistant',
  usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, cost: { total: costUsd } },
})

/** A run under `runs`: its manifest as `manifest` (raw text when a string), and its transcript's calls, if any. */
function earlierRun(
  runs: string,
  id: string,
  run: { readonly manifest: object | string; readonly calls?: readonly number[] },
): void {
  const directory = join(runs, id)
  mkdirSync(join(directory, 'agent'), { recursive: true })
  const manifest = typeof run.manifest === 'string' ? run.manifest : JSON.stringify(run.manifest)
  writeFileSync(join(directory, 'manifest.json'), manifest)
  if (run.calls === undefined) return
  const lines = run.calls.map((costUsd) => JSON.stringify(call(costUsd)))
  writeFileSync(join(directory, 'agent', 'transcript.jsonl'), `${lines.join('\n')}\n`)
}

const OPUS = { driver: { provider: 'anthropic', model: 'claude-opus' } }

test('the estimate is the mean over the earlier runs of the same agent and perception', () => {
  const runs = mkdtempSync(join(tmpdir(), 'arena-usage-'))
  earlierRun(runs, 'snake-1', { manifest: { ...OPUS, perception: 'tree' }, calls: [1, 2] })
  earlierRun(runs, 'snake-2', { manifest: { ...OPUS, perception: 'tree' }, calls: [5] })
  // Another perception, another model: not this estimate's runs.
  earlierRun(runs, 'snake-3', { manifest: { ...OPUS, perception: 'visual' }, calls: [40] })
  earlierRun(runs, 'snake-4', { manifest: { driver: { provider: 'anthropic', model: 'claude-haiku' } }, calls: [0.1] })

  expect(costEstimate(runs, 'anthropic/claude-opus', 'tree')).toEqual({ runs: 2, meanCostUsd: 4 })
  expect(costEstimate(runs, 'anthropic/claude-opus', 'visual')).toEqual({ runs: 1, meanCostUsd: 40 })
  expect(costEstimate(runs, 'anthropic/claude-sonnet', 'tree')).toEqual({ runs: 0 })
})

test('a manifest from before #680 names no perception: its run read the tree', () => {
  const runs = mkdtempSync(join(tmpdir(), 'arena-usage-'))
  earlierRun(runs, 'snake-1', { manifest: OPUS, calls: [3] })
  expect(costEstimate(runs, 'anthropic/claude-opus', 'tree')).toEqual({ runs: 1, meanCostUsd: 3 })
  expect(costEstimate(runs, 'anthropic/claude-opus', 'visual')).toEqual({ runs: 0 })
})

test('an unpriced run counts as a run but not toward the mean: its cost is unknown, never $0 (#692)', () => {
  const runs = mkdtempSync(join(tmpdir(), 'arena-usage-'))
  earlierRun(runs, 'snake-1', { manifest: OPUS, calls: [0, 0] })
  expect(costEstimate(runs, 'anthropic/claude-opus', 'tree')).toEqual({ runs: 1 })
  earlierRun(runs, 'snake-2', { manifest: OPUS, calls: [6] })
  expect(costEstimate(runs, 'anthropic/claude-opus', 'tree')).toEqual({ runs: 2, meanCostUsd: 6 })
})

test('a run with no transcript, a manifest that does not read, or no runs directory at all is no evidence', () => {
  const runs = mkdtempSync(join(tmpdir(), 'arena-usage-'))
  earlierRun(runs, 'snake-manual', { manifest: OPUS })
  earlierRun(runs, 'snake-torn', { manifest: '{"driver": {"provider": "anthr', calls: [9] })
  expect(costEstimate(runs, 'anthropic/claude-opus', 'tree')).toEqual({ runs: 0 })
  expect(costEstimate(join(runs, 'not-there'), 'anthropic/claude-opus', 'tree')).toEqual({ runs: 0 })
})
