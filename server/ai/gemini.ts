/**
 * The Gemini provider (AI_PROVIDER=gemini) — the only file that imports the
 * Google SDK. `groq.ts` is its sibling; `provider.ts` picks between them.
 *
 * Everything above it (the gateway and the tool layer) speaks the
 * vendor-neutral types in `types.ts`. That boundary is what keeps model
 * specifics out of React components, and what makes "swap the model" a
 * one-file change.
 *
 * Four things this module guarantees to its callers:
 *
 *   1. It never hangs. A whole guest turn — every model call and tool
 *      round in it — is bounded by GEMINI_TIMEOUT_MS and raises
 *      AiTimeoutError, because a guest waiting on a chat bubble is worse
 *      served by silence than by "try again".
 *   2. It never returns an empty success. A blank completion is a failure,
 *      raised as one, so no caller can render emptiness as an answer.
 *   3. It only retries what is worth retrying — a transient 429/5xx, once.
 *      A rejected key or a bad request is re-raised immediately.
 *   4. The model never touches data. When it asks for a tool, this module
 *      hands the call to the caller's `executeTool` and returns the result
 *      to the model; what a tool can reach is decided entirely by whoever
 *      built that executor (see server/ai/tools).
 */
import {
  GoogleGenAI,
  type Content,
  type GenerateContentResponse,
  type Part,
  type ThinkingLevel,
} from "@google/genai";
import {
  MAX_TOOL_ROUNDS,
  isGeminiConfigured,
  resolveGeminiConfig,
  configuredModel,
  type Env,
  type GeminiConfig,
} from "./config";
import {
  AiConfigurationError,
  AiError,
  AiTimeoutError,
  AiUnavailableError,
  errorMessage,
} from "./errors";
import type { AiGeneration, AiHealthReport, AiMessage, GenerateInput } from "./types";

export { MAX_TOOL_ROUNDS } from "./config";

export type { GenerateInput } from "./types";

/**
 * One client per credential, reused across warm invocations — building it
 * per request would add a TLS handshake to every guest message. Keyed by
 * the credential so a rotated key produces a new client instead of
 * silently reusing one holding the old secret. Process memory only: never
 * logged, never returned.
 */
let cached: { key: string; client: GoogleGenAI } | null = null;

function clientFor(config: GeminiConfig): GoogleGenAI {
  const key = `${config.apiKey}:${config.model}:${config.baseUrl ?? ""}`;
  if (cached?.key !== key) {
    cached = {
      key,
      client: new GoogleGenAI({ apiKey: config.apiKey, ...(config.baseUrl ? { httpOptions: { baseUrl: config.baseUrl } } : {}) }),
    };
  }
  return cached.client;
}

/** Test seam: drops the memoized client. */
export function resetGeminiClient(): void {
  cached = null;
}

/** Our roles, in Gemini's vocabulary. */
function toContents(messages: AiMessage[]) {
  return messages.map((message) => ({
    role: message.role === "assistant" ? "model" : "user",
    parts: [{ text: message.content }],
  }));
}

/** The provider's HTTP status, when the thrown value carries one. */
function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;

  const candidate = error as { status?: unknown; code?: unknown };
  if (typeof candidate.status === "number") return candidate.status;
  if (typeof candidate.code === "number") return candidate.code;

  // Some SDK errors only carry the status inside the message text.
  const match = /\b(4\d{2}|5\d{2})\b/.exec(errorMessage(error));
  return match ? Number(match[1]) : undefined;
}

/** Translates anything the SDK throws into our own error vocabulary. */
function asAiError(error: unknown): AiError {
  if (error instanceof AiError) return error;

  const status = statusOf(error);
  const detail = errorMessage(error);

  // Google answers a malformed or revoked key with HTTP 400 API_KEY_INVALID.
  if (status === 401 || status === 403 || /API_KEY_INVALID/.test(detail)) {
    // An operator problem, not the guest's: config errors surface as 503.
    return new AiConfigurationError(
      `Gemini rejected the API key (HTTP ${status}). Check GEMINI_API_KEY. ${detail}`
    );
  }
  if (status === 400) {
    return new AiUnavailableError(`Gemini rejected the request (HTTP 400). ${detail}`);
  }
  return new AiUnavailableError(
    status ? `Gemini call failed (HTTP ${status}). ${detail}` : `Gemini call failed. ${detail}`
  );
}

