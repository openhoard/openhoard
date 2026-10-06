import {
  AdminGrantError,
  giveTagGrant,
  listTagGrants,
  plainLine,
  takeTagGrant,
  type TagGrant,
} from "@openhoard/core-catalog";
import { getTenant, type Database, type GrantRole, type Tx } from "@openhoard/core-db";
import { getGroup, getUser } from "@openhoard/core-identity";
import { retrying } from "./retry.js";

/*
 * `admin grant …`: the operator gives a person or a group a role on a tag, lists what people
 * have given, and takes one back. A door on core/catalog grant-admin.ts, which checks, acts and
 * audits; this file reads the arguments' meaning and writes the words.
 */

/** Where the commands write: the two streams of the admin CLI. */
export interface GrantIo {
  out: (text: string) => void;
  err: (text: string) => void;
}

/** Who a grant is for, as the operator named them and as the catalog knows them. */
export interface Named {
  principal: string;
  /** For messages: a name or an email, already on one line. */
  label: string;
}

const when = (g: Pick<TagGrant, "expiresAt">) =>
  g.expiresAt === null ? "never ends" : `ends ${g.expiresAt.toISOString().slice(0, 10)}`;

/** An AdminGrantError as a message and exit code 1; anything else is thrown on. */
function refused(e: unknown, io: GrantIo): number {
  if (!(e instanceof AdminGrantError)) throw e;
  io.err(`${plainLine(e.message)}\n`);
  return 1;
}

/** `grant add`: prints the grant's id on standard output. */
export async function grantAdd(
  db: Database,
  tenantId: string,
  who: Named,
  what: { role: GrantRole; tag: string; expiresAt?: Date | null },
  by: string,
  io: GrantIo,
): Promise<number> {
  let made: TagGrant;
  try {
    // Run again after a deadlock or serialization failure: it locks the tenant's principals.
    made = await retrying(() =>
      db.withTenant(tenantId, (tx) =>
        giveTagGrant(tx, tenantId, { principal: who.principal, ...what, by }),
      ),
    );
  } catch (e) {
    return refused(e, io);
  }
  io.out(`${made.id}\n`);
  io.err(
    `${who.label} may ${made.role === "write" ? "read and tag" : "read"} every file tagged ` +
      `${plainLine(made.tag)}, as far as the tenant's policies allow: ${when(made)}.\n`,
  );
  return 0;
}

/** `grant revoke`. */
export async function grantRevoke(
  db: Database,
  tenantId: string,
  grantId: string,
  by: string,
  io: GrantIo,
): Promise<number> {
  if (!(await db.withTenant(tenantId, (tx) => getTenant(tx, tenantId)))) {
    io.err(`no tenant ${tenantId}\n`);
    return 1;
  }
  let taken: TagGrant;
  try {
    taken = await retrying(() =>
      db.withTenant(tenantId, (tx) => takeTagGrant(tx, tenantId, { grantId, by })),
    );
  } catch (e) {
    return refused(e, io);
  }
  io.err(
    `Revoked ${taken.id}: ${taken.principal} no longer has ${taken.role} on ` +
      `${plainLine(taken.tag)} by it. What a source or another grant gives them stays.\n`,
  );
  return 0;
}

/** A principal's name for a listing; the principal itself when it is gone. */
async function nameOf(tx: Tx, tenantId: string, principal: string): Promise<string> {
  const id = principal.slice(principal.indexOf(":") + 1);
  const name = principal.startsWith("group:")
    ? (await getGroup(tx, tenantId, id))?.name
    : (await getUser(tx, tenantId, id))?.displayName;
  return plainLine(name ?? principal);
}

/**
 * `grant list`: one grant a line, newest first, tab-separated: id, role, tag, principal, their
 * name, when it ends (a date or `never`), who gave it. Imported grants aren't listed: they are
 * the source's, and there is one for every file a source shares.
 */
export async function grantList(
  db: Database,
  tenantId: string,
  who: Named | undefined,
  io: GrantIo,
): Promise<number> {
  if (!(await db.withTenant(tenantId, (tx) => getTenant(tx, tenantId)))) {
    io.err(`no tenant ${tenantId}\n`);
    return 1;
  }
  const { total, rows } = await db.withTenant(tenantId, async (tx) => {
    const found = await listTagGrants(
      tx,
      tenantId,
      who === undefined ? {} : { principal: who.principal },
    );
    const names = new Map<string, string>();
    for (const g of found.grants) {
      if (!names.has(g.principal)) names.set(g.principal, await nameOf(tx, tenantId, g.principal));
    }
    return {
      total: found.total,
      rows: found.grants.map((g) => ({ g, name: names.get(g.principal) ?? g.principal })),
    };
  });
  for (const { g, name } of rows) {
    io.out(
      [
        g.id,
        g.role,
        plainLine(g.tag),
        g.principal,
        name,
        g.expiresAt === null ? "never" : g.expiresAt.toISOString().slice(0, 10),
        plainLine(g.grantedBy),
      ].join("\t") + "\n",
    );
  }
  if (total === 0) {
    io.err(
      who === undefined
        ? `Nobody has given a grant on a tag in tenant ${tenantId}.\n`
        : `Nobody has given ${who.label} a grant on a tag by name. What a group of theirs holds is listed under --group.\n`,
    );
  } else if (total > rows.length) {
    io.err(`The newest ${rows.length} of ${total}: name a --user or a --group for theirs.\n`);
  }
  return 0;
}
