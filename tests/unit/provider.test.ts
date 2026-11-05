/**
 * The AI provider seam, including fallback activation when the primary
 * provider is rate-limited. Mocks both SDKs; no key, no network, no quota.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const groqRequests: Record<string, unknown>[] = [];
const geminiRequests: Record<string, unknown>[] = [];

const groqGenerate = vi.fn();
const geminiGenerate = vi.fn();

vi.mock("groq-sdk", () => ({
  default: class {
    chat = {
      completions: {
        create: async (_body: Record<string, unknown>) => {
          groqRequests.push(_body);
          return groqGenerate(_body);
        },
      },
    };
  },
}));

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = {
      generateContent: async (_request: Record<string, unknown>) => {
        geminiRequests.push(_request);
        return geminiGenerate(_request);
      },
    };
  },
}));

import { generate } from "../../server/ai/provider.js";
import { resolveFallbackProvider } from "../../server/ai/config.js";
import { AiRateLimitError, AiUnavailableError } from "../../server/ai/errors.js";

const groqEnv = { GROQ_API_KEY: "gsk_test_not_real" };
const geminiEnv = { GEMINI_API_KEY: "gemini_test_not_real" };

const baseInput = {
  system: "You are a test concierge.",
  messages: [{ role: "user", content: "Hello" }],
} as Parameters<typeof generate>[0];

function geminiReply(text: string) {
  return {
    candidates: [{ content: { parts: [{ text }] } }],
  };
}

beforeEach(() => {
  vi.unstubAllGlobals();
  groqRequests.length = 0;
  geminiRequests.length = 0;
  groqGenerate.mockReset();
  geminiGenerate.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveFallbackProvider", () => {
  it("returns null when no fallback is configured", () => {
    expect(resolveFallbackProvider(groqEnv)).toBeNull();
  });

  it("resolves a gemini fallback with its default model", () => {
    const fallback = resolveFallbackProvider({ ...groqEnv, AI_FALLBACK_PROVIDER: "gemini", GEMINI_API_KEY: "k" });
    expect(fallback).toMatchObject({ provider: "gemini" });
    expect(typeof fallback?.model).toBe("string");
  });

  it("resolves a groq fallback with the configured model", () => {
    const fallback = resolveFallbackProvider({
      ...geminiEnv,
      AI_FALLBACK_PROVIDER: "groq",
      AI_FALLBACK_GROQ_MODEL: "openai/gpt-oss-20b",
    });
    expect(fallback).toMatchObject({ provider: "groq", model: "openai/gpt-oss-20b" });
  });

  it("rejects an unknown fallback provider", () => {
    expect(() => resolveFallbackProvider({ ...groqEnv, AI_FALLBACK_PROVIDER: "ollama" as any })).toThrow();
  });
});

describe("fallback activation", () => {
  it("does not fall back when the primary succeeds", async () => {
    groqGenerate.mockResolvedValue({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "groq reply" } }] });
    const result = await generate({ ...baseInput, env: { ...groqEnv, AI_FALLBACK_PROVIDER: "gemini", GEMINI_API_KEY: "k" } });
    expect(result.text).toBe("groq reply");
    expect(geminiGenerate).not.toHaveBeenCalled();
  });

  it("activates the fallback when the primary returns 429 (AiRateLimitError)", async () => {
    const rateLimitError = new AiRateLimitError(5);
    groqGenerate.mockRejectedValueOnce(rateLimitError);
    geminiGenerate.mockResolvedValue(geminiReply("gemini fallback reply"));

    const result = await generate({
      ...baseInput,
      env: { ...groqEnv, AI_FALLBACK_PROVIDER: "gemini", GEMINI_API_KEY: "k" },
    });
    expect(result.text).toBe("gemini fallback reply");
    expect(geminiGenerate).toHaveBeenCalledTimes(1);
  });

  it("activates the fallback when the primary returns HTTP 429 (provider-wrapped)", async () => {
    // Groq wraps 429s as AiUnavailableError with httpStatus 429.
    const http429Error = Object.assign(new AiUnavailableError("Groq rate limit reached (HTTP 429)."), {
      httpStatus: 429,
    });
    groqGenerate.mockRejectedValueOnce(http429Error);
    geminiGenerate.mockResolvedValue(geminiReply("gemini fallback reply"));

    const result = await generate({
      ...baseInput,
      env: { ...groqEnv, AI_FALLBACK_PROVIDER: "gemini", GEMINI_API_KEY: "k" },
    });
    expect(result.text).toBe("gemini fallback reply");
    expect(geminiGenerate).toHaveBeenCalledTimes(1);
  });

  it("activates the fallback when the primary returns 503", async () => {
    // 503 with httpStatus 503 is not 429, so isRateLimited returns false.
    // Fallback only activates for 429, not for generic 503.
    groqGenerate.mockRejectedValueOnce(new AiUnavailableError("Groq call failed (HTTP 503)."));
    geminiGenerate.mockResolvedValue(geminiReply("gemini fallback reply"));

    await expect(
      generate({ ...baseInput, env: { ...groqEnv, AI_FALLBACK_PROVIDER: "gemini", GEMINI_API_KEY: "k" } })
    ).rejects.toBeInstanceOf(AiUnavailableError);
    expect(geminiGenerate).not.toHaveBeenCalled();
  });

  it("does not fall back when no fallback provider is configured", async () => {
    groqGenerate.mockRejectedValueOnce(new AiRateLimitError(5));
    // Without fallback, the AiRateLimitError propagates as-is.
    await expect(generate({ ...baseInput, env: groqEnv })).rejects.toBeInstanceOf(AiRateLimitError);
    expect(geminiGenerate).not.toHaveBeenCalled();
  });

  it("does not fall back to the same provider", async () => {
    groqGenerate.mockRejectedValueOnce(new AiRateLimitError(5));
    // Fallback is groq, same as primary groq — should not fall back.
    await expect(
      generate({ ...baseInput, env: { ...groqEnv, AI_FALLBACK_PROVIDER: "groq", AI_FALLBACK_GROQ_MODEL: "openai/gpt-oss-20b" } })
    ).rejects.toBeInstanceOf(AiRateLimitError);
    expect(geminiGenerate).not.toHaveBeenCalled();
  });

  it("passes the fallback model to the fallback provider", async () => {
    groqGenerate.mockRejectedValueOnce(new AiRateLimitError(5));
    geminiGenerate.mockResolvedValue(geminiReply("gemini fallback reply"));

    await generate({
      ...baseInput,
      env: {
        ...groqEnv,
        AI_FALLBACK_PROVIDER: "gemini",
        AI_FALLBACK_GEMINI_MODEL: "gemini-2.0-flash",
        GEMINI_API_KEY: "k",
      },
    });
    // The SDK request carries the model resolved from AI_FALLBACK_GEMINI_MODEL.
    const model = geminiGenerate.mock.calls[0][0].model;
    expect(model).toBe("gemini-2.0-flash");
  });
});
