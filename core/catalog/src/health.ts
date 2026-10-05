import { isId, queryRows, type SHARE_KINDS, type Tx } from "@openhoard/core-db";
import { isAdmin } from "@openhoard/core-identity";
import { sql, type SQL } from "drizzle-orm";
import { requireSnapshot } from "./visibility.js";

/*
 * The File Health Report's queries (T-1001): what a tenant's admin should look at in the files
 * OpenHoard indexes, found from what the catalog already holds.
 *
 * | section          | a file is listed when …                                              |
 * | ---------------- | -------------------------------------------------------------------- |
 * | `publicLinks`    | its source shares it by a link anyone can open                       |
 * | `organization`   | its source shares it with the whole organization (a link for it, or  |
 * |                  | "everyone"), or a group holding most of the tenant's people has a    |
 * |                  | grant that reaches it                                                |
 * | `sensitiveWide`  | it is in `organization` or `publicLinks` and carries a trusted tag   |
 * |                  | whose value restricts it (visibility hidden, or exposure metadata    |
 * |                  | only or local only)                                                  |
 * | `guests`         | its source shares it with someone outside, or a guest (or a group a  |
 * |                  | guest is in) holds a grant that reaches it                           |
 * | `formerStaff`    | someone who has left (locked, disabled by the identity provider, or  |
 * |                  | retired, and not provisioned again since) made it, changed it last,  |
 * |                  | owns it, or still holds a grant that reaches it                      |
 * | `unmatched`      | its source shares it with a person or group OpenHoard doesn't know:  |
 * |                  | they get nothing here until they are provisioned                     |
 * | `stale`          | its source last saw it change longer ago than `staleAfterDays`       |
 * | `duplicates`     | another live file has the same content (byte for byte)               |
 * | `large`          | it is larger than `largeBytes`                                       |
 *
 * A grant reaches a file when it is live and on the file itself or on a tag the file carries
 * as a trusted tag (not a model's unreviewed guess), as authorize() reads grants.
 *
 * Where it comes from: sharing beyond grants is what core/jobs keeps of a source's permissions
 * (core/db source_shares), read while it hasn't lapsed; who made and changed a file, and when,
 * is what the source said when the file was last synced (source_refs), matched to people by
 * the id the identity provider gave them; grants, people and content are the catalog's own.
 *
 * What it can't say, and says so where it can count it:
 * - a file no source dated is not judged for `stale` (`undated`); one no source named a maker
 *   or changer of is not judged for those (`unattributed`); one whose maker or changer matches
 *   nobody the identity provider provisioned here is counted, not listed (`unknownPeople`):
 *   unknown is not the same as gone. Makers and changers are matched by that id only, so a
 *   tenant of local accounts has all of its files there, and none "made by" anyone;
 * - what someone who left can still reach through a group they are in is not listed file by
 *   file (`formerStaffInGroups` counts those people): that is the directory's to mend;
 * - sharing is known only for sources whose permissions are imported, and for files synced
 *   since they have been kept: complete after the source's next full crawl. A file with none
 *   kept reads as not shared;
 * - a file every member can find or read by its visibility level alone is not listed: levels
 *   are the tenant's own setting, explained by explainLevels();
 * - pack rules that permit beyond grants are not followed.
 *
 * FOR TENANT ADMINS ONLY, like whoCanAccess(): it names files by their real titles, whoever
 * may read them, and people by what the source calls them. healthReport() checks the asker is
 * an admin itself. It gives nobody access to a file: opening one still goes through the gate.
 *
 * Runs in a snapshot (VIEW_TRANSACTION). Each section is one or two statements over the
 * tenant's live files, each reading every file's current version; the sections that follow
 * grants do so file by file. Not measured on a large tenant.
 */

export const HEALTH_SECTIONS = [
  "publicLinks",
  "organization",
  "sensitiveWide",
  "guests",
  "formerStaff",
  "unmatched",
  "stale",
  "duplicates",
  "large",
] as const;
export type HealthSection = (typeof HEALTH_SECTIONS)[number];

