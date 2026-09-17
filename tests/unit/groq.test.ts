/**
 * The Groq provider, with the SDK scripted: request translation, the tool
 * loop, and every failure a free-plan deployment will meet (missing key,
 * 429, timeout, outage, malformed output, a model that can't call tools).
 * No key, no network, no quota spent.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Script = Record<string, unknown> | "hang" | Error | ((body: Record<string, unknown>) => Record<string, unknown>);
const sdk = vi.hoisted(() => ({
  script: [] as unknown[],
  requests: [] as Record<string, unknown>[],
  requestOptions: [] as Record<string, unknown>[],
  clientOptions: [] as Record<string, unknown>[],
}));

vi.mock("groq-sdk", () => ({
  default: class {
    constructor(options: Record<string, unknown>) {
      sdk.clientOptions.push(options);
    }
    chat = {
      completions: {
        create: async (body: Record<string, unknown>, options: { signal?: AbortSignal } & Record<string, unknown>) => {
          sdk.requests.push(JSON.parse(JSON.stringify(body)));
          sdk.requestOptions.push({ ...options, signal: Boolean(options?.signal) });
          const next = sdk.script.shift() as Script | undefined;
          if (!next) throw new Error("No scripted Groq response left.");
          if (next instanceof Error) throw next;
          if (next === "hang") {
            return new Promise((_, reject) => options.signal?.addEventListener("abort", () => reject(new Error("Request was aborted."))));
          }
          return typeof next === "function" ? next(body) : next;
        },
      },
    };
  },
}));

import { generate, checkHealth, parseRetryAfter, resetGroqClient, MAX_RATE_LIMIT_WAIT_MS } from "../../server/ai/groq";
import { checkHealth as providerHealth, providerFor } from "../../server/ai/provider";
import { DEFAULT_GROQ_MODEL, MAX_TOOL_ROUNDS } from "../../server/ai/config";
import { AiConfigurationError, AiTimeoutError, AiUnavailableError, guestMessageFor } from "../../server/ai/errors";
import type { AiToolCall, GenerateInput } from "../../server/ai/types";

const KEY = "gsk_test_key_not_real_0000000000000000000000000000000";
const env = { GROQ_API_KEY: KEY };

const text = (content: string, usage = { prompt_tokens: 100, completion_tokens: 10 }) => ({
  model: DEFAULT_GROQ_MODEL,
  choices: [{ finish_reason: "stop", message: { role: "assistant", content } }],
  usage,
});
const toolCalls = (...calls: { name: string; args: unknown; id?: string }[]) => ({
  choices: [
    {
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        tool_calls: calls.map((call, index) => ({
          id: call.id ?? `call_${index}`,
          type: "function",
          function: { name: call.name, arguments: typeof call.args === "string" ? call.args : JSON.stringify(call.args) },
        })),
      },
    },
  ],
  usage: { prompt_tokens: 120, completion_tokens: 20 },
});

/** What the SDK throws for an HTTP error: status, Fetch headers, parsed body. */
function apiError(status: number, headers: Record<string, string> = {}, body: Record<string, unknown> = {}) {
  return Object.assign(new Error(`${status} ${JSON.stringify(body)} (key ${KEY})`), { status, headers: new Headers(headers), error: body });
}

const tools = [
  { name: "search_hotels", description: "Search.", parameters: { type: "object", properties: { destination: { type: "string" } } } },
];

function input(overrides: Partial<GenerateInput> = {}): GenerateInput {
  return { system: "You are a test concierge.", messages: [{ role: "user", content: "Rooms in Kabale?" }], env, ...overrides };
}

beforeEach(() => {
  sdk.script = [];
  sdk.requests = [];
  sdk.requestOptions = [];
  sdk.clientOptions = [];
  resetGroqClient();
  vi.useRealTimers();
});

