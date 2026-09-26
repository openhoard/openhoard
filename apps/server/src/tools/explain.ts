import {
  explainAccess,
  viewObjects,
  whoCanAccess,
  VIEW_TRANSACTION,
  type AccessEntry,
} from "@openhoard/core-catalog";
import { isId } from "@openhoard/core-db";
import { findUserByEmail, getUser } from "@openhoard/core-identity";
import { mayAdminister } from "@openhoard/core-policy";
import { z } from "zod";
import { clip, DEFAULT_TOKENS, maxTokensArg, TITLE_MAX, tokensOf } from "./cards.js";
import { answer, readRequest, refuse, type McpTool } from "./context.js";

/*
 * `explain` (T-806, scenario 4 read side: "why can they see it?"): who has access to a file, and
 * optionally why one named person can or can't read it, from core/catalog whoCanAccess() and
 * explainAccess().
 *
 * FOR THE FILE'S OWNER ONLY through MCP (and a tenant admin, where core/policy mayAdminister()
 * allows it: never through an AI client today, since administration goes through OpenHoard's
 * own app, T-106). Explanations name groups, people, grants and the real title, which a mere
 * reader must not learn. Anyone else gets a refusal; a file they may not know about answers as
 * an unknown id does.
 */

export const ExplainInput = {
  id: z.string().max(64).describe("The file's id, from a card."),
  person: z
    .string()
    .max(320)
    .optional()
    .describe("Optional: a person's email (or user id) to explain their access."),
  maxTokens: maxTokensArg,
};

const Access = z.object({
  name: z.string(),
  kind: z.enum(["user", "group"]),
  role: z.enum(["read", "write"]),
  /** `this file`, or `tag facet:value`. */
  via: z.string(),
  /** ISO 8601, or null for a grant without an end. */
  expires: z.string().nullable(),
});

export const ExplainOutput = {
  file: z.object({ id: z.string(), title: z.string() }),
  owner: z.string().nullable(),
  /** Who discovers it without a grant (hidden, discoverable, readable), and AI exposure. */
  visibility: z.string(),
  exposure: z.string(),
  access: z.array(Access),
  /** Grants on tags only a model guessed: they count once a person reviews the tag. */
  pendingTagAccess: z.array(Access),
  /** Entries left out for the answer's size. */
  omitted: z.number().int(),
  person: z
    .object({
      name: z.string(),
      canRead: z.boolean(),
      /** What they get in a listing: card, title-only or none. */
      sees: z.string(),
      explanation: z.string(),
    })
    .nullable()
    .optional(),
  note: z.string(),
};

type AccessRow = z.infer<typeof Access>;

export const explain: McpTool = {
  name: "explain",
  title: "Who can see this",
  description:
    "For a file the person owns: who has access (people and groups, through which grant), its " +
    "visibility and AI exposure, and optionally why a named person can or can't read it. " +
    "Others are refused.",
  inputSchema: ExplainInput,
  outputSchema: ExplainOutput,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  async run(ctx, args) {
    const a = args as { id: string; person?: string; maxTokens?: number };
    const { bearer } = ctx;
    const { tenantId } = bearer;
    const out = await ctx.db.withTenant(
      tenantId,
      async (tx) => {
        const authz = await ctx.authz(tx, tenantId);
        const [view] = await viewObjects(tx, tenantId, authz, readRequest(ctx), [a.id]);
        if (!view) return "not-found" as const;
        const owner = view.ownerId === `user:${bearer.principal.userId}`;
        if (!owner && !mayAdminister(bearer.principal, bearer.client).allow) {
          return "refused" as const;
        }
        const list = await whoCanAccess(tx, tenantId, view.id);
        let person: { name: string; canRead: boolean; sees: string; explanation: string } | null =
          null;
        if (a.person !== undefined) {
          const who = isId("user", a.person)
            ? await getUser(tx, tenantId, a.person)
            : await findUserByEmail(tx, tenantId, a.person);
          if (who) {
            const e = await explainAccess(tx, tenantId, authz, {
              userId: who.id,
              objectId: view.id,
            });
            person = {
              name: who.displayName,
              canRead: e.allowed,
              sees: e.view,
              explanation: e.summary,
            };
          }
        }
        const row = (g: AccessEntry): AccessRow => ({
          name: clip(g.name, 120),
          kind: g.principal.startsWith("group:") ? "group" : "user",
          role: g.role,
          via: "tag" in g.target ? `tag ${g.target.tag}` : "this file",
          expires: g.expiresAt?.toISOString() ?? null,
        });
        return {
          file: { id: view.id, title: clip(list.title, TITLE_MAX) },
          owner: list.ownerName,
          visibility: list.levels.visibility,
          exposure: list.levels.exposure,
          access: list.grants.map(row),
          pendingTagAccess: list.unreviewedTagGrants.map(row),
          omitted: 0,
          ...(a.person !== undefined
            ? {
                person: person ?? {
                  name: a.person,
                  canRead: false,
                  sees: "none",
                  explanation: "No such person in this organization.",
                },
              }
            : {}),
          note: "Grants and the file's own levels; pack rules can add or remove access, and a locked account reads nothing. Name a person for their exact decision.",
        };
      },
      VIEW_TRANSACTION,
    );
    if (out === "not-found") return refuse(ctx, "not found", { outcome: "not-found" });
    if (out === "refused") {
      return refuse(
        ctx,
        "Only the file's owner can see who has access to it (admins: in OpenHoard's app).",
        { outcome: "refused", object: a.id },
      );
    }
    // Over budget: the longest list gives way first; `omitted` says how much went.
    const budget = a.maxTokens ?? DEFAULT_TOKENS;
    while (tokensOf(out) > budget && (out.access.length > 0 || out.pendingTagAccess.length > 0)) {
      if (out.pendingTagAccess.length > 0) out.pendingTagAccess.pop();
      else out.access.pop();
      out.omitted++;
    }
    ctx.trail.note({ outcome: "ok", object: out.file.id, results: out.access.length });
    return answer(out);
  },
};
