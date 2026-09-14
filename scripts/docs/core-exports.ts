import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, sep as pathSeparator, relative, resolve } from 'node:path'
import { findRepoRoot } from '../../packages/core/src/index.ts'

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
const LOG_PROCESS = join(CORE_SOURCE, 'log-process.ts')

type Classification = 'wire' | 'host contract' | 'config/policy' | 'node-only utility'
type Region = 'web/host' | 'web/server' | 'web/browser' | 'harness' | 'scripts'
type Kind = 'type' | 'value'

const REGIONS: readonly Region[] = ['web/host', 'web/server', 'web/browser', 'harness', 'scripts']

/** Checked by `exportsOf`: a newly public module cannot acquire a classification by accident. */
const CLASSIFICATION_BY_MODULE: Readonly<Record<string, Classification>> = {
  'config.ts': 'config/policy',
  'dialog.ts': 'wire',
  'follow.ts': 'wire',
  'guard.ts': 'config/policy',
  'log.ts': 'wire',
  'log-bundle.ts': 'node-only utility',
  'log-process.ts': 'node-only utility',
  'observation.ts': 'wire',
  'paths.ts': 'node-only utility',
  'permission-mode.ts': 'config/policy',
  'secrets.ts': 'node-only utility',
  'thread-inspection.ts': 'wire',
  'thread-runtime.ts': 'host contract',
  'tool-result.ts': 'wire',
  'web-fetch.ts': 'config/policy',
  'web-search.ts': 'config/policy',
}

/** Glossary sections, assigned by module rather than inferred from symbol spelling. */
const DOMAIN_BY_MODULE: Readonly<Record<string, string>> = {
  'config.ts': 'Record, Permission',
  'dialog.ts': 'Control',
  'follow.ts': 'Control, Observation',
  'guard.ts': 'Permission',
  'log.ts': 'Record',
  'log-bundle.ts': 'Record',
  'log-process.ts': 'Record',
  'observation.ts': 'Observation',
  'paths.ts': 'Project vocabulary',
  'permission-mode.ts': 'Permission',
  'secrets.ts': 'Permission',
  'thread-inspection.ts': 'Thread, Observation',
  'thread-runtime.ts': 'Thread, Control',
  'tool-result.ts': 'Surface, Observation',
  'web-fetch.ts': 'Permission, Control',
  'web-search.ts': 'Permission, Control',
}

interface PublicExport {
  readonly symbol: string
  readonly kind: Kind
  readonly module: string
  readonly entrypoint: '@zen/core' | '@zen/core/log-process'
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
  const classification = CLASSIFICATION_BY_MODULE[module]
  const domain = DOMAIN_BY_MODULE[module]
  if (classification === undefined) throw new Error(`${module} has no classification`)
  if (domain === undefined) throw new Error(`${module} has no glossary domain`)
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
      exports.push(checkedExport(specifier.symbol, specifier.kind, module, '@zen/core'))
    }
  }
  return exports
}

function subpathExports(source: string): PublicExport[] {
  const exports: PublicExport[] = []
  const declaration = /^export\s+(?:async\s+)?(const|let|type|interface|function|class|enum)\s+([$A-Z_a-z][$\w]*)\b/gm
  for (const match of source.matchAll(declaration)) {
    const keyword = match[1] ?? ''
    const symbol = match[2] ?? ''
    exports.push(
      checkedExport(
        symbol,
        keyword === 'type' || keyword === 'interface' ? 'type' : 'value',
        'log-process.ts',
        '@zen/core/log-process',
      ),
    )
  }
  return exports
}

function exportsOf(): PublicExport[] {
  const exports = [...barrelExports(readFileSync(BARREL, 'utf8')), ...subpathExports(readFileSync(LOG_PROCESS, 'utf8'))]
  const seen = new Set<string>()
  const detectedModules = new Set<string>()
  for (const item of exports) {
    const key = `${item.entrypoint}:${item.symbol}`
    if (seen.has(key)) throw new Error(`duplicate public export ${key}`)
    seen.add(key)
    detectedModules.add(item.module)
  }
  if (exports.length === 0) throw new Error('no public core exports detected')
  for (const module of Object.keys(CLASSIFICATION_BY_MODULE)) {
    if (!detectedModules.has(module)) throw new Error(`${module} is classified but exports no public symbol`)
  }
  for (const module of Object.keys(DOMAIN_BY_MODULE)) {
    if (!detectedModules.has(module)) throw new Error(`${module} has a glossary domain but exports no public symbol`)
  }
  return exports.sort(
    (left, right) => left.symbol.localeCompare(right.symbol) || left.entrypoint.localeCompare(right.entrypoint),
  )
}

function sourceFiles(directory: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...sourceFiles(path))
    else if (/\.(?:[cm]?[jt]sx?)$/.test(entry.name) && !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name))
      files.push(path)
  }
  return files
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
  if (specifier === '@zen/core') return '@zen/core'
  if (specifier === '@zen/core/log-process') return '@zen/core/log-process'
  if (!specifier.startsWith('.')) return undefined
  const target = resolve(dirname(importer), specifier)
  if (target === BARREL) return '@zen/core'
  if (target === LOG_PROCESS) return '@zen/core/log-process'
  return undefined
}

function importerCounts(exports: readonly PublicExport[]): Map<string, Readonly<Record<Region, number>>> {
  const counts = new Map<string, Record<Region, number>>()
  for (const item of exports)
    counts.set(
      `${item.entrypoint}:${item.symbol}`,
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
const rows = publicExports.map((item) => {
  const modulePath = `../../packages/core/src/${item.module}`
  const declaration = `${modulePath}#L${item.declarationLine}`
  const imported = counts.get(`${item.entrypoint}:${item.symbol}`)
  if (imported === undefined) throw new Error(`no importer counts for ${item.symbol}`)
  return `| \`${item.symbol}\` | ${item.kind} | \`${item.entrypoint}\` | [\`${item.module}\`](${modulePath}) | ${linkDomain(item.domain)} | ${item.classification} | ${REGIONS.map((region) => imported[region]).join(' | ')} | [L${item.declarationLine}](${declaration}) |`
})

process.stdout.write(
  [
    '<!-- generated: scripts/docs/core-exports.ts -->',
    '# Core exports',
    '',
    'Generated from the named re-export blocks in `packages/core/src/index.ts`, the top-level exports',
    'of `packages/core/src/log-process.ts`, and static named imports in production source. Counts are',
    'importing files, not reference occurrences; tests are excluded. `web/browser` is web source outside',
    '`host/` and `server/` (including `rpc/`). The generator recognizes `@zen/core`,',
    '`@zen/core/log-process`, and relative imports resolving to those entrypoints.',
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
