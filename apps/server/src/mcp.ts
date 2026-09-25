import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { ACTIVITY_PAGE, ActivityBuffer, writeActivity } from "@openhoard/core-catalog";
import type { Database } from "@openhoard/core-db";
import { getUser } from "@openhoard/core-identity";
import type { Hono, MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import type { Logger } from "pino";
import { z } from "zod";
import type { AuthEnv, BearerAuth } from "./auth.js";

/*
 * The MCP server (T-801): Streamable HTTP at `<publicUrl>/mcp`, the resource T-105's tokens are
 * for. Stateless: no Mcp-Session-Id, and every request is its own POST, whose bearer token is
 * checked against oauth_tokens before anything else (requireBearer). A fresh McpServer and
 * transport serve each request, so nothing about one caller outlives their request.
 *
 * Each request gets an ActivityBuffer, which the tools' gated reads record into (they run in
 * read-only snapshots), written once the response is ready (T-205). An MCP read is an AI read:
 * the event keeps the client's id and trust.
 *
 * Tools: `whoami` (who the token speaks for). find, recent and describe come with T-802.
 */

/** A read that writes nothing and sees one moment (as the bearer check reads). */
const SNAPSHOT = { isolationLevel: "repeatable read", accessMode: "read only" } as const;
/** MCP requests are small JSON-RPC messages. */
const MAX_BODY = 256 * 1024;
/** A request still running after this long is answered 503 and its tools aborted. */
const DEADLINE_MS = 60_000;

export interface McpDeps {
  db: Database;
  log?: Logger;
  requireBearer: () => MiddlewareHandler<AuthEnv>;
  version: string;
  /** The server's public origin (auth.publicUrl): browsers there may call /mcp. */
  publicUrl: string;
  /** Other browser origins allowed to call /mcp (auth.mcpOrigins). */
  origins?: readonly string[];
  /** Milliseconds a request may run; {@link DEADLINE_MS} by default. */
  deadlineMs?: number;
  /** The tools served; {@link TOOLS} by default. */
  tools?: readonly McpTool[];
}

/** What a tool call runs with: who is asking, through which client, and where activity goes. */
export interface ToolContext {
  db: Database;
  bearer: BearerAuth;
  /** Gated reads record into it (ViewRequest.activity); it is written after the response. */
  activity: ActivityBuffer;
  /** Aborted when the client hangs up or the request passes its deadline: stop reading. */
  signal: AbortSignal;
}

/** A tool: what clients see of it, and what it does for one caller. */
export interface McpTool {
  name: string;
  title: string;
  description: string;
  /** Arguments, as a zod shape the SDK validates (none: the tool takes no arguments). */
  inputSchema?: z.ZodRawShape;
  outputSchema?: z.ZodRawShape;
  annotations?: ToolAnnotations;
  run(ctx: ToolContext, args: Record<string, unknown>): Promise<CallToolResult>;
}

const JSON_RPC_ERROR = (code: number, message: string) => ({
  jsonrpc: "2.0" as const,
  error: { code, message },
  id: null,
});

export function mountMcp(app: Hono<AuthEnv>, deps: McpDeps): void {
  const { db, log } = deps;
  const allowed = allowedOrigin(deps.publicUrl, deps.origins ?? []);

  // Browser clients (the MCP Inspector) call /mcp across origins with a bearer token and no
  // cookies, and must read the WWW-Authenticate challenge. Only allowed origins get CORS.
  app.use(
    "/mcp",
    cors({
      origin: (origin) => (allowed(origin) ? origin : null),
      allowHeaders: ["authorization", "content-type", "mcp-protocol-version"],
      exposeHeaders: ["www-authenticate"],
    }),
  );

  // The spec's DNS-rebinding defence: a request a browser sent from an origin not allowed gets
  // 403, before the token is even looked at. No Origin (a hosted or local client) is fine.
  const checkOrigin: MiddlewareHandler<AuthEnv> = async (c, next) => {
    const origin = c.req.header("origin");
    if (origin !== undefined && !allowed(origin)) {
      return c.json(JSON_RPC_ERROR(-32000, "origin not allowed"), 403);
    }
    await next();
  };

  app.all("/mcp", checkOrigin, deps.requireBearer(), async (c) => {
    // Stateless: no standalone stream to GET and no session to DELETE.
    if (c.req.method !== "POST") {
      c.header("allow", "POST");
      return c.json(JSON_RPC_ERROR(-32000, "method not allowed: POST only"), 405);
    }
    // A client gone mid-body (or before we started) gets nothing further, and no error log.
    const gone = () => c.json(JSON_RPC_ERROR(-32000, "client closed the request"), 400);
    const signal = c.req.raw.signal;
    const body = await readMessage(c.req.raw).catch((err: unknown) => {
      if (signal.aborted) return null;
      throw err;
    });
    if (body === null || signal.aborted) return gone();
    if (!body.ok) return c.json(JSON_RPC_ERROR(body.code, body.message), body.status);

    const bearer = c.get("bearer") as BearerAuth;
    const ctx: Omit<ToolContext, "signal"> = { db, bearer, activity: new ActivityBuffer() };
    const server = buildServer(deps, ctx);
    // No sessionIdGenerator: stateless, the transport issues and accepts no session id.
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    const warn = (what: string) => (err: unknown) => log?.warn({ err }, `mcp: ${what}`);
    transport.onerror = warn("transport error");
    server.server.onerror = warn("protocol error");
    // A client that hangs up, or a request past the deadline, ends the request and aborts its
    // tools (server.close() below): the transport's pending answer then never settles.
    let hangUp: (() => void) | undefined;
    const hungUp = new Promise<"gone">((resolve) => (hangUp = () => resolve("gone")));
    signal.addEventListener("abort", hangUp as () => void, { once: true });
    let timer: NodeJS.Timeout | undefined;
    let response: Response | "timeout" | "gone";
    try {
      await server.connect(transport);
      response = await Promise.race([
        transport.handleRequest(c.req.raw, {
          parsedBody: body.message,
          authInfo: {
            token: "",
            clientId: bearer.client.id,
            scopes: [...bearer.scopes],
            extra: { tenantId: bearer.tenantId, userId: bearer.principal.userId },
          },
        }),
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), deps.deadlineMs ?? DEADLINE_MS);
        }),
        hungUp,
      ]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", hangUp as () => void);
      await server.close().catch(warn("close failed"));
    }
    if (response === "gone") return gone();
    if (response === "timeout") {
      log?.warn({ tenantId: bearer.tenantId }, "mcp: request past its deadline");
      return c.json(JSON_RPC_ERROR(-32000, "request took too long"), 503);
    }
    // What the tools read is recorded before the answer leaves: an unrecorded AI read is refused.
    const events = ctx.activity.take();
    if (events.length > 0) {
      try {
        await db.withTenant(bearer.tenantId, async (tx) => {
          for (let i = 0; i < events.length; i += ACTIVITY_PAGE) {
            await writeActivity(tx, bearer.tenantId, events.slice(i, i + ACTIVITY_PAGE));
          }
        });
      } catch (err) {
        log?.error({ err }, "mcp: writing activity failed");
        return c.json(JSON_RPC_ERROR(-32603, "internal error"), 500);
      }
    }
    return response;
  });
}

