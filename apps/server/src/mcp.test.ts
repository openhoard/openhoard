import { createHash, randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { exportAudit } from "@openhoard/core-audit";
import { markProcessed, openContent, viewObject, VIEW_TRANSACTION } from "@openhoard/core-catalog";
import {
  activityEvents,
  addGrant,
  facets,
  facetValues,
  objectTags,
  type Database,
  type Tx,
} from "@openhoard/core-db";
import { Authorizer, createCedarEngine } from "@openhoard/core-policy";
import { and, eq } from "drizzle-orm";
import { openTestDatabase, seedTenant, type SeededTenant } from "@openhoard/core-db/testing";
import {
  createUser,
  decideClient,
  issueCode,
  lockUser,
  noteClient,
  redeemCode,
  revokeGrant,
  type OAuthScope,
  type User,
} from "@openhoard/core-identity";
import { generateTenant, startDevOidc, type DevOidc, type FakeUser } from "@openhoard/testkit";
import { Hono } from "hono";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createApp } from "./app.js";
import type { AuthEnv } from "./auth.js";
import { ConfigSchema } from "./config.js";
import { mountMcp, readRequest, TOOLS, whoami, type McpTool } from "./mcp.js";

/* T-801: the MCP server, stateless Streamable HTTP behind T-105's bearer tokens. */

const PUBLIC = "https://hoard.example";
const RESOURCE = `${PUBLIC}/mcp`;
const CLIENT_ID = "https://client.example/oauth/mcp.json";
const REDIRECT = "https://client.example/cb";
const fake = generateTenant({ items: 20 });
const person = fake.users.find((u) => u.active && !u.guest) as FakeUser;

let idp: DevOidc;
beforeAll(async () => {
  idp = await startDevOidc({
    tenant: fake,
    clients: [{ clientId: "openhoard-test", redirectUris: [`${PUBLIC}/auth/callback/dev`] }],
  });
});
afterAll(() => idp?.close());

let db: Database;
let t: SeededTenant;
let ana: User;
let clientKey: string;
beforeEach(async () => {
  db = await openTestDatabase();
  t = await seedTenant(db, 1);
  ana = await db.withTenant(t.tenantId, (tx) =>
    createUser(tx, t.tenantId, {
      email: person.upn,
      displayName: person.displayName,
      source: "local",
    }),
  );
  // The client an admin approved as commercial (T-105), without the browser dance.
  clientKey = await db.withTenant(t.tenantId, async (tx) => {
    const noted = await noteClient(
      tx,
      t.tenantId,
      { kind: "cimd", clientRef: CLIENT_ID, name: "Example", redirectUris: [REDIRECT] },
      `user:${ana.id}`,
    );
    const key = noted?.clientKey as string;
    await decideClient(tx, t.tenantId, key, { approve: true, trust: "commercial" }, "system:test");
    return key;
  });
});
afterEach(() => db?.close());

function build(
  tools?: readonly McpTool[],
  database: Database = db,
  auth: Record<string, unknown> = {},
): Hono<AuthEnv> {
  const config = ConfigSchema.parse({
    dataDir: "/tmp/unused",
    auth: {
      ...auth,
      publicUrl: PUBLIC,
      cookieKey: "k".repeat(43),
      providers: [
        {
          id: "dev",
          kind: "generic",
          tenantId: t.tenantId,
          issuer: idp.issuer,
          clientId: "openhoard-test",
        },
      ],
    },
  });
  return createApp(config, undefined, { db: database, ...(tools ? { mcpTools: tools } : {}) });
}

/** An access token for ana through the approved client, as the token endpoint would issue it. */
async function token(scopes: OAuthScope[] = ["files:read"]) {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return db.withTenant(t.tenantId, async (tx) => {
    const code = await issueCode(tx, t.tenantId, {
      userId: ana.id,
      clientKey,
      redirectUri: REDIRECT,
      codeChallenge: challenge,
      scopes,
      resource: RESOURCE,
    });
    const set = await redeemCode(tx, t.tenantId, code, {
      clientKey,
      redirectUri: REDIRECT,
      codeVerifier: verifier,
      resource: RESOURCE,
    });
    if (!set.ok) throw new Error(set.reason);
    return set;
  });
}

