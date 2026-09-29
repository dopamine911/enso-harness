import { readFileSync } from 'node:fs'
import { dirname, join, sep as pathSeparator, relative, resolve } from 'node:path'
import { findRepoRoot } from '../../packages/core/src/paths.ts'
import { filesUnder } from '../source-tree.ts'

/**
 * Generates `docs/reference/core-exports.md` (#170): the public core barrel and the
 * node-only logging subpath, with their defining declarations and production importers.
 * `test/docs-gate.test.ts` keeps the page equal to this output.
 *
 * This deliberately parses only this repository's current, boring source shapes: named
 * `export { … } from './module.ts'` blocks, top-level declarations in the subpath, and
 * static named imports. Star/default exports, dynamic imports, `require`, and string
 * references are not imports and are not guessed.
 */

const ROOT = findRepoRoot(import.meta.url)
const CORE_SOURCE = join(ROOT, 'packages/core/src')
const BARREL = join(CORE_SOURCE, 'index.ts')
/**
 * The node-only subpaths (#211): declared in package.json `exports`, never on the barrel, so
 * the browser graph cannot reach `node:*` through `@enso/core`. Each is read like the barrel is.
 */
const SUBPATH_MODULES: readonly { readonly file: string; readonly entrypoint: SubpathEntrypoint }[] = [
  { file: 'git.ts', entrypoint: '@enso/core/git' },
  { file: 'log-process.ts', entrypoint: '@enso/core/log-process' },
  { file: 'paths.ts', entrypoint: '@enso/core/paths' },
  { file: 'pi-manifest.ts', entrypoint: '@enso/core/pi-manifest' },
  { file: 'secrets.ts', entrypoint: '@enso/core/secrets' },
]
type SubpathEntrypoint =
  | '@enso/core/git'
  | '@enso/core/log-process'
  | '@enso/core/paths'
  | '@enso/core/pi-manifest'
  | '@enso/core/secrets'

type Classification = 'wire' | 'host contract' | 'config/policy' | 'node-only utility'
type Region = 'web/host' | 'web/server' | 'web/browser' | 'harness' | 'scripts'
type Kind = 'type' | 'value'

const REGIONS: readonly Region[] = ['web/host', 'web/server', 'web/browser', 'harness', 'scripts']

/**
 * Per public module: its classification, and the glossary sections it belongs to — assigned by
 * module rather than inferred from symbol spelling. One row each, so a module cannot gain one
 * without the other. Checked by `exportsOf`: a newly public module cannot acquire either by
 * accident, and a row for a module that exports nothing is refused.
 */
const MODULE_FACTS: Readonly<Record<string, readonly [classification: Classification, domain: string]>> = {
  'ask-user.ts': ['wire', 'Control'],
  'config.ts': ['config/policy', 'Record, Permission'],
  'dialog.ts': ['wire', 'Control'],
  'follow.ts': ['wire', 'Control, Observation'],
  'git.ts': ['node-only utility', 'Project vocabulary'],
  'git-state.ts': ['wire', 'Thread, Observation'],
  'guard.ts': ['config/policy', 'Permission'],
  'log.ts': ['wire', 'Record'],
  'log-bundle.ts': ['node-only utility', 'Record'],
  'log-process.ts': ['node-only utility', 'Record'],
  'log-stats.ts': ['wire', 'Record, Observation'],
  'log-tail.ts': ['wire', 'Record, Observation'],
  'observation.ts': ['wire', 'Observation'],
  'paths.ts': ['node-only utility', 'Project vocabulary'],
  'pi-manifest.ts': ['node-only utility', 'Project vocabulary'],
  'permission-mode.ts': ['config/policy', 'Permission'],
  'project.ts': ['wire', 'Thread, Permission'],
  'provider-refusal.ts': ['wire', 'Observation, Record'],
  'run-context.ts': ['wire', 'Thread, Record'],
  'secrets.ts': ['node-only utility', 'Permission'],
  'session-eval.ts': ['wire', 'Thread, Record'],
  'thread-inspection.ts': ['wire', 'Thread, Observation'],
  'thread-timeline.ts': ['wire', 'Thread, Observation, Record'],
  'thread-context.ts': ['wire', 'Thread, Observation'],
  'thread-stats.ts': ['wire', 'Thread, Observation, Record'],
  'thread-runtime.ts': ['host contract', 'Thread, Control'],
  'tool-input.ts': ['wire', 'Surface'],
  'tool-result.ts': ['wire', 'Surface, Observation'],
  'transcript.ts': ['wire', 'Thread, Record'],
  'web-fetch.ts': ['config/policy', 'Permission, Control'],
  'web-search.ts': ['config/policy', 'Permission, Control'],
}

