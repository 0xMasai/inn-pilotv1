/**
 * The AI provider seam: which model service answers a guest turn.
 *
 *   AI_PROVIDER=groq    (default) → server/ai/groq.ts
 *   AI_PROVIDER=gemini            → server/ai/gemini.ts
 *
 * Every provider takes the same GenerateInput and returns the same
 * AiGeneration, and translates its own failures into AiError. The hotel
 * tools, the prompt, the booking guards and the conversation record live
 * above this line and never learn which provider ran (DECISIONS D31).
 *
 * Resolved per request from the environment, so switching provider is a
 * Vercel environment change, not a deploy of different code. Adding one
 * (e.g. a local Ollama for development) is a new module plus an entry here.
 */
import { resolveFallbackProvider, resolveProviderName, type AiProviderName, type Env } from "./config.js";
import * as gemini from "./gemini.js";
import * as groq from "./groq.js";
import { isRateLimitError } from "./errors.js";
import type { AiGeneration, AiHealthReport, GenerateInput } from "./types.js";

export interface AiProvider {
  generate(input: GenerateInput): Promise<AiGeneration>;
  checkHealth(options?: { probe?: boolean; env?: Env }): Promise<AiHealthReport>;
}

const PROVIDERS: Record<AiProviderName, AiProvider> = { groq, gemini };

export function providerFor(env: Env = process.env): { name: AiProviderName; provider: AiProvider } {
  const name = resolveProviderName(env);
  return { name, provider: PROVIDERS[name] };
}

/** One guest turn through the configured provider. If the primary is rate-limited
 * and a fallback provider is configured, the fallback gets one attempt (it has its
 * own rate-limit bucket). Throws AiError subclasses only. */
export function generate(input: GenerateInput): Promise<AiGeneration> {
  const env = input.env ?? process.env;
  const { name, provider } = providerFor(env);
  return generateWithFallback(name, provider, input, env);
}

async function generateWithFallback(
  primaryName: AiProviderName,
  primaryProvider: AiProvider,
  input: GenerateInput,
  env: Env,
): Promise<AiGeneration> {
  try {
    return await primaryProvider.generate(input);
  } catch (error) {
    if (!isRateLimited(error)) throw error;
    const fallback = resolveFallbackProvider(env);
    if (!fallback) throw error;
    // Don't fall back to the same provider.
    if (fallback.provider === primaryName) throw error;
    const fallbackProvider = PROVIDERS[fallback.provider];
    const fallbackInput: GenerateInput = {
      ...input,
      env: {
        ...env,
        ...(fallback.provider === "groq"
          ? { GROQ_MODEL: fallback.model }
          : { GEMINI_MODEL: fallback.model }),
      },
    };
    console.warn("[provider] primary rate-limited, trying fallback", {
      primary: primaryName,
      fallback: fallback.provider,
      fallbackModel: fallback.model,
    });
    return await fallbackProvider.generate(fallbackInput);
  }
}

/** True when the primary provider is rate-limited and a fallback may help.
 * Covers both the gateway's own AiRateLimitError and provider 429s that
 * providers wrap as AiUnavailableError/GroqCallError with HTTP 429. */
function isRateLimited(error: unknown): boolean {
  if (isRateLimitError(error)) return true;
  // Groq wraps 429s as GroqCallError (extends AiUnavailableError) with httpStatus 429.
  const groqErr = error as { httpStatus?: number } | undefined;
  return groqErr?.httpStatus === 429;
}

/** The configured provider's health, labelled with which provider it is. */
export async function checkHealth(
  { probe = false, env = process.env }: { probe?: boolean; env?: Env } = {}
): Promise<AiHealthReport & { provider: AiProviderName }> {
  const { name, provider } = providerFor(env);
  return { provider: name, ...(await provider.checkHealth({ probe, env })) };
}
