import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { createServerModels, DEFAULT_ANTHROPIC_MODEL, modelsStartupWarning } from "./models.js";

/*
 * T-404 in the server: providers from `models`, keys only from the environment, and nothing
 * secret in errors or logs.
 */

const KEY = "sk-ant-api03-SECRET-abc123";

function config(models: unknown) {
  const cwd = mkdtempSync(join(tmpdir(), "oh-models-"));
  mkdirSync(join(cwd, ".openhoard"));
  writeFileSync(join(cwd, ".openhoard", "config.json"), JSON.stringify({ models }));
  return loadConfig({}, cwd);
}

describe("models configuration", () => {
  it("is off by default: no providers, no router", () => {
    const c = loadConfig({}, mkdtempSync(join(tmpdir(), "oh-models-")));
    expect(c.models.providers).toEqual([]);
    expect(c.models.dailyTokenBudget).toBe(5_000_000);
    expect(createServerModels(c.models, {})).toBe(null);
  });

  it("builds Ollama, Anthropic (Haiku by default, key from the environment) and a stub", () => {
    const c = config({
      providers: [
        { id: "claude", kind: "commercial", adapter: "anthropic" },
        {
          id: "ollama",
          kind: "local",
          adapter: "ollama",
          chatModel: "llama3.2",
          embedModel: "nomic-embed-text",
        },
        {
          id: "lmstudio",
          kind: "local",
          adapter: "openai",
          baseUrl: "http://localhost:1234/v1",
          chatModel: "qwen",
        },
        { id: "ci", kind: "local", adapter: "stub" },
      ],
      tasks: { summarize: ["claude", "ollama"] },
      dailyTokenBudget: 1000,
      tenantBudgets: { ten_01k5xr3c8v0q6m2d4n7p9s1t3w: 50 },
      summarize: { budgetMs: 120_000 },
    });
    const models = createServerModels(c.models, { OPENHOARD_MODEL_CLAUDE_API_KEY: KEY });
    expect(models?.router.candidates("summarize").map((m) => [m.id, m.kind, m.chatModel])).toEqual([
      ["claude", "commercial", DEFAULT_ANTHROPIC_MODEL],
      ["ollama", "local", "llama3.2"],
    ]);
    expect(models?.router.candidates("embed").map((m) => m.id)).toEqual(["ollama"]);
    expect(models?.router.pick("summarize", "local-only")?.id).toBe("ollama");
    expect(models?.budget.limitFor("ten_01k5xr3c8v0q6m2d4n7p9s1t3w")).toBe(50);
    expect(models?.budget.limitFor("ten_other")).toBe(1000);
    expect(models?.summarize).toEqual({ budgetMs: 120_000 });
    // The key is nowhere in the configuration.
    expect(JSON.stringify(c)).not.toContain(KEY);
  });

  it("refuses a key written into the configuration file", () => {
    expect(() =>
      config({
        providers: [{ id: "claude", kind: "commercial", adapter: "anthropic", apiKey: KEY }],
      }),
    ).toThrow(/unrecognized key|apiKey/i);
  });

  it("names the missing key's variable, never a value", () => {
    const c = config({
      providers: [{ id: "claude-eu", kind: "commercial", adapter: "anthropic" }],
    });
    let message = "";
    try {
      createServerModels(c.models, { OPENHOARD_MODEL_OTHER_API_KEY: KEY });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("OPENHOARD_MODEL_CLAUDE_EU_API_KEY");
    expect(message).not.toContain(KEY);
  });

  it.each([
    [
      { id: "o", kind: "local", adapter: "openai", baseUrl: "http://localhost:1/v1" },
      "chatModel is required",
    ],
    [
      {
        id: "o",
        kind: "commercial",
        adapter: "openai",
        chatModel: "m",
        baseUrl: "http://gpu.lan/v1",
      },
      "must be https",
    ],
    [{ id: "c", kind: "local", adapter: "anthropic" }, "not a local provider"],
  ])("refuses %j", (provider, problem) => {
    const c = config({ providers: [provider] });
    expect(() => createServerModels(c.models, { OPENHOARD_MODEL_C_API_KEY: KEY })).toThrow(problem);
  });

  it("refuses a task order naming an unknown provider", () => {
    const c = config({
      providers: [{ id: "ci", kind: "local", adapter: "stub" }],
      tasks: { summarize: ["gpt"] },
    });
    expect(() => createServerModels(c.models, {})).toThrow("no provider gpt");
  });

  it("warns at startup when providers are configured but no content can be read", () => {
    const c = config({ providers: [{ id: "ci", kind: "local", adapter: "stub" }] });
    const models = createServerModels(c.models, {});
    expect(modelsStartupWarning(models, false)).toContain("no summaries will run");
    expect(modelsStartupWarning(models, true)).toBe(null);
    expect(modelsStartupWarning(null, false)).toBe(null);
  });

  it("redacts keys and headers from logs", () => {
    const lines: string[] = [];
    const log = createLogger({ logLevel: "info" }, { write: (s: string) => void lines.push(s) });
    log.info(
      { provider: { id: "claude", apiKey: KEY }, request: { headers: { "x-api-key": KEY } } },
      "x",
    );
    expect(lines.join("\n")).not.toContain(KEY);
  });
});
