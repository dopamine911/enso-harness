import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { findRepoRoot } from '../../packages/core/src/paths.ts'
import { assertExactKeys, runGenerator } from './generator-support.ts'

/**
 * Generates `docs/reference/observations.md`: every member of `EnsoObservation`, its producer,
 * follow carrier, browser adapter emissions, and browser-side destination. Extraction follows
 * this repository's deliberately simple declaration and switch shapes.
 */

const ROOT = findRepoRoot(import.meta.url)
export const OBSERVATION_PATH = 'packages/core/src/observation.ts'
export const MAPPER_PATH = 'packages/web/src/host/map-events.ts'
const FOLLOW_PATH = 'packages/web/src/server/follow.ts'
export const ADAPTER_PATH = 'packages/web/src/to-agui.ts'
export const CUSTOM_ROUTER_PATH = 'packages/web/src/custom-event-router.ts'
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
  'session-usage': {
    consumer:
      "`recentChunks`; `usage` (the status bar's cost and context meter, #45); clears `refusal` once output grows (#340)",
    routerBranch: true,
  },
  'branch-compacted': {
    consumer: "`recentChunks`; `branchCompacted` (the pane re-reads the thread's messages once idle, #348)",
    routerBranch: true,
  },
  login: {
    consumer: '`recentChunks`; `login` (the composer offers Stop for a login waiting on its provider, #348)',
    routerBranch: true,
  },
  queue: { consumer: '`recentChunks`; `queue`', routerBranch: true },
  'dialog-settled': { consumer: '`recentChunks`; `dialog`', routerBranch: true },
  'permission-mode': { consumer: '`recentChunks`; `permissionMode`; `modeLines`', routerBranch: true },
  'permission-mode-rejected': { consumer: '`recentChunks`; `notifications` (a warning)', routerBranch: true },
  'provider-refused': {
    consumer: "`recentChunks`; `notifications` (an error); `refusal` (the status bar's class word, #340)",
    routerBranch: true,
  },
  'provider-retry': { consumer: '`recentChunks`; `notifications` (a warning, #340)', routerBranch: true },
  'provider-retry-ended': {
    consumer: '`recentChunks`; `notifications` (an error, when no retry got through — #380 review)',
    routerBranch: true,
  },
  model: {
    consumer: '`recentChunks`; `model` (the composer chip and thinking level, #338 slice 2)',
    routerBranch: true,
  },
  'custom-entry': {
    consumer:
      '`recentChunks`; a refusal (`enso-guard-denial` #387, `enso-permission-denial` #523) lands in `refusals`; a stopped run (`enso-run-stopped` #766) is one `notifications` line and counts in `runStops` — every other entry is rendered by nothing (L3)',
    routerBranch: true,
  },
  unmapped: { consumer: '`recentChunks` only; nothing else consumes it', routerBranch: false },
}

/**
 * The chunks that are not observations: the follow's frames, named by `EnsoFollowFrame.type`
 * and carried whole, and the adapter's own `follow-ended`. Checked against the adapter's
 * `name: frame.type` push and the router's `eventType === '<name>'` branches.
 */
const FRAME_METADATA: Record<string, string> = {
  snapshot:
    "`recentChunks`; `permissionMode`; `modeLines`; `model`; `cwd`; `usage`; `refusal` (the status bar's class word off the branch's last reply, #381); `dialog` (the complete open list); `notifications` and `runStops` (a line after each stop not yet said, #766); `generation`; `disconnected`",
  status: '`recentChunks`; `generation`; `disconnected`',
  'follow-ended': '`recentChunks`; `disconnected`; `notifications`',
}

