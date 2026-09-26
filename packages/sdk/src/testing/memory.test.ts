import { describe, expect, it } from "vitest";
import { connectorContract } from "./contract.js";
import { memorySource } from "./memory.js";

/** A connector's optional method, which these tests know it has. */
function need<T>(method: T | undefined): T {
  if (method === undefined) throw new Error("the connector lacks this method");
  return method;
}

/*
 * The kit against the reference connector, with stable ids and with ids that follow the path
 * (a rename is a delete and a create), and with faults.
 */

const manifest = {
  manifest_version: 1,
  name: "memory",
  version: "1.0.0",
  type: "connector",
  runtime: "process",
  capabilities: ["source:crawl", "source:delta", "read:content", "import:acl", "source:redirect"],
};

connectorContract("memory", {
  checkpointEvery: 3,
  manifest,
  open: async () => {
    const source = memorySource({ checkpointEvery: 3 });
    // Some permissions for the kit to compare against what aclImport() reports.
    const setAcl = source.setAcl.bind(source);
    const write = source.write.bind(source);
    source.write = async (path, bytes) => {
      await write(path, bytes);
      if (path[0] === "Projects") {
        setAcl(path, [
          { principal: { kind: "group", id: "g-projects" }, role: "write", inherited: true },
          {
            principal: { kind: "link", id: "l1", scope: "organization" },
            role: "read",
            inherited: false,
          },
        ]);
      }
    };
    return source;
  },
});

connectorContract("memory, ids by path", {
  checkpointEvery: 4,
  open: async () => memorySource({ checkpointEvery: 4, stableIds: false }),
});

describe("memorySource", () => {
  it("fails a crawl after some events when asked", async () => {
    const source = memorySource();
    for (let i = 0; i < 5; i++) await source.write([`f${i}.txt`], new Uint8Array([i]));
    source.fault("throttled", { afterEvents: 2 });
    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const e of source.connector.crawl(null, new AbortController().signal)) {
          seen.push(e.type);
        }
      })(),
    ).rejects.toMatchObject({ code: "throttled", retryAfterMs: 1_500 });
    expect(seen).toEqual(["item", "item"]);
    expect(source.calls.crawl).toBe(1);
  });

  it("refuses misuse of its tree", async () => {
    const source = memorySource();
    await source.write(["a", "b.txt"], new Uint8Array(1));
    await expect(source.write(["a"], new Uint8Array(1))).rejects.toThrow(/folder/);
    await expect(source.mkdir(["a", "b.txt", "c"])).rejects.toThrow(/file/);
    await expect(source.move(["x"], ["y"])).rejects.toThrow(/no x/);
    await expect(source.move(["a", "b.txt"], ["a", "b.txt"])).rejects.toThrow(/exists/);
    await expect(source.remove(["x"])).rejects.toThrow(/no x/);
    expect(() => source.setAcl(["x"], [])).toThrow(/no x/);
    await expect(source.write([], new Uint8Array(1))).rejects.toThrow(/name/);
    expect(await source.expectedAcl(["x"])).toBeUndefined();
    await source.close();
    await expect(
      (async () => {
        for await (const e of need(source.connector.delta)(
          "delta:1",
          new AbortController().signal,
        )) {
          void e;
        }
      })(),
    ).rejects.toMatchObject({ code: "resync" });
  });
});
