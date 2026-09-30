/**
 * Canonical tool identity (#4, gap 2).
 *
 * pi's built-in tools are lowercase (`bash`, `write`), but Claude-Code-style packages
 * register capitalised names (`Bash`, `Write`), so two naming conventions can be live in
 * one process. A case-sensitive
 * comparison against a policy name silently misses the variant: the call proceeds, the
 * guard never fires, and nothing reports the miss. That is the silence-as-refusal class
 * this module closes.
 *
 * Every comparison of a tool name to a policy name goes through this fold — on BOTH
 * sides — so a case variant can never skip a guard branch. One function, no mapping
 * table: the only consumer today is our own comparisons, and a name-translation table
 * belongs to the allow-store work deferred with the #4 arbiter.
 *
 * @group Guard predicates
 */
export function canonicalToolName(name: string): string {
  return name.toLowerCase()
}