interface PublicExport {
  readonly symbol: string
  readonly kind: Kind
  readonly module: string
  readonly entrypoint: '@enso/core' | SubpathEntrypoint
  readonly declarationLine: number
  readonly classification: Classification
  readonly domain: string
}

function namedSpecifiers(body: string, allTypes = false): { symbol: string; kind: Kind }[] {
  return body
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const isType = allTypes || part.startsWith('type ')
      const withoutType = part.replace(/^type\s+/, '')
      const symbol = withoutType.split(/\s+as\s+/)[0]?.trim() ?? ''
      if (!/^[$A-Z_a-z][$\w]*$/.test(symbol)) throw new Error(`unsupported named specifier: ${JSON.stringify(part)}`)
      return { symbol, kind: isType ? 'type' : 'value' }
    })
}

function declarationLine(source: string, symbol: string, module: string): number {
  const declaration = new RegExp(
    `^export\\s+(?:async\\s+)?(?:const|let|type|interface|function|class|enum)\\s+${symbol}\\b`,
  )
  const line = source.split('\n').findIndex((candidate) => declaration.test(candidate))
  if (line === -1) throw new Error(`${module} has no top-level declaration for ${symbol}`)
  return line + 1
}

function checkedExport(
  symbol: string,
  kind: Kind,
  module: string,
  entrypoint: PublicExport['entrypoint'],
): PublicExport {
  const facts = MODULE_FACTS[module]
  if (facts === undefined) throw new Error(`${module} has no classification and glossary domain`)
  const [classification, domain] = facts
  const path = join(CORE_SOURCE, module)
  return {
    symbol,
    kind,
    module,
    entrypoint,
    declarationLine: declarationLine(readFileSync(path, 'utf8'), symbol, module),
    classification,
    domain,
  }
}

function barrelExports(source: string): PublicExport[] {
  const exports: PublicExport[] = []
  const blocks = source.matchAll(/^export\s*{([\s\S]*?)}\s*from\s*['"]\.\/([^'"]+)['"]\s*$/gm)
  for (const block of blocks) {
    const body = block[1] ?? ''
    const module = block[2] ?? ''
    for (const specifier of namedSpecifiers(body)) {
      exports.push(checkedExport(specifier.symbol, specifier.kind, module, '@enso/core'))
    }
  }
  return exports
}

function subpathExports(source: string, module: string, entrypoint: SubpathEntrypoint): PublicExport[] {
  const exports: PublicExport[] = []
  const declaration = /^export\s+(?:async\s+)?(const|let|type|interface|function|class|enum)\s+([$A-Z_a-z][$\w]*)\b/gm
  for (const match of source.matchAll(declaration)) {
    const keyword = match[1] ?? ''
    const symbol = match[2] ?? ''
    exports.push(
      checkedExport(symbol, keyword === 'type' || keyword === 'interface' ? 'type' : 'value', module, entrypoint),
    )
  }
  return exports
}

function exportsOf(): PublicExport[] {
  const exports = [
    ...barrelExports(readFileSync(BARREL, 'utf8')),
    ...SUBPATH_MODULES.flatMap((subpath) =>
      subpathExports(readFileSync(join(CORE_SOURCE, subpath.file), 'utf8'), subpath.file, subpath.entrypoint),
    ),
  ]
  const seen = new Set<string>()
  const detectedModules = new Set<string>()
  for (const publicExport of exports) {
    const key = `${publicExport.entrypoint}:${publicExport.symbol}`
    if (seen.has(key)) throw new Error(`duplicate public export ${key}`)
    seen.add(key)
    detectedModules.add(publicExport.module)
  }
  if (exports.length === 0) throw new Error('no public core exports detected')
  for (const module of Object.keys(MODULE_FACTS)) {
    if (!detectedModules.has(module)) throw new Error(`${module} is classified but exports no public symbol`)
  }
  return exports.sort(
    (left, right) => left.symbol.localeCompare(right.symbol) || left.entrypoint.localeCompare(right.entrypoint),
  )
}

/** Production modules only: no `__tests__`, no `.test`/`.spec` files. */
function sourceFiles(directory: string): string[] {
  return filesUnder(directory, {
    skipDirectories: ['__tests__'],
    keep: (name: string): boolean => !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(name),
  })
}

function regionOf(path: string): Region | undefined {
  const repoPath = relative(ROOT, path).split(pathSeparator).join('/')
  if (repoPath.startsWith('packages/web/src/host/')) return 'web/host'
  if (repoPath.startsWith('packages/web/src/server/')) return 'web/server'
  if (repoPath.startsWith('packages/web/src/')) return 'web/browser'
  if (repoPath.startsWith('packages/harness/')) return 'harness'
  if (repoPath.startsWith('scripts/')) return 'scripts'
  return undefined
}

