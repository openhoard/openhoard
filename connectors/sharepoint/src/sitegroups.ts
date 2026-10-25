import { createHash } from "node:crypto";
import { ConnectorError, normalizeAcl, type AclEntry, type AclPrincipal } from "@openhoard/sdk";
import type { GraphAuth } from "./auth.js";
import { graphClient, type GraphClient } from "./graph.js";
import { memberOf } from "./permissions.js";

/*
 * Who is in a site's SharePoint groups (T-305). Most files on a SharePoint site are shared
 * through its Owners, Members and Visitors groups, which Graph names by id and nothing more.
 * SharePoint's own REST API says who is in one
 * (`{site}/_api/web/sitegroups/getbyid({id})/users`): people, Entra and Microsoft 365 groups,
 * everyone. Each permission given to a SharePoint group becomes the same permission for each
 * of them (memberOf() says who they are here).
 *
 * SharePoint takes app-only tokens only from an app that signs in with a certificate, and the
 * app needs SharePoint's own `Sites.Selected` (or `Sites.Read.All`) besides Graph's, with the
 * site granted as for Graph. Without a certificate there is nothing to ask, and a SharePoint
 * group grants nobody, as before.
 *
 * A group's members are asked once in {@link MEMBERS_MS} and kept in memory for the items
 * recorded meanwhile. Nothing about a file changes when someone leaves a group, so Graph's delta
 * says nothing of it. So the connector's cursor keeps, for each group its files were recorded
 * with, which answer they were recorded with ({@link SiteGroups.recorded}), or MIXED when they
 * were recorded with more than one (someone left mid-crawl); each delta run asks the groups
 * again ({@link SiteGroups.fresh}) and crawls again when an answer differs. Someone removed from
 * Members loses its files from the next sync on, as that crawl records each again. A group
 * SharePoint won't show (its membership hidden from the app, or the app without
 * SharePoint's permission: 401 or 403) grants nobody, as before this, and the rest goes on; the
 * run counts it among the groups that matched nobody, and the tenant check says why.
 */

/** A group whose files were recorded with more than one answer: no fresh answer matches it. */
export const MIXED = "mixed";

/** How long a group's members are taken as they were. */
export const MEMBERS_MS = 15 * 60_000;
export const GROUP_ID = /^\d{1,10}$/;

export interface SiteGroups {
  /** An item's entries, each SharePoint group's replaced by its members'. */
  expand(entries: readonly AclEntry[], site: string, signal: AbortSignal): Promise<AclEntry[]>;
  /** The answer SharePoint gives for the group now (a digest), asked again; what follows uses it. */
  fresh(id: string, signal: AbortSignal): Promise<string>;
  /** Each group expanded since the last forget(): the answer items got, or MIXED for several. */
  recorded(): Map<string, string>;
  /** Starts over what recorded() says (a crawl from the beginning). */
  forget(): void;
}

interface Answer {
  members: AclPrincipal[] | undefined;
  digest: string;
}

function answerOf(members: AclPrincipal[] | undefined): Answer {
  const who = members === undefined ? ["?"] : members.map((p) => JSON.stringify(p)).sort();
  return {
    members,
    digest: createHash("sha256").update(JSON.stringify(who)).digest("hex").slice(0, 16),
  };
}

export function siteGroups(o: {
  auth: GraphAuth;
  /** The site's address as Graph gives it (`webUrl`), on a host the source allows. */
  webUrl: string;
  /** The Graph client's: SharePoint's limits are the tenant's too. */
  pacer: GraphClient["pacer"];
  now: () => number;
  fetch?: typeof fetch;
  maxWaitMs?: number;
}): SiteGroups {
  const site = new URL(o.webUrl);
  const client = graphClient({
    // The same app, its token for SharePoint's origin instead of Graph's.
    auth: {
      graph: site.origin,
      appToken: (signal) => o.auth.appToken(signal, site.origin),
      forget: (token) => o.auth.forget(token),
    },
    pacer: o.pacer,
    now: o.now,
    ...(o.fetch === undefined ? {} : { fetch: o.fetch }),
    ...(o.maxWaitMs === undefined ? {} : { maxWaitMs: o.maxWaitMs }),
  });
  const kept = new Map<string, { at: number; answer: Promise<Answer> }>();
  /** The answers given to items, by group, since forget(). */
  const given = new Map<string, Set<string>>();

  /** The group's members; undefined when SharePoint won't show them. */
  async function ask(id: string, signal: AbortSignal): Promise<AclPrincipal[] | undefined> {
    const path = `${site.pathname.replace(/\/$/, "")}/_api/web/sitegroups/getbyid(${id})/users`;
    let answer: Record<string, unknown>;
    try {
      answer = await client.json(path, signal, {
        headers: { accept: "application/json;odata=nometadata" },
      });
    } catch (e) {
      if (e instanceof ConnectorError && e.code === "not-found") return []; // a group since removed
      if (e instanceof ConnectorError && e.code === "auth") return undefined;
      throw e;
    }
    if (!Array.isArray(answer.value)) {
      throw new ConnectorError("retryable", "SharePoint's answer wasn't a list of users");
    }
    return answer.value.map(memberOf).filter((p): p is AclPrincipal => p !== undefined);
  }

  function answer(id: string, signal: AbortSignal, fresh = false): Promise<Answer> {
    const had = kept.get(id);
    if (!fresh && had && o.now() - had.at < MEMBERS_MS) return had.answer;
    const asked = ask(id, signal).then(answerOf);
    kept.set(id, { at: o.now(), answer: asked });
    // A failure isn't kept: the next item asks again.
    asked.catch(() => kept.delete(id));
    return asked;
  }

  return {
    async expand(entries, siteId, signal) {
      const prefix = `sitegroup:${siteId}:`;
      const out: AclEntry[] = [];
      for (const entry of entries) {
        const { principal } = entry;
        const id = principal.kind === "group" ? principal.id.slice(prefix.length) : "";
        if (principal.kind !== "group" || !principal.id.startsWith(prefix) || !GROUP_ID.test(id)) {
          out.push(entry);
          continue;
        }
        const { members: found, digest } = await answer(id, signal);
        const seen = given.get(id) ?? new Set<string>();
        given.set(id, seen.add(digest));
        if (found === undefined)
          out.push(entry); // matches nobody
        else for (const member of found) out.push({ ...entry, principal: member });
      }
      return normalizeAcl(out);
    },
    async fresh(id, signal) {
      const { digest } = await answer(id, signal, true);
      // What items get from here on is this answer: earlier ones were checked by the caller.
      given.delete(id);
      return digest;
    },
    recorded() {
      const out = new Map<string, string>();
      for (const [id, digests] of given) {
        out.set(id, digests.size === 1 ? ([...digests][0] as string) : MIXED);
      }
      return out;
    },
    forget: () => given.clear(),
  };
}
