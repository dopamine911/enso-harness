import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { findRepoRoot } from '../../packages/core/src/index.ts'
import { assertExactKeys, runGenerator } from './generator-support.ts'

/**
 * Generates `docs/reference/observations.md`: every member of `ZenObservation`, its producer,
 * follow carrier, browser adapter emissions, and browser-side destination. Extraction follows
 * this repository's deliberately simple declaration and switch shapes.
 */

const ROOT = findRepoRoot(import.meta.url)
const OBSERVATION_PATH = 'packages/core/src/observation.ts'
const MAPPER_PATH = 'packages/web/src/host/map-events.ts'
const FOLLOW_PATH = 'packages/web/src/server/follow.ts'
const ADAPTER_PATH = 'packages/web/src/rpc/to-agui.ts'
const CUSTOM_NAMES_PATH = 'packages/web/src/rpc/custom-event-names.ts'
const CUSTOM_ROUTER_PATH = 'packages/web/src/custom-event-router.ts'
const FOLLOW_CONNECTION_PATH = 'packages/web/src/follow-connection.ts'

interface CustomMetadata {
  readonly consumer: string
  readonly routerBranch: boolean
}

/** Browser destinations are checked against every custom constant declared in `custom-event-names.ts`. */
const CUSTOM_METADATA: Record<string, CustomMetadata> = {
  ZEN_CUSTOM_EVENT_NOTIFY: { consumer: '`recentChunks`; `notifications`', routerBranch: true },
  ZEN_CUSTOM_EVENT_USAGE: { consumer: '`recentChunks`; `stats`', routerBranch: true },
  ZEN_CUSTOM_EVENT_QUEUE: { consumer: '`recentChunks`; `queue`', routerBranch: true },
  ZEN_CUSTOM_EVENT_DIALOG: {
    consumer: '`recentChunks`; `dialog` (or `notifications` if malformed)',
    routerBranch: true,
  },
  ZEN_CUSTOM_EVENT_DIALOG_SETTLED: { consumer: '`recentChunks`; `dialog`', routerBranch: true },
  ZEN_CUSTOM_EVENT_OPEN_DIALOGS: { consumer: '`recentChunks`; `dialog`', routerBranch: true },
  ZEN_CUSTOM_EVENT_FOLLOW_ENDED: { consumer: '`recentChunks`; `disconnected`; `notifications`', routerBranch: true },
  ZEN_CUSTOM_EVENT_ENTRY: {
    consumer: '`recentChunks` only; recorded and counted, rendered by nothing (L3)',
    routerBranch: false,
  },
  ZEN_CUSTOM_EVENT_MODE: { consumer: '`recentChunks`; `permissionMode`; `modeLines`', routerBranch: true },
  ZEN_CUSTOM_EVENT_RUN: { consumer: '`recentChunks`; `generation`; `disconnected`', routerBranch: true },
  ZEN_CUSTOM_EVENT_UNMAPPED: { consumer: '`recentChunks` only; nothing else consumes it', routerBranch: false },
}

interface SchemaMember {
  readonly schema: string
  readonly kind: string
  readonly line: number
}

interface AdapterResult {
  readonly labels: readonly string[]
  readonly constants: readonly string[]
  readonly dropped: boolean
  readonly classified: boolean
}

function lineAt(source: string, offset: number): number {
  return source.slice(0, offset).split('\n').length
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function unionMembers(source: string): string[] {
  const union = /export const ZenObservation = Type\.Union\(\[([\s\S]*?)\n\]\)/.exec(source)
  if (union?.[1] === undefined) throw new Error('observations: could not find the ZenObservation union')
  const members = union[1]
    .split('\n')
    .map((line) => line.trim().replace(/,$/, ''))
    .filter((line) => /^[A-Za-z_$][\w$]*$/.test(line))
  if (members.length !== new Set(members).size) throw new Error('observations: ZenObservation repeats a schema member')
  return members
}

function schemaMember(source: string, schema: string): SchemaMember {
  const declaration = `export const ${schema} = Type.Object(`
  const offset = source.indexOf(declaration)
  if (offset < 0) throw new Error(`observations: union member ${schema} is not a direct Type.Object schema`)
  const nextDeclaration = source.indexOf('\nexport const ', offset + declaration.length)
  const block = source.slice(offset, nextDeclaration < 0 ? source.length : nextDeclaration)
  const kinds = [...block.matchAll(/kind: Type\.Literal\('([a-z-]+)'\)/g)].map((match) => match[1] ?? '')
  if (kinds.length !== 1) throw new Error(`observations: ${schema} has ${kinds.length} inline kind literals`)
  return { schema, kind: kinds[0] ?? '', line: lineAt(source, offset) }
}

function producedKinds(source: string): Map<string, number> {
  const kinds = new Map<string, number>()
  for (const match of source.matchAll(/\bkind: '([a-z-]+)'/g)) {
    const kind = match[1] ?? ''
    if (!kinds.has(kind)) kinds.set(kind, lineAt(source, match.index))
  }
  return kinds
}

function customNames(source: string): Record<string, string> {
  const entries = [...source.matchAll(/export const (ZEN_CUSTOM_EVENT_\w+) = '([^']+)'/g)].map((match) => [
    match[1] ?? '',
    match[2] ?? '',
  ])
  const constants = entries.map(([constant]) => constant ?? '')
  if (constants.length !== new Set(constants).size) {
    throw new Error('observations: custom-event-names.ts repeats a custom constant')
  }
  return Object.fromEntries(entries)
}

