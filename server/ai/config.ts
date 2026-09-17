/**
 * Model configuration, resolved from the environment at request time.
 *
 * `GEMINI_API_KEY` deliberately has no `VITE_` prefix. That prefix is this
 * repo's dividing line (see firebase.ts and .env.example): Vite bundles
 * every `VITE_*` value into the public browser JS, so a key carrying one
 * is world-readable. This module only ever reads `process.env`, which the
 * browser bundle has no access to — the key exists solely inside the
 * Vercel function.
 *
 * Everything is overridable per deployment so switching model or tightening
 * a timeout is an environment change, never a code change.
 */
import { AiConfigurationError } from "./errors";

export interface GeminiConfig {
  apiKey: string;
  model: string;
  /** Upper bound on a single reply. Concierge answers are short. */
  maxOutputTokens: number;
  /** Low by default: a concierge quoting hotel facts should not be inventive. */
  temperature: number;
  /**
   * Hard ceiling on one guest turn — every model call and tool round in it —
   * kept below the function's own limit (maxDuration in vercel.json).
   */
  timeoutMs: number;
  /**
   * How much the model thinks before answering. Unset leaves the model's
   * own default. Thinking is most of a turn's latency on Gemini 3 models,
   * so this is the first knob for slow turns; not every model accepts it.
   */
  thinkingLevel?: ThinkingLevelName;
  /**
   * Optional alternative endpoint for the Gemini API (a proxy, or a local
   * stand-in for browser verification: scripts/verify/fake-gemini.mjs).
   * Unset uses Google's.
   */
  baseUrl?: string;
}

export const THINKING_LEVELS = ["MINIMAL", "LOW", "MEDIUM", "HIGH"] as const;
export type ThinkingLevelName = (typeof THINKING_LEVELS)[number];

/** gemini-2.5-flash is closed to new API keys (404 "no longer available to new users"). */
export const DEFAULT_MODEL = "gemini-3.6-flash";
const DEFAULT_MAX_OUTPUT_TOKENS = 1024;
const DEFAULT_TEMPERATURE = 0.3;
/** A tool turn is two or three model calls; measured at 8–15s, occasionally over 20s. */
const DEFAULT_TIMEOUT_MS = 25_000;

export type Env = Record<string, string | undefined>;

/**
 * Model ↔ tool round trips allowed in one guest turn, whichever provider.
 * A real conversation needs two or three (look up, then book); more means
 * the model is looping.
 */
export const MAX_TOOL_ROUNDS = 5;

function read(env: Env, key: string): string | undefined {
  const value = env[key];
  return value && value.trim() ? value.trim() : undefined;
}

function readNumber(
  env: Env,
  key: string,
  fallback: number,
  { min, max }: { min: number; max: number }
): number {
  const raw = read(env, key);
  if (raw === undefined) return fallback;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new AiConfigurationError(
      `${key} must be a number between ${min} and ${max}, got '${raw}'.`
    );
  }
  return parsed;
}

/**
 * Whether a credential exists at all.
 *
 * Callers use this to degrade honestly — reporting "the assistant is not
 * configured" — instead of throwing at a guest for what is an operator's
 * missing environment variable.
 */
export function isGeminiConfigured(env: Env = process.env): boolean {
  return read(env, "GEMINI_API_KEY") !== undefined;
}

/** The model id in use, even when no key is set — for the health report. */
export function configuredModel(env: Env = process.env): string {
  return read(env, "GEMINI_MODEL") ?? DEFAULT_MODEL;
}

