import { defineConfig } from 'oxlint'
import { PROCESS_ENVIRONMENT_READERS } from './scripts/lint/process-environment.ts'

/**
 * The lint gate (gate 2 in scripts/gate.ts). Type-aware: the `typescript/*` rules that need type
 * information run through `oxlint-tsgolint`.
 *
 * Scope is deliberate, not a preset: `correctness` is the only category switched on wholesale,
 * and every other rule below is named. Turning on `suspicious` adds ~1,300 findings (915 of them
 * `react-in-jsx-scope`, a pre-React-17 rule) — rules join one at a time, with a reason.
 *
 * What lives elsewhere, and why:
 *   • Formatting, import order, Tailwind class order → oxfmt (`.oxfmtrc.json`, gate 1).
 *   • Cognitive complexity → fallow `health` (`.fallowrc.jsonc`), which pins per FUNCTION.
 *   • The naming gate's word lists → scripts/lint/naming-policy.ts; its rules → the `enso` plugin.
 *   • The process-environment allowlist → scripts/lint/process-environment.ts.
 *
 * ⚠ No rule is silenced by a comment in this repository (`test/no-lint-suppressions.test.ts`):
 * an exception is an `overrides` entry below, with its reason beside it.
 */
export default defineConfig({
  plugins: ['typescript', 'unicorn', 'oxc', 'react', 'jsx-a11y', 'node'],
  jsPlugins: [
    './scripts/lint/enso-plugin.ts',
    // The jest rules, from upstream's plugin rather than oxlint's native port: the native port
    // recognises `describe`/`test` only as globals or `@jest/globals` imports, and is silent on
    // `import … from 'bun:test'` — every test file here. Upstream reads `settings.jest.globalPackage`.
    { name: 'jest-js', specifier: 'eslint-plugin-jest' },
  ],
  settings: { jest: { globalPackage: 'bun:test' } },
  categories: { correctness: 'error' },
  options: {
    typeAware: true,
    // A warning never fails the run. The only rule registered at `warn` is the advisory naming
    // tier (`enso/generic-iteration`) — turning this on would make it block.
    denyWarnings: false,
    reportUnusedDisableDirectives: 'error',
  },
  ignorePatterns: [
    '**/dist',
    '**/dist-types',
    '**/coverage',
    '.claude',
    '.inspiration',
    '.local',
    '.enso',
    '.playwright-mcp',
    '.codegraph',
    // Vendored upstream presentation — shadcn/ui primitives and the ai-elements port — kept
    // diffable against its registry/commit receipt rather than held to our rules. ONE of three
    // exclusions drawn at this path (the others are bunfig's `coveragePathIgnorePatterns` and
    // `.fallowrc.jsonc`'s `ignoreFindings`); `test/presentation-gate.test.ts` scans this whole
    // tree, requires a provenance receipt per vendored subdirectory, and refuses any import of
    // the state layer. Widen this line and that gate widens with it.
    'packages/web/src/components',
  ],
  rules: {
    // A JSX file does not import React under the automatic runtime.
    'react/react-in-jsx-scope': 'off',
    'react/rules-of-hooks': 'error',
    'react/exhaustive-deps': 'error',
    // The React Compiler's rules (oxlint ships them in `correctness`). Biome had no counterpart,
    // react-doctor (gate 4) is this repo's React review, and adopting the compiler's model of
    // effects and refs is a change of its own — not something a linter swap should smuggle in.
    'react/set-state-in-effect': 'off',
    'react/refs': 'off',
    'react/immutability': 'off',
    'react/incompatible-library': 'off',
    // Biome's `useSemanticElements` — the rule this replaces — did not ask for these roles
    // (`status`, `group`, `heading`, `img` on shadcn primitives and chips); swapping the elements
    // changes rendered semantics and styling, which is UI work with its own review. The stats
    // drawer's `role="button"` cost points (#359) were the one exception Biome did raise: an SVG
    // `<circle>` cannot be a `<button>`.
    'jsx-a11y/prefer-tag-over-role': 'off',

    // ── complexity and shape ──
    'no-unneeded-ternary': 'error',
    'typescript/no-unnecessary-type-constraint': 'error',
    'no-implicit-coercion': 'error',
    'no-useless-concat': 'error',
    'max-params': ['error', { max: 4 }],

    // ── suspicious ──
    'no-unused-vars': 'error',
    'no-console': 'error',
    'typescript/ban-ts-comment': 'error',
    'typescript/no-explicit-any': 'error',
    'no-empty': 'error',
    'no-empty-function': 'error',
    'no-empty-static-block': 'error',
    // `warn`, as Biome's `noTemplateCurlyInString` was: three tests spell a literal `${…}` on purpose
    // (a workflow expression, a shell range, a source fixture) and say so beside it.
    'no-template-curly-in-string': 'warn',

    // ── style ──
    'no-nested-ternary': 'error',
    'unicorn/numeric-separators-style': 'error',
    'typescript/only-throw-error': 'error',
    'unicorn/throw-new-error': 'error',
    'typescript/no-non-null-assertion': 'error',
    'unicorn/explicit-length-check': 'error',
    'node/no-process-env': 'error',

    // ── types and promises ──
    'typescript/no-floating-promises': 'error',
    'typescript/no-misused-promises': 'error',
    'typescript/await-thenable': 'error',
    'typescript/no-implied-eval': 'error',
    'typescript/no-unnecessary-type-conversion': 'error',
    'typescript/prefer-nullish-coalescing': 'error',
    // A `default` arm counts as exhaustive: the check is that every arm EXISTS, and
    // `noFallthroughCasesInSwitch` (tsconfig.base.json) is what proves none runs into the next.
    'typescript/switch-exhaustiveness-check': ['error', { considerDefaultExhaustiveForUnions: true }],
    // Expressions are exempt — an IIFE, a callback handed straight to its caller, a closure
    // returned from a typed function — because their type is fixed by where they stand.
    'typescript/explicit-function-return-type': [
      'error',
      {
        allowExpressions: true,
        allowIIFEs: true,
        allowHigherOrderFunctions: true,
        allowTypedFunctionExpressions: true,
      },
    ],
    'typescript/explicit-module-boundary-types': 'error',
    'no-unmodified-loop-condition': 'error',

    // ── tests ──
    'jest-js/max-nested-describe': ['error', { max: 5 }],
    'jest-js/no-conditional-expect': 'error',
    'jest-js/no-identical-title': 'error',
    'jest-js/no-focused-tests': 'error',
    'jest-js/no-export': 'error',
    'jest-js/no-done-callback': 'error',
    'jest-js/no-duplicate-hooks': 'error',

    // ── this repository's own ──
    'enso/abbreviated-binding': 'error',
    'enso/abbreviated-key': 'error',
    'enso/generic-iteration': 'warn',
    'enso/no-export-all': 'error',
  },
  overrides: [
    {
      files: [...PROCESS_ENVIRONMENT_READERS],
      rules: { 'node/no-process-env': 'off' },
    },
    {
      // Test files are exempt from naming discipline: a test's throwaway bindings and wire-format
      // fixtures are not the code readers navigate.
      //
      // ⚠ `site/src/content.config.ts` is exempt because its ONE object is Starlight's, not
      // ours: the collection must be keyed `docs` for `docsLoader()`/`docsSchema()` to find it
      // (@astrojs/starlight 0.42.2, #188), and the file declares nothing else. Exempted as a
      // FILE rather than by adding `docs` to the contract keys, because that list is keyed on the
      // NAME and would exempt the word everywhere. `site/astro.config.ts` likewise: every object in
      // it is Astro's or Starlight's option bag, whose keys are fixed there (`logo.src`, a `head`
      // entry's `attrs`, @astrojs/starlight 0.42.3).
      files: ['**/*.test.ts', '**/*.test.tsx', 'site/src/content.config.ts', 'site/astro.config.ts'],
      rules: {
        'enso/abbreviated-binding': 'off',
        'enso/abbreviated-key': 'off',
        'enso/generic-iteration': 'off',
      },
    },
    {
      // bun-types declares `expect(p).rejects`/`.resolves` matchers as returning `void`, but at
      // runtime they return the promise the test must await — so this rule reads every
      // `await expect(…).rejects.toThrow(…)` as awaiting a non-thenable. Scoped to tests, where
      // those matchers are the only such await.
      files: ['**/*.test.ts', '**/*.test.tsx'],
      rules: { 'typescript/await-thenable': 'off' },
    },
  ],
})
