import { afterEach, describe, expect, it } from "vitest";
import {
  apiKeyVariable,
  checkProviderConfig,
  createModelClient,
  echoResponder,
  estimateTokens,
  type ClientOptions,
} from "./clients.js";
import { ModelError } from "./errors.js";
import { fakeApi, hang, json, type FakeApi } from "./fake-server.fixtures.js";
import { isPrivateAddress, parseRetryAfter, type Lookup } from "./http.js";
import type { ChatRequest, ProviderConfig } from "./types.js";

/*
 * T-404: the adapters against fake servers that speak each API. The request shapes are pinned
 * here (as of 2026-09): if a provider changes its API, these are the tests to update first.
 */

const KEY = "sk-test-SECRET-4f1c9e";
let api: FakeApi | undefined;
afterEach(async () => {
  await api?.close();
  api = undefined;
});

/** A log that records every line, to prove no key or content reaches it. */
function captureLog() {
  const lines: string[] = [];
  const at = (level: string) => (fields: object, message: string) =>
    lines.push(`${level} ${message} ${JSON.stringify(fields)}`);
  return { lines, log: { debug: at("debug"), info: at("info"), warn: at("warn") } };
}

const request = (over: Partial<ChatRequest> = {}): ChatRequest => ({
  system: "SYSTEM-TEXT",
  user: "DOCUMENT-TEXT",
  json: true,
  signal: AbortSignal.timeout(20_000),
  guard: () => Promise.resolve(true),
  ...over,
});

function client(
  over: Partial<ProviderConfig> & Pick<ProviderConfig, "adapter">,
  options: ClientOptions = {},
) {
  return createModelClient(
    {
      id: "p1",
      kind: "commercial",
      chatModel: "model-x",
      baseUrl: api?.url ?? "http://127.0.0.1:9",
      timeoutMs: 2_000,
      maxRetries: 2,
      ...over,
    },
    { backoffBaseMs: 5, ...options },
  );
}

