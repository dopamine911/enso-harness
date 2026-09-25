import unicorn from 'eslint-plugin-unicorn'
import {
  ABBREVIATIONS,
  EXTERNAL_CONTRACT_KEYS,
  GENERIC_ITERATION_NAMES,
  NAME_ALLOWLIST,
  SINGLE_CHARACTER_EXEMPTIONS,
  SINGLE_CHARACTER_KEY_EXEMPTIONS,
} from './naming-policy.ts'

/**
 * This repository's oxlint plugin, registered in `oxlint.config.ts` as `enso`. Four rules:
 *
 *   • `abbreviated-binding` / `abbreviated-key` — the naming gate (naming-policy.ts). Detection
 *     is upstream's `unicorn/name-replacements`, run twice with two option sets: oxlint cannot
 *     load one package under two aliases, so the tiers are two names for the same rule here.
 *     Its reports are rewritten into this repo's messages and carry NO fix or suggestion:
 *     the gate names the problem, the author picks the word.
 *   • `generic-iteration` — the advisory tier: generic names in iteration callbacks and loop
 *     headers. Registered at `warn`, which oxlint does not fail on.
 *   • `no-export-all` — `export * from …`, which Biome's `noReExportAll` refused and oxlint has
 *     no native rule for.
 *
 * The types below are the slice of the ESTree/ESLint rule API these rules touch — declared here,
 * not imported, because the ESLint type packages are not dependencies of this repository.
 */

interface IdentifierNode {
  readonly type: 'Identifier'
  readonly name: string
}

/** The nodes a loop header or callback parameter can be; anything else binds nothing we read. */
type PatternNode =
  | IdentifierNode
  | { readonly type: 'VariableDeclaration'; readonly declarations: readonly { readonly id: PatternNode }[] }
  | { readonly type: 'ObjectPattern'; readonly properties: readonly (PatternProperty | RestNode)[] }
  | { readonly type: 'ArrayPattern'; readonly elements: readonly (PatternNode | null)[] }
  | RestNode
  | { readonly type: 'AssignmentPattern'; readonly left: PatternNode }
  | { readonly type: 'Expression' }

interface PatternProperty {
  readonly type: 'Property'
  readonly value: PatternNode
}

interface RestNode {
  readonly type: 'RestElement'
  readonly argument: PatternNode
}

interface CallNode {
  readonly callee:
    | { readonly type: 'MemberExpression'; readonly computed: boolean; readonly property: PatternNode }
    | { readonly type: 'Other' }
  readonly arguments: readonly (
    | { readonly type: 'ArrowFunctionExpression'; readonly params: readonly PatternNode[] }
    | { readonly type: 'Other' }
  )[]
}

interface Report {
  readonly node?: unknown
  readonly loc?: unknown
  readonly data?: Readonly<Record<string, unknown>>
}

interface RuleContext {
  report(problem: { readonly node?: unknown; readonly loc?: unknown; readonly message: string }): void
}

type Visitor = Record<string, (node: never) => void>

interface Rule {
  readonly meta?: Readonly<Record<string, unknown>>
  create(context: RuleContext): Visitor
}

/** The `name-replacements` options this repo sets (upstream's schema, the subset used). */
interface NameReplacementOptions {
  readonly checkVariables: boolean
  readonly checkProperties: boolean
  readonly replacements: Readonly<Record<string, Readonly<Record<string, boolean>>>>
  readonly allowList: Readonly<Record<string, boolean>>
}

type Tier = 'binding' | 'key'

const NAMING_DOCUMENT = 'See naming-and-style.md.'
const SINGLE_LETTERS: readonly string[] = 'abcdefghijklmnopqrstuvwxyz'.split('')

/**
 * Whole-name matching. Upstream also splits camelCase and judges each word (`logsDir` → `Dir`),
 * which this gate has never done: any name with a character outside `a-z` is skipped before the
 * split, except the dictionary's own camelCase entries.
 */
