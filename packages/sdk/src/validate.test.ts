import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ConnectorDescription, SourceItem } from "./connector.js";
import {
  acceptAcl,
  canonicalUrl,
  checkAcl,
  checkDescription,
  checkEvent,
  checkItem,
  checkRedirect,
  normalizeAcl,
  refOf,
  storableText,
  titleOf,
} from "./validate.js";

const description: ConnectorDescription = {
  apiVersion: 1,
  id: "connector-fs",
  version: "1.0.0",
  zoneKinds: ["indexed"],
  capabilities: { delta: true, aclImport: true, redirect: true },
  stableIds: true,
  redirectSchemes: ["file:"],
};

const file: SourceItem = {
  externalId: "i.1",
  kind: "file",
  parentId: "i.0",
  path: ["Docs", "plan.md"],
  mediaType: "text/markdown",
  size: 12,
  modifiedAt: "2026-09-26T10:00:00.123Z",
  modifiedBy: { id: "u1", email: "ann@example.com", name: "Ann" },
  etag: "e1",
  contentVersion: "v1",
  url: "file:///srv/Docs/plan.md",
};
const folder: SourceItem = {
  externalId: "i.0",
  kind: "folder",
  parentId: null,
  path: ["Docs"],
  etag: "e0",
};

describe("checkDescription", () => {
  it("accepts a valid description and lists what is wrong with others", () => {
    expect(checkDescription(description)).toEqual([]);
    expect(checkDescription(null)).toEqual(["describe() must return an object"]);
    const bad = checkDescription({
      apiVersion: 2,
      id: "Bad Id",
      version: "one",
      zoneKinds: ["indexed", "indexed"],
      capabilities: { delta: "yes" },
      stableIds: 1,
      redirectSchemes: ["javascript:"],
    });
    expect(bad).toHaveLength(7);
    expect(checkDescription({ ...description, zoneKinds: [] })).toHaveLength(1);
    expect(checkDescription({ ...description, redirectSchemes: "file:" })).toHaveLength(1);
  });
});

describe("checkItem and checkEvent", () => {
  it("accepts files and folders", () => {
    expect(checkItem(file, description)).toBeNull();
    expect(checkItem(folder)).toBeNull();
    expect(checkEvent({ type: "item", item: file }, description)).toBeNull();
    expect(checkEvent({ type: "deleted", externalId: "i.1" })).toBeNull();
    expect(checkEvent({ type: "checkpoint", token: "t" })).toBeNull();
    expect(checkEvent({ type: "done", cursor: "c" })).toBeNull();
  });

  it.each([
    ["not an object", 5],
    ["no id", { ...file, externalId: "" }],
    ["a NUL in the id", { ...file, externalId: "a\0b" }],
    ["a lone surrogate", { ...file, externalId: "a\ud800" }],
    ["a long id", { ...file, externalId: "x".repeat(2049) }],
    ["a bad kind", { ...file, kind: "link" }],
    ["a bad parent", { ...file, parentId: 7 }],
    ["its own parent", { ...file, parentId: "i.1" }],
    ["no path", { ...file, path: [] }],
    ["a dot name", { ...file, path: ["Docs", ".."] }],
    ["a slash in a name", { ...file, path: ["Docs", "a/b"] }],
    ["a top item with a parent", { ...file, path: ["plan.md"] }],
    ["a nested item without one", { ...folder, path: ["a", "b"] }],
    ["a bad title", { ...file, title: "" }],
    ["no etag", { ...file, etag: "" }],
    ["a bad url", { ...file, url: 5 }],
    ["a loose time", { ...file, modifiedAt: "yesterday" }],
    ["an impossible time", { ...file, modifiedAt: "2026-13-45T99:99:99Z" }],
    ["a bad author", { ...file, modifiedBy: { id: "" } }],
    ["a fractional size", { ...file, size: 1.5 }],
    ["a file without a version", { ...file, contentVersion: undefined }],
    ["a bad media type", { ...file, mediaType: 5 }],
    ["a folder with a size", { ...folder, size: 1 }],
  ])("refuses an item with %s", (_label, item) => {
    expect(checkItem(item, description)).not.toBeNull();
  });

  it("refuses unknown events and bad tokens", () => {
    expect(checkEvent(null)).not.toBeNull();
    expect(checkEvent({ type: "moved" })).not.toBeNull();
    expect(checkEvent({ type: "deleted", externalId: "" })).not.toBeNull();
    expect(checkEvent({ type: "checkpoint", token: "x".repeat(65_537) })).not.toBeNull();
    expect(checkEvent({ type: "done" })).not.toBeNull();
    expect(checkEvent({ type: "item", item: { ...file, size: -1 } })).not.toBeNull();
  });

  it("never throws, whatever it is given", () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        expect(typeof (checkEvent(value) ?? "")).toBe("string");
        expect(typeof (checkItem(value) ?? "")).toBe("string");
        expect(Array.isArray(checkDescription(value))).toBe(true);
        expect(typeof (checkAcl(value) ?? "")).toBe("string");
      }),
    );
  });
});