describe("requests", () => {
  it("sends the system prompt, the transcript and the tools in Groq's format, on the configured model", async () => {
    sdk.script = [text("Hello!")];
    const executeTool = vi.fn();
    const result = await generate(
      input({
        messages: [
          { role: "user", content: "Hi" },
          { role: "assistant", content: "Hello, how can I help?" },
          { role: "user", content: "Rooms in Kabale?" },
        ],
        tools,
        executeTool,
        env: { ...env, GROQ_MODEL: "openai/gpt-oss-20b" },
      })
    );

    expect(result).toEqual({ text: "Hello!", model: "openai/gpt-oss-20b", usage: { inputTokens: 100, outputTokens: 10 }, toolCalls: [] });
    expect(sdk.requests[0]).toEqual({
      model: "openai/gpt-oss-20b",
      messages: [
        { role: "system", content: "You are a test concierge." },
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello, how can I help?" },
        { role: "user", content: "Rooms in Kabale?" },
      ],
      temperature: 0.3,
      max_completion_tokens: 1024,
      reasoning_effort: "low",
      tools: [{ type: "function", function: tools[0] }],
      tool_choice: "auto",
    });
  });

  it("defaults to a tool-calling model and never lets the SDK retry on its own", async () => {
    sdk.script = [text("ok")];
    await generate(input());
    expect(sdk.requests[0].model).toBe("openai/gpt-oss-120b");
    expect(sdk.clientOptions[0]).toMatchObject({ apiKey: KEY, maxRetries: 0 });
    expect(sdk.requestOptions[0]).toMatchObject({ maxRetries: 0, signal: true });
  });

  it("only sends reasoning_effort to models that take it, unless configured", async () => {
    sdk.script = [text("ok"), text("ok")];
    await generate(input({ env: { ...env, GROQ_MODEL: "qwen/qwen3.8-27b" } }));
    expect(sdk.requests[0]).not.toHaveProperty("reasoning_effort");
    resetGroqClient();
    await generate(input({ env: { ...env, GROQ_MODEL: "qwen/qwen3.8-27b", GROQ_REASONING_EFFORT: "none" } }));
    expect(sdk.requests[1].reasoning_effort).toBe("none");
  });

  it("rejects bad configuration as an operator error", async () => {
    await expect(generate(input({ env: { ...env, GROQ_REASONING_EFFORT: "extreme" } }))).rejects.toBeInstanceOf(AiConfigurationError);
    await expect(generate(input({ env: { ...env, GROQ_TIMEOUT_MS: "99" } }))).rejects.toBeInstanceOf(AiConfigurationError);
    expect(sdk.requests).toHaveLength(0);
  });
});

describe("the tool loop", () => {
  it("runs each requested tool with parsed arguments and returns the results under the matching call id", async () => {
    sdk.script = [
      toolCalls({ name: "search_hotels", args: { destination: "Kabale" }, id: "fc_1" }),
      (body) => {
        const messages = body.messages as Record<string, unknown>[];
        return text(`Found: ${messages.at(-1)!.content}`);
      },
    ];
    const executeTool = vi.fn(async (call: AiToolCall) => ({ status: "ok", echoed: call.args }));
    const trace = { modelCalls: [], toolCalls: [] } as NonNullable<GenerateInput["trace"]>;

    const result = await generate(input({ tools, executeTool, trace }));

    expect(executeTool).toHaveBeenCalledWith({ name: "search_hotels", args: { destination: "Kabale" } });
    expect(sdk.requests[1].messages).toEqual([
      expect.objectContaining({ role: "system" }),
      expect.objectContaining({ role: "user" }),
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "fc_1", type: "function", function: { name: "search_hotels", arguments: '{"destination":"Kabale"}' } }],
      },
      { role: "tool", tool_call_id: "fc_1", content: '{"status":"ok","echoed":{"destination":"Kabale"}}' },
    ]);
    expect(result.text).toBe('Found: {"status":"ok","echoed":{"destination":"Kabale"}}');
    expect(result.toolCalls).toEqual(["search_hotels"]);
    expect(result.usage).toEqual({ inputTokens: 220, outputTokens: 30 });
    expect(trace.modelCalls).toHaveLength(2);
    expect(trace.toolCalls).toEqual([{ name: "search_hotels", ms: expect.any(Number) }]);
  });

  it("runs several calls in one round one at a time, in order", async () => {
    const order: string[] = [];
    sdk.script = [toolCalls({ name: "a", args: {} }, { name: "b", args: {} }), text("done")];
    await generate(
      input({
        tools,
        executeTool: async ({ name }) => {
          order.push(`start ${name}`);
          await new Promise((r) => setTimeout(r, 5));
          order.push(`end ${name}`);
          return {};
        },
      })
    );
    expect(order).toEqual(["start a", "end a", "start b", "end b"]);
  });

  it("stops a model that keeps calling tools", async () => {
    sdk.script = Array.from({ length: MAX_TOOL_ROUNDS + 1 }, () => toolCalls({ name: "search_hotels", args: {} }));
    await expect(generate(input({ tools, executeTool: async () => ({}) }))).rejects.toThrow(/still calling tools/);
    expect(sdk.requests).toHaveLength(MAX_TOOL_ROUNDS + 1);
  });

  it("refuses a Compound model, which cannot call tools, before spending a request", async () => {
    const attempt = generate(input({ tools, executeTool: async () => ({}), env: { ...env, GROQ_MODEL: "groq/compound-mini" } }));
    await expect(attempt).rejects.toBeInstanceOf(AiConfigurationError);
    await expect(attempt).rejects.toThrow(/cannot call tools/);
    expect(sdk.requests).toHaveLength(0);
  });
});