export interface SchemaMember {
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

export function unionMembers(source: string): string[] {
  const union = /export const EnsoObservation = Type\.Union\(\[([\s\S]*?)\n\]\)/.exec(source)
  if (union?.[1] === undefined) throw new Error('observations: could not find the EnsoObservation union')
  const members = union[1]
    .split('\n')
    .map((line) => line.trim().replace(/,$/, ''))
    .filter((line) => /^[A-Za-z_$][\w$]*$/.test(line))
  if (members.length !== new Set(members).size) throw new Error('observations: EnsoObservation repeats a schema member')
  return members
}

export function schemaMember(source: string, schema: string): SchemaMember {
  const declaration = `export const ${schema} = Type.Object(`
  const offset = source.indexOf(declaration)
  if (offset < 0) throw new Error(`observations: union member ${schema} is not a direct Type.Object schema`)
  const nextDeclaration = source.indexOf('\nexport const ', offset + declaration.length)
  const block = source.slice(offset, nextDeclaration < 0 ? source.length : nextDeclaration)
  const kinds = [...block.matchAll(/kind: Type\.Literal\('([a-z-]+)'\)/g)].map((match) => match[1] ?? '')
  if (kinds.length !== 1) throw new Error(`observations: ${schema} has ${kinds.length} inline kind literals`)
  return { schema, kind: kinds[0] ?? '', line: lineAt(source, offset) }
}

export function producedKinds(source: string): Map<string, number> {
  const kinds = new Map<string, number>()
  for (const match of source.matchAll(/\bkind: '([a-z-]+)'/g)) {
    const kind = match[1] ?? ''
    if (!kinds.has(kind)) kinds.set(kind, lineAt(source, match.index))
  }
  return kinds
}

/**
 * Kinds the follow writer ELIDES instead of writing (#279), by the `writeFrame` guard that
 * does it: `tool-result` frames that are not complete carry pi's ACCUMULATED output, which
 * the browser's adapter discards. Keyed by kind, valued by the guard's line and the field
 * that decides it, so the carrier column says what the wire actually does — and so removing
 * the guard changes this page.
 */
function elidedKinds(source: string): Map<string, { line: number; field: string }> {
  const elided = new Map<string, { line: number; field: string }>()
  const guard = /frame\.observation\.kind === '([a-z-]+)' && !frame\.observation\.(\w+)\) return/g
  for (const match of source.matchAll(guard)) {
    elided.set(match[1] ?? '', { line: lineAt(source, match.index), field: match[2] ?? '' })
  }
  return elided
}

/**
 * What the AG-UI adapter's `case '<kind>':` block emits for `kind`: its `EventType.*` events, the
 * kind itself when it rides CUSTOM, `dropped` for an empty-array branch. A kind with no case, or a
 * case with no recognized output, is labelled UNCLASSIFIED rather than refused: the page reports it.
 */