describe("storableText", () => {
  it("accepts paired surrogates and refuses NUL and lone ones", () => {
    expect(storableText("emoji \ud83d\ude00")).toBe(true);
    expect(storableText("a\udc00")).toBe(false);
    expect(storableText("\0")).toBe(false);
    expect(storableText(5)).toBe(false);
  });
});

describe("refOf and titleOf", () => {
  it("builds a reference from what the crawl reported", () => {
    expect(refOf(file)).toEqual({
      externalId: "i.1",
      contentVersion: "v1",
      size: 12,
      url: "file:///srv/Docs/plan.md",
      path: ["Docs", "plan.md"],
    });
    expect(refOf(folder)).toEqual({ externalId: "i.0", path: ["Docs"] });
    expect(titleOf(file)).toBe("plan.md");
    expect(titleOf({ ...file, title: "The plan" })).toBe("The plan");
  });
});

describe("normalizeAcl", () => {
  it("keeps one entry per principal, the strongest role, sorted", () => {
    expect(
      normalizeAcl([
        { principal: { kind: "user", id: "u2" }, role: "read", inherited: true },
        { principal: { kind: "group", id: "g1" }, role: "write", inherited: false },
        {
          principal: { kind: "user", id: "u2", email: "Ann@Example.COM" },
          role: "owner",
          inherited: true,
        },
        { principal: { kind: "organization" }, role: "read", inherited: true },
      ]),
    ).toEqual([
      { principal: { kind: "group", id: "g1" }, role: "write", inherited: false },
      { principal: { kind: "organization" }, role: "read", inherited: true },
      {
        principal: { kind: "user", id: "u2", email: "ann@example.com" },
        role: "owner",
        inherited: true,
      },
    ]);
  });

  it("is direct if any entry is, and expires only when every entry does, at the latest", () => {
    const guest = { kind: "guest", email: "Bob@Partner.example" } as const;
    expect(
      normalizeAcl([
        { principal: guest, role: "read", inherited: true, expiresAt: "2026-10-01T00:00:00Z" },
        {
          principal: guest,
          role: "read",
          inherited: false,
          expiresAt: "2026-12-01T00:00:00+01:00",
        },
      ]),
    ).toEqual([
      {
        principal: { kind: "guest", email: "bob@partner.example" },
        role: "read",
        inherited: false,
        expiresAt: "2026-11-30T23:00:00.000Z",
      },
    ]);
    expect(
      normalizeAcl([
        { principal: guest, role: "read", inherited: true, expiresAt: "2026-10-01T00:00:00Z" },
        { principal: guest, role: "read", inherited: true },
      ]),
    ).toEqual([
      { principal: { kind: "guest", email: "bob@partner.example" }, role: "read", inherited: true },
    ]);
  });

  it("gives the same answer whatever order the entries come in", () => {
    const entries = [
      {
        principal: { kind: "user", id: "u1", email: "a@x.example" },
        role: "read",
        inherited: true,
      },
      {
        principal: { kind: "user", id: "u1", email: "b@x.example" },
        role: "write",
        inherited: true,
      },
      { principal: { kind: "group", id: "g1" }, role: "read", inherited: false },
    ];
    expect(normalizeAcl([...entries].reverse())).toEqual(normalizeAcl(entries));
    expect(normalizeAcl(entries)[1]?.principal).toEqual({
      kind: "user",
      id: "u1",
      email: "a@x.example",
    });
  });

  it("keys links by id and keeps their scope", () => {
    expect(
      normalizeAcl([
        { principal: { kind: "link", id: "l1", scope: "anyone" }, role: "read", inherited: false },
        {
          principal: { kind: "guest", email: "x@y.example", id: "g" },
          role: "read",
          inherited: false,
        },
      ]),
    ).toEqual([
      {
        principal: { kind: "guest", email: "x@y.example", id: "g" },
        role: "read",
        inherited: false,
      },
      { principal: { kind: "link", id: "l1", scope: "anyone" }, role: "read", inherited: false },
    ]);
  });

  it.each([
    ["not an array", "x"],
    ["a non-object entry", [5]],
    ["an unknown kind", [{ principal: { kind: "robot" }, role: "read", inherited: false }]],
    ["no principal", [{ role: "read", inherited: false }]],
    ["a bad role", [{ principal: { kind: "organization" }, role: "admin", inherited: false }]],
    ["no inherited flag", [{ principal: { kind: "organization" }, role: "read" }]],
    [
      "a bad expiry",
      [{ principal: { kind: "organization" }, role: "read", inherited: false, expiresAt: "soon" }],
    ],
    [
      "an impossible expiry",
      [
        {
          principal: { kind: "organization" },
          role: "read",
          inherited: false,
          expiresAt: "2026-02-31T99:00:00Z",
        },
      ],
    ],
    ["an empty user id", [{ principal: { kind: "user", id: "" }, role: "read", inherited: false }]],
    [
      "a bad user email",
      [{ principal: { kind: "user", id: "u", email: 5 }, role: "read", inherited: false }],
    ],
    [
      "an empty group id",
      [{ principal: { kind: "group", id: "" }, role: "read", inherited: false }],
    ],
    ["a guest without email", [{ principal: { kind: "guest" }, role: "read", inherited: false }]],
    [
      "a bad guest id",
      [{ principal: { kind: "guest", email: "a@b", id: "" }, role: "read", inherited: false }],
    ],
    [
      "a link without id",
      [{ principal: { kind: "link", scope: "anyone" }, role: "read", inherited: false }],
    ],
    [
      "a bad link scope",
      [{ principal: { kind: "link", id: "l", scope: "world" }, role: "read", inherited: false }],
    ],
  ])("refuses %s", (_label, entries) => {
    expect(() => normalizeAcl(entries as never)).toThrow(TypeError);
  });
});

