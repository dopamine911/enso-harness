import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { findRepoRoot } from '../../packages/core/src/paths.ts'
import { runGenerator } from './generator-support.ts'
import {
  ADAPTER_PATH,
  CUSTOM_ROUTER_PATH,
  MAPPER_PATH,
  OBSERVATION_PATH,
  producedKinds,
  schemaMember,
  unionMembers,
} from './observations.ts'
import { discoverRoutes, type ResolvedRoute } from './routes.ts'

/**
 * Generates `docs/reference/flows.md` (#188): the control plane and the observation pipeline as
 * Mermaid, drawn from the SAME discovery the reference tables use.
 *
 * ⚠ NOT A SECOND SOURCE OF TRUTH, AND THAT IS THE ONLY REASON THIS FILE IS ALLOWED TO EXIST. A
 * hand-drawn architecture diagram is the worst documentation this repository could own: it is
 * read as authoritative, it is checked by nobody, and it is wrong the first week a route moves.
 * So every node here is a value read out of code — `discoverRoutes()` finds the routes exactly
 * as `routes.ts` does, and the observation kinds come from the `ZenObservation` union itself. A
 * route added, renamed or deleted changes this page or fails the docs gate; there is no third
 * option in which the picture stays pretty and stops being true.
 *
 * WHAT EACH DIAGRAM IS DRAWN FROM:
 *   • control plane — `discoverRoutes()`: method, path, handler and the runtime factory each
 *     control route reaches, plus the dispatcher line that proves the route is wired.
 *   • observation pipeline — the `ZenObservation` union's members and the producers that emit
 *     their `kind`, then the fixed stages every observation crosses (follow frame, browser
 *     adapter, event router).
 *
 * WHAT IT DOES NOT DRAW. Anything with no machine-readable source: the reasons a seam exists,
 * what a refusal means, the ordering guarantees inside the runtime. Those are prose, and prose
 * pages own them (`docs/seams/`, `docs/flows/`). A diagram that guessed at them would be the
 * hand-maintained picture this file refuses to be.
 *
 * LINKS. Mermaid `click` directives do not survive GitHub's renderer, so each diagram is
 * followed by a table carrying the same nodes to their CONTRACT (a reference row) and to their
 * SOURCE (`path:line`). The trail a debugger needs — diagram → contract → source — is therefore
 * readable in both renderers rather than only in the site.
 */

const ROOT = findRepoRoot(import.meta.url)
const FOLLOW_PATH = 'packages/web/src/server/follow.ts'
const FOLLOW_CONNECTION_PATH = 'packages/web/src/follow-connection.ts'

/** A Mermaid node id: the identifier must survive a path, a method and a slash. */
function nodeId(prefix: string, value: string): string {
  return `${prefix}_${value.replace(/[^A-Za-z0-9]+/g, '_')}`
}

/** `label` with the characters Mermaid reads as syntax quoted out of the way. */
function nodeLabel(label: string): string {
  return `"${label.replace(/"/g, "'")}"`
}

function sourceLink(path: string, line: number): string {
  return `[\`${path}:${line}\`](../../${path}#L${line})`
}

/**
 * The control plane: browser → dispatcher → handler → the runtime factory the route reaches.
 *
 * Only `control` routes are drawn. The observation routes are the OTHER diagram's first stage,
 * and drawing them here would state the same edge twice in two pictures that could disagree.
 */
function controlPlane(routes: readonly ResolvedRoute[]): string[] {
  const control = routes.filter((route) => route.routeClass === 'control')
  if (control.length === 0) throw new Error('flow-diagrams: no control routes were discovered')
  const lines = ['```mermaid', 'flowchart LR', '  Browser["Browser"]']
  for (const route of control) {
    const id = nodeId('R', `${route.method}${route.path}`)
    const handlerId = nodeId('H', route.handler)
    lines.push(`  Browser -->|${route.method} ${route.path}| ${id}[${nodeLabel(route.handler)}]`)
    if (route.factory === undefined) continue
    const factoryName = route.factory.declaration.replace(/^export (?:async )?function /, '')
    lines.push(`  ${id} --> ${handlerId}[${nodeLabel(`${factoryName}()`)}]`)
    lines.push(`  ${handlerId} --> Runtime`)
  }
  lines.push('  Runtime["ThreadRuntime"] --> Observations["ZenObservation stream"]', '```')
  return lines
}

/** One row per control route: the node, the reference row that specifies it, and its source. */
function controlPlaneTable(routes: readonly ResolvedRoute[]): string[] {
  const rows = routes
    .filter((route) => route.routeClass === 'control')
    .map((route) => {
      const contract = `[\`${route.method} ${route.path}\`](./routes.md)`
      const sources = [sourceLink(route.dispatch.path, route.dispatch.line)]
      if (route.factory !== undefined && route.factoryLine !== undefined) {
        sources.push(sourceLink(route.factory.path, route.factoryLine))
      }
      return `| \`${route.handler}\` | ${contract} | ${route.input} | ${sources.join('<br>')} |`
    })
  return ['| Node | Contract | Input | Source |', '|---|---|---|---|', ...rows]
}