export function adapterResult(source: string, kind: string): AdapterResult {
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

export function observationsPage(): string {
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
  assertCustomRouting(adapterSource, routerSource)
  assertFrameChunks(connectionSource, routerSource)
  const carrier = observationCarrier(followSource)
  const elided = elidedKinds(followSource)

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
      const producer = producerCell(member.kind, mapperKinds, promptRouteKinds)
      if (producer === undefined) noProducer.push(member.kind)
      const adapter = adapterResults.get(member.kind) ?? adapterResult(adapterSource, member.kind)
      const consumers = unique([
        ...(adapter.custom ? [CUSTOM_METADATA[member.kind]?.consumer ?? `UNCLASSIFIED (${member.kind})`] : []),
        ...(adapter.labels.some((label) => label.startsWith('EventType.')) ? ['TanStack chat state'] : []),
        ...(adapter.dropped ? ['nothing consumes the dropped branch'] : []),
        ...(!adapter.classified ? ['UNCLASSIFIED'] : []),
      ])
      // The cell is the finding, so the cell is the test: an unclassified adapter has already
      // put `UNCLASSIFIED` in `consumers` above, and a `!adapter.classified` disjunct here only
      // restates that.
      if (consumers.some((consumer) => consumer.startsWith('UNCLASSIFIED'))) unclassified.push(member.kind)
      return {
        ...member,
        producer: producer ?? '**nothing produces it**',
        carrier: carrierCell(carrier, elided.get(member.kind)),
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
    .toSorted((left, right) => left.kind.localeCompare(right.kind))
    .map(
      (row) =>
        `| \`${row.kind}\` | [\`${row.schema}\`](../../${OBSERVATION_PATH}#L${row.line}) | ${row.producer} | ${row.carrier} | ${row.adapter} | ${row.consumers} |`,
    )

  const recordedOnly = customKinds.filter((kind) => CUSTOM_METADATA[kind]?.routerBranch === false).toSorted()
  const frameRows = Object.entries(FRAME_METADATA).map(
    ([name, consumer]) =>
      `| \`${name}\` | ${name === 'follow-ended' ? `the adapter, when the follow closes under the page ([\`follow-connection.ts\`](../../${FOLLOW_CONNECTION_PATH}))` : `the follow's \`${name}\` frame, whole ([\`follow.ts\`](../../packages/core/src/follow.ts))`} | ${consumer} |`,
  )

  return [
    '<!-- generated: scripts/docs/observations.ts -->',
    '# Observation inventory',
    '',
    'Generated from `EnsoObservation`, the pi-event mapper, the prompt route, the follow carrier, the AG-UI adapter and the browser chunk router. One vocabulary (#162 workstream 5): a CUSTOM chunk is named by the observation `kind` (or the frame `type`) it carries whole.',
    '',
    "> Parser limitation: schemas must be direct identifiers in `EnsoObservation = Type.Union([…])` and direct `Type.Object` declarations with one inline `kind` literal. Producers are recognized from object-literal `kind` fields. Adapter output recognizes `case` blocks, `EventType.*`, `custom(observation)` and explicit empty-array branches; router branches are `case '<kind>':` lines; browser store semantics remain explicit checked metadata.",
    '',
    'A carrier marked **ELIDED** does not reach the browser in that state (#279): the observation is still numbered, still logged at `trace` and still counted in the `emitted` tail of `/api/threads/:id/events`, but no frame is written — the adapter emission for that state is `dropped`, so the bytes would be serialised and schema-checked for nothing. The `sent` tail claims only what crossed, and frame `seq` skips the elided numbers.',
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
    `- Schemas with no producer: ${noProducer.length === 0 ? 'none' : codeList(noProducer.toSorted())}`,
    `- CUSTOM kinds the router records but does not route: ${recordedOnly.length === 0 ? 'none' : codeList(recordedOnly)}`,
    `- Kinds with an unclassified cell: ${
      unclassified.length === 0
        ? 'none'
        : `${codeList(unclassified.toSorted())} — a finding, not a generation failure: the kind is printed, never omitted`
    }`,
    '',
    `Inventory: ${schemas.length} union members; ${customKinds.length} ride CUSTOM by kind; ${Object.keys(FRAME_METADATA).length} chunks that are not observations; every chunk name has a checked browser classification.`,
    '',
  ].join('\n')
}

/** The adapter names each CUSTOM chunk by its kind, and every metadata kind's router branch is where the metadata says. */
function assertCustomRouting(adapterSource: string, routerSource: string): void {
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
}

/** The frame chunks: the connection pushes each frame named by its type; the router branches on each. */
function assertFrameChunks(connectionSource: string, routerSource: string): void {
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
}

/** The link to the `observation` frame `follow.ts` carries every observation in. */
function observationCarrier(followSource: string): string {
  if (!/\{ type: 'observation', seq: frame\.seq, observation: frame\.observation \}/.test(followSource)) {
    throw new Error('observations: follow.ts no longer carries observations in observation frames')
  }
  const carrierOffset = followSource.indexOf("{ type: 'observation', seq: frame.seq, observation: frame.observation }")
  const carrierLine = lineAt(followSource, carrierOffset)
  return `[\`observation\` frame](../../${FOLLOW_PATH}#L${carrierLine})`
}

/** The mapper's line producing `kind`, else the prompt route's; `undefined` when nothing produces it. */
function producerCell(
  kind: string,
  mapperKinds: ReadonlyMap<string, number>,
  promptRouteKinds: ReadonlyMap<string, number>,
): string | undefined {
  const mapperLine = mapperKinds.get(kind)
  if (mapperLine !== undefined) return `[mapper](../../${MAPPER_PATH}#L${mapperLine})`
  const promptRouteLine = promptRouteKinds.get(kind)
  if (promptRouteLine !== undefined) return `[prompt route](../../${FOLLOW_PATH}#L${promptRouteLine})`
  return undefined
}

/** The follow carrier, marked ELIDED with the guard's line when the follow writer drops the kind in some state (#279). */
function carrierCell(carrier: string, elision: { line: number; field: string } | undefined): string {
  if (elision === undefined) return carrier
  return `${carrier} — [ELIDED](../../${FOLLOW_PATH}#L${elision.line}) while \`${elision.field}: false\``
}

/** Kinds as a comma-separated list of code spans. */
function codeList(kinds: readonly string[]): string {
  return kinds.map((kind) => `\`${kind}\``).join(', ')
}

// Importable: `flow-diagrams.ts` reuses these extractors and `build-docs.ts#generatedPage` calls
// `observationsPage` (#832); importing must not print a page.
if (import.meta.main) runGenerator('observations', observationsPage)
