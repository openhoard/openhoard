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
 * A group's members are asked once in {@link MEMBERS_MS} and kept in memory: who joined or left
 * a group is seen by the files recorded after that, and by every file at the next crawl. A
 * group SharePoint won't show (its membership hidden from the app, or the app without
 * SharePoint's permission: 401 or 403) grants nobody, as before this, and the rest goes on; the
 * run counts it among the groups that matched nobody, and the tenant check says why.
 */

/** How long a group's members are taken as they were. */
export const MEMBERS_MS = 15 * 60_000;
const GROUP_ID = /^\d{1,10}$/;

export interface SiteGroups {
  /** An item's entries, each SharePoint group's replaced by its members'. */
  expand(entries: readonly AclEntry[], site: string, signal: AbortSignal): Promise<AclEntry[]>;
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
  const kept = new Map<string, { at: number; members: Promise<AclPrincipal[] | undefined> }>();

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

  function members(id: string, signal: AbortSignal): Promise<AclPrincipal[] | undefined> {
    const had = kept.get(id);
    if (had && o.now() - had.at < MEMBERS_MS) return had.members;
    const asked = ask(id, signal);
    kept.set(id, { at: o.now(), members: asked });
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
        const found = await members(id, signal);
        if (found === undefined)
          out.push(entry); // matches nobody
        else for (const member of found) out.push({ ...entry, principal: member });
      }
      return normalizeAcl(out);
    },
  };
}
