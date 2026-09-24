import type { FakeItem, FakeTenant, FakeUser } from "./types.js";

/**
 * Ground truth for "who can read this item", computed from the source ACLs the way a correct
 * permission import would:
 *
 * - `user:<id>` grants that user; `group:<id>` grants every direct member;
 * - `guest:<upn>` grants the guest account with that sign-in name;
 * - `anyone-with-link` grants NOBODY search visibility: holding a link is not membership, so a
 *   link-shared file must not show up in anyone's search results through that link;
 * - users who have left (`active: false`) can no longer sign in, so they read nothing.
 */
export class AccessModel {
  private readonly users: Map<string, FakeUser>;
  private readonly members: Map<string, readonly string[]>;
  private readonly guestByUpn: Map<string, string>;
  private readonly readers = new Map<string, ReadonlySet<string>>();

  constructor(private readonly tenant: FakeTenant) {
    this.users = new Map(tenant.users.map((u) => [u.id, u]));
    this.members = new Map(tenant.groups.map((g) => [g.id, g.members]));
    this.guestByUpn = new Map(tenant.users.filter((u) => u.guest).map((u) => [u.upn, u.id]));
  }

  /** Active user ids that can read the item. */
  readersOf(item: FakeItem): ReadonlySet<string> {
    const cached = this.readers.get(item.id);
    if (cached) return cached;
    const out = new Set<string>();
    for (const entry of item.acl) {
      for (const userId of this.expand(entry.principal)) {
        if (this.users.get(userId)?.active) out.add(userId);
      }
    }
    this.readers.set(item.id, out);
    return out;
  }

  canRead(userId: string, item: FakeItem): boolean {
    return this.readersOf(item).has(userId);
  }

  /** Items the user can read, in tenant order. */
  readableBy(userId: string): FakeItem[] {
    return this.tenant.items.filter((i) => this.canRead(userId, i));
  }

  /**
   * The principal keys a correct identity layer gives the user: namespaced user and group keys
   * (`user:<id>`, `group:<id>`, as core/identity's userPrincipal() and groupPrincipal() write
   * them, so a group named like a user never collides), and a guest key for this fake tenant's
   * guests.
   */
  principalsOf(userId: string): string[] {
    const user = this.users.get(userId);
    if (!user) throw new RangeError(`unknown user ${userId}`);
    const groups = this.tenant.groups
      .filter((g) => g.members.includes(userId))
      .map((g) => `group:${g.id}`);
    return [`user:${userId}`, ...groups, ...(user.guest ? [`guest:${user.upn}`] : [])];
  }

  private expand(principal: string): readonly string[] {
    if (principal.startsWith("user:")) return [principal.slice("user:".length)];
    if (principal.startsWith("group:"))
      return this.members.get(principal.slice("group:".length)) ?? [];
    if (principal.startsWith("guest:")) {
      const id = this.guestByUpn.get(principal.slice("guest:".length));
      return id ? [id] : [];
    }
    return []; // "anyone-with-link" and anything unknown: fail closed.
  }
}
