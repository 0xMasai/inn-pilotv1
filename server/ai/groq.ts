/**
 * The Groq provider (AI_PROVIDER=groq) — the only file that imports the Groq
 * SDK. It speaks the same vendor-neutral contract as `gemini.ts`, so the
 * gateway, the prompt and the hotel tools are unchanged by the switch.
 *
 * Built for Groq's free plan, where every request and token is scarce
 * (DECISIONS D31):
 *
 *   1. The SDK's own retries are OFF (it defaults to two, with backoff).
 *      This module makes at most ONE extra attempt per model call, and only
 *      for a failure a retry can fix: a 5xx, a dropped connection, a
 *      malformed tool call the model can redo, or a 429 whose retry-after
 *      is at most MAX_RATE_LIMIT_WAIT_MS. A 429 asking for longer — a spent minute or
 *      day — fails straight away instead of burning more quota.
 *   2. It never hangs: the whole guest turn is bounded by GROQ_TIMEOUT_MS.
 *   3. It never returns an empty success or trusts a malformed response:
 *      no choice, blank text, or tool arguments that are not a JSON object
 *      all fail as AiUnavailableError, which the gateway turns into the
 *      standard safe guest message.
 *   4. It refuses a model that cannot call tools (groq/compound*) as an
 *      operator configuration error, rather than letting a concierge run
 *      with no access to real inventory.
 *
 * Operator-facing error text carries the HTTP status and Groq's error type,
 * never the key or the provider's response body (which can echo prompt
 * content, i.e. guest details).
 */
import Groq from "groq-sdk";
import {
  MAX_TOOL_ROUNDS,
  configuredGroqModel,
  isGroqConfigured,
  resolveGroqConfig,
  supportsToolCalling,
  type Env,
  type GroqConfig,
} from "./config.js";
import { AiConfigurationError, AiError, AiTimeoutError, AiUnavailableError, errorMessage } from "./errors.js";
import type { AiGeneration, AiHealthReport, AiMessage, AiToolResult, GenerateInput } from "./types.js";

/**
 * A 429 asking us to wait longer than this is a spent minute or day, not a
 * blip. The free plan's 8K tokens-per-minute bucket refills continuously, so
 * a turn arriving just after another is often told to wait a few seconds;
 * one wait of up to 10s (never past the turn deadline) beats failing it.
 */
export const MAX_RATE_LIMIT_WAIT_MS = 10_000;
/** Pause before the single retry of a transient failure. */
const RETRY_PAUSE_MS = 400;

/* ------------------------------------------------------------------ */
/* Wire shapes: the OpenAI-compatible subset of the API this module uses */
/* ------------------------------------------------------------------ */

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface Completion {
  model?: string;
  choices?: {
    finish_reason?: string | null;
    message?: { content?: string | null; tool_calls?: ToolCall[] | null } | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } };
}

/* ------------------------------------------------------------------ */
/* Client                                                              */
/* ------------------------------------------------------------------ */

let cached: { key: string; client: Groq } | null = null;

/** One client per credential and endpoint, reused across warm invocations. */
function clientFor(config: GroqConfig): Groq {
  const key = `${config.apiKey}:${config.baseUrl ?? ""}`;
  if (cached?.key !== key) {
    cached = {
      key,
      client: new Groq({
        apiKey: config.apiKey,
        // Retries are this module's decision, bounded to one (see header).
        maxRetries: 0,
        timeout: config.timeoutMs,
        ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
      }),
    };
  }
  return cached.client;
}

/** Test seam: drops the memoized client. */
export function resetGroqClient(): void {
  cached = null;
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

/** Why a Groq call failed, in terms the retry policy needs. */
class GroqCallError extends AiUnavailableError {
  readonly httpStatus?: number;
  /** From the retry-after header, when Groq sent one. */
  readonly retryAfterMs?: number;
  readonly retryable: boolean;

  constructor(message: string, { httpStatus, retryAfterMs, retryable }: { httpStatus?: number; retryAfterMs?: number; retryable: boolean }) {
    super(message);
    this.name = "GroqCallError";
    this.httpStatus = httpStatus;
    this.retryAfterMs = retryAfterMs;
    this.retryable = retryable;
  }
}

function headerOf(error: unknown, name: string): string | undefined {
  const headers = (error as { headers?: unknown })?.headers;
  if (!headers) return undefined;
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name) ?? undefined;
  const value = (headers as Record<string, unknown>)[name];
  return typeof value === "string" ? value : undefined;
}

