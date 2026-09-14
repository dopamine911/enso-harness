import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { findRepoRoot } from '../../packages/core/src/index.ts'

/**
 * Generates `docs/seams/observation-kinds.md` (#168): one row per observation kind — the
 * schema that declares it, whether the mapper produces it, and what the browser adapter
 * turns it into. Read from the source, never written by hand: the union in
 * `observation.ts`, the `kind:` literals the mapper returns, the `case` blocks of the
 * adapter. `test/docs-gate.test.ts` keeps the page equal to this output.
 *
 * A kind the union declares but the mapper never returns is printed as such — that is a
 * finding, not an error; the reader decides.
 */

const ROOT = findRepoRoot(import.meta.url)
const OBSERVATION = join(ROOT, 'packages/core/src/observation.ts')
const MAPPER = join(ROOT, 'packages/web/src/rpc/map-events.ts')
/** The one producer beside the mapper: the prompt route announces a rejection itself (#112). */
const PROMPT_ROUTE = join(ROOT, 'packages/web/src/server/follow.ts')
const ADAPTER = join(ROOT, 'packages/web/src/rpc/to-agui.ts')
const CUSTOM_NAMES = join(ROOT, 'packages/web/src/rpc/custom-event-names.ts')

interface Kind {
  readonly kind: string
  readonly schema: string
}

/** `export const <Schema> = Type.Object({ … kind: Type.Literal('<kind>') … })`, in declaration order. */
function declaredKinds(source: string): Kind[] {
  const kinds: Kind[] = []
  let schema = ''
  for (const line of source.split('\n')) {
    const declaration = /^export const (\w+) = Type\.Object\(/.exec(line)
    if (declaration) schema = declaration[1] ?? ''
    const literal = /kind: Type\.Literal\('([a-z-]+)'\)/.exec(line)
    if (literal) kinds.push({ kind: literal[1] ?? '', schema })
  }
  return kinds
}

function mappedKinds(source: string): Set<string> {
  return new Set([...source.matchAll(/\bkind: '([a-z-]+)'/g)].map((match) => match[1] ?? ''))
}

/** Per `case '<kind>':` block of the adapter's switch, the `EventType.*` and `ZEN_CUSTOM_EVENT_*` names it emits. */
function adapterEmissions(source: string): Map<string, string[]> {
  const emissions = new Map<string, string[]>()
  let current: string | undefined
  for (const line of source.split('\n')) {
    const caseLine = /^\s+case '([a-z-]+)':/.exec(line)
    if (caseLine) {
      current = caseLine[1]
      emissions.set(current ?? '', [])
      continue
    }
    if (current === undefined) continue
    for (const match of line.matchAll(/EventType\.(\w+)|(ZEN_CUSTOM_EVENT_\w+)/g)) {
      const name = match[1] ? `\`${match[1]}\`` : `\`${match[2]}\``
      const list = emissions.get(current) ?? []
      if (!list.includes(name)) list.push(name)
      emissions.set(current, list)
    }
  }
  return emissions
}

function customNames(source: string): Map<string, string> {
  return new Map(
    [...source.matchAll(/export const (ZEN_CUSTOM_EVENT_\w+) = '([^']+)'/g)].map((match) => [
      match[1] ?? '',
      match[2] ?? '',
    ]),
  )
}

const kinds = declaredKinds(readFileSync(OBSERVATION, 'utf8'))
const mapped = mappedKinds(readFileSync(MAPPER, 'utf8'))
const announced = mappedKinds(readFileSync(PROMPT_ROUTE, 'utf8'))
const emissions = adapterEmissions(readFileSync(ADAPTER, 'utf8'))
const names = customNames(readFileSync(CUSTOM_NAMES, 'utf8'))

const rows = kinds.map(({ kind, schema }) => {
  const emitted = (emissions.get(kind) ?? []).map((emission) => {
    const constant = emission.slice(1, -1)
    const wire = names.get(constant)
    return wire === undefined ? emission : `\`${wire}\``
  })
  let adapter = '— (no case: falls through)'
  if (emissions.has(kind)) adapter = emitted.length > 0 ? emitted.join(', ') : 'dropped (no chunk)'
  let producer = '**nothing produces it**'
  if (mapped.has(kind)) producer = 'the mapper'
  else if (announced.has(kind)) producer = 'the prompt route (`follow.ts`)'
  return `| \`${kind}\` | \`${schema}\` | ${producer} | ${adapter} |`
})

process.stdout.write(
  [
    '<!-- generated: scripts/docs/observation-kinds.ts -->',
    '# Observation kinds',
    '',
    'Generated from `packages/core/src/observation.ts` (the union), `packages/web/src/rpc/map-events.ts`',
    '(the mapper), `packages/web/src/server/follow.ts` (the one route that announces an observation',
    'itself) and `packages/web/src/rpc/to-agui.ts` (the browser adapter). One row per kind the union',
    'declares. "Adapter emits" is what the state layer sees for that kind — an `EventType.*` stream',
    'event, or a custom event by its wire name.',
    '',
    '| Kind | Schema | Produced by | Adapter emits |',
    '|---|---|---|---|',
    ...rows,
    '',
  ].join('\n'),
)