/** Worth one more attempt: rate limiting and transient server failures. */
function isRetryable(error: AiError): boolean {
  if (error.code !== "unavailable") return false;
  const status = statusOf(error);
  return status === undefined || status === 429 || status >= 500;
}

/** Plain answer text: every text part, minus any thinking the model emitted. */
function answerText(response: GenerateContentResponse): string {
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  return parts
    .filter((part) => typeof part.text === "string" && !part.thought)
    .map((part) => part.text)
    .join("")
    .trim();
}

async function callOnce(
  config: GeminiConfig,
  input: GenerateInput,
  contents: Content[],
  deadline: number
): Promise<GenerateContentResponse> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new AiTimeoutError(config.timeoutMs);

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, remaining);

  try {
    return await clientFor(config).models.generateContent({
      model: config.model,
      contents,
      config: {
        systemInstruction: input.system,
        temperature: input.temperature ?? config.temperature,
        maxOutputTokens: input.maxOutputTokens ?? config.maxOutputTokens,
        abortSignal: controller.signal,
        ...(config.thinkingLevel
          ? { thinkingConfig: { thinkingLevel: config.thinkingLevel as ThinkingLevel } }
          : {}),
        ...(input.tools?.length
          ? {
              tools: [
                {
                  functionDeclarations: input.tools.map((tool) => ({
                    name: tool.name,
                    description: tool.description,
                    ...(tool.parameters ? { parametersJsonSchema: tool.parameters } : {}),
                  })),
                },
              ],
            }
          : {}),
      },
    });
  } catch (error) {
    // The abort we scheduled surfaces here as a generic abort error; only
    // our own flag can tell it apart from a caller-side cancellation.
    if (timedOut) throw new AiTimeoutError(config.timeoutMs);
    throw asAiError(error);
  } finally {
    clearTimeout(timer);
  }
}

async function callWithRetry(
  config: GeminiConfig,
  input: GenerateInput,
  contents: Content[],
  deadline: number
): Promise<GenerateContentResponse> {
  try {
    return await callOnce(config, input, contents, deadline);
  } catch (error) {
    const aiError = asAiError(error);
    if (!isRetryable(aiError)) throw aiError;

    // One retry, after a short pause. A second failure is a real outage,
    // and making a guest wait through a third attempt helps nobody.
    await new Promise((resolve) => setTimeout(resolve, 400));
    return callOnce(config, input, contents, deadline);
  }
}

/**
 * Generate one reply, running any tools the model asks for along the way.
 *
 * Each round: call the model; if it requested tools, run them one at a
 * time (a booking must never race a lookup in the same turn), send the
 * results back, and call again — until it answers in text or runs out of
 * rounds or time.
 *
 * Throws AiError subclasses only — callers can map `code` to a response
 * without inspecting provider internals.
 */
