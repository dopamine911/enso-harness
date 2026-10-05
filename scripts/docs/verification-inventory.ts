import { readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import fallowConfig from '../../.fallowrc.jsonc'
import { findRepoRoot } from '../../packages/core/src/paths.ts'
import { filesUnder } from '../source-tree.ts'
import { detectedExceptionConstants, numericConstant, stringArray, stringConstant } from './gate-source.ts'
import { assertExactKeys, runGenerator } from './generator-support.ts'

/**
 * Generates `docs/reference/verification-inventory.md` (#170): enforcement gates, the
 * numeric and count ratchets they carry, and the deliberately reusable test doubles.
 * `test/docs-gate.test.ts` keeps the checked-in page equal to this output.
 *
 * The constants the page publishes are read back out of the gates' source by
 * `./gate-source.ts`, which owns every shape this understands and every refusal it makes.
 *
 * Blind spots, named (the wrong-and-self-consistent class this must not have):
 * - a gate header whose backticks do not pair is REFUSED, not split into sentences;
 * - a test double is a consumer only through a static relative import naming the exact symbol;
 *   a re-export or a namespace import does not count and the double shows fewer consumers;
 * - an allowlist-shaped constant with no array declaration under its name (`const MAX_ALLOWED
 *   = 5`) is SKIPPED by `gate-source.ts`; one whose array is found and cannot be read flat is
 *   REFUSED (#262). The two used to be one swallowed exception, which made this page's
 *   completeness claim silently untrue at exactly the constants hardest to parse.
 */

const ROOT = findRepoRoot(import.meta.url)
const TEST_ROOT = join(ROOT, 'test')
const COVERAGE_SCRIPT = 'scripts/check-coverage.ts'
const FALLOW_CONFIG = '.fallowrc.jsonc'
const COMPLEXITY_SCRIPT = 'complexity:check'
const EXTRA_GATE_FILES = [
  'coverage-manifest.test.ts',
  'check-coverage.test.ts',
  'no-lint-suppressions.test.ts',
  'complexity-ratchet.test.ts',
] as const

interface ExceptionMetadata {
  readonly constant: string
  readonly reason: string
}

interface GateMetadata {
  readonly rootArrays?: readonly string[]
  readonly rootStrings?: readonly string[]
  readonly roots?: readonly string[]
  readonly exceptions: readonly ExceptionMetadata[]
  readonly emptyAllowlist?: { readonly pattern: RegExp; readonly reason: string }
  readonly limitation: string
}

const GATE_METADATA: Readonly<Record<string, GateMetadata>> = {
  'test/api-group-gate.test.ts': {
    roots: ['typedoc.json', 'packages/core/src', 'packages/harness/core'],
    exceptions: [],
    limitation:
      'Holds that every documented export carries `@group`, that the subdivided group carries `@category`, and that both names are declared in the config’s order lists. Which group a symbol belongs in is a judgement it cannot make.',
  },
  'test/mermaid-gate.test.ts': {
    roots: ['docs'],
    exceptions: [],
    limitation:
      'Parses every mermaid fence under `docs/` and names the ones mermaid refuses. It cannot say a diagram is true, readable, or in agreement with the prose beside it — only that it renders rather than showing the reader a parse error.',
  },
  'test/site-gate.test.ts': {
    roots: ['docs', 'site/astro.config.ts', '.github/workflows/docs-site.yml'],
    exceptions: [],
    limitation:
      'Holds that every page under `docs/` projects with a title, that every page the sidebar names exists, and that each link class is rewritten for a route. Whether the BUILT site serves them is the `site` gate step, which builds and crawls.',
  },
  'test/features-gate.test.ts': {
    roots: ['docs/features', 'packages/web/src'],
    exceptions: [],
    limitation:
      'Holds that every bold label on a Features page is a string the web surface renders, that every page has the six parts, and that every screenshot is used. Whether a label sits on the screen the page says it does is the screenshot capture’s to catch (`bun run docs:screenshots`), which fails on a control it cannot find.',
  },
  'test/browser-bundle-gate.test.ts': {
    roots: ['packages/web/src/main.tsx'],
    exceptions: [],
    limitation:
      'Builds the web entry for the browser target; a node:-only module reachable from it fails by the bundler’s own error. It does not run the bundle.',
  },
  'test/check-coverage.test.ts': {
    roots: [COVERAGE_SCRIPT],
    exceptions: [],
    limitation: 'Exercises synthetic LCOV records; it does not run the suite or measure live coverage.',
  },
  'test/complexity-ratchet.test.ts': {
    roots: [FALLOW_CONFIG, 'package.json'],
    exceptions: [],
    limitation:
      'Re-runs the gate’s own fallow command and asserts each per-function pin is live and equal to its function’s score; whether the pinned complexity is warranted is not a question it can ask.',
  },
  'test/coverage-manifest.test.ts': {
    rootArrays: ['LIBRARY_SOURCE_ROOTS'],
    exceptions: [
      {
        constant: 'ENTRY_POINT_EXCEPTIONS',
        reason: 'Program entry points execute at import time and are verified by live receipts.',
      },
      {
        constant: 'VENDORED_DIRECTORIES',
        reason: 'Vendored presentation code shares the lint and coverage exclusion boundary.',
      },
    ],
    limitation:
      'Importability enters files into Bun’s denominator; it does not prove that their behavior was exercised.',
  },
  'test/dependency-gate.test.ts': {
    rootArrays: ['SOURCE_ROOTS'],
    exceptions: [],
    limitation:
      'Reads import specifiers from code lines — type-only imports included, which is the point — and versions from the manifests. That the installer honoured a pin is bun.lock’s record, not this scan’s; a specifier resolving to no installed package is treated as a matcher fixture and left to tsc.',
  },
  'test/docs-gate.test.ts': {
    roots: ['docs'],
    exceptions: [],
    emptyAllowlist: {
      pattern: /allowlist is EMPTY/i,
      reason: 'Generated pages and sourced fences have no drift exceptions.',
    },
    limitation:
      'Recognizes generated first-line markers and TypeScript fences backed by current top-level declaration shapes.',
  },
  'test/duplicate-shapes-gate.test.ts': {
    rootArrays: ['SEARCHED_ROOTS'],
    exceptions: [],
    limitation:
      'Matches a named TypeBox declaration in any export spelling, across line breaks, whole-file — so a commented-out declaration is reported and a schema built by a helper rather than declared is not.',
  },
  'test/gate-abort.test.ts': {
    roots: ['scripts/gate.ts', 'docs/verification.md', 'README.md'],
    exceptions: [],
    limitation:
      'Recognizes the known fatal stderr banners; arbitrary tool corruption with different output is outside the matcher. It also holds the two pages that state what the gate IS — the step lists and the gate census — against `GATES` and the generated inventory, but says nothing about the prose around them.',
  },
  'test/glossary-gate.test.ts': {
    rootArrays: ['SEARCHED_ROOTS'],
    exceptions: [
      {
        constant: 'RETIRED_ALLOWED',
        reason: 'Named sites may retain retired words only for the documented vendor leak or contract test.',
      },
      {
        constant: 'VENDOR_ROOTS',
        reason: 'The vendor runtime’s own roots may retain its vocabulary.',
      },
    ],
    limitation: 'Matches retired words and paths, not a retired meaning expressed under a new word.',
  },
  'test/harness-barrel-gate.test.ts': {
    roots: ['packages/harness/core/index.ts', 'packages/harness/extensions'],
    exceptions: [],
    limitation:
      'Compares the barrel’s re-exported names with the names imported through it by the extensions; a name imported directly from a module rather than through the barrel is outside it, and so is module reachability.',
  },
  'test/logging-gate.test.ts': {
    rootArrays: ['MIGRATED_ROOTS'],
    exceptions: [
      {
        constant: 'LOGTAPE_ALLOWED',
        reason: 'Only the logging schema and process configurators may name the logging substrate.',
      },
    ],
    limitation:
      'Line-scans direct console calls and any string naming the LogTape substrate; comments and test directories are skipped, and an allowlist row that matches nothing is reported.',
  },
  'test/naming-gate.test.ts': {
    rootArrays: ['SCANNED_ROOTS'],
    exceptions: [
      {
        constant: 'EXEMPTED_KEY_SITES',
        reason: 'Pins every production file relying on an externally fixed property-key spelling.',
      },
    ],
    limitation:
      'The executable fixture covers the externally fixed `dir` key and asserts each diagnostic’s severity; the site scan recognizes that key spelling and reports an exemption no file spells. The counted `EXEMPTED_KEY_SITES` row counts exempted FILES — the exempted NAMES live in `scripts/lint/naming-policy.ts`, which the test imports and this generator does not parse.',
  },
  'test/no-lint-suppressions.test.ts': {
    rootArrays: ['SCANNED_ROOTS'],
    exceptions: [
      {
        constant: 'VENDORED_DIRECTORIES',
        reason: 'Vendored upstream code is excluded from linting and therefore from the suppression scan.',
      },
    ],
    emptyAllowlist: {
      pattern: /deliberately NO allowlist/,
      reason: 'Lint suppressions have no per-file or per-line allowance.',
    },
    limitation:
      'Matches the linter, dead-code and type-checker suppression pragmas by family prefix, anywhere in a line and in any comment form, across known source extensions; vendored code is outside the scan, and a suppression written in a file extension the walker does not read is not seen.',
  },
  'test/presentation-gate.test.ts': {
    rootStrings: ['PORTED_DIRECTORY'],
    exceptions: [],
    limitation:
      'Matches provenance text and static imports; dynamically assembled dependencies are outside the import matcher.',
  },
  'test/scratch-gate.test.ts': {
    roots: ['test/scratch-preload.ts'],
    exceptions: [],
    limitation:
      'Runs one real `bun test` child under a fresh `TMPDIR` and holds that it is empty afterwards; a child a suite spawns with a hand-built environment that omits `TMPDIR` still writes to the real `/tmp`, and only review catches that.',
  },
  'test/secret-scan-gate.test.ts': {
    roots: ['.github/workflows/secret-scan.yml'],
    exceptions: [],
    limitation:
      'Runs the `git log` the scanner runs, over fixture histories, with the flags read out of the workflow; it pins what gitleaks is handed, not that gitleaks ran or what its rules matched.',
  },
  'test/source-citation-gate.test.ts': {
    roots: ['docs', 'README.md'],
    exceptions: [],
    limitation:
      'Resolves `path#Name` to one file and a name declared in it, and refuses a typed line number into this repository; it holds that the named declaration exists, not that the sentence around it is true of that declaration.',
  },
  'test/style-tokens-gate.test.ts': {
    rootArrays: ['PAGE_ROOTS'],
    exceptions: [
      {
        constant: 'PIXELS_ALLOWED',
        reason:
          "The debug pages' virtualized log lists: the virtualizer places rows by arithmetic in pixels, so their row height is a pixel number by contract.",
      },
    ],
    limitation:
      'A line scan of page code: it refuses Tailwind arbitrary values, hex colours, colour functions, raw palette colours and pixel lengths or `*_PX` constants. A bare number handed to a `style` prop under another name, and anything in the vendored components or the stylesheet, are outside it.',
  },
  'test/vendor-gate.test.ts': {
    rootArrays: ['SEARCHED_ROOTS'],
    exceptions: [
      {
        constant: 'VENDOR_IMPORT_ALLOWED',
        reason:
          'One row since #215 widened the walk to tests: the guard corpus resolves the runtime to pin its path replica against it. The bundle has imported no vendor-scoped package since L6 (#162).',
      },
      {
        constant: 'VENDOR_NAMED_ALLOWED',
        reason:
          // ⚠ No count here (PR #222 review). The row's own cell carries the number, read off the
          // constant; a second count written by hand beside it goes stale the first time the list
          // moves — which it did, twice, in this PR alone.
          'Pins every first-party code site that still names a vendor extension, tests included. Most rows are sites #215 revealed by widening the walk rather than sites that were added; each carries its reason and the condition that removes it.',
      },
      {
        constant: 'VENDOR_ROOTS',
        reason: 'The host and extension roots own the vendor boundary and may name it.',
      },
    ],
    limitation:
      'Line-scans static words and package strings; structural type leaks and runtime-assembled names are not visible.',
  },
}

interface DoubleMetadata {
  readonly file: string
  readonly symbol: string
  readonly label: string
  readonly seam: string
  readonly productionSurface: string
  readonly exported: boolean
}

const DOUBLE_METADATA: readonly DoubleMetadata[] = [
  {
    file: 'packages/core/src/__tests__/log-recorder.ts',
    symbol: 'recordEnsoLogs',
    label: '`recordEnsoLogs`',
    seam: 'LogTape in-memory sink, one for every package (#178)',
    productionSurface: 'every record through `ensoLogger` — extension audits, web and server records',
    exported: true,
  },
  {
    file: 'packages/web/src/__tests__/dom-environment.ts',
    symbol: 'releaseDom',
    label: 'DOM environment / `releaseDom`',
    seam: 'process-scoped browser globals',
    productionSurface: 'mounted React components and browser events',
    exported: true,
  },
  {
    file: 'packages/web/src/__tests__/scripted-server.ts',
    symbol: 'createScriptedFetch',
    label: '`createScriptedFetch`',
    seam: 'injected `fetch` and streamed follow body',
    productionSurface: 'browser HTTP/SSE adapters, prompts, dialogs, aborts, and history',
    exported: true,
  },
  {
    file: 'packages/web/src/__tests__/scripted-server.ts',
    symbol: 'SNAPSHOT_IDLE',
    label: '`SNAPSHOT_IDLE`',
    seam: 'reusable `EnsoFollowSnapshot` fixture',
    productionSurface: 'browser follow snapshot handling',
    exported: true,
  },
  {
    file: 'packages/web/src/server/__tests__/bundle-route.test.ts',
    symbol: 'liveThread',
    label: '`liveThread`',
    seam: '`ThreadView` over `createFakeHostedThread`',
    productionSurface: 'diagnostic bundle serialization of live threads',
    exported: false,
  },
  {
    file: 'packages/web/src/server/__tests__/fake-hosted-thread.ts',
    symbol: 'createFakeHostedThread',
    label: '`createFakeHostedThread`',
    seam: 'the one fake of the thread-runtime seam (#178): recording `ThreadRuntime` / `HostedThread`',
    productionSurface:
      'server routes, registry lifecycle, follow feed, bundle — everything driven over a `ThreadRuntime`',
    exported: true,
  },
  {
    file: 'packages/web/src/server/__tests__/fake-hosted-thread.ts',
    symbol: 'createFakeAgentHost',
    label: '`createFakeAgentHost`',
    seam: 'the one fake of the storage seam (#178): `AgentHost` over a stored-thread map',
    productionSurface: 'stored-thread listing, history reads, thread building',
    exported: true,
  },
  {
    file: 'packages/web/src/server/__tests__/follow-reader.ts',
    symbol: 'openFollow',
    label: '`openFollow`',
    seam: 'real HTTP SSE reader',
    productionSurface: 'thread follow endpoint frames and keepalive comments',
    exported: true,
  },
  {
    file: 'packages/web/src/server/__tests__/follow.test.ts',
    symbol: 'fakeHost',
    label: '`fakeHost` (follow)',
    seam: '`createFakeAgentHost` over `createFakeHostedThread` with a scripted prompt acceptance',
    productionSurface: 'follow snapshots, observations, dialogs, and abort behavior',
    exported: false,
  },
  {
    file: 'packages/web/src/server/__tests__/server-handler.test.ts',
    symbol: 'fakeHost',
    label: '`fakeHost` (server handler)',
    seam: '`createFakeAgentHost` over `createFakeHostedThread` with a scripted prompt and an inspection whose entries record a mode (`modeShapedInspection`)',
    productionSurface: 'server request routing and runtime event delivery',
    exported: false,
  },
  {
    file: 'packages/web/src/server/__tests__/thread-registry.test.ts',
    symbol: 'fakeHosted',
    label: '`fakeHosted`',
    seam: '`createFakeHostedThread` with a pending abort and a failing clear',
    productionSurface: 'thread registry acquire, abort, queue clearing, and disposal',
    exported: false,
  },
]

function repositoryFile(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8')
}

/** Recursive where the flat `readdirSync` it replaced was not (#174): a gate under a `test/` subdirectory is inventoried, not missed. */
function detectedGateFiles(): string[] {
  return filesUnder(TEST_ROOT, {
    keep: (file: string): boolean =>
      (file.includes('gate') && file.endsWith('.test.ts')) || (EXTRA_GATE_FILES as readonly string[]).includes(file),
  })
    .map((path) => relative(ROOT, path).replaceAll('\\', '/'))
    .toSorted()
}

function firstHeaderSentence(source: string, file: string): string {
  const header = /\/\*\*([\s\S]*?)\*\//.exec(source)?.[1]
  if (header === undefined) throw new Error(`${file}: no header comment`)
  const prose = header
    .split('\n')
    .map((line) => line.replace(/^\s*\*?\s?/, '').trim())
    .join(' ')
    .replace(/\s+/g, ' ')
  if ((prose.match(/`/g) ?? []).length % 2 !== 0) {
    throw new Error(`${file}: header has an unpaired backtick; the sentence splitter cannot tell code from prose`)
  }
  let sentenceStart = 0
  let inCode = false
  for (let characterIndex = 0; characterIndex < prose.length; characterIndex += 1) {
    const character = prose[characterIndex]
    if (character === '`') inCode = !inCode
    const closesSentence = !inCode && character !== undefined && '.!?'.includes(character)
    if (!(closesSentence && (characterIndex === prose.length - 1 || /\s/.test(prose[characterIndex + 1] ?? ''))))
      continue
    const sentence = prose.slice(sentenceStart, characterIndex + 1).trim()
    if (!sentence.startsWith('⚠')) return sentence
    sentenceStart = characterIndex + 1
  }
  throw new Error(`${file}: no non-warning sentence in header`)
}

function rootsOf(source: string, file: string, metadata: GateMetadata): string[] {
  return [
    ...(metadata.roots ?? []),
    ...(metadata.rootArrays ?? []).flatMap((constantName) => stringArray(source, constantName, file)),
    ...(metadata.rootStrings ?? []).map((constantName) => stringConstant(source, constantName, file)),
  ]
}

function linkedPath(path: string): string {
  return `[\`${path}\`](../../${path})`
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ')
}

interface Ratchet {
  readonly kind: string
  readonly value: string
  readonly location: string
  readonly reason: string
}

interface ComplexityPin {
  readonly files: readonly string[]
  readonly functions: readonly string[]
  readonly maxCognitive: number
  readonly reason: string
}

/** Whether one `health.thresholdOverrides` entry has the one-file, one-function shape published here. */
function isComplexityPin(entry: unknown): entry is ComplexityPin {
  if (typeof entry !== 'object' || entry === null) return false
  if (!('files' in entry && 'functions' in entry && 'maxCognitive' in entry && 'reason' in entry)) return false
  return (
    Array.isArray(entry.files) &&
    entry.files.length === 1 &&
    Array.isArray(entry.functions) &&
    entry.functions.length === 1 &&
    typeof entry.maxCognitive === 'number' &&
    typeof entry.reason === 'string'
  )
}

/**
 * The complexity gate's ceiling (the `complexity:check` script's `--max-cognitive`) and its
 * per-function pins (`.fallowrc.jsonc` → `health.thresholdOverrides`). An entry this cannot read
 * as one file, one function, a number and a reason is REFUSED, never skipped.
 */
function complexityRatchets(): Ratchet[] {
  const scripts: Readonly<Record<string, string>> = JSON.parse(repositoryFile('package.json')).scripts
  const ceiling = /--max-cognitive (\d+)/.exec(scripts[COMPLEXITY_SCRIPT] ?? '')?.[1]
  if (ceiling === undefined) throw new Error(`package.json: \`${COMPLEXITY_SCRIPT}\` sets no --max-cognitive`)
  // Bun imports the JSONC config untyped; every field read below is checked before it is used.
  const config: unknown = fallowConfig
  const health: unknown =
    typeof config === 'object' && config !== null && 'health' in config ? config.health : undefined
  const overrides: unknown =
    typeof health === 'object' && health !== null && 'thresholdOverrides' in health
      ? health.thresholdOverrides
      : undefined
  if (!Array.isArray(overrides)) throw new Error(`${FALLOW_CONFIG}: health.thresholdOverrides is not a list`)
  return [
    {
      kind: 'Complexity ceiling',
      value: `cognitive max \`${ceiling}\``,
      location: `${linkedPath('package.json')} — \`${COMPLEXITY_SCRIPT}\``,
      reason: 'Global cognitive-complexity ceiling for code without a narrower pin.',
    },
    ...overrides.map((override: unknown): Ratchet => {
      if (!isComplexityPin(override))
        throw new Error(`${FALLOW_CONFIG}: a complexity override is not one file + one function`)
      return {
        kind: 'Complexity pin',
        value: `cognitive max \`${override.maxCognitive}\``,
        location: `${linkedPath(FALLOW_CONFIG)} — \`${override.files[0]}:${override.functions[0]}\``,
        reason: override.reason,
      }
    }),
  ]
}

/** Repository-relative paths under `root`, the shape every table here keys on. */
function repositoryFilesUnder(root: string): string[] {
  return filesUnder(join(ROOT, root)).map((path) => relative(ROOT, path).replaceAll('\\', '/'))
}

function testFiles(): string[] {
  return ['packages', 'scripts', 'test']
    .flatMap(repositoryFilesUnder)
    .filter((path) => /\.test\.tsx?$/.test(path))
    .toSorted()
}

function supportFiles(): string[] {
  return repositoryFilesUnder('packages')
    .filter((path) => path.includes('/__tests__/') && !/\.test\.tsx?$/.test(path) && /\.tsx?$/.test(path))
    .toSorted()
}

function exportedDoubleKeys(): string[] {
  const keys: string[] = []
  for (const file of supportFiles()) {
    const source = repositoryFile(file)
    for (const match of source.matchAll(
      /^export\s+(?:async\s+)?function\s+(create\w+|recordEnsoLogs|openFollow|releaseDom)\b/gm,
    )) {
      keys.push(`${file}#${match[1]}`)
    }
    if (/^export\s+const\s+SNAPSHOT_IDLE\b/m.test(source)) keys.push(`${file}#SNAPSHOT_IDLE`)
  }
  return keys.toSorted()
}

function validateDouble(metadata: DoubleMetadata): void {
  const source = repositoryFile(metadata.file)
  const escaped = metadata.symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const declaration = new RegExp(`^(?:export\\s+)?(?:async\\s+)?(?:function|const|class)\\s+${escaped}\\b`, 'm')
  if (!declaration.test(source)) throw new Error(`${metadata.file}: stale double metadata for ${metadata.symbol}`)
}

/** `@enso/core/<subpath>` → the file core's export map names, read once; other bare specifiers → undefined. */
const CORE_SUBPATH_TARGETS: ReadonlyMap<string, string> = new Map(
  Object.entries(
    (JSON.parse(repositoryFile('packages/core/package.json')) as { exports: Record<string, string> }).exports,
  )
    .filter(([subpath]) => subpath !== '.')
    .map(([subpath, target]) => [`@enso/core/${subpath.slice(2)}`, `packages/core/${target.replace(/^\.\//, '')}`]),
)

function coreSubpathTarget(specifier: string): string | undefined {
  return CORE_SUBPATH_TARGETS.get(specifier)
}

function importsSymbol(testFile: string, metadata: DoubleMetadata): boolean {
  const source = repositoryFile(testFile)
  for (const match of source.matchAll(/import\s+(?:type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g)) {
    const clause = match[1] ?? ''
    const specifier = match[2] ?? ''
    const imported = specifier.startsWith('.')
      ? relative(ROOT, resolve(dirname(join(ROOT, testFile)), specifier)).replaceAll('\\', '/')
      : coreSubpathTarget(specifier)
    if (imported !== metadata.file) continue
    const importedNames = clause
      .replace(/[{}]/g, ' ')
      .split(',')
      .map(
        (part) =>
          part
            .trim()
            .split(/\s+as\s+/)[0]
            ?.replace(/^type\s+/, '')
            .trim() ?? '',
      )
    if (importedNames.includes(metadata.symbol)) return true
  }
  return false
}

function consumersOf(metadata: DoubleMetadata, tests: readonly string[]): string[] {
  if (!metadata.exported) return [metadata.file]
  return tests.filter((file) => importsSymbol(file, metadata))
}

function generate(): string {
  const gateFiles = detectedGateFiles()
  assertExactKeys('gate', gateFiles, Object.keys(GATE_METADATA).toSorted())

  const gateRows: string[] = []
  const allowlistRatchets: Ratchet[] = []
  for (const file of gateFiles) {
    const source = repositoryFile(file)
    const metadata = GATE_METADATA[file]
    if (metadata === undefined) throw new Error(`${file}: missing gate metadata`)
    const detectedExceptions = detectedExceptionConstants(source, file).toSorted()
    const recordedExceptions = metadata.exceptions.map((exception) => exception.constant).toSorted()
    assertExactKeys(`${file} exception`, detectedExceptions, recordedExceptions)
    const exceptionCounts = metadata.exceptions.map((exception) => {
      const count = stringArray(source, exception.constant, file).length
      allowlistRatchets.push({
        kind: 'Allowlist / exception count',
        value: `\`${count}\``,
        location: `${linkedPath(file)} — \`${exception.constant}\``,
        reason: exception.reason,
      })
      return `\`${exception.constant}\` = ${count}`
    })
    if (metadata.emptyAllowlist !== undefined) {
      if (!metadata.emptyAllowlist.pattern.test(source))
        throw new Error(`${file}: stated empty allowlist is no longer present`)
      allowlistRatchets.push({
        kind: 'Allowlist count',
        value: '`0`',
        location: `${linkedPath(file)} — stated empty allowlist`,
        reason: metadata.emptyAllowlist.reason,
      })
      exceptionCounts.push('stated allowlist = 0')
    }
    gateRows.push(
      `| ${linkedPath(file)} | ${cell(firstHeaderSentence(source, file))} | ${
        rootsOf(source, file, metadata)
          .map((root) => `\`${root}\``)
          .join('<br>') || 'UNCLASSIFIED'
      } | ${exceptionCounts.join('<br>') || 'none (0)'} | ${cell(metadata.limitation)} |`,
    )
  }

  const coverageSource = repositoryFile(COVERAGE_SCRIPT)
  const ratchets: Ratchet[] = [
    {
      kind: 'Coverage line floor',
      value: `\`${numericConstant(coverageSource, 'TOTAL_LINE_COVERAGE_FLOOR', COVERAGE_SCRIPT)}\``,
      location: `${linkedPath(COVERAGE_SCRIPT)} — \`TOTAL_LINE_COVERAGE_FLOOR\``,
      reason: 'Minimum aggregate line coverage accepted by the coverage gate.',
    },
    {
      kind: 'Coverage function floor',
      value: `\`${numericConstant(coverageSource, 'TOTAL_FUNCTION_COVERAGE_FLOOR', COVERAGE_SCRIPT)}\``,
      location: `${linkedPath(COVERAGE_SCRIPT)} — \`TOTAL_FUNCTION_COVERAGE_FLOOR\``,
      reason: 'Minimum aggregate function coverage accepted by the coverage gate.',
    },
    ...complexityRatchets(),
    ...allowlistRatchets,
  ]

  for (const metadata of DOUBLE_METADATA) validateDouble(metadata)
  const exportedMetadata = DOUBLE_METADATA.filter((double) => double.exported)
    .map((double) => `${double.file}#${double.symbol}`)
    .toSorted()
  assertExactKeys('exported test double', exportedDoubleKeys(), exportedMetadata)
  const tests = testFiles()
  const doubleRows = [...DOUBLE_METADATA]
    .toSorted((left, right) => `${left.file}#${left.symbol}`.localeCompare(`${right.file}#${right.symbol}`))
    .map((metadata) => {
      const consumers = consumersOf(metadata, tests)
      if (consumers.length === 0) throw new Error(`${metadata.file}#${metadata.symbol}: nothing consumes this double`)
      return `| ${metadata.label} | ${linkedPath(metadata.file)} | ${cell(metadata.seam)} | ${cell(metadata.productionSurface)} | ${consumers.length} file${consumers.length === 1 ? '' : 's'}: ${consumers.map(linkedPath).join('<br>')} |`
    })

  return [
    '<!-- generated: scripts/docs/verification-inventory.ts -->',
    '# Verification inventory',
    '',
    'Generated from gate sources, coverage and complexity ratchets, and exact test-double declarations and imports.',
    '**Counts are inventory, not quality scores.** A larger count records a larger reviewed surface; it does not make that surface better.',
    '',
    'Parser boundary: this generator reads the repository’s current flat string arrays, numeric constants, fallow complexity overrides,',
    'and exact helper exports. Unsupported or stale shapes fail generation instead of being silently omitted.',
    '',
    '## Enforcement gates',
    '',
    '| File | Rule | Searched roots | Allowlist / exception constants | Limitation |',
    '|---|---|---|---|---|',
    ...gateRows,
    '',
    '## Ratchets',
    '',
    '| Ratchet | Value | Location | Reason |',
    '|---|---|---|---|',
    ...ratchets.map((row) => `| ${row.kind} | ${row.value} | ${row.location} | ${cell(row.reason)} |`),
    '',
    '## Test doubles',
    '',
    '| Double / factory | File | Seam | Production surface driven | Consumer tests / count |',
    '|---|---|---|---|---|',
    ...doubleRows,
    '',
  ].join('\n')
}

runGenerator('verification-inventory', generate)