describe("checkAcl and acceptAcl", () => {
  const entry = { principal: { kind: "group", id: "g1" }, role: "read", inherited: false };
  it("accepts normalized ACLs only", () => {
    expect(checkAcl({ basis: "source", entries: [entry] })).toBeNull();
    expect(checkAcl({ basis: "owner-only", entries: [] })).toBeNull();
    expect(checkAcl({ basis: "owner-only", entries: [entry] })).not.toBeNull();
    expect(checkAcl({ basis: "guess", entries: [] })).not.toBeNull();
    expect(checkAcl({ basis: "source", entries: "x" })).not.toBeNull();
    expect(checkAcl({ basis: "source", entries: [entry, entry] })).toMatch(/normalized/);
    expect(checkAcl({ basis: "source", entries: [{}] })).toMatch(/invalid/);
  });

  it("normalizes what it accepts, and refuses the rest", () => {
    expect(acceptAcl({ basis: "configured", entries: [entry, entry] })).toEqual({
      basis: "configured",
      entries: [entry],
    });
    expect(() => acceptAcl(null)).toThrow(TypeError);
    expect(() => acceptAcl({ basis: "all", entries: [] })).toThrow(TypeError);
    expect(() => acceptAcl({ basis: "source" })).toThrow(TypeError);
    expect(() => acceptAcl({ basis: "owner-only", entries: [entry] })).toThrow(TypeError);
  });
});

