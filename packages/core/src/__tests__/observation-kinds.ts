import { EnsoObservation } from '../observation.ts'

/**
 * The oracle both "every observation" sweeps compare against (#53 S1.4): every `kind`
 * literal the EnsoObservation union declares, sorted. Shared so the two sweeps cannot
 * drift apart again — they did once (566e8b1 bumped one hard-coded count and not the
 * other), and a second copy of the derivation is the same drift one level up.
 *
 * Lives under `__tests__/` deliberately: the coverage manifest skips that directory, so a
 * test-only helper does not enter the denominator as an untested "library" file.
 */
export function observationKindsDeclaredByTheUnion(): string[] {
  const kinds: string[] = EnsoObservation.anyOf.map((member) => member.properties.kind.const)
  return kinds.toSorted()
}
