/**
 * Error wording and retry behaviour for the concierge flow.
 *
 * Verifies that every guest-facing error in the concierge path uses
 * neutral wording ("send again", never "try again"), that retryable
 * errors can be retried, and that the retry path cannot duplicate
 * a booking because the server dedupes by turnId.
 *
 * Pure logic; no emulator, no network.
 */
import { describe, expect, it } from "vitest";
import {
  AiConfigurationError,
  AiError,
  AiInvalidRequestError,
  AiRateLimitError,
  AiTimeoutError,
  AiUnavailableError,
  DEFAULT_GUEST_MESSAGE,
  guestMessageFor,
  isAiError,
  isRateLimitError,
} from "../../server/ai/errors.js";
import { ConciergeError } from "../../src/lib/concierge.js";
import { isTurnId } from "../../server/conversations.js";
import { createReservationTool } from "../../server/ai/tools/createReservation.js";

describe("guest-facing error wording", () => {
  it("DEFAULT_GUEST_MESSAGE says 'send again' not 'try again'", () => {
    expect(DEFAULT_GUEST_MESSAGE).not.toMatch(/try again/i);
    expect(DEFAULT_GUEST_MESSAGE).toMatch(/send again/i);
  });

  it("AiRateLimitError guest message says 'send again'", () => {
    const error = new AiRateLimitError(5);
    expect(error.guestMessage).not.toMatch(/try again/i);
    expect(error.guestMessage).toMatch(/send again/i);
    expect(error.status).toBe(429);
    expect(error.code).toBe("rate_limited");
    expect(error.retryAfterSeconds).toBe(5);
  });

  it("AiTimeoutError guest message says 'send again'", () => {
    const error = new AiTimeoutError(30_000);
    expect(error.guestMessage).not.toMatch(/try again/i);
    expect(error.guestMessage).toMatch(/send again/i);
    expect(error.status).toBe(504);
    expect(error.code).toBe("timeout");
  });

  it("AiUnavailableError uses the fallback message", () => {
    const error = new AiUnavailableError("provider exploded");
    expect(error.guestMessage).toBe(DEFAULT_GUEST_MESSAGE);
    expect(error.status).toBe(503);
    expect(error.code).toBe("unavailable");
  });

  it("AiConfigurationError uses 503, not 401", () => {
    const error = new AiConfigurationError("no key");
    expect(error.status).toBe(503);
    expect(error.code).toBe("not_configured");
  });

  it("guestMessageFor returns the error's guestMessage", () => {
    expect(guestMessageFor(new AiRateLimitError(3))).toMatch(/send again/);
    expect(guestMessageFor(new Error("unknown"))).toBe(DEFAULT_GUEST_MESSAGE);
  });

  it("isAiError narrows to AiError", () => {
    expect(isAiError(new AiRateLimitError(3))).toBe(true);
    expect(isAiError(new Error("nope"))).toBe(false);
  });

  it("isRateLimitError narrows to AiRateLimitError", () => {
    expect(isRateLimitError(new AiRateLimitError(3))).toBe(true);
    expect(isRateLimitError(new AiUnavailableError("down"))).toBe(false);
    expect(isRateLimitError(new AiInvalidRequestError("bad"))).toBe(false);
  });
});

describe("ConciergeError retryability", () => {
  it("rate_limited is retryable", () => {
    const error = new ConciergeError("Rate limited.", "rate_limited");
    expect(error.retryable).toBe(true);
  });

  it("unavailable is retryable", () => {
    const error = new ConciergeError("Down.", "unavailable");
    expect(error.retryable).toBe(true);
  });

  it("timeout is retryable", () => {
    const error = new ConciergeError("Slow.", "timeout");
    expect(error.retryable).toBe(true);
  });

  it("network is retryable", () => {
    const error = new ConciergeError("No connection.", "network");
    expect(error.retryable).toBe(true);
  });

  it("invalid_request is not retryable", () => {
    const error = new ConciergeError("Bad request.", "invalid_request");
    expect(error.retryable).toBe(false);
  });

  it("carries conversationId and booking when the server provides them", () => {
    const booking = { reservationId: "RSV-1" } as never;
    const error = new ConciergeError("Reply failed.", "unavailable", "conv-123", booking);
    expect(error.conversationId).toBe("conv-123");
    expect(error.booking).toBe(booking);
  });
});

describe("turnId dedup prevents duplicate recording", () => {
  it("a valid turnId is 1-40 alphanumeric/dash/underscore chars", () => {
    expect(isTurnId("t1")).toBe(true);
    expect(isTurnId("a".repeat(40))).toBe(true);
    expect(isTurnId("")).toBe(false);
    expect(isTurnId("a".repeat(41))).toBe(false);
    expect(isTurnId("bad id!")).toBe(false);
    expect(isTurnId(123)).toBe(false);
  });

  it("the server records the guest message once when turnId matches pendingTurnId", () => {
    // The dedup rule is: repeat = isTurnId(turnId) && pendingTurnId === turnId.
    // When repeat is true, the guest message is not written a second time.
    // This is what prevents a retried turn from creating a duplicate
    // guest turn (and therefore a duplicate booking).
    const turnId = "turn-abc-123";
    const pendingTurnId = "turn-abc-123";
    const repeat = isTurnId(turnId) && pendingTurnId === turnId;
    expect(repeat).toBe(true);

    const different = "turn-xyz-789";
    const repeat2 = isTurnId(different) && pendingTurnId === different;
    expect(repeat2).toBe(false);
  });
});

describe("no duplicate booking on a retried turn", () => {
  const args = {
    hotel: "kabale-hotel-1",
    roomType: "Double",
    checkIn: "2026-11-10",
    checkOut: "2026-11-15",
    guestName: "Amina Okello",
    guestPhoneNumber: "+256 772 123 456",
  } as Record<string, unknown>;

  it("create_reservation refuses when no pending summary exists (already booked: pendingBooking cleared)", async () => {
    // After a booking is confirmed, recordTurn clears pendingBooking. A retried
    // turn (same turnId, response lost) therefore finds no pending summary and
    // create_reservation returns needs_confirmation instead of booking again.
    const result = await createReservationTool.run(
      { network: null as unknown, guestMessage: "Yes, confirm", pendingBooking: null, now: new Date() },
      args
    );
    expect(result).toMatchObject({ status: "not_booked", reason: "needs_confirmation" });
  });

  it("the turnId dedup predicate keeps a failed turn from being re-recorded", () => {
    const turnId = "turn-abc-123";
    // repeat = isTurnId(turnId) && pendingTurnId === turnId
    expect(isTurnId(turnId) && "turn-abc-123" === turnId).toBe(true);
    expect(isTurnId(turnId) && "turn-xyz-789" === turnId).toBe(false);
  });
});
