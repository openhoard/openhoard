import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { TOOLS } from "../mcp.js";
import { RESOURCE, openHarness, type Harness } from "./tools.fixtures.js";

/*
 * T-805: the tools' contract, pinned. What clients are told (tools/list: names, descriptions,
 * input and output JSON schemas, annotations) is snapshotted, so any change to a tool's shape
 * fails CI until someone looks at the diff and updates the snapshot on purpose
 * (`vitest -u`). The same zod shapes validate every answer in the other suites (strict: no
 * field a client wasn't told about).
 */

// Many calls through the real endpoint per test: the Windows runner, under coverage, needs room.
vi.setConfig({ testTimeout: process.platform === "win32" ? 300_000 : 60_000 });

let h: Harness;
beforeAll(async () => {
  h = await openHarness({ embed: false });
});
afterAll(() => h?.close());

describe("the MCP tools' contract", () => {
  async function connect(): Promise<Client> {
    const token = await h.token();
    const transport = new StreamableHTTPClientTransport(new URL(RESOURCE), {
      fetch: async (url, init) => h.app.request(String(url), init),
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: "contract", version: "1.0.0" });
    await client.connect(transport as unknown as Transport);
    return client;
  }

  it("pins what tools/list tells clients", async () => {
    const client = await connect();
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
      expect(tools).toMatchSnapshot();
    } finally {
      await client.close();
    }
  });

  // MCP 2025-11-25: schemas without `$schema` are 2020-12. Strict clients (Claude's) validate with
  // a 2020-12-only Ajv and refuse to call a tool whose schema declares another dialect.
  it("serves schemas a 2020-12-only client accepts, and answers that match them", async () => {
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    const client = await connect();
    try {
      const { tools } = await client.listTools();
      for (const tool of tools) {
        for (const [kind, schema] of [
          ["input", tool.inputSchema],
          ["output", tool.outputSchema],
        ] as const) {
          if (!schema) continue;
          const dialect = (schema as { $schema?: unknown }).$schema;
          if (dialect !== undefined) {
            expect(dialect, `${tool.name} ${kind}`).toBe(
              "https://json-schema.org/draft/2020-12/schema",
            );
          }
          expect(() => ajv.compile(schema), `${tool.name} ${kind}`).not.toThrow();
        }
      }
      const whoamiSchema = tools.find((t) => t.name === "whoami")?.outputSchema;
      const answer = await client.callTool({ name: "whoami", arguments: {} });
      expect(answer.isError).toBeFalsy();
      const valid = ajv.compile(whoamiSchema ?? {});
      expect(valid(answer.structuredContent), JSON.stringify(valid.errors)).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("gives every file tool an input and output schema, and a short description", () => {
    for (const tool of TOOLS) {
      expect(tool.outputSchema, tool.name).toBeDefined();
      if (tool.name !== "whoami") expect(tool.inputSchema, tool.name).toBeDefined();
      // Written for agents: short, and the ones that return file-derived text say it is data.
      expect(tool.description.length, tool.name).toBeLessThanOrEqual(420);
      z.toJSONSchema(z.object(tool.outputSchema ?? {}));
    }
    for (const name of ["find", "describe", "open"]) {
      expect(TOOLS.find((t) => t.name === name)?.description, name).toMatch(/untrusted/i);
    }
    expect(TOOLS.find((t) => t.name === "tag")?.description).toMatch(/never changes the file/);
  });
});
