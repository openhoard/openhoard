import { appendEvent, type AuditEvent } from "@openhoard/core-audit";
import { contentHasher, reciprocalRankFusion } from "@openhoard/core-catalog";
import { buildCard } from "@openhoard/core-summarize";
import { InMemorySearch } from "../leak/reference-search.js";
import { Random } from "../random.js";
import { AccessModel } from "../tenant/access.js";
import { contentStream } from "../tenant/content.js";
import { generateTenant } from "../tenant/generate.js";
import type { FakeTenant } from "../tenant/types.js";
import { measureLatency, measureThroughput, type BenchCase } from "./bench.js";

/**
 * The standard benchmark cases. Each is deterministic in its inputs (seeded tenant, queries and
 * users), so round-to-round and night-to-night differences come from the code and the machine,
 * not from the data.
 */
export function standardCases(options: { items?: number } = {}): BenchCase[] {
  const items = options.items ?? 10_000;
  let tenant: FakeTenant | undefined;
  const getTenant = () => (tenant ??= generateTenant({ items }));

  return [
    {
      name: "tenant.generate",
      run: async () => {
        const stats = await measureLatency(() => generateTenant({ items }), {
          iterations: 3,
          warmup: 1,
        });
        return [
          {
            name: `tenant.generate.${items}`,
            value: stats.p50,
            unit: "ms",
            better: "lower",
            noiseFloor: 20,
          },
        ];
      },
    },
    {
      name: "search",
      run: async () => {
        const t = getTenant();
        const search = new InMemorySearch(t);
        const access = new AccessModel(t);
        const rng = new Random("bench:search");
        const users = rng
          .sample(
            t.users.filter((u) => u.active),
            20,
          )
          .map((u) => ({ userId: u.id, principals: access.principalsOf(u.id) }));
        const canaries = t.items.filter((i) => i.canary).map((i) => i.canary as string);
        const queries = [
          "invoice",
          "client:acme",
          "sensitivity:confidential",
          "contract q3",
          "report",
          ...canaries.slice(0, 20),
        ];
        const stats = await measureLatency(
          (i) =>
            search.search({
              ...(users[i % users.length] as (typeof users)[number]),
              query: queries[i % queries.length] as string,
            }),
          { iterations: 2000, warmup: 200 },
        );
        return [
          { name: "search.p50", value: stats.p50, unit: "ms", better: "lower", noiseFloor: 0.05 },
          { name: "search.p95", value: stats.p95, unit: "ms", better: "lower", noiseFloor: 0.1 },
          { name: "search.p99", value: stats.p99, unit: "ms", better: "lower", noiseFloor: 0.2 },
        ];
      },
    },
    {
      name: "ingest",
      run: async () => {
        // Ingest hot path without I/O: stream content, hash it (BLAKE3), build the card.
        const t = getTenant();
        const files = t.items.filter((i) => i.kind === "file" && i.size < 2_000_000).slice(0, 200);
        let bytes = 0;
        let done = 0;
        const start = performance.now();
        for (const f of files) {
          const hasher = contentHasher();
          const reader = contentStream(t, f).getReader();
          for (let r = await reader.read(); !r.done; r = await reader.read()) {
            hasher.update(r.value);
            bytes += r.value.byteLength;
          }
          buildCard({
            id: f.id,
            title: f.name,
            tags: f.labels,
            summary: f.labels.join(" "),
            owner: f.createdBy,
            lastTouched: f.modifiedAt,
            link: "",
          });
          hasher.digest();
          done++;
        }
        const seconds = (performance.now() - start) / 1000;
        return [
          {
            name: "ingest.throughput",
            value: bytes / 1024 / 1024 / seconds,
            unit: "MiB/s",
            better: "higher",
            noiseFloor: 1,
          },
          {
            name: "ingest.files",
            value: done / seconds,
            unit: "files/s",
            better: "higher",
            noiseFloor: 5,
          },
        ];
      },
    },
    {
      name: "audit.append",
      run: async () => {
        let prev: AuditEvent | undefined;
        let n = 0;
        const perSecond = await measureThroughput(
          () => {
            for (let i = 0; i < 500; i++) {
              prev = appendEvent(prev, {
                tenantId: "t1",
                at: "2026-09-01T00:00:00.000Z",
                actor: "u-0001",
                action: "read",
                decision: "allow",
                object: `i-${n++}`,
              });
            }
            return 500;
          },
          { ms: 500 },
        );
        return [
          {
            name: "audit.append",
            value: perSecond,
            unit: "events/s",
            better: "higher",
            noiseFloor: 1000,
          },
        ];
      },
    },
    {
      name: "rank.rrf",
      run: async () => {
        const rng = new Random("bench:rrf");
        const lists = Array.from({ length: 3 }, () =>
          rng.sample(
            Array.from({ length: 5000 }, (_, i) => `i-${i}`),
            1000,
          ),
        );
        const stats = await measureLatency(() => reciprocalRankFusion(lists), {
          iterations: 200,
          warmup: 20,
        });
        return [
          {
            name: "rank.rrf.3x1000",
            value: stats.p50,
            unit: "ms",
            better: "lower",
            noiseFloor: 0.05,
          },
        ];
      },
    },
  ];
}