const anthropicOk = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-haiku-4-5",
  content: [
    { type: "text", text: '{"summary":"ok"' },
    { type: "text", text: "}" },
  ],
  stop_reason: "end_turn",
  usage: { input_tokens: 120, output_tokens: 30 },
};
const openaiOk = {
  id: "chatcmpl-1",
  object: "chat.completion",
  choices: [{ index: 0, message: { role: "assistant", content: "{}" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 50, completion_tokens: 7, total_tokens: 57 },
};
const ollamaOk = {
  model: "llama3.2",
  created_at: "2026-09-26T10:00:00Z",
  message: { role: "assistant", content: "{}" },
  done: true,
  done_reason: "stop",
  prompt_eval_count: 40,
  eval_count: 5,
};

describe("Anthropic Messages API", () => {
  it("sends the pinned request and reads text and usage", async () => {
    api = await fakeApi(json(anthropicOk));
    const c = client({ adapter: "anthropic", maxOutputTokens: 500 }, { apiKey: KEY });
    const out = await c.chat(request({ maxOutputTokens: 300 }));
    expect(out).toEqual({
      text: '{"summary":"ok"}',
      usage: { inputTokens: 120, outputTokens: 30 },
      truncated: false,
    });
    const [r] = api.requests;
    expect(r?.method).toBe("POST");
    expect(r?.path).toBe("/v1/messages");
    expect(r?.headers["x-api-key"]).toBe(KEY);
    expect(r?.headers["anthropic-version"]).toBe("2023-06-01");
    expect(r?.headers["content-type"]).toBe("application/json");
    expect(r?.headers.authorization).toBeUndefined();
    expect(r?.body).toEqual({
      model: "model-x",
      max_tokens: 300,
      system: "SYSTEM-TEXT",
      messages: [{ role: "user", content: "DOCUMENT-TEXT" }],
      temperature: 0,
    });
  });

  it("reports a cut answer and estimates usage the API left out", async () => {
    api = await fakeApi(
      json({ content: [{ type: "text", text: "abcd" }], stop_reason: "max_tokens" }),
    );
    const out = await client({ adapter: "anthropic" }, { apiKey: KEY }).chat(request());
    expect(out.truncated).toBe(true);
    expect(out.usage.outputTokens).toBe(1);
  });

  it("refuses answers without text", async () => {
    api = await fakeApi(json({ content: [{ type: "tool_use", id: "x" }] }));
    await expect(
      client({ adapter: "anthropic" }, { apiKey: KEY }).chat(request()),
    ).rejects.toMatchObject({
      code: "bad-response",
    });
    api.script(json({ content: "nope" }));
    await expect(
      client({ adapter: "anthropic" }, { apiKey: KEY }).chat(request()),
    ).rejects.toMatchObject({
      code: "bad-response",
    });
  });
});

describe("OpenAI-compatible chat completions", () => {
  it("sends the pinned request with a bearer key and JSON mode", async () => {
    api = await fakeApi(json(openaiOk));
    const out = await client({ adapter: "openai" }, { apiKey: KEY }).chat(request());
    expect(out).toEqual({
      text: "{}",
      usage: { inputTokens: 50, outputTokens: 7 },
      truncated: false,
    });
    const [r] = api.requests;
    expect(r?.path).toBe("/chat/completions");
    expect(r?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(r?.body).toEqual({
      model: "model-x",
      messages: [
        { role: "system", content: "SYSTEM-TEXT" },
        { role: "user", content: "DOCUMENT-TEXT" },
      ],
      max_tokens: 800,
      temperature: 0,
      response_format: { type: "json_object" },
    });
  });

  it("speaks Azure's api-key header, max_completion_tokens, and no JSON mode when told", async () => {
    api = await fakeApi(
      json({ ...openaiOk, choices: [{ message: { content: "x" }, finish_reason: "length" }] }),
    );
    const c = client(
      {
        adapter: "openai",
        auth: "api-key",
        maxTokensField: "max_completion_tokens",
        jsonMode: false,
        baseUrl: `${api.url}/openai/v1/`,
      },
      { apiKey: KEY },
    );
    const out = await c.chat(request());
    expect(out.truncated).toBe(true);
    const [r] = api.requests;
    expect(r?.path).toBe("/openai/v1/chat/completions");
    expect(r?.headers["api-key"]).toBe(KEY);
    expect(r?.headers.authorization).toBeUndefined();
    expect(r?.body).toMatchObject({ max_completion_tokens: 800 });
    expect(r?.body).not.toHaveProperty("response_format");
    expect(r?.body).not.toHaveProperty("max_tokens");
  });

  it("works without a key (LM Studio, vLLM) and refuses an empty answer", async () => {
    api = await fakeApi(json({ choices: [{ message: { content: "" } }] }));
    await expect(
      client({ adapter: "openai", kind: "local" }).chat(request()),
    ).rejects.toMatchObject({
      code: "bad-response",
    });
    expect(api.requests[0]?.headers.authorization).toBeUndefined();
  });

  it("embeds, in the API's order by index", async () => {
    api = await fakeApi(
      json({
        object: "list",
        data: [
          { object: "embedding", index: 1, embedding: [0, 1] },
          { object: "embedding", index: 0, embedding: [1, 0] },
        ],
        usage: { prompt_tokens: 4, total_tokens: 4 },
      }),
    );
    const c = client({ adapter: "openai", embedModel: "embed-x" }, { apiKey: KEY });
    const out = await c.embed?.({
      texts: ["a", "b"],
      signal: AbortSignal.timeout(5_000),
      guard: () => Promise.resolve(true),
    });
    expect(out).toEqual({
      vectors: [
        [1, 0],
        [0, 1],
      ],
      usage: { inputTokens: 4, outputTokens: 0 },
    });
    expect(api.requests[0]).toMatchObject({
      path: "/embeddings",
      body: { model: "embed-x", input: ["a", "b"] },
    });
    for (const bad of [
      { data: [{ index: 0, embedding: [1] }] },
      {
        data: [
          { index: 5, embedding: [1] },
          { index: 0, embedding: [1] },
        ],
      },
      {
        data: [
          { index: 0, embedding: ["x"] },
          { index: 1, embedding: [] },
        ],
      },
      {
        data: [
          { index: 0, embedding: [1] },
          { index: 0, embedding: [1] },
        ],
      },
    ]) {
      api.script(json(bad));
      await expect(
        c.embed?.({
          texts: ["a", "b"],
          signal: AbortSignal.timeout(5_000),
          guard: () => Promise.resolve(true),
        }),
      ).rejects.toMatchObject({ code: "bad-response" });
    }
  });
});

describe("Ollama", () => {
  it("sends the pinned /api/chat request and reads counts", async () => {
    api = await fakeApi(json(ollamaOk));
    const c = client({
      adapter: "ollama",
      kind: "local",
      chatModel: "llama3.2",
      maxOutputTokens: 256,
    });
    const out = await c.chat(request());
    expect(out).toEqual({
      text: "{}",
      usage: { inputTokens: 40, outputTokens: 5 },
      truncated: false,
    });
    const [r] = api.requests;
    expect(r?.path).toBe("/api/chat");
    expect(r?.body).toEqual({
      model: "llama3.2",
      messages: [
        { role: "system", content: "SYSTEM-TEXT" },
        { role: "user", content: "DOCUMENT-TEXT" },
      ],
      stream: false,
      format: "json",
      options: { temperature: 0, num_predict: 256 },
    });
  });

  it("reports length, and estimates without counts", async () => {
    api = await fakeApi(json({ message: { content: "abcdefgh" }, done_reason: "length" }));
    const out = await client({ adapter: "ollama", kind: "local" }).chat(request({ json: false }));
    expect(out).toMatchObject({ truncated: true, usage: { outputTokens: 2 } });
    expect(api.requests[0]?.body).not.toHaveProperty("format");
    api.script(json({ message: {} }));
    await expect(
      client({ adapter: "ollama", kind: "local" }).chat(request()),
    ).rejects.toMatchObject({
      code: "bad-response",
    });
  });

  it("embeds through /api/embed", async () => {
    api = await fakeApi(
      json({ model: "nomic-embed-text", embeddings: [[0.1, 0.2]], prompt_eval_count: 3 }),
    );
    const c = client({ adapter: "ollama", kind: "local", embedModel: "nomic-embed-text" });
    const out = await c.embed?.({
      texts: ["hi"],
      signal: AbortSignal.timeout(5_000),
      guard: () => Promise.resolve(true),
    });
    expect(out).toEqual({ vectors: [[0.1, 0.2]], usage: { inputTokens: 3, outputTokens: 0 } });
    expect(api.requests[0]).toMatchObject({
      path: "/api/embed",
      body: { model: "nomic-embed-text", input: ["hi"] },
    });
    api.script(json({ embeddings: [[Number.NaN]] }));
    await expect(
      c.embed?.({
        texts: ["hi"],
        signal: AbortSignal.timeout(5_000),
        guard: () => Promise.resolve(true),
      }),
    ).rejects.toMatchObject({ code: "bad-response" });
    // Without an embeddings model there is no embed().
    expect(client({ adapter: "ollama", kind: "local" }).embed).toBeUndefined();
  });
});

describe("failures, retries and limits", () => {
  it("retries a 429 after its Retry-After, then succeeds", async () => {
    api = await fakeApi(json({ error: "slow down" }, 429, { "retry-after": "1" }), json(openaiOk));
    const started = Date.now();
    const out = await client({ adapter: "openai" }, { apiKey: KEY }).chat(request());
    expect(out.text).toBe("{}");
    expect(api.requests).toHaveLength(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it("gives up at once on a Retry-After longer than a call may wait", async () => {
    api = await fakeApi(json({}, 429, { "retry-after": "3600" }));
    const err = await client({ adapter: "openai", maxRetryAfterMs: 5_000 }, { apiKey: KEY })
      .chat(request())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelError);
    expect(err).toMatchObject({
      code: "rate-limited",
      status: 429,
      retryAfterMs: 3_600_000,
      retryable: true,
    });
    expect(api.requests).toHaveLength(1);
  });

  it("retries 5xx and Anthropic's 529 with backoff, and fails typed when they persist", async () => {
    api = await fakeApi(json({}, 503), json({}, 529), json(anthropicOk));
    expect(
      (await client({ adapter: "anthropic" }, { apiKey: KEY }).chat(request())).text,
    ).toContain("summary");
    api.script(json({ type: "error", error: { type: "api_error", message: "boom" } }, 500));
    const err = await client({ adapter: "anthropic" }, { apiKey: KEY })
      .chat(request())
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ name: "ModelError", code: "server", status: 500, retryable: true });
    expect(api.requests).toHaveLength(3 + 3);
  });

  it("times out a hanging server per attempt, and says so", async () => {
    api = await fakeApi(hang);
    const err = await client({ adapter: "ollama", kind: "local", timeoutMs: 1_000, maxRetries: 1 })
      .chat(request())
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "timeout", retryable: true });
    expect(api.requests).toHaveLength(2);
  });

  it("stops at once when the caller's signal aborts, with its reason", async () => {
    api = await fakeApi(hang);
    const controller = new AbortController();
    const call = client({ adapter: "ollama", kind: "local", timeoutMs: 10_000 }).chat(
      request({ signal: controller.signal }),
    );
    setTimeout(() => controller.abort(new Error("lease ended")), 50);
    await expect(call).rejects.toThrow("lease ended");
  });

  it("fails typed on malformed JSON, an oversized body, a refused key or request", async () => {
    api = await fakeApi(json("{not json"));
    await expect(client({ adapter: "openai" }).chat(request())).rejects.toMatchObject({
      code: "bad-response",
    });
    api.script(json({ choices: [{ message: { content: "x".repeat(10_000) } }] }));
    await expect(
      client({ adapter: "openai", maxResponseBytes: 4_096 }).chat(request()),
    ).rejects.toMatchObject({
      code: "too-large",
    });
    api.script((_r, res) => {
      // Chunked: no content-length, cut off while streaming.
      res.writeHead(200, { "content-type": "application/json" });
      for (let i = 0; i < 10; i++) res.write("x".repeat(1_000));
      res.end();
    });
    await expect(
      client({ adapter: "openai", maxResponseBytes: 4_096 }).chat(request()),
    ).rejects.toMatchObject({
      code: "too-large",
    });
    api.script(json({ error: { message: "invalid x-api-key" } }, 401));
    await expect(
      client({ adapter: "anthropic" }, { apiKey: KEY }).chat(request()),
    ).rejects.toMatchObject({
      code: "auth",
      retryable: false,
    });
    api.script(json({ error: "model not found" }, 404));
    await expect(
      client({ adapter: "ollama", kind: "local" }).chat(request()),
    ).rejects.toMatchObject({
      code: "refused",
      status: 404,
    });
  });

  it("refuses a redirect at once, without retrying (a key must not travel to another host)", async () => {
    api = await fakeApi((_r, res) => {
      res.writeHead(307, { location: "http://127.0.0.1:9/steal" }).end();
    });
    await expect(
      client({ adapter: "openai" }, { apiKey: KEY }).chat(request()),
    ).rejects.toMatchObject({
      code: "refused",
      status: 307,
    });
    expect(api.requests).toHaveLength(1);
  });

  it("fails as network when nothing listens", async () => {
    const c = client({
      adapter: "ollama",
      kind: "local",
      baseUrl: "http://127.0.0.1:9",
      maxRetries: 0,
    });
    await expect(c.chat(request())).rejects.toMatchObject({ code: "network" });
  });

  it("limits calls in flight per provider", async () => {
    let active = 0;
    let most = 0;
    api = await fakeApi(async (_r, res) => {
      most = Math.max(most, ++active);
      await new Promise((r) => setTimeout(r, 50));
      active--;
      json(ollamaOk)(_r, res);
    });
    const c = client({ adapter: "ollama", kind: "local", concurrency: 2 });
    await Promise.all(Array.from({ length: 6 }, () => c.chat(request())));
    expect(most).toBe(2);
    const controller = new AbortController();
    const hold = Array.from({ length: 2 }, () => c.chat(request()));
    const waiting = c.chat(request({ signal: controller.signal }));
    controller.abort(new Error("gone"));
    await expect(waiting).rejects.toThrow("gone");
    await Promise.all(hold);
  });
});

describe("plain http reaches private addresses only, as resolved", () => {
  const port = () => new URL(api?.url ?? "http://127.0.0.1:9").port;
  const resolvingTo =
    (address: string, family = 4): Lookup =>
    (_host, _options, callback) =>
      callback(null, [{ address, family }]);

  it("connects when the name resolves to a private address, and to that address", async () => {
    api = await fakeApi(json(ollamaOk));
    const c = client(
      { adapter: "ollama", kind: "local", baseUrl: `http://gpu-box.lan:${port()}` },
      { lookup: resolvingTo("127.0.0.1") },
    );
    expect((await c.chat(request())).text).toBe("{}");
    expect(api.requests).toHaveLength(1);
  });

  it("refuses a name that resolves to a public address, before sending anything", async () => {
    api = await fakeApi(json(ollamaOk));
    for (const address of ["203.0.113.5", "8.8.8.8", "::ffff:8.8.8.8", "2001:db8::1"]) {
      const c = client(
        { adapter: "ollama", kind: "local", baseUrl: `http://gpu-box.lan:${port()}` },
        { lookup: resolvingTo(address, address.includes(":") ? 6 : 4) },
      );
      await expect(c.chat(request()), address).rejects.toMatchObject({
        code: "blocked",
        retryable: false,
      });
    }
    // One public address among private ones is enough to refuse.
    const mixed: Lookup = (_h, _o, cb) =>
      cb(null, [
        { address: "127.0.0.1", family: 4 },
        { address: "93.184.216.34", family: 4 },
      ]);
    await expect(
      client(
        { adapter: "ollama", kind: "local", baseUrl: `http://x.lan:${port()}` },
        { lookup: mixed },
      ).chat(request()),
    ).rejects.toMatchObject({ code: "blocked" });
    expect(api.requests).toHaveLength(0);
  });

  it("refuses a public IP literal, and knows the private ranges", async () => {
    await expect(
      client({ adapter: "ollama", kind: "local", baseUrl: "http://93.184.216.34:11434" }).chat(
        request(),
      ),
    ).rejects.toMatchObject({ code: "blocked" });
    for (const a of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.1.1",
      "::1",
      "fd00::1",
      "fe80::1",
      "::ffff:10.0.0.1",
    ]) {
      expect(isPrivateAddress(a), a).toBe(true);
    }
    for (const a of ["172.32.0.1", "8.8.8.8", "2001:db8::1", "::ffff:8.8.8.8", "localhost", ""]) {
      expect(isPrivateAddress(a), a).toBe(false);
    }
  });
});