type Read =
  { ok: true; message: unknown } | { ok: false; status: 400 | 413; code: number; message: string };

/**
 * The POST body as one JSON-RPC message, read to at most MAX_BODY bytes. Batches (arrays, which
 * MCP dropped in 2025-06-18) are refused: in one, a cancel or a repeated id could keep a tool
 * running past its response, and a hundred calls could hold every database connection.
 */
async function readMessage(req: Request): Promise<Read> {
  const tooBig = { ok: false, status: 413, code: -32000, message: "body too large" } as const;
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) return tooBig;
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (req.body) {
    const reader = req.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) {
        await reader.cancel().catch(() => undefined);
        return tooBig;
      }
      chunks.push(value);
    }
  }
  let message: unknown;
  try {
    message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return { ok: false, status: 400, code: -32700, message: "parse error" };
  }
  if (Array.isArray(message)) {
    return { ok: false, status: 400, code: -32600, message: "batches are not supported" };
  }
  return { ok: true, message };
}

/**
 * Which browser origins may call /mcp: publicUrl's own, this machine's (a local inspector), and
 * any the config lists.
 */
function allowedOrigin(publicUrl: string, extra: readonly string[]) {
  const listed = new Set([new URL(publicUrl).origin, ...extra.map((o) => new URL(o).origin)]);
  return (origin: string): boolean => {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      return false;
    }
    if (url.origin !== origin) return false;
    if (listed.has(origin)) return true;
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    return local && (url.protocol === "http:" || url.protocol === "https:");
  };
}