describe("malformed responses", () => {
  it.each([
    ["no choices", { choices: [] }, /no choice/],
    ["a choice with no message", { choices: [{ finish_reason: "stop" }] }, /no choice/],
    ["blank text", text("   "), /no usable text/],
    ["a tool call with non-JSON arguments", toolCalls({ name: "create_reservation", args: "{not json" }), /not JSON/],
    ["a tool call whose arguments are not an object", toolCalls({ name: "create_reservation", args: "[1,2]" }), /not an object/],
    ["a tool call with no id", { choices: [{ message: { content: null, tool_calls: [{ type: "function", function: { name: "x", arguments: "{}" } }] } }] }, /malformed tool call/],
  ])("%s fails safely and runs no tool", async (_label, response, message) => {
    sdk.script = [response];
    const executeTool = vi.fn(async () => ({}));
    const attempt = generate(input({ tools, executeTool }));
    await expect(attempt).rejects.toBeInstanceOf(AiUnavailableError);
    await expect(attempt).rejects.toThrow(message);
    expect(executeTool).not.toHaveBeenCalled();
    expect(sdk.requests).toHaveLength(1);
  });

  it("validates a whole batch before running any of it, so a bad second call books nothing", async () => {
    const response = toolCalls({ name: "prepare_booking", args: {} }, { name: "create_reservation", args: "{oops" });
    sdk.script = [response];
    const executeTool = vi.fn(async () => ({}));
    await expect(generate(input({ tools, executeTool }))).rejects.toBeInstanceOf(AiUnavailableError);
    expect(executeTool).not.toHaveBeenCalled();
  });
});

