/**
 * GET /api/ai/health and its Gemini probe, with the SDK scripted.
 *
 * Pins down the false negative this probe used to have: a thinking model
 * can spend a small output cap on thoughts and stop at MAX_TOKENS with no
 * text, and that is still a reachable model. No emulator, key or network.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  next: null as null | (() => unknown),
  calls: [] as Record<string, unknown>[],
}));

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = {
      generateContent: async (request: Record<string, unknown>) => {
        sdk.calls.push(request);
        if (!sdk.next) throw new Error("No scripted response.");
        return sdk.next();
      },
    };
  },
}));

import handler from "../../api/ai/health";
import { checkHealth, PROBE_MAX_OUTPUT_TOKENS, resetGeminiClient } from "../../server/ai/gemini";
import { resetRateLimits } from "../../server/ai/rateLimit";
import { resolveGeminiConfig } from "../../server/ai/config";
import { AiConfigurationError } from "../../server/ai/errors";

const env = { GEMINI_API_KEY: "test-key-not-real" };

function httpError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

async function get(url: string) {
  const res = {
    statusCode: 0,
    body: undefined as unknown as Record<string, unknown>,
    setHeader() {},
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload as Record<string, unknown>;
    },
    end() {},
  };
  const req = {
    method: "GET",
    url,
    headers: {},
    socket: { remoteAddress: "10.0.0.2" },
    async *[Symbol.asyncIterator]() {},
  };
  await handler(req, res);
  return res;
}

beforeEach(() => {
  sdk.next = null;
  sdk.calls = [];
  resetGeminiClient();
  resetRateLimits();
  process.env.GEMINI_API_KEY = env.GEMINI_API_KEY;
  process.env.AI_PROVIDER = "gemini";
});

describe("checkHealth", () => {
  it("reports configuration without calling the model when not probing", async () => {
    expect(await checkHealth({ env })).toEqual({ configured: true, model: "gemini-3.6-flash" });
    expect(sdk.calls).toHaveLength(0);
  });

  it("reports an unset key as not configured, without calling the model", async () => {
    expect(await checkHealth({ probe: true, env: {} })).toMatchObject({ configured: false, model: null });
    expect(sdk.calls).toHaveLength(0);
  });

  it("counts a thinking model that stops at MAX_TOKENS with no text as reachable", async () => {
    sdk.next = () => ({
      candidates: [{ content: { role: "model", parts: [] }, finishReason: "MAX_TOKENS" }],
      usageMetadata: { thoughtsTokenCount: 12 },
    });
    expect(await checkHealth({ probe: true, env })).toMatchObject({
      configured: true,
      reachable: true,
      finishReason: "MAX_TOKENS",
    });
    const config = sdk.calls[0].config as Record<string, unknown>;
    expect(config.maxOutputTokens).toBe(PROBE_MAX_OUTPUT_TOKENS);
    expect(config).not.toHaveProperty("tools");
  });

  it("counts a normal answer as reachable", async () => {
    sdk.next = () => ({ candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }] });
    expect(await checkHealth({ probe: true, env })).toMatchObject({ reachable: true, finishReason: "STOP" });
  });

  it("reports a rejected key as unreachable, without retrying", async () => {
    sdk.next = () => {
      throw httpError(400, '{"error":{"code":400,"message":"API key not valid.","status":"INVALID_ARGUMENT","reason":"API_KEY_INVALID"}}');
    };
    const report = await checkHealth({ probe: true, env });
    expect(report).toMatchObject({ configured: true, reachable: false });
    expect(report.error).toMatch(/rejected the API key/);
    expect(sdk.calls).toHaveLength(1);
  });

  it("reports an unknown model as unreachable", async () => {
    sdk.next = () => {
      throw httpError(404, "models/gemini-nope is not found");
    };
    expect(await checkHealth({ probe: true, env })).toMatchObject({ reachable: false });
  });

  it("reports a response with no candidate as unreachable", async () => {
    sdk.next = () => ({ candidates: [], promptFeedback: { blockReason: "OTHER" } });
    const report = await checkHealth({ probe: true, env });
    expect(report).toMatchObject({ reachable: false });
    expect(report.error).toMatch(/no candidate/);
  });
});

describe("GEMINI_THINKING_LEVEL", () => {
  const answered = () => ({ candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }] });

  it("sends no thinking config when unset, leaving the model's default", async () => {
    sdk.next = answered;
    await checkHealth({ probe: true, env });
    expect(sdk.calls[0].config).not.toHaveProperty("thinkingConfig");
  });

  it("sends the configured level", async () => {
    sdk.next = answered;
    await checkHealth({ probe: true, env: { ...env, GEMINI_THINKING_LEVEL: "low" } });
    expect((sdk.calls[0].config as Record<string, unknown>).thinkingConfig).toEqual({ thinkingLevel: "LOW" });
  });

  it("rejects an unknown level as a configuration error, without calling the model", () => {
    expect(() => resolveGeminiConfig({ ...env, GEMINI_THINKING_LEVEL: "turbo" })).toThrow(AiConfigurationError);
    expect(sdk.calls).toHaveLength(0);
  });
});

describe("GET /api/ai/health", () => {
  it("answers 200 without a probe", async () => {
    const res = await get("/api/ai/health");
    expect(res.statusCode).toBe(200);
    // Exactly these three fields: no model, no latency, no error text, no key.
    expect(res.body).toEqual({ status: "ok", provider: "gemini", configured: true });
    expect(sdk.calls).toHaveLength(0);
  });

  it("answers 200 when the probe reaches the model", async () => {
    sdk.next = () => ({ candidates: [{ content: { role: "model", parts: [] }, finishReason: "MAX_TOKENS" }] });
    const res = await get("/api/ai/health?probe=1");
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ status: "ok", provider: "gemini", configured: true });
  });

  it("answers 503 when the probe cannot reach the model", async () => {
    sdk.next = () => {
      throw httpError(401, "unauthorized");
    };
    const res = await get("/api/ai/health?probe=1");
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ status: "unreachable", provider: "gemini", configured: true });
  });

  it("reports a missing key as not_configured, and an invalid AI_PROVIDER as an error, with no detail", async () => {
    delete process.env.GEMINI_API_KEY;
    const missing = await get("/api/ai/health");
    expect(missing.statusCode).toBe(503);
    expect(missing.body).toEqual({ status: "not_configured", provider: "gemini", configured: false });
    process.env.AI_PROVIDER = "nope";
    const invalid = await get("/api/ai/health");
    expect(invalid.statusCode).toBe(503);
    expect(invalid.body).toEqual({ status: "error", provider: null, configured: false });
  });

  it("never echoes the key", async () => {
    sdk.next = () => ({ candidates: [{ finishReason: "STOP" }] });
    const res = await get("/api/ai/health?probe=1");
    expect(JSON.stringify(res.body)).not.toContain(env.GEMINI_API_KEY);
  });
});
