/**
 * Reading a declared constant back out of a gate's source (#170, split out on #262).
 *
 * The inventory generator publishes what the gates enforce by reading their source, not by
 * importing them: a gate's roots and allowlists are top-level constants, and the page has to
 * name them even when nothing exports them. These readers are that reading — intentionally
 * source readers, not a TypeScript parser, and they understand exactly the repository's current
 * shapes: top-level string arrays (optionally wrapped in `new Set`), string constants, numeric
 * constants.
 *
 * Separate from the page builder because they are separately answerable: every function here
 * is a question about a string, so the REFUSALS below are testable without running a generator
 * (`test/docs-gate.test.ts`), which is what #262 turned out to need.
 *
 * Every reader throws with the file and the constant named rather than returning a default. A
 * shape that cannot be read is a page that would publish a wrong inventory, and the generator's
 * caller (`runGenerator`) turns the throw into a non-zero exit with nothing written.
 *
 * Blind spot, named: string lexemes are masked before comment stripping, so a `//` inside
 * `'https://…'` is not read as a comment — but a string that spans lines is outside the mask
 * and would mis-strip. No gate allowlist has one.
 */

/** Comments and string lexemes in one alternation, so a `//` inside a string is never a comment. */
const COMMENT_OR_STRING = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g

/**
 * The body of a top-level flat-string-array declaration under `name`, or `undefined` when no
 * declaration under that name has this shape at all.
 *
 * Separate from `stringArray` because the two failures are different questions (#262): "there
 * is no array here" is a legitimate answer about a name-matched constant (`const MAX_ALLOWED =
 * 5`), while "there is an array here and it cannot be read" is a refusal no caller should be
 * able to confuse with the first.
 */
function stringArrayBody(source: string, name: string): string | undefined {
  const pattern = new RegExp(
    `\\bconst\\s+${name}\\b(?:\\s*:[^=]+)?\\s*=\\s*(?:new\\s+Set\\s*\\()?\\s*\\[([\\s\\S]*?)\\]`,
  )
  return pattern.exec(source)?.[1]
}

export function stringArray(source: string, name: string, file: string): string[] {
  const body = stringArrayBody(source, name)
  if (body === undefined) throw new Error(`${file}: cannot parse string array ${name}`)
  // Comments are dropped, string lexemes kept, in one pass — so a `//` inside a quoted entry
  // is never read as a comment and an entry is never read as one.
  const clean = body.replace(COMMENT_OR_STRING, (lexeme) => (lexeme.startsWith('/') ? '' : lexeme))
  const values = [...clean.matchAll(/(['"])(.*?)\1/g)].map((match) => match[2] ?? '')
  const residue = clean.replace(/(['"])(.*?)\1/g, '').replace(/[\s,]/g, '')
  // An EMPTY allowlist is a state the gates aim for (the vendor gate's import list since L6), not a parse failure.
  if (residue.length > 0) throw new Error(`${file}: ${name} is not a flat string array`)
  return values
}

export function stringConstant(source: string, name: string, file: string): string {
  const value = new RegExp(`\\bconst\\s+${name}\\b(?:\\s*:[^=]+)?\\s*=\\s*(['"])(.*?)\\1`).exec(source)?.[2]
  if (value === undefined) throw new Error(`${file}: cannot parse string constant ${name}`)
  return value
}

export function numericConstant(source: string, name: string, file: string): number {
  const value = new RegExp(`\\b(?:export\\s+)?const\\s+${name}\\b[^=]*=\\s*(\\d+(?:\\.\\d+)?)`).exec(source)?.[1]
  if (value === undefined) throw new Error(`${file}: cannot parse numeric constant ${name}`)
  return Number(value)
}

/**
 * Every allowlist-shaped constant in a gate file, for the inventory's exactness check to compare
 * against the exceptions its metadata records.
 *
 * ⚠ The name match is broad on purpose, so the SHAPE decides — and it decides on
 * `stringArrayBody`, never on a swallowed exception (#262). A `try/catch` here answered "no
 * array under this name" and "an array I cannot read flat" identically, so an allowlist written
 * as a spread, a regex literal or a nested array simply left the detected set, the exactness
 * check passed because the author never had to record it, and the page published as the
 * exception inventory with that allowlist absent. The docs gate could not see it either: it
 * diffs the page against the same generator, so both sides omitted the row. The escape hatch
 * sat exactly on the constants hardest to parse.
 */
export function detectedExceptionConstants(source: string, file: string): string[] {
  const candidates = [...source.matchAll(/^const\s+([A-Z][A-Z0-9_]*)\b/gm)]
    .map((match) => match[1] ?? '')
    .filter(
      (constantName) =>
        /(?:ALLOWED|ALLOWLIST|EXCEPTION|EXEMPT|SKIPPED|VENDORED)/.test(constantName) || constantName === 'VENDOR_ROOTS',
    )
  const detected: string[] = []
  for (const constantName of candidates) {
    // A name match that declares no array — `const MAX_ALLOWED = 5` — is not an allowlist.
    if (stringArrayBody(source, constantName) === undefined) continue
    // Read it for the refusal: an allowlist this cannot read flat is an error, not a gap.
    stringArray(source, constantName, file)
    detected.push(constantName)
  }
  return detected
}