function adapterResult(source: string, kind: string, names: Record<string, string>): AdapterResult {
  const cases = [...source.matchAll(/^\s+case '([a-z-]+)':/gm)]
  const matchingCases = cases.filter((caseMatch) => caseMatch[1] === kind)
  if (matchingCases.length === 0)
    return { labels: ['UNCLASSIFIED (no adapter case)'], constants: [], dropped: false, classified: false }
  if (matchingCases.length > 1) throw new Error(`observations: adapter repeats case ${kind}`)
  const current = matchingCases[0]
  if (current === undefined) throw new Error(`observations: adapter case index disappeared for ${kind}`)
  const position = cases.indexOf(current)
  const start = current.index
  const end = cases[position + 1]?.index ?? source.indexOf('\n  }\n}', start)
  if (end < 0) throw new Error(`observations: could not delimit adapter case ${kind}`)
  const block = source.slice(start, end)
  const constants = unique([...block.matchAll(/ZEN_CUSTOM_EVENT_\w+/g)].map((match) => match[0]))
  const eventTypes = unique(
    [...block.matchAll(/EventType\.(\w+)/g)].map((match) => `EventType.${match[1] ?? ''}`),
  ).filter((eventType) => constants.length === 0 || eventType !== 'EventType.CUSTOM')
  const unknownConstants = constants.filter((constant) => !(constant in names))
  if (unknownConstants.length > 0)
    throw new Error(`observations: adapter uses undeclared custom names: ${unknownConstants.join(', ')}`)
  const labels = [...eventTypes, ...constants.map((constant) => names[constant] ?? `UNCLASSIFIED (${constant})`)]
  const dropped = /(?:return|\?)\s*\[\]/.test(block)
  if (dropped) labels.push('dropped')
  return {
    labels: labels.length === 0 ? ['UNCLASSIFIED (case has no recognized output)'] : labels,
    constants,
    dropped,
    classified: labels.length > 0,
  }
}

