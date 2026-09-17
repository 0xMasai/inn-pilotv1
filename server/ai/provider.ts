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
import { resolveProviderName, type AiProviderName, type Env } from "./config";
import * as gemini from "./gemini";
import * as groq from "./groq";
import type { AiGeneration, AiHealthReport, GenerateInput } from "./types";

export interface AiProvider {
  generate(input: GenerateInput): Promise<AiGeneration>;
  checkHealth(options?: { probe?: boolean; env?: Env }): Promise<AiHealthReport>;
}

const PROVIDERS: Record<AiProviderName, AiProvider> = { groq, gemini };

export function providerFor(env: Env = process.env): { name: AiProviderName; provider: AiProvider } {
  const name = resolveProviderName(env);
  return { name, provider: PROVIDERS[name] };
}

/** One guest turn through the configured provider. Throws AiError subclasses only. */
export function generate(input: GenerateInput): Promise<AiGeneration> {
  return providerFor(input.env ?? process.env).provider.generate(input);
}

/** The configured provider's health, labelled with which provider it is. */
export async function checkHealth(
  { probe = false, env = process.env }: { probe?: boolean; env?: Env } = {}
): Promise<AiHealthReport & { provider: AiProviderName }> {
  const { name, provider } = providerFor(env);
  return { provider: name, ...(await provider.checkHealth({ probe, env })) };
}