const WHOLE_NAMES_ONLY = `^(?!(?:${ABBREVIATIONS.filter((abbreviation) => /[^a-z]/.test(abbreviation)).join('|')})$).*[^a-z]`

/**
 * The options both tiers share, and each tier's own. In upstream's `replacements` shape; the
 * target word is never shown (the report is rewritten below) and never applied (fixes are
 * dropped), so one placeholder serves every entry.
 */
function tierOptions(tier: Tier): NameReplacementOptions & Readonly<Record<string, unknown>> {
  const letterExemptions =
    tier === 'binding'
      ? SINGLE_CHARACTER_EXEMPTIONS
      : [...SINGLE_CHARACTER_EXEMPTIONS, ...SINGLE_CHARACTER_KEY_EXEMPTIONS]
  const flagged = [...ABBREVIATIONS, ...SINGLE_LETTERS.filter((letter) => !letterExemptions.includes(letter))]
  const allowed = tier === 'binding' ? NAME_ALLOWLIST : [...NAME_ALLOWLIST, ...EXTERNAL_CONTRACT_KEYS]
  return {
    extendDefaultReplacements: false,
    extendDefaultAllowList: false,
    checkFilenames: false,
    checkDefaultAndNamespaceImports: true,
    checkShorthandImports: true,
    checkShorthandProperties: false,
    ignore: [WHOLE_NAMES_ONLY],
    checkVariables: tier === 'binding',
    checkProperties: tier === 'key',
    replacements: Object.fromEntries(flagged.map((flaggedName) => [flaggedName, { descriptiveName: true }])),
    allowList: Object.fromEntries(allowed.map((allowedName) => [allowedName, true])),
  }
}

// `eslint-plugin-unicorn`'s declared types reference the `eslint` package, which is not installed,
// so its default export arrives untyped; this is the one member read from it.
const unicornRules: Readonly<Record<string, Rule | undefined>> = (
  unicorn as unknown as { readonly rules: Readonly<Record<string, Rule | undefined>> }
).rules
const nameReplacements = unicornRules['name-replacements']
if (nameReplacements === undefined) throw new Error('eslint-plugin-unicorn no longer exports name-replacements')

function namingMessage(flaggedName: string, tier: Tier): string {
  if (flaggedName.length === 1) {
    return tier === 'binding'
      ? `Single-character name \`${flaggedName}\` — use a descriptive name. Exempt: _, z. ${NAMING_DOCUMENT}`
      : `Single-character property key \`${flaggedName}\` — use a descriptive field name (\`{ n: … }\` → \`{ count: … }\`). Exempt: _, z, e. ${NAMING_DOCUMENT}`
  }
  return tier === 'binding'
    ? `Abbreviated name \`${flaggedName}\` — use the full word (config, context, request, response, message, callback, index, element, …). ${NAMING_DOCUMENT}`
    : `Abbreviated property key \`${flaggedName}\` — use the full word (\`ts\` → \`timestamp\`, \`dir\` → \`directory\`, \`cmd\` → \`command\`, \`cnt\` → \`count\`). ${NAMING_DOCUMENT}`
}

/**
 * Upstream's detection with this repo's options, messages, and no fixes. The context is proxied
 * rather than copied: oxlint's context resolves its members lazily, so everything but `options`
 * and `report` must still come from the real object.
 */
function namingTier(tier: Tier, upstream: Rule): Rule {
  const options = tierOptions(tier)
  return {
    meta: { type: 'problem', schema: [] },
    create(context: RuleContext): Visitor {
      const report = (problem: Report): void => {
        const discouraged = problem.data?.discouragedName
        context.report({
          node: problem.node,
          loc: problem.loc,
          message: namingMessage(typeof discouraged === 'string' ? discouraged : '?', tier),
        })
      }
      // The proxy's target is an empty object, not `context`: oxlint freezes the context, and a
      // proxy may not answer a frozen property with a different value than its target holds.
      const tiered = new Proxy<RuleContext>(Object.create(null), {
        get(_target: RuleContext, property: string | symbol): unknown {
          if (property === 'options') return [options]
          if (property === 'report') return report
          const member: unknown = Reflect.get(context, property)
          return typeof member === 'function' ? member.bind(context) : member
        },
      })
      return upstream.create(tiered)
    },
  }
}

