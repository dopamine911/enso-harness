/**
 * What every generator under `scripts/docs/` shares (#174): the exhaustiveness check that
 * makes a metadata table refuse to be stale, and the one way a generator runs — its page to
 * stdout, or one `name: reason` line to stderr and a non-zero exit, never a partial page.
 */

/**
 * `detected` (read from source) and `recorded` (the generator's metadata keys) must be the
 * same set, and `detected` must not repeat — a repeat means the detector matched one thing
 * twice, which a set comparison alone would hide.
 */
export function assertExactKeys(label: string, detected: readonly string[], recorded: readonly string[]): void {
  const detectedSet = new Set(detected)
  const recordedSet = new Set(recorded)
  const duplicates = detected.filter((key, index) => detected.indexOf(key) !== index)
  const missing = detected.filter((key) => !recordedSet.has(key))
  const stale = recorded.filter((key) => !detectedSet.has(key))
  if (duplicates.length > 0 || missing.length > 0 || stale.length > 0) {
    throw new Error(
      `${label} metadata mismatch; duplicate detections: ${[...new Set(duplicates)].join(', ') || 'none'}; ` +
        `missing: ${missing.join(', ') || 'none'}; absent from source: ${stale.join(', ') || 'none'}`,
    )
  }
}

/**
 * Run a generator: the whole page is built before a byte is written, so a refusal leaves
 * stdout empty and the caller's redirect target untouched only if the caller checks the
 * exit code — which `docs-gate` does, and a plain `>` does not.
 */
export function runGenerator(name: string, generate: () => string): void {
  try {
    process.stdout.write(generate())
  } catch (error) {
    process.stderr.write(`${name}: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