function importedEntrypoint(importer: string, specifier: string): PublicExport['entrypoint'] | undefined {
  if (specifier === '@enso/core') return '@enso/core'
  const bySpecifier = SUBPATH_MODULES.find((subpath) => subpath.entrypoint === specifier)
  if (bySpecifier !== undefined) return bySpecifier.entrypoint
  if (!specifier.startsWith('.')) return undefined
  const target = resolve(dirname(importer), specifier)
  if (target === BARREL) return '@enso/core'
  const byFile = SUBPATH_MODULES.find((subpath) => join(CORE_SOURCE, subpath.file) === target)
  return byFile?.entrypoint
}

function importerCounts(exports: readonly PublicExport[]): Map<string, Readonly<Record<Region, number>>> {
  const counts = new Map<string, Record<Region, number>>()
  for (const publicExport of exports)
    counts.set(
      `${publicExport.entrypoint}:${publicExport.symbol}`,
      Object.fromEntries(REGIONS.map((region) => [region, 0])) as Record<Region, number>,
    )

  const roots = [join(ROOT, 'packages/web/src'), join(ROOT, 'packages/harness'), join(ROOT, 'scripts')]
  for (const path of roots.flatMap(sourceFiles).sort()) {
    if (path === join(ROOT, 'scripts/docs/core-exports.ts')) continue
    const region = regionOf(path)
    if (region === undefined) continue
    const source = readFileSync(path, 'utf8')
    const importedHere = new Set<string>()
    const imports = source.matchAll(/^import\s+(type\s+)?{([\s\S]*?)}\s+from\s+['"]([^'"]+)['"]\s*;?$/gm)
    for (const statement of imports) {
      const entrypoint = importedEntrypoint(path, statement[3] ?? '')
      if (entrypoint === undefined) continue
      for (const specifier of namedSpecifiers(statement[2] ?? '', statement[1] !== undefined)) {
        const key = `${entrypoint}:${specifier.symbol}`
        const symbolCounts = counts.get(key)
        if (symbolCounts === undefined) throw new Error(`${relative(ROOT, path)} imports non-public ${key}`)
        if (importedHere.has(key)) continue
        importedHere.add(key)
        symbolCounts[region] += 1
      }
    }
  }
  return counts
}

function linkDomain(domains: string): string {
  return domains
    .split(', ')
    .map((domain) => `[${domain}](../glossary.md#${domain.toLowerCase().replaceAll(' ', '-')})`)
    .join(', ')
}

const publicExports = exportsOf()
const counts = importerCounts(publicExports)
const rows = publicExports.map((publicExport) => {
  const modulePath = `../../packages/core/src/${publicExport.module}`
  const declaration = `${modulePath}#L${publicExport.declarationLine}`
  const imported = counts.get(`${publicExport.entrypoint}:${publicExport.symbol}`)
  if (imported === undefined) throw new Error(`no importer counts for ${publicExport.symbol}`)
  return `| \`${publicExport.symbol}\` | ${publicExport.kind} | \`${publicExport.entrypoint}\` | [\`${publicExport.module}\`](${modulePath}) | ${linkDomain(publicExport.domain)} | ${publicExport.classification} | ${REGIONS.map((region) => imported[region]).join(' | ')} | [L${publicExport.declarationLine}](${declaration}) |`
})

process.stdout.write(
  [
    '<!-- generated: scripts/docs/core-exports.ts -->',
    '# Core exports',
    '',
    'Generated from the named re-export blocks in `packages/core/src/index.ts`, the top-level exports',
    'of `packages/core/src/log-process.ts`, and static named imports in production source. Counts are',
    'importing files, not reference occurrences; tests are excluded. `web/browser` is web source outside',
    '`host/` and `server/`. The generator recognizes `@enso/core`,',
    '`@enso/core/log-process`, and relative imports resolving to those entrypoints.',
    '',
    'Parser limits: named static imports and named re-export blocks only. Default/star exports, dynamic',
    'imports, `require`, namespace imports, and string references do not count. Classification and',
    'glossary domain are checked records keyed by defining module; a new or unknown module makes generation fail.',
    '',
    '| Symbol | Kind | Entrypoint | Defining module | Glossary domain | Classification | web/host | web/server | web/browser | harness | scripts | Source declaration |',
    '|---|---|---|---|---|---|---:|---:|---:|---:|---:|---|',
    ...rows,
    '',
  ].join('\n'),
)
