import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { findRepoRoot } from '../../packages/core/src/paths.ts'
import { PROCESS_ENVIRONMENT_READERS } from '../lint/process-environment.ts'
import { filesUnder } from '../source-tree.ts'
import { runGenerator } from './generator-support.ts'

/**
 * Generates `docs/reference/env-and-config.md` (#170): the explicit environment boundary,
 * the composed `EnsoConfig` shape, every `.enso/` path assembled by core, and the harness
 * manifest resources. Small source-shape parsers keep the inventory tied to the declarations;
 * the prose that source cannot supply (purpose, default, phase, writer, lifetime) is checked
 * metadata whose source occurrence must still exist.
 *
 * Blind spots, named: `isCommentedAt` is line-local and sees a `//` anywhere earlier on the
 * line as a comment, so a `process.env` read after a string containing `//` on the same line
 * would be skipped — no such line exists, and a skipped read shows up as "metadata without a
 * read" rather than vanishing; `NON_CODE` masks flat strings only, so a template with a nested
 * `${…}` string is unmasked and fails the field check instead of parsing wrong.
 */

const ROOT = findRepoRoot(import.meta.url)
const SOURCE_ROOTS = ['packages', 'scripts', 'test'] as const
const PROCESS_ENV_BASE = /\bprocess\s*\.\s*env\b/g
const PROCESS_ENV_CHILD_OVERRIDE = /\{\s*\.\.\.\s*process\s*\.\s*env\s*,\s*([A-Za-z_$][\w$]*)\s*:/g
/** A runtime path helper: a file under `ENSO_HOME` (#421), or the checkout's own build cache under `node_modules`. */
const RUNTIME_PATH_EXPORT =
  /export function (\w+)[^{]+\{\s*return join\((home|repoRoot, 'node_modules'), ((?:'[^']+'(?:, )?)+)\)\s*\}/g
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

function compareText(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

interface EnvironmentOccurrence {
  readonly key: string
  readonly source: string
}

interface EnvironmentScan {
  readonly occurrences: EnvironmentOccurrence[]
  readonly directFiles: string[]
}

interface EnvironmentMetadata extends EnvironmentOccurrence {
  readonly reader: string
  readonly purposeAndDefault: string
  readonly phase: 'boot' | 'load' | 'per-call' | 'build' | 'boot / load' | 'boot / load / per-call'
}

const ENVIRONMENT_METADATA: readonly EnvironmentMetadata[] = [
  {
    key: 'ENSO_SITE_URL',
    source: 'scripts/docs/site-base.ts',
    reader: '`scripts/docs/site-base.ts#SITE_URL` (module read)',
    purposeAndDefault:
      'Optional; the origin the site is served from, which Astro needs to emit a sitemap — without it `@astrojs/sitemap` skips at WARN and the build still succeeds. Defaults to the unresolvable `https://example.invalid` because a local build has no origin; the publish workflow sets the owner\u2019s Pages origin.',
    phase: 'build',
  },
  {
    key: 'ENSO_SITE_BASE',
    source: 'scripts/docs/site-base.ts',
    reader: '`scripts/docs/site-base.ts#SITE_BASE` (module read)',
    purposeAndDefault:
      'Optional; the path the documentation site is served under. Defaults to `/enso` for a local build. The publish workflow sets it to `/<repository>` — what a GitHub project site is served from — so the base is derived rather than a literal that rots on a rename.',
    phase: 'build',
  },
  {
    key: 'FORCE_COLOR',
    source: 'scripts/gate.ts',
    reader: '`scripts/gate.ts#runGate` (child environment write)',
    purposeAndDefault: 'Optional; set to `1` only when both gate output streams are TTYs, otherwise not overridden.',
    phase: 'per-call',
  },
  {
    key: 'PI_CODING_AGENT_DIR',
    source: 'packages/web/src/host/agent-host.ts',
    reader: '`packages/web/src/host/agent-host.ts#createAgentHost` (process write)',
    purposeAndDefault:
      'Required pin to the supplied scratch agent directory before pi loads; no fallback at this boundary.',
    phase: 'boot',
  },
  {
    key: 'PI_MULTI_ACCOUNT_INDEPENDENT_ROOTS',
    source: 'packages/web/src/host/agent-host.ts',
    reader: '`packages/web/src/host/agent-host.ts#createAgentHost` (process write)',
    purposeAndDefault:
      'Always `1` in the server: pi-multi-account (≥1.23.2) makes every in-process session an independent root with its own failover, instead of passive after the first (#351). Stays set — the extension reads it per session.',
    phase: 'boot',
  },
  {
    key: 'PI_CODING_AGENT_DIR',
    source: 'scripts/enso.ts',
    reader: '`scripts/enso.ts` (pi child environment write)',
    purposeAndDefault: 'Required pin to the selected agent directory in the spawned pi process.',
    phase: 'boot',
  },
  {
    key: 'ENSO_HOME',
    source: 'packages/core/src/paths.ts',
    reader: '`packages/core/src/paths.ts#ensoHome`',
    purposeAndDefault:
      'Optional user-level Enso directory (#421); an absent or empty value defaults to `~/.enso`. ' +
      "pi's agent dir, the secrets file, the logs and the project list all resolve under it.",
    phase: 'boot / load / per-call',
  },
  {
    key: 'ENSO_LOG_CONSOLE',
    source: 'packages/core/src/log-process.ts',
    reader: '`packages/core/src/log-process.ts#parseEnsoLogLevels`',
    purposeAndDefault:
      'Optional terminal log level; launcher default is `info`, while child-pi logging ' +
      'defaults to no console sink.',
    phase: 'boot / load',
  },
  {
    key: 'ENSO_LOG_LEVEL',
    source: 'packages/core/src/log-process.ts',
    reader: '`packages/core/src/log-process.ts#parseEnsoLogLevels`',
    purposeAndDefault: 'Optional file log level and per-category overrides; defaults to `info`.',
    phase: 'boot / load',
  },
  {
    key: 'ENSO_SERVER_URL',
    source: 'scripts/enso-logs.ts',
    reader: '`scripts/enso-logs.ts#bundle`',
    purposeAndDefault: 'Optional live-server URL for bundle retrieval; defaults to `http://127.0.0.1:5179`.',
    phase: 'per-call',
  },
  {
    key: 'ENSO_SERVER_URL',
    source: 'scripts/enso-thread.ts',
    reader: '`scripts/enso-thread.ts`',
    purposeAndDefault: 'Optional live-server URL for thread inspection; defaults to `http://127.0.0.1:5179`.',
    phase: 'boot',
  },
  {
    key: 'npm_config_user_agent',
    source: 'scripts/gate.ts',
    reader: '`scripts/gate.ts#detectPackageManager`',
    purposeAndDefault: 'Optional package-manager identity; falls back to Bun detection, then `npm`.',
    phase: 'boot',
  },
]

interface SourceCheck {
  readonly file: string
  readonly contains: string
}

interface ConfigFieldMetadata {
  readonly field: string
  readonly required: 'yes' | 'no'
  readonly defaultWhenOmitted: string
  readonly reader: string
  readonly check: SourceCheck
}

const WEB_SEARCH_SOURCE = 'packages/harness/extensions/web-search/index.ts'

/** A `webSearch` field: optional, read in the extension's source, proven there by `contains`. */
function webSearchField(
  suffix: string,
  defaultWhenOmitted: string,
  contains: string,
  readerSymbol = 'createWebSearch',
): ConfigFieldMetadata {
  return {
    field: `webSearch${suffix}`,
    required: 'no',
    defaultWhenOmitted,
    reader: `\`${WEB_SEARCH_SOURCE}#${readerSymbol}\``,
    check: { file: WEB_SEARCH_SOURCE, contains },
  }
}

const CONFIG_FIELD_METADATA: readonly ConfigFieldMetadata[] = [
  {
    field: 'webFetch',
    required: 'no',
    defaultWhenOmitted: 'An empty allowlist: nothing is fetchable.',
    reader: '`packages/harness/extensions/web-fetch/index.ts#createWebFetch`',
    check: {
      file: 'packages/harness/extensions/web-fetch/index.ts',
      contains: 'parsed.config.webFetch?.allowedHosts ?? []',
    },
  },
  {
    field: 'webFetch.allowedHosts',
    required: 'yes',
    defaultWhenOmitted: 'n/a — required once `webFetch` is present; `[]` fetches nothing.',
    reader: '`packages/harness/extensions/web-fetch/index.ts#createWebFetch`',
    check: {
      file: 'packages/harness/extensions/web-fetch/index.ts',
      contains: 'parsed.config.webFetch?.allowedHosts ?? []',
    },
  },
  {
    field: 'projects',
    required: 'no',
    defaultWhenOmitted: 'No roots: the launch directory is the only project, and registering another is refused.',
    reader: '`packages/web/src/server/dev.ts` → `startEnsoServer({ projectRoots })`',
    check: { file: 'packages/web/src/server/dev.ts', contains: 'config.config.projects?.roots ?? []' },
  },
  {
    field: 'projects.roots',
    required: 'yes',
    defaultWhenOmitted:
      'n/a — absolute or `~/` paths; a page may register a project only strictly under one (#395), and a root taken out hides the projects under it',
    reader: '`packages/web/src/server/projects.ts#createProjectRegistry`',
    check: {
      file: 'packages/web/src/server/projects.ts',
      contains: 'is not an absolute or ~/ path — fix ENSO_HOME/config.json',
    },
  },
  webSearchField('', '`{}`; current-model routing with no Tavily domain filters.', 'parsed.config.webSearch ?? {}'),
  webSearchField(
    '.backend',
    'Current-model routing; only `"deepseek"` pins the dedicated backend.',
    "webSearchConfig.backend === 'deepseek'",
    'runPrimary',
  ),
  webSearchField('.tavily', 'No Tavily domain filters.', 'webSearchConfig.tavily?.includeDomains'),
  webSearchField(
    '.tavily.excludeDomains',
    'Omitted from the Tavily request.',
    'webSearchConfig.tavily?.excludeDomains',
  ),
  webSearchField(
    '.tavily.includeDomains',
    'Omitted from the Tavily request.',
    'webSearchConfig.tavily?.includeDomains',
  ),
]

interface RuntimePathMetadata {
  readonly helper: string
  readonly path: string
  readonly writer: string
  readonly lifetime: string
  readonly check: SourceCheck
}

const RUNTIME_PATH_METADATA: readonly RuntimePathMetadata[] = [
  {
    helper: 'printHarnessDir',
    path: 'node_modules/.cache/enso/print-harness',
    writer:
      '`scripts/print-harness.ts#materializePrintHarness` rebuilds the package mirror ' +
      'for non-interactive launches.',
    lifetime: 'Per-checkout build cache (its links point into this checkout); reconciled on every print launch.',
    check: { file: 'scripts/print-harness.ts', contains: 'export function materializePrintHarness' },
  },
  {
    helper: 'ensoAgentDir',
    path: 'ENSO_HOME/pi-agent',
    writer:
      'The TUI/server launchers create it; pi and `createAgentHost` write settings, auth, ' +
      'sessions, and the multi-account pin.',
    lifetime: 'Per-user state shared by every checkout and launch; retained until the operator removes it.',
    check: {
      file: 'packages/web/src/host/agent-host.ts',
      contains: 'seedMultiAccountChildProxyOff(agentDir)',
    },
  },
  {
    helper: 'ensoLogsDir',
    path: 'ENSO_HOME/logs',
    writer: '`configureProcessLogging` creates it and every harness process appends to the day file.',
    lifetime: 'One file per local day; logging retains 14 days.',
    check: { file: 'packages/core/src/log-process.ts', contains: 'const KEEP_DAYS = 14' },
  },
  {
    helper: 'ensoProjectsPath',
    path: 'ENSO_HOME/projects.json',
    writer: 'The web server, when a page registers or removes a project (#395); written whole and renamed over.',
    lifetime: 'Per-user until a project is removed; entries outside the configured roots are kept but not served.',
    check: { file: 'packages/web/src/server/projects.ts', contains: 'renameSync(staging, statePath)' },
  },
  {
    helper: 'ensoSecretsPath',
    path: 'ENSO_HOME/secrets.env',
    writer: 'Operator only; harness code reads and quarantines but never writes it.',
    lifetime: 'Per-user until the operator edits or removes it; secret reads are per call.',
    check: { file: 'packages/core/src/secrets.ts', contains: 'readDotenvFile(ensoSecretsPath(home)).get(name)' },
  },
]

/**
 * Enough lexical masking for the current TypeBox declarations: comments and flat strings.
 * Nested template expressions are outside the declared parser shape and fail field checks.
 */
const NON_CODE = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g

function addOccurrence(found: Map<string, EnvironmentOccurrence>, key: string, source: string): void {
  if (!IDENTIFIER.test(key)) return
  found.set(`${key}\0${source}`, { key, source })
}

function scanObjectReads(
  sourceText: string,
  objectName: string,
  source: string,
  found: Map<string, EnvironmentOccurrence>,
): void {
  const dot = new RegExp(`(?<![\\w$.])${objectName}\\s*\\.\\s*([A-Za-z_$][\\w$]*)`, 'g')
  for (const match of sourceText.matchAll(dot)) {
    if (isCommentedAt(sourceText, match.index ?? 0)) continue
    addOccurrence(found, match[1] ?? '', source)
  }
  const bracket = new RegExp(`(?<![\\w$.])${objectName}\\s*\\[\\s*(['"])([A-Za-z_$][\\w$]*)\\1\\s*\\]`, 'g')
  for (const match of sourceText.matchAll(bracket)) {
    if (isCommentedAt(sourceText, match.index ?? 0)) continue
    addOccurrence(found, match[2] ?? '', source)
  }
  const destructuring = new RegExp(`\\{([^{}]+)\\}\\s*=\\s*${objectName}\\b`, 'g')
  for (const match of sourceText.matchAll(destructuring)) {
    const objectIndex = (match.index ?? 0) + match[0].lastIndexOf(objectName)
    if (isCommentedAt(sourceText, objectIndex)) continue
    for (const property of (match[1] ?? '').split(',')) {
      addOccurrence(found, property.split(':')[0]?.trim() ?? '', source)
    }
  }
}

function importedEnvironmentAliases(sourceText: string): string[] {
  const aliases: string[] = []
  const importPattern = /import\s*\{([^}]*)\}\s*from\s*(['"])node:process\2/g
  for (const match of sourceText.matchAll(importPattern)) {
    if (isCommentedAt(sourceText, match.index ?? 0)) continue
    for (const specifier of (match[1] ?? '').split(',')) {
      const imported = /^\s*env(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(specifier)
      if (imported) aliases.push(imported[1] ?? 'env')
    }
  }
  return aliases
}

/** Current source shapes put environment mentions in ordinary comments, never regex-generated code. */
function isCommentedAt(source: string, index: number): boolean {
  const lineStart = source.lastIndexOf('\n', index) + 1
  if (source.slice(lineStart, index).includes('//')) return true
  return source.lastIndexOf('/*', index) > source.lastIndexOf('*/', index)
}

function scanEnvironment(): EnvironmentScan {
  const found = new Map<string, EnvironmentOccurrence>()
  const directFiles = new Set<string>()
  const files = SOURCE_ROOTS.flatMap((sourceRoot) => filesUnder(join(ROOT, sourceRoot))).sort()
  for (const path of files) {
    const source = relative(ROOT, path).replaceAll('\\', '/')
    const sourceText = readFileSync(path, 'utf8')
    if (scanProcessEnvironmentReads(sourceText, source, found)) directFiles.add(source)
    for (const alias of importedEnvironmentAliases(sourceText)) {
      directFiles.add(source)
      scanObjectReads(sourceText, alias, source, found)
    }
    const isTestSource = source.includes('/__tests__/') || source.startsWith('test/')
    const declaresEnvironmentSeam = /\benvironment\s*:\s*(?:Readonly<)?Record<string,\s*string\s*\|\s*undefined>/.test(
      sourceText,
    )
    if (!isTestSource && declaresEnvironmentSeam) scanObjectReads(sourceText, 'environment', source, found)
  }
  return {
    occurrences: [...found.values()].sort(
      (left, right) => compareText(left.key, right.key) || compareText(left.source, right.source),
    ),
    directFiles: [...directFiles].sort(),
  }
}

/** Every literal `process.env` read in one file — dot, bracket, destructuring, child-override; true when the file touches it directly. */
function scanProcessEnvironmentReads(
  sourceText: string,
  source: string,
  found: Map<string, EnvironmentOccurrence>,
): boolean {
  const directBases = [...sourceText.matchAll(PROCESS_ENV_BASE)].filter(
    (match) => !isCommentedAt(sourceText, match.index ?? 0),
  )
  for (const base of directBases) {
    const tail = sourceText.slice((base.index ?? 0) + base[0].length)
    const dot = /^\s*\.\s*([A-Za-z_$][\w$]*)/.exec(tail)
    const bracket = /^\s*\[\s*(['"])([A-Za-z_$][\w$]*)\1\s*\]/.exec(tail)
    addOccurrence(found, dot?.[1] ?? bracket?.[2] ?? '', source)
  }
  const destructuring = /\{([^{}]+)\}\s*=\s*process\s*\.\s*env\b/g
  for (const match of sourceText.matchAll(destructuring)) {
    const processIndex = (match.index ?? 0) + match[0].lastIndexOf('process')
    if (isCommentedAt(sourceText, processIndex)) continue
    for (const property of (match[1] ?? '').split(',')) {
      addOccurrence(found, property.split(':')[0]?.trim() ?? '', source)
    }
  }
  for (const match of sourceText.matchAll(PROCESS_ENV_CHILD_OVERRIDE)) {
    const processIndex = (match.index ?? 0) + match[0].indexOf('process')
    if (!isCommentedAt(sourceText, processIndex)) addOccurrence(found, match[1] ?? '', source)
  }
  return directBases.length > 0
}

function sameRows(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function assertEnvironmentInventory(scan: EnvironmentScan): void {
  const allowlist = [...PROCESS_ENVIRONMENT_READERS].sort()
  if (!sameRows(scan.directFiles, allowlist)) {
    const detectedOnly = scan.directFiles.filter((file) => !allowlist.includes(file))
    const allowlistOnly = allowlist.filter((file) => !scan.directFiles.includes(file))
    throw new Error(
      `direct environment readers and the process-environment allowlist (scripts/lint/process-environment.ts) diverge; ` +
        `detected only: ${detectedOnly.join(', ') || '(none)'}; ` +
        `allowlist only: ${allowlistOnly.join(', ') || '(none)'}`,
    )
  }
  const discovered = scan.occurrences.map((row) => `${row.key}\0${row.source}`).sort()
  const classified = ENVIRONMENT_METADATA.map((row) => `${row.key}\0${row.source}`).sort()
  if (!sameRows(discovered, classified)) {
    const unclassified = discovered.filter((row) => !classified.includes(row)).map((row) => row.replace('\0', ' @ '))
    const stale = classified.filter((row) => !discovered.includes(row)).map((row) => row.replace('\0', ' @ '))
    throw new Error(
      `environment metadata differs from explicit source reads; ` +
        `UNCLASSIFIED: ${unclassified.join(', ') || '(none)'}; ` +
        `metadata without a read: ${stale.join(', ') || '(none)'}`,
    )
  }
}

function objectDeclaration(source: string, name: string): string {
  const marker = `export const ${name} = Type.Object(`
  const start = source.indexOf(marker)
  if (start === -1) throw new Error(`could not find Type.Object declaration ${name}`)
  const mask = source.replaceAll(NON_CODE, (nonCode) => ' '.repeat(nonCode.length))
  const open = source.indexOf('(', start)
  let depth = 0
  for (let characterIndex = open; characterIndex < source.length; characterIndex += 1) {
    if (mask[characterIndex] === '(') depth += 1
    else if (mask[characterIndex] === ')') {
      depth -= 1
      if (depth === 0) return source.slice(start, characterIndex + 1)
    }
  }
  throw new Error(`could not find the end of Type.Object declaration ${name}`)
}

function objectFields(source: string, name: string, prefix = ''): string[] {
  const declaration = objectDeclaration(source, name)
  const matches = [...declaration.matchAll(/^(\s+)([A-Za-z_$][\w$]*):\s*(?:Type\.|[A-Za-z_$][\w$]*)/gm)]
  const minimumIndent = Math.min(...matches.map((match) => (match[1] ?? '').length))
  const parents: { indent: number; name: string }[] = []
  const fields: string[] = []
  for (const match of matches) {
    const indent = (match[1] ?? '').length
    const field = match[2] ?? ''
    while ((parents.at(-1)?.indent ?? -1) >= indent) parents.pop()
    fields.push(`${prefix}${parents.map((parent) => `${parent.name}.`).join('')}${field}`)
    parents.push({ indent, name: field })
  }
  if (!Number.isFinite(minimumIndent)) throw new Error(`${name} declares no fields`)
  return fields
}

function assertSourceCheck(check: SourceCheck): void {
  if (!readFileSync(join(ROOT, check.file), 'utf8').includes(check.contains)) {
    throw new Error(`checked metadata probe missing: ${check.file} must contain ${JSON.stringify(check.contains)}`)
  }
}

function configInventory(): { fields: ConfigFieldMetadata[] } {
  const configSource = readFileSync(join(ROOT, 'packages/core/src/config.ts'), 'utf8')
  const webFetchSource = readFileSync(join(ROOT, 'packages/core/src/web-fetch.ts'), 'utf8')
  const webSearchSource = readFileSync(join(ROOT, 'packages/core/src/web-search.ts'), 'utf8')
  const projectSource = readFileSync(join(ROOT, 'packages/core/src/project.ts'), 'utf8')
  const discovered = [
    ...objectFields(configSource, 'EnsoConfig'),
    ...objectFields(webFetchSource, 'WebFetchConfig', 'webFetch.'),
    ...objectFields(webSearchSource, 'WebSearchConfig', 'webSearch.'),
    ...objectFields(projectSource, 'EnsoProjectsConfig', 'projects.'),
  ].sort()
  const metadata = [...CONFIG_FIELD_METADATA].sort((left, right) => compareText(left.field, right.field))
  const classified = metadata.map((row) => row.field)
  if (!sameRows(discovered, classified)) {
    const unclassified = discovered.filter((field) => !classified.includes(field))
    const stale = classified.filter((field) => !discovered.includes(field))
    throw new Error(
      `EnsoConfig metadata differs from schema; UNCLASSIFIED: ${unclassified.join(', ') || '(none)'}; ` +
        `metadata without a field: ${stale.join(', ') || '(none)'}`,
    )
  }
  for (const row of metadata) assertSourceCheck(row.check)
  return { fields: metadata }
}

function runtimePathInventory(): RuntimePathMetadata[] {
  const pathSource = readFileSync(join(ROOT, 'packages/core/src/paths.ts'), 'utf8')
  const discovered = [...pathSource.matchAll(RUNTIME_PATH_EXPORT)]
    .map((match) => ({
      helper: match[1] ?? '',
      path: `${match[2] === 'home' ? 'ENSO_HOME' : 'node_modules'}/${(match[3] ?? '').replaceAll("'", '').split(', ').join('/')}`,
    }))
    .sort((left, right) => compareText(left.path, right.path))
  const metadata = [...RUNTIME_PATH_METADATA].sort((left, right) => compareText(left.path, right.path))
  if (
    !sameRows(
      discovered.map((row) => `${row.helper}\0${row.path}`),
      metadata.map((row) => `${row.helper}\0${row.path}`),
    )
  ) {
    throw new Error('runtime path metadata differs from the exports assembled in packages/core/src/paths.ts')
  }
  for (const row of metadata) assertSourceCheck(row.check)
  return metadata
}

type ResourceKind = 'extensions' | 'skills' | 'prompts' | 'themes'
const RESOURCE_KINDS: readonly ResourceKind[] = ['extensions', 'skills', 'prompts', 'themes']

interface ManifestResource {
  readonly kind: ResourceKind
  readonly order: number
  readonly path: string
}

function manifestResources(): ManifestResource[] {
  const manifest: unknown = JSON.parse(readFileSync(join(ROOT, 'packages/harness/package.json'), 'utf8'))
  if (typeof manifest !== 'object' || manifest === null || !('pi' in manifest)) {
    throw new Error('packages/harness/package.json has no pi manifest')
  }
  const pi: unknown = manifest.pi
  if (typeof pi !== 'object' || pi === null) {
    throw new Error('packages/harness/package.json pi manifest is not an object')
  }
  const resources: ManifestResource[] = []
  for (const kind of RESOURCE_KINDS) {
    const paths: unknown = (pi as Record<string, unknown>)[kind]
    if (!Array.isArray(paths) || paths.some((path) => typeof path !== 'string')) {
      throw new Error(`packages/harness/package.json pi.${kind} must be a string array`)
    }
    for (const [pathIndex, path] of paths.entries()) resources.push({ kind, order: pathIndex + 1, path: String(path) })
  }
  return resources
}

function tableText(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ')
}

function generate(): string {
  const environment = scanEnvironment()
  assertEnvironmentInventory(environment)
  const config = configInventory()
  const runtimePaths = runtimePathInventory()
  const resources = manifestResources()
  const environmentRows = [...ENVIRONMENT_METADATA]
    .sort((left, right) => compareText(left.key, right.key) || compareText(left.reader, right.reader))
    .map((row) => `| \`${row.key}\` | ${row.reader} | ${tableText(row.purposeAndDefault)} | ${row.phase} |`)
  const configRows = config.fields.map(
    (row) => `| \`${row.field}\` | ${row.required} | ${tableText(row.defaultWhenOmitted)} | ${row.reader} |`,
  )
  const pathRows = runtimePaths.map(
    (row) => `| \`${row.path}\` | \`${row.helper}\` | ${tableText(row.writer)} | ${tableText(row.lifetime)} |`,
  )
  const resourceRows = resources.map((row) => {
    const origin = row.path.startsWith('node_modules/') ? '**vendor path**' : 'repository path'
    return `| ${row.kind} | ${row.order} | \`${row.path}\` | ${origin} |`
  })
  return [
    '<!-- generated: scripts/docs/env-and-config.ts -->',
    '# Environment and configuration reference',
    '',
    'Generated from the owned source roots, `scripts/lint/process-environment.ts`, the core config/path declarations,',
    'and `packages/harness/package.json`. No machine environment and no user config is read.',
    '',
    '## Explicit environment keys',
    '',
    `The ${environment.directFiles.length} files that directly touch the process environment exactly match the`,
    '`node/no-process-env` exception list in `scripts/lint/process-environment.ts`; generation fails if either side gains or loses a file.',
    'Rows cover literal dot access, literal bracket access, destructuring, `node:process` `env` imports,',
    'grounded `environment.KEY` seams, and keys explicitly written beside a process-environment spread.',
    '',
    '| Key | Reader | Purpose, requirement, and default | Phase |',
    '|---|---|---|---|',
    ...environmentRows,
    '',
    '**Parser limit.** Only literal keys in the source shapes named above become rows. Computed names and',
    'whole-environment quarantine/pass-through operations have no concrete key to report; adding a new literal',
    'shape or a literal without checked metadata fails generation as `UNCLASSIFIED` rather than being omitted.',
    '',
    '## `EnsoConfig` schema',
    '',
    "The user's `ENSO_HOME/config.json` (#421). No file at all is every default below. A file that is there is strict",
    'on unknown keys and fails closed when unreadable. Defaults are consumer behavior when an optional field is omitted;',
    'required fields have no schema default.',
    '',
    '| Field | Required | Default when omitted | Reader |',
    '|---|---|---|---|',
    ...configRows,
    '',
    "**Parser limit.** The schema reader handles this repository's current `Type.Object` / `Type.Optional`",
    'declaration layout in `config.ts`, `web-fetch.ts`, and `web-search.ts`; metadata and consumer probes must',
    'match every discovered field or generation fails.',
    '',
    '## Runtime paths',
    '',
    "Every runtime path helper in `packages/core/src/paths.ts`: the user's state under `ENSO_HOME` (`~/.enso` by default, #421), and the checkout's own build cache.",
    '',
    '| Path | Assembler | Writer | Lifetime |',
    '|---|---|---|---|',
    ...pathRows,
    '',
    '## Harness manifest resources',
    '',
    'Generated from the `pi` manifest. Extension order is declaration order and is deliberately not sorted;',
    'the other resource arrays are also shown in declared order. A vendor path is any path rooted at',
    '`node_modules/`; repository paths are package-local.',
    '',
    '| Kind | Declared order | Path | Origin |',
    '|---|---:|---|---|',
    ...resourceRows,
    '',
  ].join('\n')
}

runGenerator('env-and-config', generate)
