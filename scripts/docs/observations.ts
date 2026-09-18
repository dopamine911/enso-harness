import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { findRepoRoot } from '../../packages/core/src/paths.ts'
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
const ADAPTER_PATH = 'packages/web/src/to-agui.ts'
const CUSTOM_ROUTER_PATH = 'packages/web/src/custom-event-router.ts'
const FOLLOW_CONNECTION_PATH = 'packages/web/src/follow-connection.ts'

interface CustomMetadata {
  readonly consumer: string
  readonly routerBranch: boolean
}

/**
 * Browser destinations, by the chunk's name — which is the observation's `kind` (#162
 * workstream 5). Checked against the adapter's `custom(observation)` emissions and the
 * router's `case '<kind>':` branches, both directions, so a kind that gains or loses a
 * branch fails here rather than drifting.
 */
const CUSTOM_METADATA: Record<string, CustomMetadata> = {
  'extension-ui-request': {
    consumer:
      '`recentChunks`; `dialog` (a blocking question; or `notifications` if unreadable); `notifications` (a notify)',
    routerBranch: true,
  },
  'message-end': { consumer: '`recentChunks`; `stats`', routerBranch: true },
  queue: { consumer: '`recentChunks`; `queue`', routerBranch: true },
  'dialog-settled': { consumer: '`recentChunks`; `dialog`', routerBranch: true },
  'permission-mode': { consumer: '`recentChunks`; `permissionMode`; `modeLines`', routerBranch: true },
  'permission-mode-rejected': { consumer: '`recentChunks`; `notifications` (a warning)', routerBranch: true },
  'custom-entry': {
    consumer: '`recentChunks` only; recorded and counted, rendered by nothing (L3)',
    routerBranch: false,
  },
  unmapped: { consumer: '`recentChunks` only; nothing else consumes it', routerBranch: false },
}

/**
 * The chunks that are not observations: the follow's frames, named by `ZenFollowFrame.type`
 * and carried whole, and the adapter's own `follow-ended`. Checked against the adapter's
 * `name: frame.type` push and the router's `eventType === '<name>'` branches.
 */
const FRAME_METADATA: Record<string, string> = {
  snapshot:
    '`recentChunks`; `permissionMode`; `modeLines`; `dialog` (the complete open list); `generation`; `disconnected`',
  status: '`recentChunks`; `generation`; `disconnected`',
  'follow-ended': '`recentChunks`; `disconnected`; `notifications`',
}

interface SchemaMember {
  readonly schema: string
  readonly kind: string
  readonly line: number
}

