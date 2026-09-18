/**
 * A small in-memory rate limiter for the public endpoints.
 *
 * The concierge takes no login, so without this one script can spend a
 * hotel's entire token budget in a minute. A sliding window per caller is
 * enough to stop that while staying invisible to a real guest, who sends a
 * message every several seconds at most.
 *
 * Scope and honesty about it: the counter lives in one serverless
 * instance's memory, so a burst spread across cold starts gets a little
 * more headroom than the nominal limit, and a redeploy resets everything.
 * That is the right trade for an MVP — a shared store (Redis, Firestore)
 * would add a dependency and a round-trip to every guest message. It is a
 * budget guard, not a security control; treat it as such.
 */
import { AiRateLimitError } from "./errors.js";

interface Window {
  /** Timestamps of recent hits, oldest first. */
  hits: number[];
}

const windows = new Map<string, Window>();

/** Stops the map growing without bound on a long-lived warm instance. */
const MAX_TRACKED_KEYS = 5_000;

export interface RateLimitOptions {
  /** Hits allowed inside the window. */
  limit: number;
  windowMs: number;
  now?: number;
}

/**
 * Records one hit against `key`, throwing AiRateLimitError when the caller
 * is over their allowance.
 */
export function enforceRateLimit(key: string, options: RateLimitOptions): void {
  const { limit, windowMs } = options;
  const now = options.now ?? Date.now();
  const cutoff = now - windowMs;

  if (windows.size > MAX_TRACKED_KEYS) windows.clear();

  const window = windows.get(key) ?? { hits: [] };
  // Drop everything that has aged out, so `hits` only ever holds the
  // current window and the array cannot grow unbounded.
  const hits = window.hits.filter((at) => at > cutoff);

  if (hits.length >= limit) {
    const oldest = hits[0];
    const retryAfterSeconds = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
    windows.set(key, { hits });
    throw new AiRateLimitError(retryAfterSeconds);
  }

  hits.push(now);
  windows.set(key, { hits });
}

/** Test seam: forgets every tracked caller. */
export function resetRateLimits(): void {
  windows.clear();
}