export function resolveGeminiConfig(env: Env = process.env): GeminiConfig {
  const apiKey = read(env, "GEMINI_API_KEY");
  if (!apiKey) {
    throw new AiConfigurationError(
      "GEMINI_API_KEY is not set. Add it to the Vercel project's environment " +
        "variables (and to .env for local development) — never with a VITE_ prefix."
    );
  }

  return {
    apiKey,
    model: configuredModel(env),
    maxOutputTokens: readNumber(env, "GEMINI_MAX_OUTPUT_TOKENS", DEFAULT_MAX_OUTPUT_TOKENS, {
      min: 64,
      max: 8192,
    }),
    temperature: readNumber(env, "GEMINI_TEMPERATURE", DEFAULT_TEMPERATURE, { min: 0, max: 2 }),
    timeoutMs: readNumber(env, "GEMINI_TIMEOUT_MS", DEFAULT_TIMEOUT_MS, {
      min: 1_000,
      max: 55_000,
    }),
    thinkingLevel: readThinkingLevel(env),
    ...(read(env, "GEMINI_BASE_URL") ? { baseUrl: read(env, "GEMINI_BASE_URL") } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Provider selection                                                  */
/* ------------------------------------------------------------------ */

export const AI_PROVIDERS = ["groq", "gemini"] as const;
export type AiProviderName = (typeof AI_PROVIDERS)[number];

/** The deployed MVP runs on Groq (DECISIONS D31); Gemini stays selectable. */
export const DEFAULT_AI_PROVIDER: AiProviderName = "groq";

export function resolveProviderName(env: Env = process.env): AiProviderName {
  const raw = read(env, "AI_PROVIDER")?.toLowerCase();
  if (raw === undefined) return DEFAULT_AI_PROVIDER;
  if (!(AI_PROVIDERS as readonly string[]).includes(raw)) {
    throw new AiConfigurationError(`AI_PROVIDER must be one of ${AI_PROVIDERS.join(", ")}, got '${raw}'.`);
  }
  return raw as AiProviderName;
}

/* ------------------------------------------------------------------ */
/* Groq                                                                */
/* ------------------------------------------------------------------ */

export const REASONING_EFFORTS = ["none", "default", "low", "medium", "high"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface GroqConfig {
  apiKey: string;
  model: string;
  maxOutputTokens: number;
  temperature: number;
  /** Hard ceiling on one guest turn, every model call and tool round in it. */
  timeoutMs: number;
  /** Sent only when set (or defaulted for gpt-oss); models without reasoning reject it. */
  reasoningEffort?: ReasoningEffort;
  /** Optional alternative endpoint (a proxy or a local stand-in). Unset uses Groq's. */
  baseUrl?: string;
}

/**
 * The concierge only works on a model that can call InnPilot's tools.
 * Groq's Compound systems (groq/compound, groq/compound-mini) cannot: the
 * API answers a request carrying `tools` with HTTP 400 "tool calling is not
 * supported with this model" (verified 2026-09-16). gpt-oss-120b is the
 * strongest tool-calling model on the free plan.
 */
export const DEFAULT_GROQ_MODEL = "openai/gpt-oss-120b";
/** Models that reject custom tools, so they can never run the concierge. */
const NO_TOOL_CALLING = /^groq\/compound/i;
/** The free plan counts every token against a small per-minute budget: keep replies short. */
const DEFAULT_GROQ_MAX_OUTPUT_TOKENS = 1024;

export function isGroqConfigured(env: Env = process.env): boolean {
  return read(env, "GROQ_API_KEY") !== undefined;
}

export function configuredGroqModel(env: Env = process.env): string {
  return read(env, "GROQ_MODEL") ?? DEFAULT_GROQ_MODEL;
}

export function supportsToolCalling(model: string): boolean {
  return !NO_TOOL_CALLING.test(model);
}

export function resolveGroqConfig(env: Env = process.env): GroqConfig {
  const apiKey = read(env, "GROQ_API_KEY");
  if (!apiKey) {
    throw new AiConfigurationError(
      "GROQ_API_KEY is not set. Add it to the Vercel project's environment " +
        "variables (and to .env for local development) — never with a VITE_ prefix."
    );
  }

  const model = configuredGroqModel(env);
  const effort = read(env, "GROQ_REASONING_EFFORT")?.toLowerCase();
  if (effort !== undefined && !(REASONING_EFFORTS as readonly string[]).includes(effort)) {
    throw new AiConfigurationError(
      `GROQ_REASONING_EFFORT must be one of ${REASONING_EFFORTS.join(", ")}, got '${effort}'.`
    );
  }
  // gpt-oss reasons by default; "low" keeps a turn inside the free plan's token budget.
  const reasoningEffort = (effort ?? (/^openai\/gpt-oss/i.test(model) ? "low" : undefined)) as
    | ReasoningEffort
    | undefined;

  return {
    apiKey,
    model,
    maxOutputTokens: readNumber(env, "GROQ_MAX_OUTPUT_TOKENS", DEFAULT_GROQ_MAX_OUTPUT_TOKENS, { min: 64, max: 8192 }),
    temperature: readNumber(env, "GROQ_TEMPERATURE", DEFAULT_TEMPERATURE, { min: 0, max: 2 }),
    timeoutMs: readNumber(env, "GROQ_TIMEOUT_MS", DEFAULT_TIMEOUT_MS, { min: 1_000, max: 55_000 }),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(read(env, "GROQ_BASE_URL") ? { baseUrl: read(env, "GROQ_BASE_URL") } : {}),
  };
}

function readThinkingLevel(env: Env): ThinkingLevelName | undefined {
  const raw = read(env, "GEMINI_THINKING_LEVEL")?.toUpperCase();
  if (raw === undefined) return undefined;
  if (!(THINKING_LEVELS as readonly string[]).includes(raw)) {
    throw new AiConfigurationError(
      `GEMINI_THINKING_LEVEL must be one of ${THINKING_LEVELS.join(", ")}, got '${raw}'.`
    );
  }
  return raw as ThinkingLevelName;
}