describe("checkRedirect", () => {
  it("accepts https and declared schemes only, without credentials", () => {
    expect(checkRedirect("https://contoso.sharepoint.com/x", description)).toBeNull();
    expect(checkRedirect("file:///C:/Users/ann/plan.docx", description)).toBeNull();
    expect(checkRedirect("http://example.com/", description)).toMatch(/scheme/);
    expect(
      checkRedirect("javascript:alert(1)", { ...description, redirectSchemes: ["javascript:"] }),
    ).toMatch(/scheme/);
    expect(checkRedirect("ms-word:ofe|u|https://x", description)).toMatch(/scheme/);
    expect(checkRedirect("https://ann:pw@example.com/", description)).toMatch(/credentials/);
    expect(checkRedirect("/relative", description)).toMatch(/absolute/);
    expect(checkRedirect(5, description)).not.toBeNull();
  });

  it("refuses file: URLs that name a host: opening one sends Windows credentials to it", () => {
    expect(checkRedirect("file://localhost/srv/a.txt", description)).toBeNull();
    expect(checkRedirect("file://evil.example/share/a.txt", description)).toMatch(/host/);
    expect(checkRedirect("file://10.0.0.1/c$/a.txt", description)).toMatch(/host/);
  });

  it.each([
    ["four slashes", "file:////attacker.example/share/x"],
    ["localhost and two slashes", "file://localhost//evil/share/x"],
    ["backslashes for slashes", "file:\\\\evil.example\\share\\x"],
    ["backslashes after three slashes", "file:///\\\\evil\\share"],
    ["a backslash in the path", "file:///C:/Users\\ann/x"],
    ["an encoded backslash", "file:///%5C%5Cevil/share"],
    ["an encoded slash, lower case", "file:///x/%2f%2fevil/share"],
  ])("refuses a file: URL Windows would open as a share: %s", (_label, url) => {
    // Most of these parse with an empty host; browsers and the shell see a server in each.
    expect(checkRedirect(url, description)).not.toBeNull();
    expect(checkItem({ ...file, url }, description)).toMatch(/^url: /);
  });

  it("gives the parser's own text to keep, not the connector's", () => {
    expect(canonicalUrl("FILE://LOCALHOST/srv/a%20b.txt")).toBe("file:///srv/a%20b.txt");
    expect(canonicalUrl("HTTPS://Contoso.SharePoint.com/a b")).toBe(
      "https://contoso.sharepoint.com/a%20b",
    );
  });
});

describe("item URLs", () => {
  it("follow the redirect rules, with the schemes the connector declares", () => {
    const at = (url: string, d?: ConnectorDescription) => checkItem({ ...file, url }, d);
    expect(at("file:///srv/Docs/plan.md", description)).toBeNull();
    // Without a description only https: passes.
    expect(at("file:///srv/Docs/plan.md")).toMatch(/^url: scheme/);
    expect(at("https://contoso.sharepoint.com/Docs/plan.md")).toBeNull();
    for (const bad of [
      "javascript:alert(document.cookie)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox",
      "blob:https://x/1",
      "file://attacker.example/share/plan.md",
      "https://user:pw@example.com/plan.md",
      "not a url",
    ]) {
      expect(at(bad, { ...description, redirectSchemes: ["file:", "javascript:"] }), bad).toMatch(
        /^url: /,
      );
    }
    expect(
      checkEvent({ type: "item", item: { ...file, url: "javascript:x" } }, description),
    ).toMatch(/^url: /);
  });
});

describe("warnings", () => {
  it("carry a slug code and, optionally, an item", () => {
    expect(checkEvent({ type: "warning", code: "unreadable" })).toBeNull();
    expect(checkEvent({ type: "warning", code: "hard-link", externalId: "i.1" })).toBeNull();
    expect(checkEvent({ type: "warning", code: "Not A Slug" })).not.toBeNull();
    expect(checkEvent({ type: "warning", code: "unreadable", externalId: "" })).not.toBeNull();
  });
});
