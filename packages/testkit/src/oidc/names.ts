/**
 * A guest's display name without the trailing company, e.g. "Sam Rossi (Acme Corp)" becomes
 * "Sam Rossi". Uses lastIndexOf, not a regex: display names come from the directory.
 */
export function personalName(displayName: string): string {
  const at = displayName.lastIndexOf(" (");
  return at > 0 && displayName.endsWith(")") ? displayName.slice(0, at) : displayName;
}
