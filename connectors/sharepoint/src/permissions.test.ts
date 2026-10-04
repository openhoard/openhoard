import { checkAcl, type AclEntry } from "@openhoard/sdk";
import { describe, expect, it } from "vitest";
import { aclEntriesOf } from "./permissions.js";

/* Graph's permission resources, in the shapes its documentation gives, to the contract's entries. */

const SITE = "contoso.sharepoint.com,1111,2222";
const of = (permissions: readonly unknown[]): AclEntry[] => aclEntriesOf(permissions, SITE);
const ana = {
  id: "0f0e0d0c-aaaa-4908-8706-050403020100",
  displayName: "Ana",
  email: "Ana@Corp.test",
};
const anaIs = { kind: "user", id: ana.id, email: "ana@corp.test" };
const from = { inheritedFrom: { driveId: "d1", id: "root" } };
/** Who the entries are for, with the role. */
const said = (entries: AclEntry[]) => entries.map((e) => [JSON.stringify(e.principal), e.role]);

describe("Graph's permissions as ACL entries", () => {
  it("names users, groups and guests by what Entra calls them", () => {
    const entries = of([
      { id: "p1", roles: ["read"], grantedToV2: { user: ana } },
      { id: "p2", roles: ["write"], grantedToV2: { group: { id: "g-1", displayName: "Finance" } } },
      {
        id: "p3",
        roles: ["read"],
        grantedToV2: { user: { id: "u-guest", email: "pat_client.test#EXT#@corp.test" } },
        invitation: { email: "Pat@Client.test", signInRequired: true },
        expirationDateTime: "2031-05-01T00:00:00Z",
      },
      { id: "p4", roles: ["owner"], grantedToV2: { user: { id: "u-4" } }, ...from },
      // Only the older field: it can't say what kind of claim this is. Nobody.
      { id: "p5", roles: ["owner"], grantedTo: { user: { id: "u-old" } } },
    ]);
    expect(checkAcl({ basis: "source", entries })).toBeNull();
    expect(entries).toEqual([
      { principal: { kind: "group", id: "g-1" }, role: "write", inherited: false },
      {
        // The account that took the invitation up, by its own address.
        principal: { kind: "guest", email: "pat_client.test#ext#@corp.test", id: "u-guest" },
        role: "read",
        inherited: false,
        expiresAt: "2031-05-01T00:00:00.000Z",
      },
      { principal: anaIs, role: "read", inherited: false },
      { principal: { kind: "user", id: "u-4" }, role: "owner", inherited: true },
    ]);
    // An invitation nobody has taken up names nobody; one taken up by an account Graph gives
    // no address for is known by the address invited.
    const invitation = { email: "Pat@Client.test", signInRequired: true };
    expect(of([{ id: "p", roles: ["read"], invitation }])).toEqual([]);
    expect(of([{ id: "p", roles: ["read"], grantedToV2: { user: {} }, invitation }])).toEqual([]);
    expect(
      of([{ id: "p", roles: ["read"], grantedToV2: { user: { id: "u-9" } }, invitation }])[0]
        ?.principal,
    ).toEqual({ kind: "guest", email: "pat@client.test", id: "u-9" });
  });

  it("takes the strongest role it knows, and nothing from one that gives less than the file", () => {
    const role = (roles: unknown) => of([{ id: "p", roles, grantedToV2: { user: ana } }])[0]?.role;
    expect(role(["read", "write"])).toBe("write");
    expect(role(["sp.full control"])).toBe("owner");
    expect(role(["READ"])).toBe("read");
    // SharePoint's ways of letting someone see less than the file, and nonsense.
    expect(role(["sp.view only"])).toBeUndefined();
    expect(role(["sp.limited access"])).toBeUndefined();
    expect(role(["sp.restricted view"])).toBeUndefined();
    expect(role(["constructor"])).toBeUndefined();
    expect(role([])).toBeUndefined();
    expect(role("read")).toBeUndefined();
    expect(role([7, null])).toBeUndefined();
  });

  it("takes no expiry from the date Graph gives for never, and nothing from one it can't read", () => {
    const expiry = (expirationDateTime: unknown) =>
      of([{ id: "p", roles: ["read"], grantedToV2: { user: ana }, expirationDateTime }])[0];
    expect(expiry("0001-01-01T00:00:00Z")).toEqual({
      principal: anaIs,
      role: "read",
      inherited: false,
    });
    expect(expiry(null)).not.toHaveProperty("expiresAt");
    // An expiry that can't be read is not "never": the permission is left out.
    expect(expiry("soon")).toBeUndefined();
    expect(expiry(1893456000)).toBeUndefined();
    expect(expiry({})).toBeUndefined();
    expect(expiry("2030-01-01T00:00:00Z")?.expiresAt).toBe("2030-01-01T00:00:00.000Z");
  });

  it("keeps a SharePoint group to its site, and takes a claim for a person only when it is one's", () => {
    const entries = of([
      {
        id: "p1",
        roles: ["write"],
        grantedToV2: { siteGroup: { id: "5", displayName: "Finance Members" } },
        ...from,
      },
      {
        id: "p2",
        roles: ["read"],
        grantedToV2: {
          siteUser: {
            id: "9",
            displayName: "Everyone except external users",
            loginName: "c:0-.f|rolemanager|spo-grid-all-users/0f0e0d0c-0b0a-4908-8706-050403020100",
          },
        },
        ...from,
      },
      {
        id: "p3",
        roles: ["read"],
        grantedToV2: { siteUser: { id: "3", loginName: "c:0(.s|true", displayName: "Everyone" } },
      },
      {
        id: "p4",
        roles: ["read"],
        grantedToV2: {
          siteUser: {
            id: "12",
            loginName: "i:0#.f|membership|bo@corp.test",
            email: "bo@corp.test",
          },
        },
      },
      // A security group seen as a site user, with the group's address: not a person.
      {
        id: "p5",
        roles: ["read"],
        grantedToV2: {
          siteUser: { id: "14", loginName: "c:0t.c|tenant|abcd-1234", email: "team@corp.test" },
        },
      },
      // A site user with nothing to know them by, or only a number: nobody.
      { id: "p6", roles: ["read"], grantedToV2: { siteUser: { id: "13", displayName: "?" } } },
      { id: "p7", roles: ["read"], grantedToV2: { siteUser: { id: "15", email: "x@corp.test" } } },
    ]);
    expect(entries).toEqual([
      { principal: { kind: "group", id: `sitegroup:${SITE}:5` }, role: "write", inherited: true },
      { principal: { kind: "organization" }, role: "read", inherited: false },
      {
        principal: {
          kind: "user",
          id: "siteuser:i:0#.f|membership|bo@corp.test",
          email: "bo@corp.test",
        },
        role: "read",
        inherited: false,
      },
    ]);
    // The same group number in another site is another group.
    expect(
      aclEntriesOf(
        [{ id: "p", roles: ["read"], grantedToV2: { siteGroup: { id: "5" } } }],
        "other",
      )[0]?.principal,
    ).toEqual({ kind: "group", id: "sitegroup:other:5" });
  });

  it("doesn't take a group's owners for the group", () => {
    const owners = {
      id: "p1",
      roles: ["owner"],
      grantedToV2: {
        group: { id: "g-m365", displayName: "Finance Owners" },
        siteUser: {
          id: "7",
          loginName:
            "c:0o.c|federateddirectoryclaimprovider|0f0e0d0c-0b0a-4908-8706-050403020100_o",
        },
      },
    };
    expect(of([owners])).toEqual([]);
    // A claim too long to read can't be told from one: nobody, not the group.
    const long = structuredClone(owners);
    long.grantedToV2.siteUser.loginName = `c:0o.c|federateddirectoryclaimprovider|${"a".repeat(2000)}_o`;
    expect(of([long])).toEqual([]);
    const odd = structuredClone(owners) as unknown as {
      grantedToV2: { siteUser: { loginName: unknown } };
    };
    odd.grantedToV2.siteUser.loginName = 7;
    expect(of([odd])).toEqual([]);
    // The group's own claim is the group.
    const members = structuredClone(owners);
    members.grantedToV2.siteUser.loginName =
      "c:0o.c|federateddirectoryclaimprovider|0f0e0d0c-0b0a-4908-8706-050403020100";
    expect(said(of([members]))).toEqual([['{"kind":"group","id":"g-m365"}', "owner"]]);
  });

  it("says a link to view or edit is a link, and names the people one was made for", () => {
    const entries = of([
      {
        id: "l1",
        roles: ["read"],
        link: { scope: "anonymous", type: "view", webUrl: "https://x" },
      },
      {
        id: "l2",
        roles: ["write"],
        link: { scope: "organization", type: "edit" },
        hasPassword: false,
      },
      {
        id: "l3",
        roles: ["write"],
        link: { scope: "users", type: "edit" },
        grantedToIdentitiesV2: [
          { user: ana },
          { user: { id: "u-2", email: "bo@corp.test" } },
          { application: { id: "app-1" } },
          { siteUser: { loginName: "i:0#.f|membership|cy@corp.test", email: "cy@corp.test" } },
        ],
      },
      {
        id: "l4",
        roles: ["read"],
        link: { scope: "users", type: "view" },
        grantedToIdentitiesV2: [{ user: { id: "u-3" } }, { group: { id: "g-7" } }],
        // (The older list is not read.)
        grantedToIdentities: [{ user: { id: "u-legacy" } }],
      },
    ]);
    expect(said(entries)).toEqual(
      expect.arrayContaining([
        ['{"kind":"link","id":"l1","scope":"anyone"}', "read"],
        ['{"kind":"link","id":"l2","scope":"organization"}', "write"],
        ['{"kind":"link","id":"l3","scope":"specific"}', "write"],
        ['{"kind":"link","id":"l4","scope":"specific"}', "read"],
        [JSON.stringify(anaIs), "write"],
        ['{"kind":"user","id":"u-2","email":"bo@corp.test"}', "write"],
        [
          '{"kind":"user","id":"siteuser:i:0#.f|membership|cy@corp.test","email":"cy@corp.test"}',
          "write",
        ],
        ['{"kind":"user","id":"u-3"}', "read"],
        ['{"kind":"group","id":"g-7"}', "read"],
      ]),
    );
    expect(entries).toHaveLength(9);
  });

  it("takes nothing, for anyone, from a link that gives less than the file", () => {
    const people = { grantedToIdentitiesV2: [{ user: ana }] };
    const link = (more: Record<string, unknown>, id = "l") =>
      of([{ id, roles: ["read"], link: { scope: "users", type: "view", ...more }, ...people }]);
    expect(link({})).toHaveLength(2);
    for (const type of [
      "createOnly",
      "blocksDownload",
      "embed",
      "review",
      "addressBar",
      7,
      undefined,
    ]) {
      expect(link({ type }), String(type)).toEqual([]);
    }
    expect(link({ preventsDownload: true })).toEqual([]);
    // Gives nobody anything they didn't have, or isn't a scope there is, or has no id.
    expect(link({ scope: "existingAccess" })).toEqual([]);
    expect(link({ scope: "galaxy" })).toEqual([]);
    expect(link({ scope: "constructor" })).toEqual([]);
    expect(of([{ roles: ["read"], link: { scope: "anonymous", type: "view" } }])).toEqual([]);
  });

  it("leaves out what makes no sense or can't be held, and is one entry a principal whatever the order", () => {
    expect(
      of([
        null,
        "read",
        [],
        { id: "p1", roles: ["read"] },
        { id: "p2", roles: ["read"], grantedToV2: { application: { id: "app" } } },
        { id: "p3", roles: ["read"], grantedToV2: { user: { id: "" } } },
        { id: "p4", roles: ["read"], grantedToV2: { user: { id: "a".repeat(2000) } } },
        { id: "p5", roles: ["read"], grantedToV2: { group: { id: 7 } } },
        { id: "p6", roles: ["read"], grantedToV2: "everyone" },
        // Text the catalog couldn't store: a lone surrogate, a NUL.
        { id: "p7", roles: ["read"], grantedToV2: { user: { id: "u\ud800" } } },
        { id: "p8", roles: ["read"], grantedToV2: { group: { id: "g\0" } } },
        // A SharePoint group whose id leaves no room for its site's.
        { id: "p9", roles: ["read"], grantedToV2: { siteGroup: { id: "9".repeat(1020) } } },
        { id: "p10", roles: ["read"], grantedToV2: { user: ana } },
      ]),
    ).toEqual([{ principal: anaIs, role: "read", inherited: false }]);
    const two = [
      {
        id: "a",
        roles: ["read"],
        grantedToV2: { user: ana },
        ...from,
        expirationDateTime: "2031-01-01T00:00:00Z",
      },
      { id: "b", roles: ["write"], grantedToV2: { user: ana } },
    ];
    const merged = of(two);
    expect(merged).toEqual(of([...two].reverse()));
    expect(merged).toEqual([{ principal: anaIs, role: "write", inherited: false }]);
  });
});
