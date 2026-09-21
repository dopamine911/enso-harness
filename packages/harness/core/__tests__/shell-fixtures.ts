/**
 * Shell-shaped literals the scanner tests write, in one place (#261, PR #289 review).
 *
 * ⚠ `braced` exists to dodge Biome's `noTemplateCurlyInString`, not to save typing: a test
 * that needs the text `${NAME}` cannot write it inside a template literal without tripping
 * that rule, and suppressing the rule per line is what this repository refuses. Three test
 * files needed the same escape hatch and each had declared its own copy, so the next one
 * would have too — and a fourth spelling of one escape is how a corpus starts disagreeing
 * with itself about what it is testing.
 */

/** The text `${body}` — a shell expansion as a string, never a template substitution. */
export function braced(expansionBody: string): string {
  return `$\u007b${expansionBody}\u007d`
}