/** The line at which `needle` occurs in `path`, or a throw naming both. */
function lineOf(path: string, needle: RegExp): number {
  const source = readFileSync(join(ROOT, path), 'utf8')
  const match = needle.exec(source)
  if (match === null) throw new Error(`flow-diagrams: ${path} no longer contains ${needle}`)
  return source.slice(0, match.index).split('\n').length
}

interface PipelineStage {
  readonly id: string
  readonly label: string
  readonly contract: string
  readonly path: string
  readonly line: number
}

/**
 * The stages every observation crosses, from pi's event to the browser store.
 *
 * Each stage's LINE is found by the shape that makes it that stage — the mapper's return, the
 * follow writer's frame literal, the adapter's custom push, the router's dispatch. A stage that
 * is refactored away fails here rather than being drawn at a line that now means something else.
 */
function pipelineStages(mappedKinds: readonly string[]): PipelineStage[] {
  return [
    {
      id: 'Mapper',
      label: `mapPiEvent (${mappedKinds.length} kinds)`,
      contract: '[Observations](./observations.md)',
      path: MAPPER_PATH,
      line: lineOf(MAPPER_PATH, /export function mapPiEvent/),
    },
    {
      id: 'Schema',
      label: 'ZenObservation',
      contract: '[Core exports](./core-exports.md)',
      path: OBSERVATION_PATH,
      line: lineOf(OBSERVATION_PATH, /export const ZenObservation = Type\.Union/),
    },
    {
      id: 'Frame',
      label: 'observation frame',
      contract: '[Observations](./observations.md)',
      path: FOLLOW_PATH,
      line: lineOf(FOLLOW_PATH, /\{ type: 'observation', seq: frame\.seq, observation: frame\.observation \}/),
    },
    {
      id: 'Connection',
      label: 'follow connection',
      contract: '[Routes](./routes.md)',
      path: FOLLOW_CONNECTION_PATH,
      line: lineOf(FOLLOW_CONNECTION_PATH, /name: frame\.type, value: frame/),
    },
    {
      id: 'Adapter',
      label: 'to-agui chunk',
      contract: '[Observations](./observations.md)',
      path: ADAPTER_PATH,
      line: lineOf(ADAPTER_PATH, /name: observation\.kind, value: observation/),
    },
    {
      id: 'Router',
      label: 'custom event router',
      contract: '[Observations](./observations.md)',
      path: CUSTOM_ROUTER_PATH,
      line: lineOf(CUSTOM_ROUTER_PATH, /switch \(/),
    },
  ]
}

function observationPipeline(stages: readonly PipelineStage[]): string[] {
  const lines = ['```mermaid', 'flowchart LR', '  Pi["pi runtime event"]']
  let previous = 'Pi'
  for (const stage of stages) {
    lines.push(`  ${previous} --> ${stage.id}[${nodeLabel(stage.label)}]`)
    previous = stage.id
  }
  lines.push(`  ${previous} --> Store["browser store"]`, '```')
  return lines
}

function generate(): string {
  const routes = discoverRoutes()
  const observationSource = readFileSync(join(ROOT, OBSERVATION_PATH), 'utf8')
  // Declaration order, NOT sorted: the page says "in the union's order of declaration", and a
  // sort would have made that sentence false while it still read as true.
  const kinds = unionMembers(observationSource).map((schema) => schemaMember(observationSource, schema).kind)
  const mapperKinds = producedKinds(readFileSync(join(ROOT, MAPPER_PATH), 'utf8'))
  const mapped = kinds.filter((kind) => mapperKinds.has(kind))
  const stages = pipelineStages(mapped)

  return [
    '<!-- generated: scripts/docs/flow-diagrams.ts -->',
    '# Generated flows',
    '',
    'Every node below is read out of the source the flow runs through — the route table in `packages/web/src/server/index.ts` and the `ZenObservation` union in `packages/core/src/observation.ts`. Nothing here is drawn by hand, so a route or a kind that moves changes this page or fails the docs gate.',
    '',
    '## Control plane',
    '',
    `The ${routes.filter((route) => route.routeClass === 'control').length} control routes: what the browser can ask the runtime to do. Observation routes are the next diagram's first stage rather than a second copy of it.`,
    '',
    ...controlPlane(routes),
    '',
    ...controlPlaneTable(routes),
    '',
    '## Observation pipeline',
    '',
    `One pi event becomes one observation and crosses six stages to reach the browser store. The union declares ${kinds.length} kinds; the mapper produces ${mapped.length} of them, and the rest are produced by the prompt route (see [Observations](./observations.md) for the per-kind producer, carrier and consumer).`,
    '',
    ...observationPipeline(stages),
    '',
    '| Stage | Contract | Source |',
    '|---|---|---|',
    ...stages.map((stage) => `| \`${stage.label}\` | ${stage.contract} | ${sourceLink(stage.path, stage.line)} |`),
    '',
    `Kinds, in the union's order of declaration: ${kinds.map((kind) => `\`${kind}\``).join(', ')}.`,
    '',
  ].join('\n')
}

if (import.meta.main) runGenerator('flow-diagrams', generate)