/** retry-after is seconds (possibly fractional) or an HTTP date. */
export function parseRetryAfter(value: string | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** Groq's machine-readable error code (e.g. tool_use_failed), never its free text. */
function groqErrorCode(error: unknown): string | undefined {
  const body = (error as { error?: { error?: { code?: unknown; type?: unknown }; code?: unknown; type?: unknown } })?.error;
  const inner = body?.error ?? body;
  const code = inner?.code ?? inner?.type;
  return typeof code === "string" ? code.slice(0, 60) : undefined;
}

/** Translates anything the SDK throws into our own error vocabulary. */
function asAiError(error: unknown): AiError {
  if (error instanceof AiError) return error;

  const status = (error as { status?: unknown })?.status;
  const httpStatus = typeof status === "number" ? status : undefined;
  const code = groqErrorCode(error);
  const label = `HTTP ${httpStatus ?? "none"}${code ? `, ${code}` : ""}`;

  if (httpStatus === 401 || httpStatus === 403) {
    return new AiConfigurationError(`Groq rejected the API key (${label}). Check GROQ_API_KEY.`);
  }
  if (httpStatus === 404) {
    return new AiConfigurationError(`Groq does not serve this model to this key (${label}). Check GROQ_MODEL.`);
  }
  if (httpStatus === 429) {
    const retryAfterMs = parseRetryAfter(headerOf(error, "retry-after"));
    return new GroqCallError(
      `Groq rate limit reached (${label}; retry-after ${retryAfterMs === undefined ? "not given" : `${retryAfterMs}ms`}; ` +
        `remaining requests ${headerOf(error, "x-ratelimit-remaining-requests") ?? "?"}, tokens ${headerOf(error, "x-ratelimit-remaining-tokens") ?? "?"}).`,
      { httpStatus, retryAfterMs, retryable: retryAfterMs !== undefined && retryAfterMs <= MAX_RATE_LIMIT_WAIT_MS }
    );
  }
  if (httpStatus === 400 && code === "tool_use_failed") {
    // The model produced a tool call Groq could not parse; a fresh attempt usually succeeds.
    return new GroqCallError(`Groq rejected the model's tool call (${label}).`, { httpStatus, retryable: true });
  }
  if (httpStatus !== undefined && httpStatus >= 500) {
    return new GroqCallError(`Groq call failed (${label}).`, { httpStatus, retryable: true });
  }
  if (httpStatus === undefined) {
    // A connection that never produced a response. The SDK's message names the cause, not the key.
    return new GroqCallError(`Groq could not be reached: ${errorMessage(error).slice(0, 160)}`, { retryable: true });
  }
  return new GroqCallError(`Groq rejected the request (${label}).`, { httpStatus, retryable: false });
}

/* ------------------------------------------------------------------ */
/* Calls                                                               */
/* ------------------------------------------------------------------ */

function toMessages(system: string, messages: AiMessage[]): Message[] {
  return [
    { role: "system", content: system },
    ...messages.map((message): Message => ({ role: message.role, content: message.content })),
  ];
}

async function callOnce(config: GroqConfig, input: GenerateInput, messages: Message[], deadline: number): Promise<Completion> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new AiTimeoutError(config.timeoutMs);

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, remaining);

  try {
    const body = {
      model: config.model,
      messages,
      temperature: input.temperature ?? config.temperature,
      max_completion_tokens: input.maxOutputTokens ?? config.maxOutputTokens,
      ...(config.reasoningEffort ? { reasoning_effort: config.reasoningEffort } : {}),
      ...(input.tools?.length
        ? {
            tools: input.tools.map((tool) => ({
              type: "function" as const,
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters ?? { type: "object", properties: {} },
              },
            })),
            tool_choice: "auto" as const,
          }
        : {}),
    };
    return (await clientFor(config).chat.completions.create(
      body as unknown as Parameters<Groq["chat"]["completions"]["create"]>[0],
      { signal: controller.signal, maxRetries: 0 }
    )) as unknown as Completion;
  } catch (error) {
    if (timedOut) throw new AiTimeoutError(config.timeoutMs);
    throw asAiError(error);
  } finally {
    clearTimeout(timer);
  }
}

async function callWithRetry(config: GroqConfig, input: GenerateInput, messages: Message[], deadline: number): Promise<Completion> {
  try {
    return await callOnce(config, input, messages, deadline);
  } catch (error) {
    const aiError = asAiError(error);
    if (!(aiError instanceof GroqCallError) || !aiError.retryable) throw aiError;

    const pause = Math.max(RETRY_PAUSE_MS, aiError.retryAfterMs ?? 0);
    // Not enough of the turn left to wait and try again: fail now, honestly.
    if (Date.now() + pause >= deadline) throw aiError;
    console.warn("[groq] retrying once", { detail: aiError.message, pauseMs: pause });
    await new Promise((resolve) => setTimeout(resolve, pause));
    return callOnce(config, input, messages, deadline);
  }
}