export interface HealthOptions {
  /** Files listed per section, at most (1 to 10,000). Default 100. Counts are of all. */
  limit?: number;
  /** A file unchanged at its source for this many days is stale. Default 1095 (three years). */
  staleAfterDays?: number;
  /** A file over this many bytes is large. Default 1 GiB. */
  largeBytes?: number;
  /**
   * A group counts as "most of the tenant" when it holds at least this share of the tenant's
   * current members (0 to 1, above 0). Default 0.5. Groups of fewer than `wideGroupMin` people
   * (default 10) never do, so a three-person tenant's team isn't "everyone".
   */
  wideGroupShare?: number;
  wideGroupMin?: number;
  /** The moment files are stale as of. Default: the database's clock. */
  asOf?: Date;
}

export interface HealthItem {
  objectId: string;
  title: string;
  /** The connection it is synced from, and where people find it there; null when not synced. */
  source: string | null;
  url: string | null;
  /** Its current content's size in bytes. */
  bytes: number;
  /**
   * Why it is listed, piece by piece, for whoever words it for people (health-format.ts
   * reasonText()). Names in it are the tenant's own text, some from a source: data.
   */
  reasons: HealthReason[];
  /** The reasons in one compact line, for logs and sheets: `link-anyone (read, until …)`. */
  detail: string;
}

type Role = "read" | "write" | "owner";

/** One reason a file is listed. `tag`: the grant is on that tag, which the file carries. */
export type HealthReason =
  /** What the source shares it with beyond grants (core/db source_shares). */
  | {
      k: "share";
      share: (typeof SHARE_KINDS)[number];
      /** A guest's email, or the source's id of a person or group; empty otherwise. */
      who: string;
      role: Role;
      /** The day it lapses (YYYY-MM-DD, UTC), or null. */
      until: string | null;
    }
  /** A group holding most of the tenant's people has a grant reaching it. */
  | { k: "group"; name: string; members: number; role: Role; tag: string | null }
  /** A trusted tag that restricts it. */
  | { k: "label"; tag: string }
  /** A guest holds a grant reaching it, theirs or (`via`) a group's they are in. */
  | { k: "guest"; name: string; via: string | null; role: Role; tag: string | null }
  /** Someone who left made it, changed it last, or owns it. */
  | { k: "made" | "changed" | "owned"; name: string }
  /** Someone who left still holds a grant reaching it. */
  | { k: "former"; name: string; role: Role; tag: string | null }
  | { k: "stale"; since: string }
  | { k: "copies"; others: number }
  | { k: "large"; over: number };

/** The reasons in one compact line (HealthItem.detail). */
function compact(reasons: readonly HealthReason[]): string {
  const through = (r: { role: Role; tag: string | null }) =>
    `${r.role}${r.tag === null ? "" : ` through ${r.tag}`}`;
  const parts: string[] = [];
  const labels = reasons.flatMap((r) => (r.k === "label" ? [r.tag] : []));
  if (labels.length > 0) parts.push(labels.join(", "));
  const former = reasons.flatMap((r) => (r.k === "former" ? [`${r.name} (${through(r)})`] : []));
  for (const r of reasons) {
    switch (r.k) {
      case "share":
        parts.push(
          `${r.share}${r.who === "" || r.share.startsWith("link-") ? "" : ` ${r.who}`} (${r.role}${r.until === null ? "" : `, until ${r.until}`})`,
        );
        break;
      case "group":
        parts.push(`group ${r.name} (${r.members} people, ${through(r)})`);
        break;
      case "guest":
        parts.push(
          `grant to ${r.name}${r.via === null ? "" : ` in group ${r.via}`} (${through(r)})`,
        );
        break;
      case "made":
        parts.push(`made by ${r.name}`);
        break;
      case "changed":
        parts.push(`last changed by ${r.name}`);
        break;
      case "owned":
        parts.push(`owned by ${r.name}`);
        break;
      case "stale":
        parts.push(`unchanged since ${r.since}`);
        break;
      case "copies":
        parts.push(`same content as ${r.others} other file${r.others === 1 ? "" : "s"}`);
        break;
      case "large":
        parts.push(`over ${r.over} bytes`);
        break;
      default:
        break;
    }
  }
  if (former.length > 0) parts.push(`still granted to ${former.join(", ")}`);
  return parts.join("; ");
}

export interface HealthFinding {
  /** Files in the section. */
  count: number;
  /** Their bytes; for `duplicates`, the bytes the extra copies take. */
  bytes: number;
  /** The first `limit`, worst first. */
  items: HealthItem[];
}

