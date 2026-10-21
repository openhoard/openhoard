import { mayProcess, type Exposure, type ProviderKind } from "@openhoard/core-policy";
import type { ModelClient } from "./types.js";

/*
 * Routing by exposure (T-404): which provider a task (a summary, an embedding) uses for one file.
 *
 * Each task has an ordered list of providers: the configured one, or by default every provider,
 * local ones first, then commercial, then consumer (in configuration order within a kind). The
 * router takes the first one the file's exposure lets have its content (core/policy
 * mayProcess()): `full` any, `commercial-only` commercial and local, `local-only` local only,
 * `metadata-only` none. So a local-only file can only ever reach a local provider, whatever the
 * order says, and a file no provider may have gets none (the step records `no-provider`).
 *
 * Local first by default: the content stays on the tenant's machines and costs nothing per
 * token. An admin who prefers a stronger commercial model for the files that allow it lists it
 * first for the task; local-only files still go to the local one.
 *
 * Picking is planning, not permission: the provider's client asks the guard again right before
 * each HTTP attempt (the file's exposure can tighten while a job runs).
 */

export const MODEL_TASKS = ["summarize", "embed"] as const;
export type ModelTask = (typeof MODEL_TASKS)[number];

const KIND_ORDER: readonly ProviderKind[] = ["local", "commercial", "consumer"];

export interface ModelRouter {
  /** Every provider configured, by id. */
  readonly clients: ReadonlyMap<string, ModelClient>;
  /** The task's providers in preference order. */
  candidates(task: ModelTask): readonly ModelClient[];
  /** The first of the task's providers this exposure allows, or null. */
  pick(task: ModelTask, exposure: Exposure): ModelClient | null;
  /**
   * The first of the task's providers `allowed` says yes to (asked in order, stopping at the
   * first yes): for callers that ask the pipeline (`context.mayProcess`) rather than pass an
   * exposure they read themselves.
   */
  pickAllowed(
    task: ModelTask,
    allowed: (client: ModelClient) => Promise<boolean>,
  ): Promise<ModelClient | null>;
}

/**
 * A router over `clients`. `order` gives a task's providers by id, in preference order; ids
 * not configured are an error (TypeError), as is a provider listed twice. A task without an
 * order gets every provider (with embeddings, for `embed`), local first.
 */
export function createModelRouter(
  clients: readonly ModelClient[],
  order: Partial<Record<ModelTask, readonly string[]>> = {},
): ModelRouter {
  const byId = new Map<string, ModelClient>();
  for (const c of clients) {
    if (byId.has(c.id)) throw new TypeError(`model provider ${c.id} is configured twice`);
    byId.set(c.id, c);
  }
  const lists = new Map<ModelTask, readonly ModelClient[]>();
  for (const task of MODEL_TASKS) {
    const usable = (c: ModelClient) => task !== "embed" || c.embed !== undefined;
    const ids = order[task];
    let list: ModelClient[];
    if (ids === undefined) {
      list = KIND_ORDER.flatMap((k) => clients.filter((c) => c.kind === k && usable(c)));
    } else {
      if (new Set(ids).size !== ids.length) {
        throw new TypeError(`models.tasks.${task} lists a provider twice`);
      }
      list = ids.map((id) => {
        const c = byId.get(id);
        if (!c) throw new TypeError(`models.tasks.${task}: no provider ${id}`);
        if (!usable(c)) throw new TypeError(`models.tasks.${task}: ${id} has no embeddings model`);
        return c;
      });
    }
    lists.set(task, Object.freeze(list));
  }
  return {
    clients: byId,
    candidates: (task) => lists.get(task) ?? [],
    pick(task, exposure) {
      return (lists.get(task) ?? []).find((c) => mayProcess(exposure, c.kind)) ?? null;
    },
    async pickAllowed(task, allowed) {
      for (const c of lists.get(task) ?? []) if (await allowed(c)) return c;
      return null;
    },
  };
}