// ── the advisory tier ─────────────────────────────────────────────────────────

const GENERIC_ITERATION_MESSAGE = `Generic iteration variable — name what it walks (\`sessions.map((s) => …)\` → \`(session) => …\`, \`for (let i = 0; i < rows.length; ...)\` → \`rowIndex\`). Greppability wins in an agent codebase. ${NAMING_DOCUMENT}`

/**
 * Which callback parameter each iteration method names, keyed by the callback's parameter
 * count — the exact shapes the GritQL plugin matched: element callbacks with one parameter (or
 * two, for the index-taking four), and the element (second) parameter of a two-parameter
 * `reduce` callback. Arrow functions only, as there.
 */
const ITERATION_PARAMETER: Readonly<Record<string, Readonly<Record<number, number>>>> = {
  map: { 1: 0, 2: 0 },
  filter: { 1: 0, 2: 0 },
  find: { 1: 0, 2: 0 },
  forEach: { 1: 0, 2: 0 },
  some: { 1: 0 },
  every: { 1: 0 },
  flatMap: { 1: 0 },
  reduce: { 2: 1 },
}

/** Every identifier a declaration binds, destructuring included. */
function boundIdentifiers(pattern: PatternNode | null): IdentifierNode[] {
  switch (pattern?.type) {
    case 'Identifier':
      return [pattern]
    case 'VariableDeclaration':
      return pattern.declarations.flatMap((declarator) => boundIdentifiers(declarator.id))
    case 'ObjectPattern':
      return pattern.properties.flatMap((property) =>
        boundIdentifiers(property.type === 'RestElement' ? property.argument : property.value),
      )
    case 'ArrayPattern':
      return pattern.elements.flatMap((element) => boundIdentifiers(element))
    case 'RestElement':
      return boundIdentifiers(pattern.argument)
    case 'AssignmentPattern':
      return boundIdentifiers(pattern.left)
    default:
      return []
  }
}

const genericIteration: Rule = {
  meta: { type: 'suggestion', schema: [] },
  create(context: RuleContext): Visitor {
    const flag = (identifiers: readonly IdentifierNode[]): void => {
      for (const identifier of identifiers) {
        if (GENERIC_ITERATION_NAMES.includes(identifier.name)) {
          context.report({ node: identifier, message: GENERIC_ITERATION_MESSAGE })
        }
      }
    }
    return {
      CallExpression(call: CallNode): void {
        const { callee } = call
        const [callback] = call.arguments
        if (callee.type !== 'MemberExpression' || callee.computed || callee.property.type !== 'Identifier') return
        if (callback?.type !== 'ArrowFunctionExpression') return
        const position = ITERATION_PARAMETER[callee.property.name]?.[callback.params.length]
        const parameter = position === undefined ? undefined : callback.params[position]
        if (parameter?.type === 'Identifier') flag([parameter])
      },
      ForStatement(loop: { readonly init: PatternNode | null }): void {
        flag(boundIdentifiers(loop.init))
      },
      ForOfStatement(loop: { readonly left: PatternNode }): void {
        flag(boundIdentifiers(loop.left))
      },
    }
  },
}

const noExportAll: Rule = {
  meta: { type: 'problem', schema: [] },
  create(context: RuleContext): Visitor {
    return {
      ExportAllDeclaration(declaration: unknown): void {
        context.report({
          node: declaration,
          message:
            'Re-export the names this module means to expose, not everything (`export * from …`): a wildcard hides what crosses the boundary.',
        })
      },
    }
  },
}

export default {
  meta: { name: 'enso' },
  rules: {
    'abbreviated-binding': namingTier('binding', nameReplacements),
    'abbreviated-key': namingTier('key', nameReplacements),
    'generic-iteration': genericIteration,
    'no-export-all': noExportAll,
  },
}