describe("counting", () => {
  it("counts every request that goes out, retries included", async () => {
    api = await fakeApi(json({}, 503), json(openaiOk));
    let sent = 0;
    await client({ adapter: "openai" }).chat(request({ onAttempt: () => sent++ }));
    expect(sent).toBe(2);
  });

  it("estimates a token per CJK character, four characters a token otherwise", () => {
    expect(estimateTokens("abcdefgh")).toBe(2);
    expect(estimateTokens("日本語のテキスト")).toBe(8);
    expect(estimateTokens("한국어 abcd")).toBe(3 + 2);
  });
});

describe("the guard", () => {
  it("is asked before every attempt: a false answer sends nothing", async () => {
    api = await fakeApi(json(openaiOk));
    await expect(
      client({ adapter: "openai" }).chat(request({ guard: () => Promise.resolve(false) })),
    ).rejects.toMatchObject({ code: "withheld" });
    expect(api.requests).toHaveLength(0);
  });

  it("is asked again before a retry: exposure tightened mid-call stops the retry", async () => {
    api = await fakeApi(json({}, 503), json(openaiOk));
    let asked = 0;
    const err = await client({ adapter: "openai" })
      .chat(request({ guard: () => Promise.resolve(++asked === 1) }))
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "withheld" });
    expect(asked).toBe(2);
    expect(api.requests).toHaveLength(1);
  });

  it("guards the stub too", async () => {
    const stub = createModelClient({ id: "s", kind: "local", adapter: "stub", chatModel: "stub" });
    await expect(stub.chat(request({ guard: () => Promise.resolve(false) }))).rejects.toMatchObject(
      {
        code: "withheld",
      },
    );
    expect(stub.embed).toBeUndefined();
    const embedding = createModelClient({
      id: "e",
      kind: "local",
      adapter: "stub",
      chatModel: "stub",
      embedModel: "stub",
    });
    await expect(
      embedding.embed?.({
        texts: ["x"],
        signal: AbortSignal.timeout(1_000),
        guard: () => Promise.resolve(false),
      }),
    ).rejects.toMatchObject({ code: "withheld" });
  });
});

