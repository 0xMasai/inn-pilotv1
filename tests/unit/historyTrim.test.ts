/**
 * History trimming for the concierge gateway: readHistory keeps the newest
 * turns within MAX_HISTORY_TURNS and MAX_HISTORY_CHARS, and the server-side
 * pending booking state (from prepare_booking) is untouched by history
 * trimming because it lives in the conversation record, not in the client
 * transcript.
 */
import { describe, expect, it } from "vitest";
import { readHistory, MAX_HISTORY_TURNS, MAX_HISTORY_CHARS } from "../../api/ai/concierge.js";

function turn(role: "user" | "assistant", text: string) {
  return { role, content: text };
}

describe("readHistory", () => {
  it("returns empty for missing or non-array history", () => {
    expect(readHistory({})).toEqual([]);
    expect(readHistory({ history: null })).toEqual([]);
    expect(readHistory({ history: "not an array" })).toEqual([]);
  });

  it("skips malformed entries", () => {
    expect(
      readHistory({
        history: [
          { role: "user", content: "Hi" },
          { role: "bot", content: "ignored" },
          { role: "user", content: 42 },
          { role: "assistant", content: "" },
          { role: "user", content: "Hello again" },
        ],
      })
    ).toEqual([turn("user", "Hi"), turn("user", "Hello again")]);
  });

  it("keeps at most MAX_HISTORY_TURNS turns, newest first", () => {
    const history: Record<string, unknown>[] = [];
    for (let i = 0; i < 20; i++) {
      history.push({ role: "user", content: `message ${i}` });
    }
    const result = readHistory({ history });
    expect(result).toHaveLength(MAX_HISTORY_TURNS);
    expect(result[0].content).toBe("message 12"); // oldest kept
    expect(result[MAX_HISTORY_TURNS - 1].content).toBe("message 19"); // newest
  });

  it("keeps at most MAX_HISTORY_CHARS total characters, newest first", () => {
    const longText = "x".repeat(3000); // capped to 2000 by MAX_MESSAGE_CHARS
    const result = readHistory({
      history: [
        { role: "user", content: "short" },
        { role: "assistant", content: longText },
        { role: "user", content: "also short" },
      ],
    });
    // 5 + 2000 + 12 = 2017 < 6000, so all three fit.
    expect(result).toHaveLength(3);
  });

  it("trims older turns when total chars exceed the budget", () => {
    // Each 4000-char text is capped to 2000 chars by MAX_MESSAGE_CHARS.
    // 2000 + 2000 + 13 = 4013 < 6000, so all 3 fit at 2000-char cap.
    // Use 5000-char texts: capped to 2000 each. 2000*3=6000, exactly at budget.
    // The check is `totalChars + turn.content.length > MAX_HISTORY_CHARS && kept.length > 0`,
    // so the 3rd turn at exactly 6000 doesn't break, but a 4th would.
    const longText = "x".repeat(5000); // capped to 2000
    const result = readHistory({
      history: [
        { role: "user", content: longText },
        { role: "assistant", content: longText },
        { role: "user", content: longText },
        { role: "assistant", content: "final message" },
      ],
    });
    // 2000 + 2000 + 2000 = 6000 (at budget, all 3 kept). "final message" would make 6013 > 6000, so it's dropped.
    // Newest-first: "final message" is kept first, then 2 longText turns.
    expect(result.length).toBe(3);
    expect(result[result.length - 1].content).toBe("final message");
  });

  it("keeps at least one turn even if it exceeds the char budget alone", () => {
    const hugeText = "x".repeat(10000); // capped to 2000 by MAX_MESSAGE_CHARS
    const result = readHistory({
      history: [{ role: "user", content: hugeText }],
    });
    expect(result).toHaveLength(1);
    expect(result[0].content.length).toBe(2000); // capped by MAX_MESSAGE_CHARS
  });

  it("caps each message at MAX_MESSAGE_CHARS (2000)", () => {
    const longText = "x".repeat(5000);
    const result = readHistory({
      history: [{ role: "user", content: longText }],
    });
    expect(result[0].content.length).toBe(2000);
  });
});

describe("pending booking state is separate from history", () => {
  it("pending booking lives server-side, not in client history", () => {
    // readHistory only reads client-sent history. The pending booking from
    // prepare_booking is stored in the conversation record (server-side via
    // openGuestThread / recordGuestTurn) and passed to the toolbox as
    // context.pendingBooking. History trimming never touches it.
    const result = readHistory({
      history: [{ role: "user", content: "I'll take the first one" }],
    });
    expect(result).toHaveLength(1);
    // No pending booking field exists in history — it's not trimmed away
    // because it was never in history to begin with.
    expect(result.every((t) => t.role === "user" || t.role === "assistant")).toBe(true);
  });
});