/** The tool arguments as an object, or a failure: the model's JSON is untrusted input. */
function parseArguments(call: ToolCall): Record<string, unknown> {
  const raw = call.function?.arguments;
  if (raw === undefined || raw === null || raw === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AiUnavailableError(`Groq returned tool arguments that are not JSON for ${call.function?.name ?? "a tool"}.`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AiUnavailableError(`Groq returned tool arguments that are not an object for ${call.function?.name ?? "a tool"}.`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Generate one reply, running any tools the model asks for along the way.
 * Same contract as gemini.ts `generate`: throws AiError subclasses only.
 */
export async function generate(input: GenerateInput): Promise<AiGeneration> {
  const config = resolveGroqConfig(input.env ?? process.env);

  if (input.messages.length === 0) {
    throw new AiUnavailableError("generate() was called with no messages.");
  }
  if (input.tools?.length && !input.executeTool) {
    throw new AiConfigurationError("generate() was given tools but no executeTool.");
  }
  if (input.tools?.length && !supportsToolCalling(config.model)) {
    throw new AiConfigurationError(
      `GROQ_MODEL '${config.model}' cannot call tools (Groq answers HTTP 400 "tool calling is not supported"), ` +
        "so the concierge could not read hotels, prices or availability. Use a tool-calling model such as openai/gpt-oss-120b."
    );
  }

  const deadline = Date.now() + config.timeoutMs;
  const messages = toMessages(input.system, input.messages);
  const usage = { inputTokens: 0, outputTokens: 0 };
  const toolCalls: string[] = [];

  for (let round = 0; ; round++) {
    const callStarted = Date.now();
    let completion: Completion;
    try {
      completion = await callWithRetry(config, input, messages, deadline);
    } catch (error) {
      input.trace?.modelCalls.push({ ms: Date.now() - callStarted, failed: asAiError(error).code });
      throw asAiError(error);
    }

    usage.inputTokens += completion.usage?.prompt_tokens ?? 0;
    usage.outputTokens += completion.usage?.completion_tokens ?? 0;

    const choice = completion.choices?.[0];
    const message = choice?.message;
    if (!choice || !message) {
      input.trace?.modelCalls.push({ ms: Date.now() - callStarted, failed: "unavailable" });
      throw new AiUnavailableError("Groq returned no choice.");
    }

    const calls = input.executeTool && Array.isArray(message.tool_calls) ? message.tool_calls : [];
    input.trace?.modelCalls.push({
      ms: Date.now() - callStarted,
      finishReason: choice.finish_reason ?? undefined,
      inputTokens: completion.usage?.prompt_tokens,
      outputTokens: completion.usage?.completion_tokens,
      thoughtTokens: completion.usage?.completion_tokens_details?.reasoning_tokens,
      toolCallsRequested: calls.length,
    });

    if (calls.length === 0) {
      const text = typeof message.content === "string" ? message.content.trim() : "";
      if (!text) {
        throw new AiUnavailableError(`Groq returned no usable text (finish_reason: ${choice.finish_reason ?? "unknown"}).`);
      }
      return { text, model: config.model, usage, toolCalls };
    }

    if (round >= MAX_TOOL_ROUNDS) {
      throw new AiUnavailableError(`Groq was still calling tools after ${MAX_TOOL_ROUNDS} rounds.`);
    }

    // Validate every call before running any, so a malformed batch books nothing.
    const parsed = calls.map((call) => {
      if (typeof call?.id !== "string" || typeof call.function?.name !== "string") {
        throw new AiUnavailableError("Groq returned a malformed tool call.");
      }
      return { call, args: parseArguments(call) };
    });

    messages.push({ role: "assistant", content: message.content ?? null, tool_calls: calls });

    // One at a time: a booking must never race a lookup in the same turn.
    for (const { call, args } of parsed) {
      const name = call.function.name;
      toolCalls.push(name);
      const toolStarted = Date.now();
      const result: AiToolResult = await input.executeTool!({ name, args });
      input.trace?.toolCalls.push({ name, ms: Date.now() - toolStarted });
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
}

/** Output cap for the probe: room for a reasoning model to think briefly and stop. */
export const PROBE_MAX_OUTPUT_TOKENS = 64;

/**
 * Is the assistant configured, and — with `probe` — reachable? The probe
 * costs one real request from the free plan's daily allowance, so it is
 * opt-in, and it deliberately does not retry.
 */
export async function checkHealth(
  { probe = false, env = process.env }: { probe?: boolean; env?: Env } = {}
): Promise<AiHealthReport> {
  if (!isGroqConfigured(env)) {
    return { configured: false, model: null, error: "GROQ_API_KEY is not set." };
  }
  const model = configuredGroqModel(env);
  if (!supportsToolCalling(model)) {
    // Reachable or not, this model can't run the concierge: report it as the misconfiguration it is.
    return { configured: false, model, error: `GROQ_MODEL '${model}' cannot call tools.` };
  }
  if (!probe) return { configured: true, model };

  const startedAt = Date.now();
  try {
    const config = resolveGroqConfig(env);
    const completion = await callOnce(
      config,
      { system: "", messages: [], maxOutputTokens: PROBE_MAX_OUTPUT_TOKENS, temperature: 0 },
      toMessages("You are a connectivity check. Reply with the single word: ok.", [{ role: "user", content: "ping" }]),
      Date.now() + config.timeoutMs
    );
    const choice = completion.choices?.[0];
    if (!choice) throw new AiUnavailableError("Groq returned no choice.");
    return {
      configured: true,
      model: config.model,
      reachable: true,
      latencyMs: Date.now() - startedAt,
      finishReason: choice.finish_reason ?? "unknown",
    };
  } catch (error) {
    return { configured: true, model, reachable: false, latencyMs: Date.now() - startedAt, error: errorMessage(error) };
  }
}