describe("secrets and content stay out of logs and errors", () => {
  it("never logs or throws the key, the request or the response", async () => {
    const { lines, log } = captureLog();
    api = await fakeApi(
      json({ error: `bad key ${KEY} for DOCUMENT-TEXT` }, 503, { "retry-after": "0" }),
      json({ error: `bad key ${KEY}` }, 401),
    );
    const err = await client({ adapter: "openai" }, { apiKey: KEY, log })
      .chat(request())
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "auth" });
    const everything = [
      ...lines,
      (err as Error).message,
      (err as Error).stack ?? "",
      JSON.stringify(err),
    ].join("\n");
    for (const secret of [KEY, "DOCUMENT-TEXT", "SYSTEM-TEXT", "bad key"]) {
      expect(everything).not.toContain(secret);
    }
    expect(lines.some((l) => l.includes('"provider":"p1"'))).toBe(true);
  });

  it("names the key's variable, not its value, when a key is missing", () => {
    expect(apiKeyVariable("claude-main")).toBe("OPENHOARD_MODEL_CLAUDE_MAIN_API_KEY");
    expect(() =>
      createModelClient({
        id: "claude-main",
        kind: "commercial",
        adapter: "anthropic",
        chatModel: "m",
        baseUrl: "https://api.anthropic.com",
      }),
    ).toThrow("OPENHOARD_MODEL_CLAUDE_MAIN_API_KEY");
  });
});

