/**
 * Failure modes of the AI layer.
 *
 * Two audiences, deliberately separated. `message` is for operators and
 * goes to logs; `guestMessage` is what a hotel guest may read, and it
 * never carries a provider name, a stack, a model id or a hotel's data.
 *
 * The product rule behind the guest wording: when the assistant cannot
 * verify something, it must say so and point at a human — never paper over
 * the failure with an invented answer.
 */

export type AiErrorCode =
  | "not_configured"
  | "invalid_request"
  | "rate_limited"
  | "timeout"
  | "unavailable";

/** Fallback copy for a failure with nothing more specific to say. */
const DEFAULT_GUEST_MESSAGE =
  "I can't reach the hotel assistant right now. Please try again in a " +
  "moment, or contact the hotel team directly and they'll help you.";

export class AiError extends Error {
  readonly code: AiErrorCode;
  /** HTTP status the gateway should return. */
  readonly status: number;
  /** Safe to show a guest verbatim. */
  readonly guestMessage: string;

  constructor(
    code: AiErrorCode,
    status: number,
    message: string,
    guestMessage: string = DEFAULT_GUEST_MESSAGE
  ) {
    super(message);
    this.name = "AiError";
    this.code = code;
    this.status = status;
    this.guestMessage = guestMessage;
  }
}

/**
 * The deployment is missing or holding a bad credential. An operator
 * problem, so the guest is told nothing about it beyond "unavailable" —
 * and the status is 503, not 401: the *guest* is not unauthorized.
 */
export class AiConfigurationError extends AiError {
  constructor(message: string) {
    super("not_configured", 503, message);
    this.name = "AiConfigurationError";
  }
}

/** The caller sent something this endpoint cannot act on. */
export class AiInvalidRequestError extends AiError {
  constructor(message: string, guestMessage?: string) {
    super("invalid_request", 400, message, guestMessage);
    this.name = "AiInvalidRequestError";
  }
}

export class AiRateLimitError extends AiError {
  /** Seconds the caller should wait, for the Retry-After header. */
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super(
      "rate_limited",
      429,
      `Rate limit exceeded; retry in ${retryAfterSeconds}s.`,
      "You're sending messages faster than I can answer them. " +
        "Give me a few seconds and try again."
    );
    this.name = "AiRateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class AiTimeoutError extends AiError {
  constructor(timeoutMs: number) {
    super(
      "timeout",
      504,
      `The model did not respond within ${timeoutMs}ms.`,
      "That took longer than expected and I had to stop waiting. " +
        "Please try asking again."
    );
    this.name = "AiTimeoutError";
  }
}

/** The provider was reached and failed, or returned something unusable. */
export class AiUnavailableError extends AiError {
  constructor(message: string) {
    super("unavailable", 503, message);
    this.name = "AiUnavailableError";
  }
}

export function isAiError(error: unknown): error is AiError {
  return error instanceof AiError;
}

/**
 * Narrows to the one error carrying `retryAfterSeconds`. Checking `code`
 * alone would not: every subclass shares the `AiError` type, so the field
 * is only reachable through the class itself.
 */
export function isRateLimitError(error: unknown): error is AiRateLimitError {
  return error instanceof AiRateLimitError;
}

/** The one line a guest sees for any failure. */
export function guestMessageFor(error: unknown): string {
  return isAiError(error) ? error.guestMessage : DEFAULT_GUEST_MESSAGE;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