/** Who the token speaks for: the person, the client and its trust, the scopes granted. */
export const whoami: McpTool = {
  name: "whoami",
  title: "Who am I",
  description:
    "The person this connection acts for, the client it came through with its trust level, and " +
    "the scopes it was granted.",
  outputSchema: {
    user: z.object({
      id: z.string(),
      displayName: z.string(),
      email: z.string().nullable(),
      kind: z.string(),
    }),
    tenantId: z.string(),
    client: z.object({ id: z.string(), trust: z.string() }),
    scopes: z.array(z.string()),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  async run({ db, bearer }) {
    const user = await db.withTenant(
      bearer.tenantId,
      (tx) => getUser(tx, bearer.tenantId, bearer.principal.userId),
      SNAPSHOT,
    );
    if (!user) throw new Error("the token's user is gone");
    const out = {
      user: { id: user.id, displayName: user.displayName, email: user.email, kind: user.kind },
      tenantId: bearer.tenantId,
      client: { id: bearer.client.id, trust: bearer.client.trust },
      scopes: [...bearer.scopes],
    };
    return {
      structuredContent: out,
      content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
    };
  },
};

/** The tools T-801 serves. find, recent and describe join with T-802. */
export const TOOLS: readonly McpTool[] = [whoami];

/** One request's server: its tools close over that request's caller and activity buffer. */
function buildServer(deps: McpDeps, ctx: Omit<ToolContext, "signal">): McpServer {
  const server = new McpServer(
    { name: "openhoard", version: deps.version },
    {
      instructions:
        "OpenHoard holds this person's files behind their permissions. Every answer is limited " +
        "to what they may see through this client.",
    },
  );
  for (const tool of deps.tools ?? TOOLS) {
    const run = guarded(deps, tool, ctx);
    const config = {
      title: tool.title,
      description: tool.description,
      ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
      ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
      ...(tool.annotations ? { annotations: tool.annotations } : {}),
    };
    // With an input schema the SDK passes (args, extra); without one, (extra) alone.
    if (tool.inputSchema) {
      server.registerTool(tool.name, config, ((args: Record<string, unknown>, extra: Extra) =>
        run(args, extra.signal)) as never);
    } else {
      server.registerTool(tool.name, config, ((extra: Extra) => run({}, extra.signal)) as never);
    }
  }
  return server;
}

/**
 * A tool handler whose failures reach the client as a bare "internal error": the SDK would
 * otherwise send the thrown message (a database error, a file name) back as the result.
 */
function guarded(
  deps: McpDeps,
  tool: McpTool,
  ctx: Omit<ToolContext, "signal">,
): (args: Record<string, unknown>, signal: AbortSignal) => Promise<CallToolResult> {
  return async (args, signal) => {
    try {
      return await tool.run({ ...ctx, signal }, args);
    } catch (err) {
      deps.log?.error({ err, tool: tool.name }, "mcp: tool failed");
      return { isError: true, content: [{ type: "text", text: "internal error" }] };
    }
  };
}

/** What the SDK hands a tool besides its arguments; only the abort signal is used. */
interface Extra {
  signal: AbortSignal;
}
