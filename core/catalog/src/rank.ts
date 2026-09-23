export interface Ranked {
  id: string;
  score: number;
}

/**
 * Reciprocal Rank Fusion: merges ranked lists (keyword, vector, activity…) without needing
 * comparable scores. `k` dampens the weight of top ranks; 60 is the common default.
 */
export function reciprocalRankFusion(lists: readonly (readonly string[])[], k = 60): Ranked[] {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1)));
  }
  return [...scores]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
}
