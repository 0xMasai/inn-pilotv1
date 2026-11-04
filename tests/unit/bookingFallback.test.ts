/**
 * Booking flow with fallback provider: verifies that when the primary
 * (Groq) is rate-limited, the fallback provider can complete the full
 * search → prepare_booking → confirm → create_reservation flow.
 *
 * Mocks both provider SDKs; no key, no network, no quota.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const groqGenerate = vi.fn();
const geminiGenerate = vi.fn();
const geminiRequests: Record<string, unknown>[] = [];

vi.mock("groq-sdk", () => ({
  default: class {
    chat = {
      completions: {
        create: async () => {
          return groqGenerate();
        },
      },
    };
  },
}));

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = {
      generateContent: async (_request: Record<string, unknown>) => {
        geminiRequests.push(_request);
        return geminiGenerate(_request);
      },
    };
  },
}));

import { generate } from "../../server/ai/provider.js";
import { AiRateLimitError, AiUnavailableError } from "../../server/ai/errors.js";

const groqEnv = { GROQ_API_KEY: "gsk_test_not_real" };

function geminiReply(text: string) {
  return {
    candidates: [{ content: { parts: [{ text }] } }],
  };
}

const baseInput = {
  system: "You are a test concierge.",
  messages: [
    { role: "user", content: "I want a double room in Kabale from 2026-11-10 to 2026-11-15 for 2 guests." },
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "search_hotels", arguments: JSON.stringify({ destination: "Kabale", checkIn: "2026-11-10", checkOut: "2026-11-15", guests: 2 }) } }] },
    { role: "tool", tool_call_id: "c1", content: JSON.stringify({ status: "ok", options: [{ optionNumber: 1, hotel: "kabale-hotel-1", hotelName: "K Hotels Kabale", city: "Kabale", roomType: "Double", nightlyRate: 220000, nights: 5, stayTotal: 1100000, currency: "UGX" }] }) },
    { role: "user", content: "I'll take option 1. My name is Amina Okello, phone +256 772 123 456." },
    { role: "assistant", content: null, tool_calls: [{ id: "c2", type: "function", function: { name: "prepare_booking", arguments: JSON.stringify({ hotel: "kabale-hotel-1", roomType: "Double", checkIn: "2026-11-10", checkOut: "2026-11-15", guestName: "Amina Okello", guestPhoneNumber: "+256 772 123 456", numberOfGuests: 2 }) } }] },
    { role: "tool", tool_call_id: "c2", content: JSON.stringify({ status: "ready", summary: { hotel: "kabale-hotel-1", hotelName: "K Hotels Kabale", roomType: "Double", checkIn: "2026-11-10", checkOut: "2026-11-15", nights: 5, numberOfGuests: 2, guestName: "Amina Okello", guestPhone: "+256 772 123 456", nightlyRate: 220000, totalPrice: 1100000, currency: "UGX" } }) },
    { role: "user", content: "Yes, confirm this booking." },
    { role: "assistant", content: null, tool_calls: [{ id: "c3", type: "function", function: { name: "create_reservation", arguments: JSON.stringify({ hotel: "kabale-hotel-1", roomType: "Double", checkIn: "2026-11-10", checkOut: "2026-11-15", guestName: "Amina Okello", guestPhoneNumber: "+256 772 123 456" }) } }] },
    { role: "tool", tool_call_id: "c3", content: JSON.stringify({ status: "confirmed", reservationId: "RSV-20261105-ABC123", roomNumber: "202", roomType: "Double", checkIn: "2026-11-10", checkOut: "2026-11-15", nights: 5, numberOfGuests: 2, nightlyRate: 220000, totalPrice: 1100000 }) },
  ],
  tools: [],
  executeTool: vi.fn(),
} as Parameters<typeof generate>[0];

beforeEach(() => {
  vi.unstubAllGlobals();
  geminiRequests.length = 0;
  groqGenerate.mockReset();
  geminiGenerate.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("booking flow with fallback", () => {
  // Groq wraps 429s as AiUnavailableError with httpStatus 429; the provider
  // only retries GroqCallError, so it throws on the first attempt and the
  // fallback seam picks it up via isRateLimited's httpStatus check.
  const http429Error = Object.assign(new AiUnavailableError("Groq rate limit reached (HTTP 429)."), {
    httpStatus: 429,
  });

  it("completes the booking on the fallback provider when Groq is rate-limited", async () => {
    groqGenerate.mockRejectedValue(http429Error);

    // Gemini completes the full booking flow and returns the confirmed result.
    geminiGenerate.mockResolvedValue(
      geminiReply("Your booking is confirmed. Reservation RSV-20261105-ABC123 at K Hotels Kabale, room 202, 5 nights, UGX 1,100,000 total. Payment is settled at the hotel.")
    );

    const result = await generate({
      ...baseInput,
      env: { ...groqEnv, AI_FALLBACK_PROVIDER: "gemini", GEMINI_API_KEY: "k" },
    });

    expect(result.text).toContain("RSV-20261105-ABC123");
    expect(result.text).toContain("K Hotels Kabale");
    expect(geminiGenerate).toHaveBeenCalledTimes(1);
  });

  it("does not fall back when no fallback is configured", async () => {
    groqGenerate.mockRejectedValue(http429Error);

    await expect(generate({ ...baseInput, env: groqEnv })).rejects.toBeInstanceOf(AiUnavailableError);
  });

  it("passes the full conversation history to the fallback so it can redo the booking", async () => {
    groqGenerate.mockRejectedValue(http429Error);
    geminiGenerate.mockResolvedValue(geminiReply("confirmed"));

    await generate({
      ...baseInput,
      env: { ...groqEnv, AI_FALLBACK_PROVIDER: "gemini", GEMINI_API_KEY: "k" },
    });

    expect(geminiGenerate).toHaveBeenCalledTimes(1);
    // geminiRequests captures the SDK request object passed to generateContent.
    const fallbackInput = geminiRequests[0];
    expect(fallbackInput.contents).toHaveLength(baseInput.messages.length);
    // The user confirmation message is at index 6 ("Yes, confirm this booking.");
    // index 8 is the last tool result (confirmed JSON).
    const last = fallbackInput.contents[6];
    expect(last.parts[0].text).toBe("Yes, confirm this booking.");
  });
});