export interface HealthReport {
  generatedAt: Date;
  /** The tenant's live files, and their current content's bytes. */
  files: number;
  bytes: number;
  /** Live files a source hasn't dated: not judged for `stale`. */
  undated: number;
  /** Live files with no word from a source on who made or changed them. */
  unattributed: number;
  /**
   * Live files whose maker or last changer, as the source names them, matches nobody the
   * identity provider ever provisioned here: someone who left before OpenHoard was connected,
   * or a tenant whose people are local accounts (which have no such id to match).
   */
  unknownPeople: number;
  /**
   * People who have left and are still members of a group. What their groups can read isn't
   * listed file by file under `formerStaff` (it would be every file of a site): take them out
   * of the groups.
   */
  formerStaffInGroups: number;
  /** What the findings were judged by: the options, with their defaults filled in. */
  thresholds: {
    staleAfterDays: number;
    largeBytes: number;
    wideGroupShare: number;
    wideGroupMin: number;
  };
  sections: Record<HealthSection, HealthFinding>;
}

export class HealthError extends Error {
  constructor(
    readonly code: "not-admin" | "invalid",
    message: string,
  ) {
    super(message);
    this.name = "HealthError";
  }
}

interface Row extends Record<string, unknown> {
  object_id: string;
  title: string;
  source: string | null;
  url: string | null;
  bytes: number | string | null;
  detail: string | null;
}
interface Total extends Record<string, unknown> {
  n: number | string;
  bytes: number | string | null;
}

/** A person who has left: any of the three stops (core/identity). */
const LEFT = sql`(u.locked_at is not null or u.provider_disabled_at is not null or u.retired_at is not null)`;

/**
 * The tenant's File Health Report, for one of its admins. Throws HealthError `not-admin` when
 * `asker` isn't one now, `invalid` for options out of range.
 */