export async function generate(input: GenerateInput): Promise<AiGeneration> {
  const config = resolveGeminiConfig(input.env ?? process.env);

  if (input.messages.length === 0) {
    throw new AiUnavailableError("generate() was called with no messages.");
  }
  if (input.tools?.length && !input.executeTool) {
    throw new AiConfigurationError("generate() was given tools but no executeTool.");
  }

  const deadline = Date.now() + config.timeoutMs;
  const contents: Content[] = toContents(input.messages);
  const usage = { inputTokens: 0, outputTokens: 0 };
  const toolCalls: string[] = [];

  for (let round = 0; ; round++) {
    const callStarted = Date.now();
    let response: GenerateContentResponse;
    try {
      response = await callWithRetry(config, input, contents, deadline);
    } catch (error) {
      input.trace?.modelCalls.push({ ms: Date.now() - callStarted, failed: asAiError(error).code });
      throw error;
    }
    usage.inputTokens += response.usageMetadata?.promptTokenCount ?? 0;
    usage.outputTokens += response.usageMetadata?.candidatesTokenCount ?? 0;

    const calls = input.executeTool ? (response.functionCalls ?? []) : [];
    input.trace?.modelCalls.push({
      ms: Date.now() - callStarted,
      finishReason: response.candidates?.[0]?.finishReason,
      inputTokens: response.usageMetadata?.promptTokenCount,
      outputTokens: response.usageMetadata?.candidatesTokenCount,
      thoughtTokens: response.usageMetadata?.thoughtsTokenCount,
      toolCallsRequested: calls.length,
    });
    if (calls.length === 0) {
      const text = answerText(response);
      if (!text) {
        // Usually a safety block or a hit output cap. Either way there is no
        // answer, and returning "" would let a caller render silence as one.
        throw new AiUnavailableError(
          `Gemini returned no usable text (finishReason: ${
            response.candidates?.[0]?.finishReason ?? "unknown"
          }).`
        );
      }
      return { text, model: config.model, usage, toolCalls };
    }

    if (round >= MAX_TOOL_ROUNDS) {
      throw new AiUnavailableError(`Gemini was still calling tools after ${MAX_TOOL_ROUNDS} rounds.`);
    }

    // The model's own turn goes back verbatim: it carries the thought
    // signatures Gemini requires to continue a function-calling exchange.
    const modelTurn = response.candidates?.[0]?.content;
    if (!modelTurn) throw new AiUnavailableError("Gemini requested tools without returning its turn.");
    contents.push(modelTurn);

    const responses: Part[] = [];
    for (const call of calls) {
      const name = call.name ?? "";
      toolCalls.push(name);
      const toolStarted = Date.now();
      const result = await input.executeTool!({ name, args: call.args ?? {} });
      input.trace?.toolCalls.push({ name, ms: Date.now() - toolStarted });
      responses.push({ functionResponse: { id: call.id, name, response: result } });
    }
    contents.push({ role: "user", parts: responses });
  }
}

/** Output cap for the probe: room for a thinking model to think and still stop cheaply. */
export const PROBE_MAX_OUTPUT_TOKENS = 64;

/**
 * Is the assistant configured, and — when `probe` is set — actually
 * reachable? The probe costs a real (tiny) call, so it is opt-in: an
 * uptime check should not be able to spend the hotel's token budget by
 * accident.
 *
 * "Reachable" means Gemini accepted the key and the model and returned a
 * candidate. It deliberately does not require answer text: a thinking
 * model can spend a small output cap on thoughts and stop at MAX_TOKENS
 * before writing a word, which proves connectivity just as well. Requiring
 * text made the probe report a working model as unreachable.
 */
export async function checkHealth(
  { probe = false, env = process.env }: { probe?: boolean; env?: Env } = {}
): Promise<AiHealthReport> {
  const configured = isGeminiConfigured(env);
  const model = configuredModel(env);

  if (!configured) {
    return { configured: false, model: null, error: "GEMINI_API_KEY is not set." };
  }
  if (!probe) {
    return { configured: true, model };
  }

  const startedAt = Date.now();
  try {
    const config = resolveGeminiConfig(env);
    const response = await callWithRetry(
      config,
      {
        system: "You are a connectivity check. Reply with the single word: ok.",
        messages: [],
        maxOutputTokens: PROBE_MAX_OUTPUT_TOKENS,
        temperature: 0,
      },
      toContents([{ role: "user", content: "ping" }]),
      Date.now() + config.timeoutMs
    );
    const candidate = response.candidates?.[0];
    if (!candidate) {
      const blocked = response.promptFeedback?.blockReason;
      throw new AiUnavailableError(
        `Gemini returned no candidate${blocked ? ` (blockReason: ${blocked})` : ""}.`
      );
    }
    return {
      configured: true,
      model: config.model,
      reachable: true,
      latencyMs: Date.now() - startedAt,
      finishReason: candidate.finishReason ?? "unknown",
    };
  } catch (error) {
    return {
      configured: true,
      model,
      reachable: false,
      latencyMs: Date.now() - startedAt,
      error: errorMessage(error),
    };
  }
}