interface AdapterResult {
  readonly labels: readonly string[]
  readonly custom: boolean
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

function adapterResult(source: string, kind: string): AdapterResult {
  const cases = [...source.matchAll(/^\s+case '([a-z-]+)':/gm)]
  const matchingCases = cases.filter((caseMatch) => caseMatch[1] === kind)
  if (matchingCases.length === 0)
    return { labels: ['UNCLASSIFIED (no adapter case)'], custom: false, dropped: false, classified: false }
  if (matchingCases.length > 1) throw new Error(`observations: adapter repeats case ${kind}`)
  const current = matchingCases[0]
  if (current === undefined) throw new Error(`observations: adapter case index disappeared for ${kind}`)
  const position = cases.indexOf(current)
  const start = current.index
  const end = cases[position + 1]?.index ?? source.indexOf('\n  }\n}', start)
  if (end < 0) throw new Error(`observations: could not delimit adapter case ${kind}`)
  const block = source.slice(start, end)
  // `custom(observation)` is the one way an observation rides CUSTOM: named by its kind.
  const custom = /\bcustom\(observation\)/.test(block)
  if (custom && /EventType\.CUSTOM/.test(block))
    throw new Error(`observations: adapter case ${kind} spells CUSTOM twice`)
  const eventTypes = unique([...block.matchAll(/EventType\.(\w+)/g)].map((match) => `EventType.${match[1] ?? ''}`))
  const labels = [...eventTypes, ...(custom ? [kind] : [])]
  const dropped = /(?:return|\?)\s*\[\]/.test(block)
  if (dropped) labels.push('dropped')
  return {
    labels: labels.length === 0 ? ['UNCLASSIFIED (case has no recognized output)'] : labels,
    custom,
    dropped,
    classified: labels.length > 0,
  }
}

function generate(): string {
  const observationSource = readFileSync(join(ROOT, OBSERVATION_PATH), 'utf8')
  const mapperSource = readFileSync(join(ROOT, MAPPER_PATH), 'utf8')
  const followSource = readFileSync(join(ROOT, FOLLOW_PATH), 'utf8')
  const adapterSource = readFileSync(join(ROOT, ADAPTER_PATH), 'utf8')
  const routerSource = readFileSync(join(ROOT, CUSTOM_ROUTER_PATH), 'utf8')
  const connectionSource = readFileSync(join(ROOT, FOLLOW_CONNECTION_PATH), 'utf8')

  const schemas = unionMembers(observationSource).map((schema) => schemaMember(observationSource, schema))
  const duplicateKinds = schemas.map(({ kind }) => kind).filter((kind, index, kinds) => kinds.indexOf(kind) !== index)
  if (duplicateKinds.length > 0)
    throw new Error(`observations: duplicate union kinds: ${unique(duplicateKinds).join(', ')}`)

  const mapperKinds = producedKinds(mapperSource)
  const promptRouteKinds = producedKinds(followSource)
  // The kinds the adapter puts on CUSTOM are exactly the metadata's keys, both directions.
  const adapterResults = new Map(schemas.map((member) => [member.kind, adapterResult(adapterSource, member.kind)]))
  const customKinds = [...adapterResults].filter(([, result]) => result.custom).map(([kind]) => kind)
  assertExactKeys('custom chunk kind', customKinds, Object.keys(CUSTOM_METADATA))
  if (!/name: observation\.kind, value: observation/.test(adapterSource)) {
    throw new Error('observations: to-agui.ts no longer names a CUSTOM chunk by the observation kind')
  }
  for (const [kind, metadata] of Object.entries(CUSTOM_METADATA)) {
    const hasBranch = new RegExp(`^\\s+case '${kind}':`, 'm').test(routerSource)
    if (hasBranch !== metadata.routerBranch) {
      throw new Error(
        `observations: ${kind} router classification drifted; source=${hasBranch}, metadata=${metadata.routerBranch}`,
      )
    }
  }

  // The frame chunks: the connection pushes each frame named by its type; the router branches on each.
  if (!/name: frame\.type, value: frame/.test(connectionSource)) {
    throw new Error('observations: follow-connection.ts no longer pushes frames named by their type')
  }
  if (
    !(
      /name: FOLLOW_ENDED_CUSTOM_EVENT/.test(connectionSource) &&
      /FOLLOW_ENDED_CUSTOM_EVENT = 'follow-ended'/.test(routerSource)
    )
  ) {
    throw new Error('observations: the follow-ended chunk is not declared by the router and pushed by the connection')
  }
  for (const chunkName of Object.keys(FRAME_METADATA)) {
    const branch =
      chunkName === 'follow-ended' ? 'eventType === FOLLOW_ENDED_CUSTOM_EVENT' : `eventType === '${chunkName}'`
    if (!routerSource.includes(branch)) {
      throw new Error(`observations: the router has no branch for the ${chunkName} chunk`)
    }
  }

  if (!/\{ type: 'observation', seq: frame\.seq, observation: frame\.observation \}/.test(followSource)) {
    throw new Error('observations: follow.ts no longer carries observations in observation frames')
  }
  const carrierOffset = followSource.indexOf("{ type: 'observation', seq: frame.seq, observation: frame.observation }")
  const carrierLine = lineAt(followSource, carrierOffset)
  const carrier = `[\`observation\` frame](../../${FOLLOW_PATH}#L${carrierLine})`

  const noProducer: string[] = []
  // An unclassified cell is a FINDING here, not a generation failure (`docs/reference/README.md`,
  // and the observation seam's fence). `decisions.ts` and `env-and-config.ts` throw because an
  // unclassified row there means their metadata and their detector disagree, and the page would be
  // wrong. Here it means the repository grew a kind the adapter does not handle: the page saying so,
  // in a line the docs gate compares byte-for-byte, is the report. Collected so the finding is at the
  // bottom of the page and not only buried in one cell of one row.
  const unclassified: string[] = []
  const rows = schemas
    .map((member) => {
      let producer = '**nothing produces it**'
      const mapperLine = mapperKinds.get(member.kind)
      const promptRouteLine = promptRouteKinds.get(member.kind)
      if (mapperLine !== undefined) producer = `[mapper](../../${MAPPER_PATH}#L${mapperLine})`
      else if (promptRouteLine !== undefined) producer = `[prompt route](../../${FOLLOW_PATH}#L${promptRouteLine})`
      else noProducer.push(member.kind)

      const adapter = adapterResults.get(member.kind) ?? adapterResult(adapterSource, member.kind)
      const consumers = unique([
        ...(adapter.custom ? [CUSTOM_METADATA[member.kind]?.consumer ?? `UNCLASSIFIED (${member.kind})`] : []),
        ...(adapter.labels.some((label) => label.startsWith('EventType.')) ? ['TanStack chat state'] : []),
        ...(adapter.dropped ? ['nothing consumes the dropped branch'] : []),
        ...(!adapter.classified ? ['UNCLASSIFIED'] : []),
      ])
      if (!adapter.classified || consumers.some((consumer) => consumer.startsWith('UNCLASSIFIED')))
        unclassified.push(member.kind)
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

  const recordedOnly = customKinds.filter((kind) => CUSTOM_METADATA[kind]?.routerBranch === false).sort()
  const frameRows = Object.entries(FRAME_METADATA).map(
    ([name, consumer]) =>
      `| \`${name}\` | ${name === 'follow-ended' ? `the adapter, when the follow closes under the page ([\`follow-connection.ts\`](../../${FOLLOW_CONNECTION_PATH}))` : `the follow's \`${name}\` frame, whole ([\`follow.ts\`](../../packages/core/src/follow.ts))`} | ${consumer} |`,
  )

  return [
    '<!-- generated: scripts/docs/observations.ts -->',
    '# Observation inventory',
    '',
    'Generated from `ZenObservation`, the pi-event mapper, the prompt route, the follow carrier, the AG-UI adapter and the browser chunk router. One vocabulary (#162 workstream 5): a CUSTOM chunk is named by the observation `kind` (or the frame `type`) it carries whole.',
    '',
    "> Parser limitation: schemas must be direct identifiers in `ZenObservation = Type.Union([…])` and direct `Type.Object` declarations with one inline `kind` literal. Producers are recognized from object-literal `kind` fields. Adapter output recognizes `case` blocks, `EventType.*`, `custom(observation)` and explicit empty-array branches; router branches are `case '<kind>':` lines; browser store semantics remain explicit checked metadata.",
    '',
    '| Kind | Schema | Producer | Follow carrier | Adapter emissions | Browser consumer / store |',
    '|---|---|---|---|---|---|',
    ...rows,
    '',
    '## Chunks that are not observations',
    '',
    '| Chunk | Carries | Browser consumer / store |',
    '|---|---|---|',
    ...frameRows,
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
    `- CUSTOM kinds the router records but does not route: ${recordedOnly.length === 0 ? 'none' : recordedOnly.map((kind) => `\`${kind}\``).join(', ')}`,
    `- Kinds with an unclassified cell: ${
      unclassified.length === 0
        ? 'none'
        : `${unclassified
            .sort()
            .map((kind) => `\`${kind}\``)
            .join(', ')} — a finding, not a generation failure: the kind is printed, never omitted`
    }`,
    '',
    `Inventory: ${schemas.length} union members; ${customKinds.length} ride CUSTOM by kind; ${Object.keys(FRAME_METADATA).length} chunks that are not observations; every chunk name has a checked browser classification.`,
    '',
  ].join('\n')
}

runGenerator('observations', generate)