const HEADERS = {
  accept: "application/json, text/event-stream",
  "content-type": "application/json",
};
/** One raw JSON-RPC call to /mcp. */
const rpc = (
  app: Hono<AuthEnv>,
  accessToken: string | undefined,
  method: string,
  params: unknown = {},
  init: RequestInit = {},
) =>
  app.request(RESOURCE, {
    method: "POST",
    ...init,
    headers: {
      ...HEADERS,
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });

/** The official SDK client, talking to the app in-process. */
async function sdkClient(app: Hono<AuthEnv>, accessToken: string) {
  const transport = new StreamableHTTPClientTransport(new URL(RESOURCE), {
    fetch: async (url, init) => app.request(String(url), init),
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  // The SDK's own types disagree under exactOptionalPropertyTypes (sessionId?: string).
  await client.connect(transport as unknown as Transport);
  return { client, transport };
}

describe("the MCP server", () => {
  it("serves an SDK client: initialize, list tools, call whoami, with no session", async () => {
    const app = build();
    const { accessToken } = await token(["files:read", "files:tag"]);
    const { client, transport } = await sdkClient(app, accessToken);
    expect(client.getServerVersion()).toMatchObject({ name: "openhoard" });
    expect(transport.sessionId).toBeUndefined();
    const { tools } = await client.listTools();
    expect(tools.map((x) => x.name)).toEqual(["whoami"]);
    expect(tools[0]?.annotations).toMatchObject({ readOnlyHint: true });
    const result = await client.callTool({ name: "whoami", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      user: { id: ana.id, displayName: person.displayName, email: person.upn, kind: "member" },
      tenantId: t.tenantId,
      client: { id: CLIENT_ID, trust: "commercial" },
      scopes: ["files:read", "files:tag"],
    });
    await client.close();
  });

  it("challenges a request without a valid token, pointing at the resource metadata", async () => {
    const app = build();
    for (const bearer of [undefined, "ohat.nonsense", `ohat.${t.tenantId}.x.y`]) {
      const res = await rpc(app, bearer, "tools/list");
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toMatch(
        new RegExp(
          `^Bearer resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource/mcp"`,
        ),
      );
    }
  });

  it("checks the token on every request: revoked or locked, the next one is refused", async () => {
    const app = build();
    const first = await token();
    expect((await rpc(app, first.accessToken, "tools/list")).status).toBe(200);
    await db.withTenant(t.tenantId, (tx) =>
      revokeGrant(tx, t.tenantId, first.grantId, `user:${ana.id}`),
    );
    expect((await rpc(app, first.accessToken, "tools/list")).status).toBe(401);
    const second = await token();
    expect((await rpc(app, second.accessToken, "tools/list")).status).toBe(200);
    await db.withTenant(t.tenantId, (tx) => lockUser(tx, t.tenantId, ana.id, "user:admin"));
    expect((await rpc(app, second.accessToken, "tools/list")).status).toBe(401);
  });

  it("is stateless: POST only, no session id issued, and a sent one ignored", async () => {
    const app = build();
    const { accessToken } = await token();
    for (const method of ["GET", "DELETE", "PUT"]) {
      const res = await app.request(RESOURCE, {
        method,
        headers: { ...HEADERS, authorization: `Bearer ${accessToken}` },
      });
      expect(res.status, method).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
    }
    const init = await rpc(app, accessToken, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "raw", version: "1" },
    });
    expect(init.status).toBe(200);
    expect(init.headers.get("mcp-session-id")).toBeNull();
    // A call needs no initialize before it (each request is its own), and a stray id is harmless.
    const call = await rpc(
      app,
      accessToken,
      "tools/call",
      { name: "whoami", arguments: {} },
      { headers: { "mcp-session-id": "made-up" } },
    );
    expect(call.status).toBe(200);
    expect(await call.json()).toMatchObject({
      result: { structuredContent: { user: { id: ana.id } } },
    });
  });

  it("refuses what a JSON-RPC client shouldn't send, without crashing", async () => {
    const app = build();
    const { accessToken } = await token();
    const post = (body: string, headers: Record<string, string> = HEADERS) =>
      app.request(RESOURCE, {
        method: "POST",
        headers: { ...headers, authorization: `Bearer ${accessToken}` },
        body,
      });
    expect((await post("{not json")).status).toBe(400);
    expect((await post("{}", { "content-type": "application/json" })).status).toBe(406);
    expect((await post("x".repeat(300 * 1024))).status).toBe(413);
    const parse = await post('{"jsonrpc": "2.0", "id": 1, "method": "secret-term');
    expect(parse.status).toBe(400);
    const parsed = JSON.stringify(await parse.json());
    expect(parsed).toMatch(/-32700/);
    expect(parsed).not.toMatch(/secret-term/);
    const unknown = await rpc(app, accessToken, "tools/call", { name: "rm", arguments: {} });
    expect(await unknown.json()).toMatchObject({ result: { isError: true } });
    const version = await rpc(
      app,
      accessToken,
      "tools/list",
      {},
      {
        headers: { "mcp-protocol-version": "1999-01-01" },
      },
    );
    expect(version.status).toBe(400);
  });

  it("refuses batches, so one request can't run a hundred calls or outlive its answer", async () => {
    let runs = 0;
    const counted: McpTool = {
      ...whoami,
      name: "count",
      run: (ctx, args) => (runs++, whoami.run(ctx, args)),
    };
    const app = build([counted]);
    const { accessToken } = await token();
    const call = (id: number) => ({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "count", arguments: {} },
    });
    for (const batch of [
      [call(1), call(2)],
      [call(7), call(7)],
      [call(1), { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } }],
      [],
    ]) {
      const res = await app.request(RESOURCE, {
        method: "POST",
        headers: { ...HEADERS, authorization: `Bearer ${accessToken}` },
        body: JSON.stringify(batch),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: -32600 } });
    }
    expect(runs).toBe(0);
  });

  it("answers a notification with 202 and no body", async () => {
    const app = build();
    const { accessToken } = await token();
    const res = await app.request(RESOURCE, {
      method: "POST",
      headers: { ...HEADERS, authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  it("needs files:read: a token without it gets 403 with the scopes to ask for", async () => {
    const app = build();
    const { accessToken } = await token(["files:tag"]);
    const res = await rpc(app, accessToken, "tools/list");
    expect(res.status).toBe(403);
    expect(res.headers.get("www-authenticate")).toMatch(/error="insufficient_scope"/);
  });

  it("refuses browsers from other origins before looking at the token", async () => {
    const app = build(undefined, db, { mcpOrigins: ["https://web-client.example"] });
    const { accessToken } = await token();
    const from = (origin: string, bearer: string | undefined = accessToken) =>
      rpc(app, bearer, "tools/list", {}, { headers: { origin } });
    for (const origin of ["https://evil.example", "null", "http://localhost.evil.example"]) {
      const res = await from(origin);
      expect(res.status, origin).toBe(403);
      expect(res.headers.get("access-control-allow-origin"), origin).toBeNull();
      expect((await from(origin, undefined)).status, origin).toBe(403);
    }
    for (const origin of [PUBLIC, "https://web-client.example", "http://127.0.0.1:6274"]) {
      const res = await from(origin);
      expect(res.status, origin).toBe(200);
      expect(res.headers.get("access-control-allow-origin"), origin).toBe(origin);
    }
    // An entry that can't be a browser origin is a config error, not a silent no-op.
    for (const bad of ["chrome-extension://abcdef", "file:///tmp/x"]) {
      expect(() => build(undefined, db, { mcpOrigins: [bad] }), bad).toThrow(/http\(s\) origin/);
    }
    // No Origin at all: a hosted client calling from its servers, or a local one.
    expect((await rpc(app, accessToken, "tools/list")).status).toBe(200);
  });
});

describe("tools", () => {
  const recordsAView = (objectId: () => string): McpTool => ({
    name: "peek",
    title: "Peek",
    description: "Records a view, as T-802's reads will.",
    async run({ bearer, activity }) {
      activity.record({
        type: "view",
        actor: `user:${bearer.principal.userId}`,
        objectId: objectId(),
        client: bearer.client,
      });
      return { content: [{ type: "text", text: "ok" }] };
    },
  });

  it("writes each request's activity, with the client's id and trust (an AI read)", async () => {
    const app = build([whoami, recordsAView(() => t.objectId)]);
    const { accessToken } = await token();
    const res = await rpc(app, accessToken, "tools/call", { name: "peek", arguments: {} });
    expect(res.status).toBe(200);
    const rows = await db.withTenant(t.tenantId, (tx) => tx.select().from(activityEvents));
    expect(rows).toMatchObject([
      {
        type: "view",
        actor: `user:${ana.id}`,
        objectId: t.objectId,
        clientId: CLIENT_ID,
        clientTrust: "commercial",
      },
    ]);
    // whoami reads no file, so records nothing.
    await rpc(app, accessToken, "tools/call", { name: "whoami", arguments: {} });
    expect(await db.withTenant(t.tenantId, (tx) => tx.select().from(activityEvents))).toHaveLength(
      1,
    );
  });

  it("refuses to answer when the activity can't be written", async () => {
    const app = build([recordsAView(() => "not-an-object-id")]);
    const { accessToken } = await token();
    const res = await rpc(app, accessToken, "tools/call", { name: "peek", arguments: {} });
    expect(res.status).toBe(500);
    const body = JSON.stringify(await res.json());
    expect(body).toMatch(/internal error/);
    expect(body).not.toMatch(/"ok"/);
  });

  it("answers a failing tool with a bare internal error, never its message", async () => {
    const boom: McpTool = {
      name: "boom",
      title: "Boom",
      description: "Fails.",
      run: () => Promise.reject(new Error("secret: Termination – J. Smith.docx")),
    };
    const app = build([boom]);
    const { accessToken } = await token();
    const res = await rpc(app, accessToken, "tools/call", { name: "boom", arguments: {} });
    const json = await res.json();
    expect(json).toMatchObject({
      result: { isError: true, content: [{ type: "text", text: "internal error" }] },
    });
    expect(JSON.stringify(json)).not.toMatch(/secret|Smith/);
  });

  it("validates a tool's arguments against its schema before running it", async () => {
    let seen: unknown;
    const echo: McpTool = {
      name: "echo",
      title: "Echo",
      description: "Echoes n.",
      inputSchema: { n: z.number().int() },
      run: (_ctx, args) => {
        seen = args;
        return Promise.resolve({ content: [{ type: "text", text: String(args.n) }] });
      },
    };
    const app = build([echo]);
    const { accessToken } = await token();
    const ok = await rpc(app, accessToken, "tools/call", { name: "echo", arguments: { n: 3 } });
    expect(await ok.json()).toMatchObject({ result: { content: [{ text: "3" }] } });
    expect(seen).toEqual({ n: 3 });
    seen = undefined;
    const bad = await rpc(app, accessToken, "tools/call", { name: "echo", arguments: { n: "x" } });
    expect(await bad.json()).toMatchObject({ result: { isError: true } });
    expect(seen).toBeUndefined();
  });

  it("answers 503 past the deadline, aborting the tool, and shows nothing it made", async () => {
    let aborted: AbortSignal | undefined;
    const hang: McpTool = {
      name: "hang",
      title: "Hang",
      description: "Never finishes.",
      run: (ctx) => {
        aborted = ctx.signal;
        ctx.activity.record({
          type: "view",
          actor: `user:${ana.id}`,
          objectId: t.objectId,
        });
        return new Promise(() => undefined);
      },
    };
    const app = await bare([hang], 100);
    const res = await app.request(RESOURCE, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "hang", arguments: {} },
      }),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { message: "request took too long" } });
    expect(aborted?.aborted).toBe(true);
    // Withheld, so nothing to record either.
    expect(await db.withTenant(t.tenantId, (tx) => tx.select().from(activityEvents))).toEqual([]);
  });

  it("ends a request whose client hangs up at once, aborting its tools", async () => {
    let signal: AbortSignal | undefined;
    const hang: McpTool = {
      name: "hang",
      title: "Hang",
      description: "Never finishes.",
      run: (ctx) => {
        signal = ctx.signal;
        return new Promise(() => undefined);
      },
    };
    const app = await bare([hang], 10_000);
    const client = new AbortController();
    setTimeout(() => client.abort(), 50);
    const started = Date.now();
    const res = await app.request(RESOURCE, {
      method: "POST",
      headers: HEADERS,
      signal: client.signal,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "hang", arguments: {} },
      }),
    });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(await res.json()).toMatchObject({ error: { message: "client closed the request" } });
    expect(signal?.aborted).toBe(true);
    // Gone before it began: nothing runs.
    signal = undefined;
    const before = new AbortController();
    before.abort();
    const early = await app.request(RESOURCE, {
      method: "POST",
      headers: HEADERS,
      signal: before.signal,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "hang" },
      }),
    });
    expect(await early.json()).toMatchObject({ error: { message: "client closed the request" } });
    expect(signal).toBeUndefined();
  });

  /** mountMcp on its own, with a bearer check that lets ana through as the approved client. */
  async function bare(tools: readonly McpTool[], deadlineMs: number) {
    const app = new Hono<AuthEnv>();
    const { grantId, accessToken } = await token();
    mountMcp(app, {
      db,
      version: "0.0.0",
      publicUrl: PUBLIC,
      deadlineMs,
      tools,
      requireBearer: () => async (c, next) => {
        c.set("bearer", {
          tenantId: t.tenantId,
          principal: {
            userId: ana.id,
            groupIds: [],
            tagGrants: [],
            tagWriteGrants: [],
            objectGrants: [],
            objectWriteGrants: [],
            guest: false,
            active: true,
          },
          client: { id: CLIENT_ID, trust: "commercial" },
          grantId,
          tokenId: accessToken.split(".")[2] as string,
          scopes: ["files:read"],
        });
        await next();
      },
    });
    return app;
  }

  it("serves only whoami in T-801", () => {
    expect(TOOLS.map((x) => x.name)).toEqual(["whoami"]);
  });
});

