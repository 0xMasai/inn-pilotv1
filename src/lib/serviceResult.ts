/**
 * Result type shared by InnPilot's service layer.
 *
 * Returning failures instead of throwing keeps every call site on one
 * path, and keeps user-facing wording in one place rather than
 * duplicated per caller.
 */
export type ServiceResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export function ok<T>(data: T): ServiceResult<T> {
  return { ok: true, data };
}

export function fail<T = never>(error: string): ServiceResult<T> {
  return { ok: false, error };
}

/** Firestore error code, when the thrown value carries one. */
export function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === "string") return code;
  }
  return "unknown";
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error);
}

/** Turns a Firestore failure into something a hotel manager can act on. */
export function describeWriteFailure(error: unknown, fallback: string): string {
  switch (errorCode(error)) {
    case "permission-denied":
      return "This change isn't allowed. Reload the page and try again.";
    case "unavailable":
      return "InnPilot is offline. Check your connection and try again.";
    default:
      return errorMessage(error) || fallback;
  }
}