describe("settings", () => {
  it.each([
    [{ id: "Bad Id" }, "id must be a lower-case slug"],
    [{ kind: "cloud" }, "kind must be"],
    [{ adapter: "gemini" }, "unknown adapter"],
    [{ chatModel: "" }, "chatModel is required"],
    [{ baseUrl: undefined }, "baseUrl is required"],
    [{ baseUrl: "not a url" }, "not a URL"],
    [{ baseUrl: "ftp://x.example" }, "must be http(s)"],
    [{ baseUrl: "http://models.example/v1" }, "must be https unless"],
    [{ baseUrl: "https://u:p@x.example/v1" }, "credentials"],
    [{ baseUrl: "https://x.example/v1?k=1" }, "credentials"],
    [{ timeoutMs: 10 }, "timeoutMs must be"],
    [{ concurrency: 0 }, "concurrency must be"],
  ])("refuses %j", (over, problem) => {
    const config = {
      id: "p",
      kind: "commercial",
      adapter: "openai",
      chatModel: "m",
      baseUrl: "https://x.example/v1",
      ...over,
    } as ProviderConfig;
    expect(checkProviderConfig(config).join("; ")).toContain(problem);
  });

  it("allows http for loopback and local providers, and nothing else odd", () => {
    const base = { id: "p", adapter: "openai", chatModel: "m" } as const;
    expect(
      checkProviderConfig({ ...base, kind: "commercial", baseUrl: "http://localhost:1234/v1" }),
    ).toEqual([]);
    expect(
      checkProviderConfig({ ...base, kind: "local", baseUrl: "http://gpu-box:8000/v1" }),
    ).toEqual([]);
    expect(
      checkProviderConfig({ id: "s", kind: "local", adapter: "stub", chatModel: "stub" }),
    ).toEqual([]);
  });

  it("knows Anthropic has no embeddings and is never local", () => {
    const a = {
      id: "a",
      adapter: "anthropic",
      chatModel: "m",
      baseUrl: "https://api.anthropic.com",
    } as const;
    expect(
      checkProviderConfig({ ...a, kind: "commercial", embedModel: "e" }, KEY).join(),
    ).toContain("no embeddings");
    expect(checkProviderConfig({ ...a, kind: "local" }, KEY).join()).toContain(
      "not a local provider",
    );
  });
});