/*
 * T-604 through MCP, and T-106's trust label reaching policy: a tool as T-802 and T-803 will
 * write them, reading the catalog with readRequest(ctx), for a client whose label an admin set.
 */
describe("exposure and the client's trust through MCP", () => {
  const plain = new Authorizer(createCedarEngine());
  // A pack rule on the client's trust: a label is something policy can decide on.
  const noConsumerOpens = new Authorizer(
    createCedarEngine({
      "pack/no-consumer-open": `forbid (principal, action == OpenHoard::Action::"open", resource)
        when { context.client.trust == "consumer" };`,
    }),
  );
  const probe: McpTool = {
    name: "probe",
    title: "Probe",
    description: "Reads the seeded file's card and opens it, as T-802/T-803's tools will.",
    inputSchema: { rule: z.boolean() },
    async run(ctx, args) {
      const gate = args.rule === true ? noConsumerOpens : plain;
      const request = readRequest(ctx);
      const snapshot = <T>(work: (tx: Tx) => Promise<T>) =>
        ctx.db.withTenant(ctx.bearer.tenantId, work, VIEW_TRANSACTION);
      const card = await snapshot((tx) =>
        viewObject(tx, ctx.bearer.tenantId, gate, request, t.objectId),
      );
      const opened = await snapshot((tx) =>
        openContent(tx, ctx.bearer.tenantId, gate, request, t.objectId),
      );
      const out = {
        metadataOnly: card?.shape === "card" ? card.metadataOnly : null,
        opened: opened !== null,
      };
      return { structuredContent: out, content: [{ type: "text", text: JSON.stringify(out) }] };
    },
  };
  const setExposure = (exposure: string) =>
    db.withTenant(t.tenantId, (tx) =>
      tx
        .update(facetValues)
        .set({ exposure: exposure as "full" })
        .where(and(eq(facetValues.tenantId, t.tenantId), eq(facetValues.facet, "sensitivity"))),
    );
  const relabel = (trust: "local" | "commercial" | "consumer") =>
    db.withTenant(t.tenantId, (tx) =>
      decideClient(tx, t.tenantId, clientKey, { approve: true, trust }, "user:admin"),
    );

  beforeEach(async () => {
    await db.withTenant(t.tenantId, async (tx) => {
      await tx.insert(facets).values({ tenantId: t.tenantId, key: "sensitivity", label: "S" });
      await tx.insert(facetValues).values({
        tenantId: t.tenantId,
        facet: "sensitivity",
        value: "internal",
        label: "Internal",
        approved: true,
        exposure: "commercial-only",
      });
      await tx.insert(objectTags).values({
        tenantId: t.tenantId,
        objectId: t.objectId,
        facet: "sensitivity",
        value: "internal",
        source: "rule",
        appliedBy: "rule:test",
        confidence: 1,
      });
      await addGrant(tx, t.tenantId, {
        principal: `user:${ana.id}`,
        role: "read",
        target: { objectId: t.objectId },
        grantedBy: "user:admin",
      });
      await markProcessed(tx, t.tenantId, { versionId: t.versionId, title: "Report 1.docx" });
    });
  });

  const call = async (app: Hono<AuthEnv>, accessToken: string, rule = false) => {
    const res = await rpc(app, accessToken, "tools/call", { name: "probe", arguments: { rule } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { structuredContent: unknown } };
    return body.result.structuredContent;
  };
  const withheldAudit = async () => {
    const lines: string[] = [];
    await exportAudit(db, t.tenantId, {}, "ndjson", (s: string) => void lines.push(s));
    return lines
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((e) => e.action === "object.open");
  };

  it("gives a consumer client metadata only for a commercial-only tag, and audits what it withheld", async () => {
    const app = build([probe]);
    const { accessToken } = await token();
    // Approved as commercial: the content.
    expect(await call(app, accessToken)).toEqual({ metadataOnly: false, opened: true });
    expect(await withheldAudit()).toEqual([]);
    // Relabelled consumer: the same token's next request gets metadata only.
    await relabel("consumer");
    expect(await call(app, accessToken)).toEqual({ metadataOnly: true, opened: false });
    expect(await withheldAudit()).toMatchObject([
      {
        actor: `user:${ana.id}`,
        decision: "deny",
        client: CLIENT_ID,
        object: t.objectId,
        detail: { reason: "exposure", exposure: "commercial-only", trust: "consumer" },
      },
    ]);
    // Full exposure: any client.
    await setExposure("full");
    expect(await call(app, accessToken)).toEqual({ metadataOnly: false, opened: true });
    // Local-only: only a local client.
    await setExposure("local-only");
    await relabel("commercial");
    expect(await call(app, accessToken)).toEqual({ metadataOnly: true, opened: false });
    await relabel("local");
    expect(await call(app, accessToken)).toEqual({ metadataOnly: false, opened: true });
    expect(await withheldAudit()).toHaveLength(2);
  });

  it("hands the client's trust label to policy: a pack rule can decide on it", async () => {
    await setExposure("full");
    const app = build([probe]);
    const { accessToken } = await token();
    expect(await call(app, accessToken, true)).toEqual({ metadataOnly: false, opened: true });
    await relabel("consumer");
    // Exposure would let it through; the pack's forbid on consumer clients doesn't.
    expect(await call(app, accessToken, false)).toEqual({ metadataOnly: false, opened: true });
    expect(await call(app, accessToken, true)).toEqual({ metadataOnly: false, opened: false });
  });
});