export async function healthReport(
  tx: Tx,
  tenantId: string,
  asker: { userId: string; adminGroupId?: string | undefined },
  options: HealthOptions = {},
): Promise<HealthReport> {
  await requireSnapshot(tx, "healthReport");
  const limit = options.limit ?? 100;
  const staleAfterDays = options.staleAfterDays ?? 1095;
  const largeBytes = options.largeBytes ?? 1024 ** 3;
  const wideShare = options.wideGroupShare ?? 0.5;
  const wideMin = options.wideGroupMin ?? 10;
  const whole = (n: number, min: number, max: number) =>
    Number.isSafeInteger(n) && n >= min && n <= max;
  if (
    !whole(limit, 1, 10_000) ||
    !whole(staleAfterDays, 1, 36_500) ||
    !whole(largeBytes, 1, Number.MAX_SAFE_INTEGER) ||
    !whole(wideMin, 1, 1_000_000_000) ||
    !(wideShare > 0 && wideShare <= 1)
  ) {
    throw new HealthError("invalid", "a health report option is out of range");
  }
  if (options.asOf !== undefined && !Number.isFinite(options.asOf.getTime())) {
    throw new HealthError("invalid", "asOf is not a time");
  }
  const asOf =
    options.asOf === undefined ? sql`now()` : sql`${options.asOf.toISOString()}::timestamptz`;
  const admin =
    typeof asker.userId === "string" &&
    isId("user", asker.userId) &&
    (await isAdmin(tx, tenantId, asker.userId, {
      ...(asker.adminGroupId === undefined ? {} : { adminGroupId: asker.adminGroupId }),
    }));
  if (!admin) throw new HealthError("not-admin", "the file health report is for tenant admins");

  /*
   * `f`: every live file with its current version's content and its source reference (the
   * first, should it have several). Each section selects from it.
   */
  const files = sql`
    select o.id as object_id, o.title, o.owner_id, cur.blob_id, b.size as bytes,
           r.source, r.url, r.source_modified_at, r.source_modified_by, r.source_created_by
      from objects o
      join lateral (select v.blob_id from versions v
                     where v.tenant_id = o.tenant_id and v.object_id = o.id
                     order by v.seq desc limit 1) cur on true
      join blobs b on b.tenant_id = o.tenant_id and b.id = cur.blob_id
      left join lateral (select s.source, s.url, s.source_modified_at, s.source_modified_by,
                                s.source_created_by
                           from source_refs s
                          where s.tenant_id = o.tenant_id and s.object_id = o.id
                          order by s.source, s.external_id limit 1) r on true
     where o.tenant_id = ${tenantId} and o.deleted_at is null`;

  /** A section: the files `where` keeps, with `detail`, in `order`; counted and summed whole. */
  const section = async (
    detail: SQL,
    where: SQL,
    order: SQL,
    more: { with?: SQL; bytes?: SQL } = {},
  ): Promise<HealthFinding> => {
    const withs =
      more.with === undefined
        ? sql`with f as (${files}), ${gone}`
        : sql`with f as (${files}), ${gone}, ${more.with}`;
    const [total] = await queryRows<Total>(
      tx,
      sql`${withs} select count(*)::int as n, coalesce(sum(${more.bytes ?? sql`f.bytes`}), 0) as bytes
            from f where ${where}`,
    );
    const count = Number(total?.n ?? 0);
    const rows =
      count === 0
        ? []
        : await queryRows<Row>(
            tx,
            sql`${withs} select f.object_id, f.title, f.source, f.url, f.bytes,
                         coalesce(${detail}, '[]'::jsonb)::text as detail
                  from f where ${where} order by ${order}, f.object_id limit ${limit}`,
          );
    return {
      count,
      bytes: Number(total?.bytes ?? 0),
      items: rows.map((r) => {
        const reasons = JSON.parse(r.detail ?? "[]") as HealthReason[];
        return {
          objectId: r.object_id,
          title: r.title,
          source: r.source,
          url: r.url,
          bytes: Number(r.bytes ?? 0),
          reasons,
          detail: compact(reasons),
        };
      }),
    };
  };

  /*
   * `stopped`: the people who left, by their id here (for what they own or hold). `gone`: by
   * the id their identity provider gave them (for what a source says they made or changed),
   * unless someone current holds that id now: provisioned again, they haven't left.
   */
  const gone = sql`stopped as (
    select u.id, u.external_id, u.display_name
      from users u where u.tenant_id = ${tenantId} and ${LEFT}),
  gone as (
    select u.external_id, u.display_name
      from stopped u
     where u.external_id is not null
       and not exists (select 1 from users c
                        where c.tenant_id = ${tenantId} and c.external_id = u.external_id
                          and c.retired_at is null and c.locked_at is null
                          and c.provider_disabled_at is null))`;

  /** A share that hasn't lapsed, as `s`, of the file. */
  const liveShare = (kinds: SQL) => sql`s.tenant_id = ${tenantId} and s.object_id = f.object_id
      and s.kind in (${kinds}) and (s.expires_at is null or s.expires_at > now())`;
  /** Reasons (jsonb arrays, null for none) joined into one array. */
  const all = (...parts: SQL[]) =>
    sql.join(
      parts.map((part) => sql`coalesce(${part}, '[]'::jsonb)`),
      sql` || `,
    );
  /** A file's shares of some kinds that haven't lapsed, as reasons. */
  const shares = (kinds: SQL) => sql`
    (select jsonb_agg(jsonb_build_object(
              'k', 'share', 'share', s.kind, 'who', s.key, 'role', s.role,
              'until', to_char(s.expires_at at time zone 'UTC', 'YYYY-MM-DD'))
              order by s.kind, s.key)
       from source_shares s where ${liveShare(kinds)})`;
  const shared = (kinds: SQL) =>
    sql`exists (select 1 from source_shares s where ${liveShare(kinds)})`;
  /*
   * The live grants that reach the file, as a table to select from: those on the file, and
   * those on a tag it carries as a trusted tag (`tag` says which). Two arms, so each uses its
   * index (grants by object; the file's tags, then grants by tag).
   */
  const live = sql`g.revoked_at is null and (g.expires_at is null or g.expires_at > now())`;
  const reaching = sql`(
      select g.principal, g.role, g.granted_by, null::text as tag
        from grants g
       where g.tenant_id = ${tenantId} and g.object_id = f.object_id and ${live}
      union all
      select g.principal, g.role, g.granted_by, gt.facet || ':' || gt.value
        from object_tags gt
        join grants g on g.tenant_id = gt.tenant_id and g.facet = gt.facet and g.value = gt.value
       where gt.tenant_id = ${tenantId} and gt.object_id = f.object_id
         and (gt.source <> 'model' or gt.reviewed) and ${live}) g`;
  // Groups that hold most of the tenant's current members.
  const wide = sql`wide as (
    select g.id, g.name, count(*)::int as members
      from groups g
      join group_members gm on gm.tenant_id = g.tenant_id and gm.group_id = g.id
      join users u on u.tenant_id = gm.tenant_id and u.id = gm.user_id
     where g.tenant_id = ${tenantId} and u.kind = 'member' and u.retired_at is null
       and u.locked_at is null and u.provider_disabled_at is null
     group by g.id, g.name
    having count(*) >= ${wideMin}
       and count(*) >= ${wideShare}::float8 * (
             select count(*) from users m
              where m.tenant_id = ${tenantId} and m.kind = 'member' and m.retired_at is null
                and m.locked_at is null and m.provider_disabled_at is null))`;
  const toWide = sql`g.principal = 'group:' || w.id`;
  const wideGrant = sql`exists (select 1 from ${reaching} join wide w on ${toWide})`;
  const orgKinds = sql`'link-organization', 'organization'`;
  const everyone = sql`(${shared(orgKinds)} or ${wideGrant})`;
  const everyoneDetail = all(
    shares(orgKinds),
    sql`(select jsonb_agg(distinct jsonb_build_object(
                  'k', 'group', 'name', w.name, 'members', w.members, 'role', g.role, 'tag', g.tag))
           from ${reaching} join wide w on ${toWide})`,
  );
  // Trusted tags (not a model's unreviewed guess) whose value restricts the file: the tightest
  // visibility, or an exposure that keeps content from commercial AI clients.
  const sensitive = sql`
    (select jsonb_agg(jsonb_build_object('k', 'label', 'tag', t.facet || ':' || t.value)
                      order by t.facet, t.value)
       from object_tags t
       join facet_values fv on fv.tenant_id = t.tenant_id and fv.facet = t.facet and fv.value = t.value
      where t.tenant_id = ${tenantId} and t.object_id = f.object_id
        and (t.source <> 'model' or t.reviewed) and fv.approved
        and (fv.visibility = 'hidden' or fv.exposure in ('metadata-only', 'local-only')))`;

  /** Who left, by what the source calls them (`column` is an id there), or null. */
  const leftBy = (column: SQL) =>
    sql`(select min(gone.display_name) from gone where gone.external_id = ${column})`;
  const leftOwner = sql`(select min(u.display_name) from stopped u where 'user:' || u.id = f.owner_id)`;
  const leftGrants = sql`
    (select jsonb_agg(distinct jsonb_build_object(
              'k', 'former', 'name', u.display_name, 'role', g.role, 'tag', g.tag))
       from ${reaching} join stopped u on g.principal = 'user:' || u.id)`;
  /** One reason naming a person, when there is one. */
  const named = (k: string, name: SQL) =>
    sql`(select jsonb_build_array(jsonb_build_object('k', ${k}::text, 'name', n.name))
           from (select ${name} as name) n where n.name is not null)`;
  /*
   * Guests a grant reaching the file is for: theirs, or their group's (`via` names it). `u` is
   * the guest. Someone outside reads what their groups read, like anyone.
   */
  const guestHolders = sql`${reaching}
      join lateral (
        select u.display_name, u.email, null::text as via
          from users u
         where u.tenant_id = ${tenantId} and g.principal = 'user:' || u.id and u.kind = 'guest'
           and u.retired_at is null
        union all
        select u.display_name, u.email, gr.name
          from group_members gm
          join groups gr on gr.tenant_id = gm.tenant_id and gr.id = gm.group_id
          join users u on u.tenant_id = gm.tenant_id and u.id = gm.user_id
         where gm.tenant_id = ${tenantId} and g.principal = 'group:' || gm.group_id
           and u.kind = 'guest' and u.retired_at is null) u on true`;
  /** Whether the source's id for a person is anyone's here, ever. */
  const known = (column: SQL) => sql`exists (
    select 1 from users u where u.tenant_id = ${tenantId} and u.external_id = ${column})`;

  const [totals] = await queryRows<
    Total & { undated: number; unattributed: number; unknown_people: number; in_groups: number }
  >(
    tx,
    sql`with f as (${files})
        select count(*)::int as n, coalesce(sum(f.bytes), 0) as bytes,
               (count(*) filter (where f.source_modified_at is null))::int as undated,
               (count(*) filter (where f.source_modified_by is null
                                   and f.source_created_by is null))::int as unattributed,
               (count(*) filter (where
                    (f.source_created_by is not null and not ${known(sql`f.source_created_by`)})
                 or (f.source_modified_by is not null and not ${known(sql`f.source_modified_by`)})
               ))::int as unknown_people,
               (select count(distinct gm.user_id)::int
                  from group_members gm join users u on u.tenant_id = gm.tenant_id
                                                    and u.id = gm.user_id
                 where gm.tenant_id = ${tenantId} and ${LEFT}) as in_groups
          from f`,
  );

  const sections: Record<HealthSection, HealthFinding> = {
    publicLinks: await section(
      shares(sql`'link-anyone'`),
      shared(sql`'link-anyone'`),
      sql`f.bytes desc`,
    ),
    organization: await section(everyoneDetail, everyone, sql`f.bytes desc`, { with: wide }),
    sensitiveWide: await section(
      all(sensitive, shares(sql`'link-anyone'`), everyoneDetail),
      sql`${sensitive} is not null and (${everyone} or ${shared(sql`'link-anyone'`)})`,
      sql`f.bytes desc`,
      { with: wide },
    ),
    guests: await section(
      // (A guest the source names by invitation, who has an account, holds its grant too:
      // said once, as the share.)
      all(
        shares(sql`'guest'`),
        sql`(select jsonb_agg(distinct jsonb_build_object(
                      'k', 'guest', 'name', u.display_name, 'via', u.via, 'role', g.role,
                      'tag', g.tag))
               from ${guestHolders}
              where not (u.via is null and g.granted_by like 'source:%' and exists (
                      select 1 from source_shares s
                       where ${liveShare(sql`'guest'`)} and s.matched
                         and lower(s.key) = lower(u.email))))`,
      ),
      sql`(${shared(sql`'guest'`)} or exists (select 1 from ${guestHolders}))`,
      sql`f.bytes desc`,
    ),
    formerStaff: await section(
      all(
        named("made", leftBy(sql`f.source_created_by`)),
        named("changed", leftBy(sql`f.source_modified_by`)),
        named("owned", leftOwner),
        leftGrants,
      ),
      sql`(${leftBy(sql`f.source_created_by`)} is not null
           or ${leftBy(sql`f.source_modified_by`)} is not null
           or ${leftOwner} is not null or ${leftGrants} is not null)`,
      sql`f.bytes desc`,
    ),
    unmatched: await section(
      shares(sql`'user', 'group'`),
      shared(sql`'user', 'group'`),
      sql`f.bytes desc`,
    ),
    stale: await section(
      sql`jsonb_build_array(jsonb_build_object('k', 'stale', 'since',
            to_char(f.source_modified_at at time zone 'UTC', 'YYYY-MM-DD')))`,
      sql`f.source_modified_at < ${asOf} - make_interval(days => ${staleAfterDays})`,
      sql`f.source_modified_at`,
    ),
    duplicates: await section(
      sql`(select jsonb_build_array(jsonb_build_object('k', 'copies', 'others', d.copies - 1))
             from d where d.blob_id = f.blob_id)`,
      sql`f.blob_id in (select d.blob_id from d)`,
      sql`f.bytes desc, f.blob_id`,
      {
        // Empty files are all alike, and no waste.
        with: sql`d as (select f.blob_id, count(*)::int as copies from f
                         where f.bytes > 0 group by f.blob_id having count(*) > 1)`,
      },
    ),
    large: await section(
      sql`jsonb_build_array(jsonb_build_object('k', 'large', 'over', ${largeBytes}::bigint))`,
      sql`f.bytes > ${largeBytes}`,
      sql`f.bytes desc`,
    ),
  };
  // What the copies beyond the first of each take.
  const [wasted] = await queryRows<Total>(
    tx,
    sql`with f as (${files})
        select count(*)::int as n, coalesce(sum(x.waste), 0) as bytes
          from (select (count(*) - 1) * max(f.bytes) as waste from f
                 where f.bytes > 0 group by f.blob_id having count(*) > 1) x`,
  );
  sections.duplicates.bytes = Number(wasted?.bytes ?? 0);

  const [clock] = await queryRows<{ now: Date | string }>(tx, sql`select now() as now`);
  return {
    generatedAt: new Date(clock?.now ?? Date.now()),
    files: Number(totals?.n ?? 0),
    bytes: Number(totals?.bytes ?? 0),
    undated: Number(totals?.undated ?? 0),
    unattributed: Number(totals?.unattributed ?? 0),
    unknownPeople: Number(totals?.unknown_people ?? 0),
    formerStaffInGroups: Number(totals?.in_groups ?? 0),
    thresholds: { staleAfterDays, largeBytes, wideGroupShare: wideShare, wideGroupMin: wideMin },
    sections,
  };
}
