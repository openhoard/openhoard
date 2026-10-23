import { Hono, type Context } from "hono";
import type { FakeTenant } from "../tenant/types.js";
import { ALL_SITES_PERMISSIONS, type FakeEntra } from "./entra.js";

/*
 * A fake of SharePoint's own REST API (T-305), limited to the one thing Graph can't say: who is
 * in a site's SharePoint group (`GET {site}/_api/web/sitegroups/getbyid({id})/users`). A file
 * granted to "Finance Members" is listed by Graph as that group, by id, and nothing more.
 *
 * As SharePoint does, it takes app-only tokens only from an app that signed in with a
 * certificate ("Unsupported app only token" otherwise), issued by the fake Entra for the
 * sites' origin, and reaches a site as Sites.Selected grants it.
 */

/** Who is in a SharePoint group: a person, an Entra group (or its owners only), or everyone. */
export type FakeSiteGroupMember =
  { user: string } | { group: string; owners?: boolean } | { everyone: true };

export interface FakeSharePointOptions {
  entra: FakeEntra;
}

export class FakeSharePoint {
  readonly app = new Hono();
  /** Every request, as answered. */
  readonly requests: { path: string; status: number }[] = [];
  /** False: users come without `AadObjectId`, as older answers have them. */
  objectIds = true;
  private readonly groups = new Map<string, FakeSiteGroupMember[]>();

  constructor(
    readonly tenant: FakeTenant,
    private readonly options: FakeSharePointOptions,
  ) {
    this.app.get("*", async (c) => {
      const response = await this.users(c);
      this.requests.push({ path: new URL(c.req.url).pathname, status: response.status });
      return response;
    });
  }

  /** Makes (or replaces) a site's SharePoint group `id`, with these members. */
  defineGroup(siteId: string, id: number, members: FakeSiteGroupMember[]): void {
    this.groups.set(`${siteId}:${id}`, members);
  }

  /** Sends a request to the fake without a network hop. */
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    return Promise.resolve(this.app.request(input, init));
  }

  private async users(c: Context): Promise<Response> {
    const url = new URL(c.req.url);
    const asked = /^(\/sites\/[^/]+)\/_api\/web\/sitegroups\/getbyid\((\d+)\)\/users$/.exec(
      url.pathname,
    );
    const site = asked && this.tenant.sites.find((s) => s.webUrl === `${url.origin}${asked[1]}`);
    if (!asked || !site) return spError(c, 404, "File Not Found.");
    const auth = c.req.header("authorization") ?? "";
    const caller = auth.startsWith("Bearer ")
      ? await this.options.entra.verify(auth.slice(7), url.origin)
      : undefined;
    if (!caller) return spError(c, 401, "Invalid JWT token.");
    if (!caller.certificate) return spError(c, 401, "Unsupported app only token.");
    const reaches =
      caller.roles.some((r) => (ALL_SITES_PERMISSIONS as readonly string[]).includes(r)) ||
      (caller.roles.includes("Sites.Selected") &&
        this.options.entra.siteRole(caller.appId, site.id) !== undefined);
    if (!reaches) return spError(c, 403, "Access denied.");
    const members = this.groups.get(`${site.id}:${asked[2]}`);
    if (!members) return spError(c, 404, "Group cannot be found.");
    return c.json({ value: members.map((m, i) => this.userOf(m, i + 10)) });
  }

  /** A member as SharePoint's SP.User has it (odata=nometadata). */
  private userOf(m: FakeSiteGroupMember, id: number): Record<string, unknown> {
    if ("everyone" in m) {
      return { Id: id, LoginName: "c:0(.s|true", Title: "Everyone", Email: "", PrincipalType: 4 };
    }
    if ("group" in m) {
      const group = this.tenant.groups.find((g) => g.id === m.group);
      return {
        Id: id,
        LoginName: `c:0o.c|federateddirectoryclaimprovider|${m.group}${m.owners ? "_o" : ""}`,
        Title: `${group?.displayName ?? m.group}${m.owners ? " Owners" : ""}`,
        Email: "",
        PrincipalType: 4,
      };
    }
    const user = this.tenant.users.find((u) => u.id === m.user);
    const upn = user?.upn ?? m.user;
    return {
      Id: id,
      LoginName: `i:0#.f|membership|${upn}`,
      Title: user?.displayName ?? upn,
      Email: upn,
      UserPrincipalName: upn,
      PrincipalType: 1,
      ...(!this.objectIds
        ? {}
        : { AadObjectId: { NameId: m.user, NameIdIssuer: "urn:federation:microsoftonline" } }),
    };
  }
}

function spError(c: Context, status: number, message: string): Response {
  return c.json(
    {
      "odata.error": {
        code: "-2147024891, System.UnauthorizedAccessException",
        message: { lang: "en-US", value: message },
      },
    },
    status as 401,
  );
}