describe("the stub", () => {
  it("echoes the document's first 60 words as a card, deterministically", async () => {
    const stub = createModelClient({
      id: "s",
      kind: "local",
      adapter: "stub",
      chatModel: "stub",
      embedModel: "stub",
    });
    const user = [
      "BEGIN-DOCUMENT-ab",
      "File name: x",
      "",
      "Hello world.",
      "END-DOCUMENT-ab",
      "Describe.",
    ].join("\n");
    const out = await stub.chat(request({ user }));
    expect(JSON.parse(out.text)).toEqual({ summary: "Hello world.", tags: [], displayTitle: null });
    expect(out.usage.inputTokens).toBe(estimateTokens("SYSTEM-TEXT") + estimateTokens(user));
    expect(JSON.parse(echoResponder({ system: "", user: "no markers" }))).toMatchObject({
      summary: "no markers",
    });
    const v = await stub.embed?.({
      texts: ["abc", "abc"],
      signal: AbortSignal.timeout(1_000),
      guard: () => Promise.resolve(true),
    });
    expect(v?.vectors[0]).toEqual(v?.vectors[1]);
    expect(v?.vectors[0]).toHaveLength(8);
  });

  it("answers what a test tells it to", async () => {
    const stub = createModelClient(
      { id: "s", kind: "commercial", adapter: "stub", chatModel: "stub" },
      { stub: () => "custom" },
    );
    expect((await stub.chat(request())).text).toBe("custom");
  });
});

describe("Retry-After", () => {
  it("reads seconds and HTTP dates", () => {
    expect(parseRetryAfter(null)).toBe(null);
    expect(parseRetryAfter("7")).toBe(7_000);
    expect(
      parseRetryAfter("Fri, 26 Sep 2026 10:00:30 GMT", Date.parse("2026-09-26T10:00:00Z")),
    ).toBe(30_000);
    expect(
      parseRetryAfter("Fri, 26 Sep 2026 09:00:00 GMT", Date.parse("2026-09-26T10:00:00Z")),
    ).toBe(0);
    expect(parseRetryAfter("soon")).toBe(null);
    expect(parseRetryAfter("x".repeat(100))).toBe(null);
  });
});