describe("failures and the retry budget", () => {
  it("fails a missing key as not configured, with no request and the standard guest message", async () => {
    const attempt = generate(input({ env: {} }));
    await expect(attempt).rejects.toBeInstanceOf(AiConfigurationError);
    const error = await attempt.catch((e) => e);
    expect(error.status).toBe(503);
    expect(guestMessageFor(error)).toMatch(/can't reach the hotel assistant right now/);
    expect(sdk.requests).toHaveLength(0);
  });

  it("does not retry a 429 that asks for a long wait (a spent minute or day)", async () => {
    sdk.script = [apiError(429, { "retry-after": "37", "x-ratelimit-remaining-requests": "0" }, { error: { code: "rate_limit_exceeded", message: "Limit reached for gsk_…" } })];
    const error = await generate(input()).catch((e) => e);
    expect(error).toBeInstanceOf(AiUnavailableError);
    expect(error.status).toBe(503);
    expect(sdk.requests).toHaveLength(1);
    // The operator log line says why, and carries neither the key nor Groq's message text.
    expect(error.message).toMatch(/HTTP 429, rate_limit_exceeded; retry-after 37000ms; remaining requests 0/);
    expect(error.message).not.toContain(KEY);
    expect(error.message).not.toContain("Limit reached");
    expect(guestMessageFor(error)).not.toMatch(/groq|429|rate|gsk_/i);
  });

  it("does not retry a 429 without retry-after", async () => {
    sdk.script = [apiError(429)];
    await expect(generate(input())).rejects.toBeInstanceOf(AiUnavailableError);
    expect(sdk.requests).toHaveLength(1);
  });

  it("waits out a short retry-after once, then succeeds", async () => {
    sdk.script = [apiError(429, { "retry-after": "0.01" }), text("after the wait")];
    expect((await generate(input())).text).toBe("after the wait");
    expect(sdk.requests).toHaveLength(2);
  });

  it("retries at most once, even when the second attempt is also rate limited", async () => {
    sdk.script = [apiError(429, { "retry-after": "0.01" }), apiError(429, { "retry-after": "0.01" }), text("never reached")];
    await expect(generate(input())).rejects.toBeInstanceOf(AiUnavailableError);
    expect(sdk.requests).toHaveLength(2);
  });

  it("does not wait for a retry-after that would outlast the turn", async () => {
    sdk.script = [apiError(429, { "retry-after": "5" }), text("never reached")];
    await expect(generate(input({ env: { ...env, GROQ_TIMEOUT_MS: "2000" } }))).rejects.toBeInstanceOf(AiUnavailableError);
    expect(sdk.requests).toHaveLength(1);
  });

  it("retries a 5xx or a dropped connection once", async () => {
    sdk.script = [apiError(503), text("recovered")];
    expect((await generate(input())).text).toBe("recovered");
    sdk.script = [new Error("Connection error."), text("recovered again")];
    expect((await generate(input())).text).toBe("recovered again");
    sdk.script = [apiError(500), apiError(502)];
    await expect(generate(input())).rejects.toBeInstanceOf(AiUnavailableError);
    expect(sdk.requests).toHaveLength(6);
  });

  it("retries a tool call Groq could not parse (tool_use_failed) once", async () => {
    sdk.script = [apiError(400, {}, { error: { code: "tool_use_failed" } }), text("second try")];
    expect((await generate(input())).text).toBe("second try");
    expect(sdk.requests).toHaveLength(2);
  });

  it("never retries a rejected key, an unserved model or a bad request", async () => {
    for (const [status, type] of [
      [401, AiConfigurationError],
      [403, AiConfigurationError],
      [404, AiConfigurationError],
      [400, AiUnavailableError],
      [413, AiUnavailableError],
    ] as const) {
      sdk.requests = [];
      sdk.script = [apiError(status), text("never reached")];
      const error = await generate(input()).catch((e) => e);
      expect(error).toBeInstanceOf(type);
      expect(error.message).not.toContain(KEY);
      expect(sdk.requests).toHaveLength(1);
      sdk.script = [];
    }
  });

  it("times out a hung call as AiTimeoutError", async () => {
    sdk.script = ["hang"];
    const error = await generate(input({ env: { ...env, GROQ_TIMEOUT_MS: "1000" } })).catch((e) => e);
    expect(error).toBeInstanceOf(AiTimeoutError);
    expect(error.status).toBe(504);
    expect(guestMessageFor(error)).toMatch(/took longer than expected/);
  });

  it("parses retry-after as seconds or an HTTP date", () => {
    expect(parseRetryAfter("2")).toBe(2000);
    expect(parseRetryAfter("0.5")).toBe(500);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(parseRetryAfter("soon")).toBeUndefined();
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(MAX_RATE_LIMIT_WAIT_MS).toBeLessThanOrEqual(10_000);
  });
});

describe("health and provider selection", () => {
  it("reports configuration without spending a request unless probed", async () => {
    expect(await checkHealth({ env: {} })).toMatchObject({ configured: false, model: null });
    expect(await checkHealth({ env })).toEqual({ configured: true, model: DEFAULT_GROQ_MODEL });
    expect(await checkHealth({ env: { ...env, GROQ_MODEL: "groq/compound-mini" } })).toMatchObject({ configured: false, error: expect.stringMatching(/cannot call tools/) });
    expect(sdk.requests).toHaveLength(0);

    sdk.script = [text("ok")];
    expect(await checkHealth({ probe: true, env })).toMatchObject({ configured: true, reachable: true, finishReason: "stop" });
    sdk.script = [apiError(429, { "retry-after": "1" })];
    expect(await checkHealth({ probe: true, env })).toMatchObject({ reachable: false });
    // A probe never retries.
    expect(sdk.requests).toHaveLength(2);
  });

  it("uses Groq unless AI_PROVIDER says otherwise", async () => {
    expect(providerFor({}).name).toBe("groq");
    expect(providerFor({ AI_PROVIDER: "GEMINI" }).name).toBe("gemini");
    expect(() => providerFor({ AI_PROVIDER: "ollama" })).toThrow(AiConfigurationError);
    expect(await providerHealth({ env })).toEqual({ provider: "groq", configured: true, model: DEFAULT_GROQ_MODEL });
    expect(await providerHealth({ env: { AI_PROVIDER: "gemini", GEMINI_API_KEY: "x" } })).toMatchObject({ provider: "gemini", configured: true });
  });
});
