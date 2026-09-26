export interface Ranked {
  id: string;
  score: number;
}

/**
 * Reciprocal Rank Fusion: merges ranked lists (keyword, vector, activity…) without needing
 * comparable scores. `k` dampens the weight of top ranks; 60 is the common default.
 */
export function reciprocalRankFusion(lists: readonly (readonly string[])[], k = 60): Ranked[] {
  return fuseChannels(
    lists.map((ids) => ({ channel: "list", ids })),
    k,
  ).map(({ id, score }) => ({ id, score }));
}

/** One ranked list for {@link fuseChannels}: best first. */
export interface ChannelList<C extends string = string> {
  channel: C;
  ids: readonly string[];
  /** How much a place in this list counts, from 0 to 1. Default 1. */
  weight?: number;
}

/** A fused result: its score, and its rank (1 is first) in each list it was in. */
export interface FusedRank<C extends string = string> extends Ranked {
  ranks: Partial<Record<C, number>>;
}

/**
 * Reciprocal Rank Fusion with named, weighted lists, keeping each result's rank per list so a
 * ranking can be explained ("second by keyword, fifth by meaning"). A result's score is the sum,
 * over the lists it is in, of weight / (k + rank). Ties go by id, so the order is deterministic.
 * An id repeated within one list counts at its first place only.
 */
export function fuseChannels<C extends string>(
  lists: readonly ChannelList<C>[],
  k = 60,
): FusedRank<C>[] {
  const out = new Map<string, FusedRank<C>>();
  for (const { channel, ids, weight = 1 } of lists) {
    const w = Number.isFinite(weight) ? Math.min(1, Math.max(0, weight)) : 0;
    const seen = new Set<string>();
    ids.forEach((id, i) => {
      if (seen.has(id)) return;
      seen.add(id);
      const entry: FusedRank<C> = out.get(id) ?? { id, score: 0, ranks: {} };
      entry.score += w / (k + i + 1);
      entry.ranks[channel] ??= i + 1;
      out.set(id, entry);
    });
  }
  return [...out.values()].sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
}
