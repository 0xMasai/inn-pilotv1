/**
 * Throttle env defaults and overrides: the concierge rate limit reads
 * CONCIERGE_RATE_LIMIT and CONCIERGE_RATE_WINDOW_MS from the environment
 * via readNumber(), with sensible defaults and bounds.
 */
import { describe, expect, it } from "vitest";
import { readNumber } from "../../server/ai/config.js";

describe("throttle env reading (via readNumber)", () => {
  it("uses defaults when env vars are unset", () => {
    const limit = readNumber({}, "CONCIERGE_RATE_LIMIT", 12, { min: 1, max: 1000 });
    const windowMs = readNumber({}, "CONCIERGE_RATE_WINDOW_MS", 60_000, { min: 1_000, max: 3_600_000 });
    expect(limit).toBe(12);
    expect(windowMs).toBe(60_000);
  });

  it("uses env overrides when set", () => {
    const limit = readNumber({ CONCIERGE_RATE_LIMIT: "50" }, "CONCIERGE_RATE_LIMIT", 12, { min: 1, max: 1000 });
    const windowMs = readNumber(
      { CONCIERGE_RATE_WINDOW_MS: "300000" },
      "CONCIERGE_RATE_WINDOW_MS",
      60_000,
      { min: 1_000, max: 3_600_000 }
    );
    expect(limit).toBe(50);
    expect(windowMs).toBe(300_000);
  });

  it("rejects values below min", () => {
    expect(() =>
      readNumber({ CONCIERGE_RATE_LIMIT: "0" }, "CONCIERGE_RATE_LIMIT", 12, { min: 1, max: 1000 })
    ).toThrow(/CONCIERGE_RATE_LIMIT must be a number between 1 and 1000/);
  });

  it("rejects values above max", () => {
    expect(() =>
      readNumber({ CONCIERGE_RATE_LIMIT: "2000" }, "CONCIERGE_RATE_LIMIT", 12, { min: 1, max: 1000 })
    ).toThrow(/CONCIERGE_RATE_LIMIT must be a number between 1 and 1000/);
  });

  it("rejects non-numeric values", () => {
    expect(() =>
      readNumber({ CONCIERGE_RATE_LIMIT: "not-a-number" }, "CONCIERGE_RATE_LIMIT", 12, { min: 1, max: 1000 })
    ).toThrow(/CONCIERGE_RATE_LIMIT must be a number between 1 and 1000/);
  });

  it("ignores empty string env values (falls back to default)", () => {
    const limit = readNumber({ CONCIERGE_RATE_LIMIT: "" }, "CONCIERGE_RATE_LIMIT", 12, { min: 1, max: 1000 });
    expect(limit).toBe(12);
  });
});