function generate(): string {
  const observationSource = readFileSync(join(ROOT, OBSERVATION_PATH), 'utf8')
  const mapperSource = readFileSync(join(ROOT, MAPPER_PATH), 'utf8')
  const followSource = readFileSync(join(ROOT, FOLLOW_PATH), 'utf8')
  const adapterSource = readFileSync(join(ROOT, ADAPTER_PATH), 'utf8')
  const customNamesSource = readFileSync(join(ROOT, CUSTOM_NAMES_PATH), 'utf8')
  const routerSource = readFileSync(join(ROOT, CUSTOM_ROUTER_PATH), 'utf8')
  const connectionSource = readFileSync(join(ROOT, FOLLOW_CONNECTION_PATH), 'utf8')

  const schemas = unionMembers(observationSource).map((schema) => schemaMember(observationSource, schema))
  const duplicateKinds = schemas.map(({ kind }) => kind).filter((kind, index, kinds) => kinds.indexOf(kind) !== index)
  if (duplicateKinds.length > 0)
    throw new Error(`observations: duplicate union kinds: ${unique(duplicateKinds).join(', ')}`)

  const mapperKinds = producedKinds(mapperSource)
  const promptRouteKinds = producedKinds(followSource)
  const names = customNames(customNamesSource)
  assertExactKeys('custom event', Object.keys(names), Object.keys(CUSTOM_METADATA))

  const emittedCustomConstants = new Set([
    ...[...adapterSource.matchAll(/name:\s*(ZEN_CUSTOM_EVENT_\w+)/g)].map((match) => match[1] ?? ''),
    ...[...connectionSource.matchAll(/name:\s*(ZEN_CUSTOM_EVENT_\w+)/g)].map((match) => match[1] ?? ''),
  ])
  const undeclaredEmissions = [...emittedCustomConstants].filter((constant) => !(constant in names))
  if (undeclaredEmissions.length > 0)
    throw new Error(`observations: emissions use undeclared custom names: ${undeclaredEmissions.join(', ')}`)

  for (const [constant, metadata] of Object.entries(CUSTOM_METADATA)) {
    const hasBranch = new RegExp(`eventType\\s*(?:===|!==)\\s*${constant}\\b`).test(routerSource)
    if (hasBranch !== metadata.routerBranch) {
      throw new Error(
        `observations: ${constant} router classification drifted; source=${hasBranch}, metadata=${metadata.routerBranch}`,
      )
    }
  }

  if (!/\{ type: 'observation', seq: frame\.seq, observation: frame\.observation \}/.test(followSource)) {
    throw new Error('observations: follow.ts no longer carries observations in observation frames')
  }
  const carrierOffset = followSource.indexOf("{ type: 'observation', seq: frame.seq, observation: frame.observation }")
  const carrierLine = lineAt(followSource, carrierOffset)
  const carrier = `[\`observation\` frame](../../${FOLLOW_PATH}#L${carrierLine})`

  const noProducer: string[] = []
  const rows = schemas
    .map((member) => {
      let producer = '**nothing produces it**'
      const mapperLine = mapperKinds.get(member.kind)
      const promptRouteLine = promptRouteKinds.get(member.kind)
      if (mapperLine !== undefined) producer = `[mapper](../../${MAPPER_PATH}#L${mapperLine})`
      else if (promptRouteLine !== undefined) producer = `[prompt route](../../${FOLLOW_PATH}#L${promptRouteLine})`
      else noProducer.push(member.kind)

      const adapter = adapterResult(adapterSource, member.kind, names)
      const consumers = unique([
        ...adapter.constants.map((constant) => CUSTOM_METADATA[constant]?.consumer ?? `UNCLASSIFIED (${constant})`),
        ...(adapter.labels.some((label) => label.startsWith('EventType.')) ? ['TanStack chat state'] : []),
        ...(adapter.dropped ? ['nothing consumes the dropped branch'] : []),
        ...(!adapter.classified ? ['UNCLASSIFIED'] : []),
      ])
      return {
        ...member,
        producer,
        adapter: adapter.labels
          .map((label) =>
            label.startsWith('EventType.') || label === 'dropped' || label.startsWith('UNCLASSIFIED')
              ? `\`${label}\``
              : `\`${label}\` (CUSTOM)`,
          )
          .join('<br>'),
        consumers: consumers.join('<br>'),
      }
    })
    .sort((left, right) => left.kind.localeCompare(right.kind))
    .map(
      (row) =>
        `| \`${row.kind}\` | [\`${row.schema}\`](../../${OBSERVATION_PATH}#L${row.line}) | ${row.producer} | ${carrier} | ${row.adapter} | ${row.consumers} |`,
    )

  const customWithoutEmission = Object.keys(names).filter((constant) => !emittedCustomConstants.has(constant))
  const emissionsWithoutRouter = [...emittedCustomConstants].filter(
    (constant) => CUSTOM_METADATA[constant]?.routerBranch === false,
  )
  const displayConstants = (constants: readonly string[]): string =>
    constants.length === 0
      ? 'none'
      : [...constants]
          .sort()
          .map((constant: string) => `\`${names[constant] ?? constant}\` (\`${constant}\`)`)
          .join(', ')

  return [
    '<!-- generated: scripts/docs/observations.ts -->',
    '# Observation inventory',
    '',
    'Generated from `ZenObservation`, the pi-event mapper, the prompt route, the follow carrier, the AG-UI adapter, all custom event names, their emitters, and the browser custom-event router.',
    '',
    '> Parser limitation: schemas must be direct identifiers in `ZenObservation = Type.Union([…])` and direct `Type.Object` declarations with one inline `kind` literal. Producers are recognized from object-literal `kind` fields. Adapter output recognizes `case` blocks, `EventType.*`, `ZEN_CUSTOM_EVENT_*`, and explicit empty-array branches; browser store semantics remain explicit checked metadata.',
    '',
    '| Kind | Schema | Producer | Follow carrier | Adapter emissions | Browser consumer / store |',
    '|---|---|---|---|---|---|',
    ...rows,
    '',
    '## Diagnostics',
    '',
    `- Schemas with no producer: ${
      noProducer.length === 0
        ? 'none'
        : noProducer
            .sort()
            .map((kind) => `\`${kind}\``)
            .join(', ')
    }`,
    `- Custom names with no emission: ${displayConstants(customWithoutEmission)}`,
    `- Emissions with no router branch: ${displayConstants(emissionsWithoutRouter)}`,
    '',
    `Inventory: ${schemas.length} union members; ${Object.keys(names).length} custom event constants; all custom constants have checked browser classifications.`,
    '',
  ].join('\n')
}

runGenerator('observations', generate)
