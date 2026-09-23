/** A caller as the rest of the core sees it, after SSO/SCIM have resolved who they are. */
export interface Subject {
  userId: string;
  groupIds: readonly string[];
  /** Tags this user has been granted access to directly or through groups (e.g. "client:acme"). */
  tagGrants: readonly string[];
}

/**
 * The principal set is what search filters and the policy engine match against.
 * Keys are namespaced so a group named "steve" can't collide with user "steve".
 */
export function principalSet(subject: Subject): string[] {
  return [
    `user:${subject.userId}`,
    ...subject.groupIds.map((g) => `group:${g}`),
    ...subject.tagGrants.map((t) => `tag:${t}`),
  ].filter((v, i, all) => all.indexOf(v) === i);
}

/** True when any principal of the caller appears in a file's `visible_to` list. */
export function canSee(visibleTo: readonly string[], principals: readonly string[]): boolean {
  const set = new Set(principals);
  return visibleTo.some((p) => set.has(p));
}
