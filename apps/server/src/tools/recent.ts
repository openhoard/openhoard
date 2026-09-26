import { recentObjects, VIEW_TRANSACTION } from "@openhoard/core-catalog";
import { z } from "zod";
import {
  auditSummaries,
  CardSchema,
  cursorOf,
  DEFAULT_TOKENS,
  fitCards,
  KINDS,
  maxTokensArg,
  mimesOf,
  offsetOf,
  ownerNames,
  parseInstant,
  toCard,
  UNTRUSTED_NOTE,
  type Card,
  type Kind,
} from "./cards.js";
import { answer, readRequest, refuse, type McpTool } from "./context.js";
import { isTimeZone, periodRange, PERIODS, type Period } from "./time.js";

/*
 * `recent` (T-802, T-506; scenario 2 "What CSVs was I looking at yesterday?"): the files the
 * person viewed, opened or edited, from their own activity log (core/catalog recentObjects),
 * newest first, as cards with what they last did and when. Nothing is read from the files: the
 * answer is the activity and the gate's cards.
 *
 * Periods are days in the person's time zone: `timeZone` (IANA, e.g. Europe/Paris) when the
 * client knows it, else UTC; the answer says which zone it used, so the agent can say so.
 */

/** Files a `recent` answer can page through (core/catalog recentObjects' offset). */
const WINDOW = 1_000;

export const RecentInput = {
  period: z
    .enum(PERIODS)
    .optional()
    .describe("A range of whole days in `timeZone` (default last-7-days)."),
  from: z.string().max(40).optional().describe("ISO date or date-time; instead of period."),
  to: z.string().max(40).optional().describe("ISO date or date-time (exclusive)."),
  timeZone: z
    .string()
    .max(64)
    .optional()
    .describe("The person's IANA time zone, e.g. America/Denver (default UTC)."),
  actions: z
    .array(z.enum(["view", "open", "edit"]))
    .min(1)
    .max(3)
    .optional()
    .describe("Which of their actions count (default all)."),
  kind: z.enum(KINDS).optional().describe("Only this kind of file (csv, presentation…)."),
  mediaType: z.string().max(255).optional().describe("Only this exact media type."),
  limit: z.number().int().min(1).max(50).optional().describe("Files to return (default 10)."),
  cursor: z.string().max(64).optional().describe("`more.cursor` from the previous answer."),
  maxTokens: maxTokensArg,
};

const RecentCard = CardSchema.extend({
  /** What the person last did to it in the range, and when (ISO 8601). */
  lastAction: z.enum(["view", "open", "edit", "share"]),
  lastAt: z.string(),
});

export const RecentOutput = {
  files: z.array(RecentCard),
  total: z.number().int(),
  /** The range, as instants, and the zone its days were counted in. */
  range: z.object({ from: z.string().nullable(), to: z.string().nullable(), timeZone: z.string() }),
  /** Only the newest 1,000 events in the range were read: narrow it for older ones. */
  historyTruncated: z.boolean(),
  more: z.object({ cursor: z.string() }).nullable(),
  note: z.string().optional(),
};

export const recent: McpTool = {
  name: "recent",
  title: "Recent files",
  description:
    "Files the person themself viewed, opened or edited in a period (e.g. yesterday in their " +
    "time zone), newest first, from OpenHoard's activity log, as compact cards with their last " +
    "action. For questions like 'what CSVs was I looking at yesterday?'. Reads no file content. " +
    "Pass timeZone (IANA) so days are theirs.",
  inputSchema: RecentInput,
  outputSchema: RecentOutput,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  async run(ctx, args) {
    const a = args as {
      period?: Period;
      from?: string;
      to?: string;
      timeZone?: string;
      actions?: ("view" | "open" | "edit")[];
      kind?: Kind;
      mediaType?: string;
      limit?: number;
      cursor?: string;
      maxTokens?: number;
    };
    const zone = a.timeZone ?? "UTC";
    if (!isTimeZone(zone)) return refuse(ctx, "unknown timeZone", { outcome: "invalid" });
    const offset = offsetOf(a.cursor, WINDOW);
    if (offset === null) return refuse(ctx, "invalid cursor", { outcome: "invalid" });
    let from: Date | undefined;
    let to: Date | undefined;
    if (a.from !== undefined || a.to !== undefined) {
      if (a.period !== undefined) {
        return refuse(ctx, "pass either period or from/to", { outcome: "invalid" });
      }
      const f = a.from === undefined ? undefined : parseInstant(a.from);
      const t = a.to === undefined ? undefined : parseInstant(a.to);
      if (f === null || t === null) {
        return refuse(ctx, "from and to must be ISO dates or date-times", { outcome: "invalid" });
      }
      from = f;
      to = t;
    } else {
      ({ from, to } = periodRange(a.period ?? "last-7-days", zone, new Date()));
    }
    const mimes =
      a.mediaType !== undefined
        ? [a.mediaType.toLowerCase()]
        : a.kind !== undefined && a.kind !== "image" && a.kind !== "other"
          ? mimesOf(a.kind)
          : undefined;
    if (a.kind === "image" || a.kind === "other") {
      return refuse(ctx, "recent filters by document kinds; use mediaType for others", {
        outcome: "invalid",
      });
    }
    const limit = a.limit ?? 10;
    const { tenantId } = ctx.bearer;
    const out = await ctx.db.withTenant(
      tenantId,
      async (tx) => {
        const authz = await ctx.authz(tx, tenantId);
        const got = await recentObjects(tx, tenantId, authz, readRequest(ctx), {
          ...(a.actions ? { types: a.actions } : {}),
          ...(from ? { from } : {}),
          ...(to ? { to } : {}),
          ...(mimes ? { mimes } : {}),
          limit: Math.min(100, limit),
          offset,
        });
        const owners = await ownerNames(
          tx,
          tenantId,
          got.items.map((i) => i.view),
        );
        const cards = got.items.map((i) => ({
          ...toCard(i.view, owners),
          lastAction: i.lastType,
          lastAt: i.lastAt.toISOString(),
        }));
        const shape = (fit: Card[]) => {
          const next = offset + fit.length;
          return {
            files: fit,
            total: got.total,
            range: {
              from: from?.toISOString() ?? null,
              to: to?.toISOString() ?? null,
              timeZone: zone,
            },
            historyTruncated: got.historyTruncated,
            more: next < got.total && next < WINDOW ? { cursor: cursorOf(next) } : null,
            ...(fit.some((c) => c.summary !== undefined) ? { note: UNTRUSTED_NOTE } : {}),
          };
        };
        const fit = fitCards(cards, a.maxTokens ?? DEFAULT_TOKENS, shape);
        await auditSummaries(tx, ctx, "recent", fit);
        return shape(fit);
      },
      VIEW_TRANSACTION,
    );
    ctx.trail.note({ outcome: "ok", results: out.files.length });
    return answer(out);
  },
};
