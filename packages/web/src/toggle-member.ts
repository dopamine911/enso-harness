/** `members` with `member` added, or taken out when it was in — a legend's or a list's open set. */
export function toggleMember<Member>(members: ReadonlySet<Member>, member: Member): Set<Member> {
  const next = new Set(members)
  if (!next.delete(member)) next.add(member)
  return next
}
