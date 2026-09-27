import { createHash, randomBytes } from "node:crypto";
import { exportAudit } from "@openhoard/core-audit";
import { saveCard, saveEmbeddings, saveExtract } from "@openhoard/core-catalog";
import {
  facets,
  facetValues,
  newId,
  objects,
  objectTags,
  sourceRefs,
  tenants,
  versions,
  type Database,
  type Tx,
} from "@openhoard/core-db";
import { openTestDatabase, seedTenant, type SeededTenant } from "@openhoard/core-db/testing";
import {
  createUser,
  decideClient,
  issueCode,
  noteClient,
  redeemCode,
  type OAuthScope,
  type User,
} from "@openhoard/core-identity";
import {
  createModelClient,
  createModelRouter,
  dailyTokenBudget,
  stubEmbedding,
} from "@openhoard/core-models";
import type { ClientTrust } from "@openhoard/core-policy";
import { and, eq, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { createApp } from "../app.js";
import type { AuthEnv } from "../auth.js";
import { ConfigSchema } from "../config.js";
import type { McpTool } from "../mcp.js";

/*
 * A tenant, its people and approved AI clients, and files as enrichment leaves them (title,
 * tags, extracted text, a summary, a web link), behind the real /mcp endpoint with OAuth tokens
 * as the token endpoint issues them: for the T-802..T-806 tool tests.
 */

export const PUBLIC = "https://hoard.example";
export const RESOURCE = `${PUBLIC}/mcp`;
/** The stub embeddings model files and queries share: words hashed, so shared words align. */
export const EMBED_MODEL = "ollama/stub-embed";
const DIMENSIONS = 64;

export const MIME = {
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv",
  pdf: "application/pdf",
  txt: "text/plain",
} as const;

/** One approved client per trust label, as an admin would approve them. */
export const CLIENTS: Record<ClientTrust, { id: string; redirect: string }> = {
  commercial: {
    id: "https://claude.example/oauth/mcp.json",
    redirect: "https://claude.example/cb",
  },
  consumer: { id: "https://chat.example/oauth/mcp.json", redirect: "https://chat.example/cb" },
  local: { id: "https://agent.example/oauth/mcp.json", redirect: "https://agent.example/cb" },
};

export interface FileInput {
  title: string;
  mime?: string;
  /** A user, or any principal string. Default Ana. */
  owner?: User | string;
  /** Trusted (rule) tags, `facet:value`; the vocabulary is created approved. */
  tags?: readonly string[];
  /** Unreviewed model tags. */
  modelTags?: readonly string[];
  /** Extracted text. */
  text?: string;
  /** A summary, written by a local model. */
  summary?: string;
  /** The source's web address for the item. */
  url?: string;
  processed?: boolean;
  /** Last change; now by default. */
  updatedAt?: Date;
}

export interface ToolAnswer {
  status: number;
  isError: boolean;
  /** structuredContent (any: tests read what they pin). */
  data: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  /** The text block: what a text-only client (and the model) reads. */
  text: string;
}

export interface Harness {
  db: Database;
  seed: SeededTenant;
  tenantId: string;
  ana: User;
  bo: User;
  app: Hono<AuthEnv>;
  clientKeys: Record<ClientTrust, string>;
  token(options?: { scopes?: OAuthScope[]; trust?: ClientTrust; user?: User }): Promise<string>;
  call(
    token: string,
    tool: string,
    args?: Record<string, unknown>,
    meta?: Record<string, unknown>,
  ): Promise<ToolAnswer>;
  addFile(input: FileInput): Promise<{ objectId: string; versionId: string }>;
  /** The tenant's audit log, oldest first. */
  audit(action?: string): Promise<Record<string, any>[]>; // eslint-disable-line @typescript-eslint/no-explicit-any
  inTenant<T>(work: (tx: Tx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function openHarness(
  options: { tools?: readonly McpTool[]; embed?: boolean } = {},
): Promise<Harness> {
  const db = await openTestDatabase();
  const seed = await seedTenant(db, 1);
  const { tenantId } = seed;
  const inTenant = <T>(work: (tx: Tx) => Promise<T>) => db.withTenant(tenantId, work);
  const { ana, bo, clientKeys } = await inTenant(async (tx) => {
    // Processed files are discoverable, and AI clients may have their content, unless a tag
    // says otherwise (sensitivity:confidential keeps it local).
    await tx.update(tenants).set({ defaultVisibility: "discoverable", defaultExposure: "full" });
    await tx.insert(facets).values({ tenantId, key: "sensitivity", label: "Sensitivity" });
    await tx.insert(facetValues).values({
      tenantId,
      facet: "sensitivity",
      value: "confidential",
      label: "Confidential",
      approved: true,
      exposure: "local-only",
    });
    const ana = await createUser(tx, tenantId, {
      email: "ana@example.com",
      displayName: "Ana Lima",
      source: "local",
    });
    const bo = await createUser(tx, tenantId, {
      email: "bo@example.com",
      displayName: "Bo Chen",
      source: "local",
    });
    const clientKeys = {} as Record<ClientTrust, string>;
    for (const trust of ["commercial", "consumer", "local"] as const) {
      const c = CLIENTS[trust];
      const noted = await noteClient(
        tx,
        tenantId,
        { kind: "cimd", clientRef: c.id, name: trust, redirectUris: [c.redirect] },
        `user:${ana.id}`,
      );
      const key = noted?.clientKey as string;
      await decideClient(tx, tenantId, key, { approve: true, trust }, "system:test");
      clientKeys[trust] = key;
    }
    return { ana, bo, clientKeys };
  });

  const config = ConfigSchema.parse({
    dataDir: "/tmp/unused",
    auth: {
      publicUrl: PUBLIC,
      cookieKey: "k".repeat(43),
      providers: [
        { id: "dev", kind: "generic", tenantId, issuer: "https://idp.example", clientId: "x" },
      ],
    },
  });
  // A local stub embeddings model (on by default): find embeds queries with it, and files get
  // vectors of their text under the same model.
  const embed = options.embed !== false;
  const model = createModelClient({
    id: "ollama",
    kind: "local",
    adapter: "stub",
    chatModel: "stub",
    embedModel: "stub-embed",
    embedDimensions: DIMENSIONS,
  });
  const app = createApp(config, undefined, {
    db,
    ...(options.tools ? { mcpTools: options.tools } : {}),
    ...(embed
      ? { embed: { router: createModelRouter([model]), budget: dailyTokenBudget(10_000_000) } }
      : {}),
  });

  const token: Harness["token"] = async ({
    scopes = ["files:read"],
    trust = "commercial",
    user = ana,
  }: { scopes?: OAuthScope[]; trust?: ClientTrust; user?: User } = {}) => {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const c = CLIENTS[trust];
    return inTenant(async (tx) => {
      const code = await issueCode(tx, tenantId, {
        userId: user.id,
        clientKey: clientKeys[trust],
        redirectUri: c.redirect,
        codeChallenge: challenge,
        scopes,
        resource: RESOURCE,
      });
      const set = await redeemCode(tx, tenantId, code, {
        clientKey: clientKeys[trust],
        redirectUri: c.redirect,
        codeVerifier: verifier,
        resource: RESOURCE,
      });
      if (!set.ok) throw new Error(set.reason);
      return set.accessToken;
    });
  };

  const call: Harness["call"] = async (accessToken, tool, args = {}, meta) => {
    const res = await app.request(RESOURCE, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: tool, arguments: args, ...(meta ? { _meta: meta } : {}) },
      }),
    });
    const body = (await res.json()) as {
      result?: { isError?: boolean; structuredContent?: unknown; content?: { text?: string }[] };
    };
    return {
      status: res.status,
      isError: body.result?.isError === true,
      data: body.result?.structuredContent,
      text: body.result?.content?.[0]?.text ?? "",
    };
  };

  const addFile: Harness["addFile"] = async (input) => {
    const objectId = newId("object");
    const versionId = newId("version");
    const owner =
      input.owner === undefined
        ? `user:${ana.id}`
        : typeof input.owner === "string"
          ? input.owner
          : `user:${input.owner.id}`;
    await inTenant(async (tx) => {
      await tx.insert(objects).values({
        tenantId,
        id: objectId,
        zoneId: seed.zoneId,
        title: input.title,
        ownerId: owner,
        ...(input.updatedAt ? { updatedAt: input.updatedAt } : {}),
      });
      await tx.insert(versions).values({
        tenantId,
        id: versionId,
        objectId,
        seq: 1,
        blobId: seed.blobId,
        mime: input.mime ?? MIME.docx,
        authorId: owner,
        ...(input.processed === false ? {} : { processedAt: sql`now()` }),
      });
      await tx.insert(sourceRefs).values({
        tenantId,
        source: "sharepoint",
        externalId: `item-${objectId}`,
        objectId,
        url: input.url ?? null,
      });
      const tags = [
        ...(input.tags ?? []).map((tag) => ({ tag, model: false })),
        ...(input.modelTags ?? []).map((tag) => ({ tag, model: true })),
      ];
      for (const { tag, model } of tags) {
        const [facet, value] = tag.split(":") as [string, string];
        await tx
          .insert(facets)
          .values({ tenantId, key: facet, label: facet })
          .onConflictDoNothing();
        const [known] = await tx
          .select({ value: facetValues.value })
          .from(facetValues)
          .where(
            and(
              eq(facetValues.tenantId, tenantId),
              eq(facetValues.facet, facet),
              eq(facetValues.value, value),
            ),
          );
        if (!known) {
          // risk:injection is built-in vocabulary: metadata-only, as core/db keeps it.
          const builtIn = facet === "risk" && value === "injection";
          await tx.insert(facetValues).values({
            tenantId,
            facet,
            value,
            label: value,
            approved: true,
            ...(builtIn ? { exposure: "metadata-only" as const } : {}),
          });
        }
        await tx.insert(objectTags).values({
          tenantId,
          objectId,
          facet,
          value,
          source: model ? "model" : "rule",
          appliedBy: model ? "model:m" : "rule:fixture",
          confidence: model ? 0.9 : 1,
        });
      }
      if (input.text !== undefined) {
        await saveExtract(tx, tenantId, {
          objectId,
          versionId,
          status: "extracted",
          kind: "text",
          text: input.text,
          truncated: false,
          metadata: {},
          signals: [],
          warnings: [],
          failure: null,
          extractor: "fixture/1",
        });
      }
      if (embed && input.text !== undefined) {
        await saveEmbeddings(tx, tenantId, {
          objectId,
          versionId,
          model: EMBED_MODEL,
          providerKind: "local",
          items: [
            {
              part: "chunk",
              seq: 0,
              textHash: createHash("sha256").update(input.text).digest("hex"),
              embedding: stubEmbedding(input.text, DIMENSIONS),
            },
          ],
        });
      }
      if (input.summary !== undefined) {
        await saveCard(tx, tenantId, {
          objectId,
          versionId,
          status: "summarized",
          summary: input.summary,
          providerId: "fixture",
          providerKind: "local",
          model: "fixture",
          promptVersion: "fixture-1",
          filtered: 0,
          inputTokens: 1,
          outputTokens: 1,
        });
      }
    });
    return { objectId, versionId };
  };

  const audit: Harness["audit"] = async (action) => {
    const lines: string[] = [];
    await exportAudit(db, tenantId, {}, "ndjson", (s: string) => void lines.push(s));
    return lines
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((e) => action === undefined || e.action === action);
  };

  return {
    db,
    seed,
    tenantId,
    ana,
    bo,
    app,
    clientKeys,
    token,
    call,
    addFile,
    audit,
    inTenant,
    close: () => db.close(),
  };
}
