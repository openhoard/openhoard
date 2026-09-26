import { createHash } from "node:crypto";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { AuditRecord } from "@openhoard/core-audit";
import {
  canonicalJson,
  tenantPolicies,
  type ActivityBuffer,
  type RecordedRequest,
} from "@openhoard/core-catalog";
import type { Database, Tx } from "@openhoard/core-db";
import type { ModelRouter, TokenBudget } from "@openhoard/core-models";
import { Authorizer, createCedarEngine } from "@openhoard/core-policy";
import type { Logger } from "pino";
import type { z } from "zod";
import type { BearerAuth } from "../auth.js";

/*
 * What an MCP tool runs with (T-801, T-802): the caller, the request's activity buffer and
 * audit trail, the tenant's policies, and the model the client says it is. Kept apart from
 * mcp.ts so the tools and the server can both import it.
 */

/** Query embeddings for find (T-503): the server's model router and the tenant token budget. */
export interface EmbedDeps {
  router: ModelRouter;
  budget: TokenBudget;
}

/** The tenant's Authorizer: the core rules plus its applied packs' policies. */
export type TenantAuthorizer = (tx: Tx, tenantId: string) => Promise<Authorizer>;

/** What a tool call runs with: who is asking, through which client, and where records go. */
export interface ToolContext {
  db: Database;
  bearer: BearerAuth;
  /** Gated reads record into it (ViewRequest.activity); it is written after the response. */
  activity: ActivityBuffer;
  /** Audit records the call adds (AI reads, refusals); written with the activity. */
  trail: AuditTrail;
  /** Aborted when the client hangs up or the request passes its deadline: stop reading. */
  signal: AbortSignal;
  /** The tenant's policies, read in the caller's transaction (a pack change applies at once). */
  authz: TenantAuthorizer;
  /**
   * The model the client says it runs (`_meta` on the call), for the audit of AI reads
   * (T-704); `unknown` when it doesn't say. Self-reported: a label, never a decision.
   */
  model: string;
  /** Query embeddings, when the server has an embeddings model. */
  embed?: EmbedDeps;
  log?: Logger;
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

/** What one call is noted as in its `mcp.tool` audit record: never content, never a query. */
export interface CallNote {
  /** `ok`, or why nothing (or less) came back: `not-found`, `metadata-only`, `refused`… */
  outcome: string;
  /** The one file the call was about. */
  object?: string;
  /** How many files it answered with. */
  results?: number;
}

/**
 * The audit records a request adds, written in the same transaction as its activity, after it,
 * before the answer leaves (mcp.ts): an unrecorded AI read is refused, as an unrecorded view is.
 */
export class AuditTrail {
  #records: AuditRecord[] = [];
  #note: CallNote = { outcome: "ok" };

  record(record: AuditRecord): void {
    this.#records.push({ ...record, ...(record.detail ? { detail: { ...record.detail } } : {}) });
  }

  /** Sets what the call's `mcp.tool` record says (the last note wins). */
  note(note: CallNote): void {
    this.#note = { ...note };
  }

  /** The call's note, and a fresh one for the next call. */
  takeNote(): CallNote {
    const note = this.#note;
    this.#note = { outcome: "ok" };
    return note;
  }

  /** The records since the last take(), oldest first; empties the trail. */
  take(): AuditRecord[] {
    const out = this.#records;
    this.#records = [];
    return out;
  }
}

/**
 * What a tool passes to core/catalog's gated reads (viewObject, openContent, searchObjects…):
 * the person the token speaks for, with the grant's scopes, through the client that holds it
 * with the trust label an admin gave it, recording into the request's buffer. Exposure (T-604)
 * follows from that trust: cards are metadata only, and content isn't opened, where the file's
 * exposure doesn't reach the client. Build every catalog request from this, never by hand.
 */
export function readRequest(ctx: Pick<ToolContext, "bearer" | "activity">): RecordedRequest {
  return { principal: ctx.bearer.principal, client: ctx.bearer.client, activity: ctx.activity };
}

/** The principal string of the caller: `user:usr_…`. */
export const actorOf = (ctx: Pick<ToolContext, "bearer">) => `user:${ctx.bearer.principal.userId}`;

/**
 * The tenant's Authorizer, compiled once per distinct policy set (a few tenants share the
 * starter pack's) and kept for the most recent `max` sets. The policies are read in the
 * caller's own transaction, so a pack applied or removed counts from the next request; a set
 * that doesn't compile throws (the tool answers "internal error"), it never falls back to fewer
 * rules.
 */
export function cachedTenantAuthorizer(max = 64): TenantAuthorizer {
  const cache = new Map<string, Authorizer>();
  return async (tx, tenantId) => {
    const policies = await tenantPolicies(tx, tenantId);
    const key = createHash("sha256").update(canonicalJson(policies)).digest("hex");
    const hit = cache.get(key);
    if (hit) {
      cache.delete(key);
      cache.set(key, hit);
      return hit;
    }
    const authz = new Authorizer(createCedarEngine(policies));
    cache.set(key, authz);
    if (cache.size > max) cache.delete(cache.keys().next().value as string);
    return authz;
  };
}

/** A tool's JSON answer: structured, and the same JSON as text for clients that read only text. */
export function answer(out: Record<string, unknown>): CallToolResult {
  return { structuredContent: out, content: [{ type: "text", text: JSON.stringify(out) }] };
}

/** A refusal the agent should read and relay: `isError`, with a plain reason, never a detail. */
export function refuse(ctx: ToolContext, reason: string, note: CallNote): CallToolResult {
  ctx.trail.note(note);
  return { isError: true, content: [{ type: "text", text: reason }] };
}

/**
 * The model a tool call says the client runs: `_meta["openhoard/model"]`, `_meta.model` or
 * `_meta.clientInfo.model`, as printable ASCII up to 128 characters; `unknown` otherwise. It is
 * the client's word only, for the audit record.
 */
export function reportedModel(meta: unknown): string {
  if (meta === null || typeof meta !== "object") return "unknown";
  const m = meta as Record<string, unknown>;
  const info = m.clientInfo;
  const candidates = [
    m["openhoard/model"],
    m.model,
    info !== null && typeof info === "object" ? (info as Record<string, unknown>).model : undefined,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && /^[\x21-\x7e][\x20-\x7e]{0,127}$/.test(c)) return c;
  }
  return "unknown";
}
