/**
 * HTTP plumbing shared by the /api handlers.
 *
 * Typed structurally rather than against `@vercel/node`, so the exact same
 * handler function runs unmodified in three places: a Vercel function, the
 * local dev server (server/dev-server.ts), and a test that passes plain
 * objects. Vercel's own req/res satisfy these shapes, so no adapter and no
 * extra dependency is needed.
 */
import type { IncomingHttpHeaders } from "node:http";

export type ApiRequest = {
  method?: string;
  headers: IncomingHttpHeaders;
  /** Pre-parsed by Vercel; absent on a raw Node request, which we then read. */
  body?: unknown;
  socket?: { remoteAddress?: string | undefined };
} & AsyncIterable<Uint8Array | string>;

export interface ApiResponse {
  setHeader(name: string, value: string): unknown;
  status(code: number): ApiResponse;
  json(body: unknown): unknown;
  end(): unknown;
}

/** A request body larger than this is refused unread. */
const MAX_BODY_BYTES = 32 * 1024;

/**
 * Quotable in a support conversation, and useful for correlating a guest's
 * "it failed" with one log line. Identifies nothing else.
 */
export function newRequestId(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2, 14);
}

export function sendJson(res: ApiResponse, status: number, body: unknown): void {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  // A gateway answer is specific to one guest's turn; never let a proxy or
  // a browser reuse it for the next.
  res.setHeader("Cache-Control", "no-store");
  res.status(status).json(body);
}

/**
 * Same-origin needs no CORS headers at all, so an unset ALLOWED_ORIGINS
 * grants nothing rather than defaulting to `*`. A wildcard here would let
 * any site on the internet spend this deployment's token budget.
 *
 * Returns true when the request may proceed.
 */
export function applyCors(
  req: ApiRequest,
  res: ApiResponse,
  env: Record<string, string | undefined> = process.env
): boolean {
  const allowed = (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  const origin = req.headers.origin;
  if (typeof origin === "string" && allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "86400");
  }
  return true;
}

/** Handles the preflight. Returns true when the request is fully answered. */
export function handlePreflight(req: ApiRequest, res: ApiResponse): boolean {
  if (req.method !== "OPTIONS") return false;
  res.status(204).end();
  return true;
}

/** Enforces the method, answering 405 itself when it doesn't match. */
export function requireMethod(req: ApiRequest, res: ApiResponse, method: string): boolean {
  if (req.method === method) return true;
  res.setHeader("Allow", `${method}, OPTIONS`);
  sendJson(res, 405, { error: "Method not allowed." });
  return false;
}

/**
 * The JSON body, however the host chose to deliver it.
 *
 * Returns `null` for anything that isn't a JSON object — callers validate
 * fields themselves and should treat a null as "nothing usable arrived".
 */
export async function readJsonBody(req: ApiRequest): Promise<Record<string, unknown> | null> {
  if (req.body && typeof req.body === "object" && !Array.isArray(req.body)) {
    return req.body as Record<string, unknown>;
  }

  let raw: string;
  if (typeof req.body === "string") {
    raw = req.body;
  } else {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
      size += buffer.byteLength;
      if (size > MAX_BODY_BYTES) return null;
      chunks.push(buffer);
    }
    raw = Buffer.concat(chunks).toString("utf8");
  }

  if (!raw.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Who is calling, for rate limiting.
 *
 * `x-forwarded-for` is spoofable in general, but on Vercel the platform
 * sets it and the client cannot override it. It is the best key available
 * for an endpoint with no login, and it is never stored or logged.
 */
export function clientKey(req: ApiRequest): string {
  const forwarded = req.headers["x-forwarded-for"];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const ip = first?.split(",")[0]?.trim() || req.socket?.remoteAddress || "unknown";
  return ip;
}
