/**
 * The guest concierge's browser helpers (pure; no emulator, no network).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chooseOptionMessage,
  chooseRoomTypeMessage,
  ConciergeError,
  fetchThreadUpdates,
  stayRange,
  historyOf,
  parseReply,
  sendConciergeMessage,
  stayDay,
  fetchConciergeHotel,
} from "../../src/lib/concierge";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseReply", () => {
  it("keeps plain sentences as one paragraph", () => {
    expect(parseReply("We have rooms.\nWhat dates?")).toEqual([
      {
        kind: "paragraph",
        spans: [
          { text: "We have rooms.", bold: false },
          { text: " ", bold: false },
          { text: "What dates?", bold: false },
        ],
      },
    ]);
  });

  it("splits paragraphs on blank lines and groups bullets into a list", () => {
    const blocks = parseReply("Here are the options:\n\n- **Double** from UGX 220,000\n* Suite: UGX 420,000\n\nWhich one?");
    expect(blocks).toEqual([
      { kind: "paragraph", spans: [{ text: "Here are the options:", bold: false }] },
      {
        kind: "list",
        items: [
          [
            { text: "Double", bold: true },
            { text: " from UGX 220,000", bold: false },
          ],
          [{ text: "Suite: UGX 420,000", bold: false }],
        ],
      },
      { kind: "paragraph", spans: [{ text: "Which one?", bold: false }] },
    ]);
  });

  it("never produces markup: angle brackets stay text", () => {
    const blocks = parseReply("<img src=x onerror=alert(1)> **<b>hi</b>**");
    expect(JSON.stringify(blocks)).toContain("<img src=x onerror=alert(1)>");
    expect(blocks[0]).toMatchObject({ kind: "paragraph" });
  });

  it("drops stray bold markers and heading hashes", () => {
    expect(parseReply("## Rooms\n**unclosed")).toEqual([
      { kind: "paragraph", spans: [{ text: "Rooms", bold: false }, { text: " ", bold: false }, { text: "unclosed", bold: false }] },
    ]);
  });
});

describe("messages the buttons send", () => {
  it("chooses a search option in the guest's own words, with no room number", () => {
    expect(chooseOptionMessage({ optionNumber: 1, roomType: "Double", hotelName: "K Hotels Kabale" })).toBe(
      "I'll take option 1: the Double at K Hotels Kabale."
    );
  });

  it("chooses a room type at one hotel", () => {
    expect(chooseRoomTypeMessage("Family", "K Hotels Jinja")).toBe("I'll take the Family at K Hotels Jinja.");
  });
});

describe("stayRange", () => {
  it("reads as calendar days", () => {
    expect(stayRange("2031-10-10", "2031-10-15")).toBe("10 Oct – 15 Oct 2031");
  });
});

describe("stayDay", () => {
  it("reads a stay date as a calendar day, whatever the timezone", () => {
    expect(stayDay("2031-06-01")).toBe("Sun, 1 Jun 2031");
  });
});

describe("historyOf", () => {
  it("leaves out a message that never got an answer", () => {
    expect(
      historyOf([
        { id: "1", role: "user", text: "Rooms?", failed: true },
        { id: "2", role: "user", text: "Rooms please?" },
      ])
    ).toEqual([{ role: "user", content: "Rooms please?" }]);
  });

  it("sends text turns only, never cards", () => {
    expect(
      historyOf([
        { id: "1", role: "user", text: "Rooms?" },
        { id: "2", role: "assistant", text: "Yes.", booking: { reservationId: "RSV" } as never },
      ])
    ).toEqual([
      { role: "user", content: "Rooms?" },
      { role: "assistant", content: "Yes." },
    ]);
  });
});

describe("the API client", () => {
  it("posts the message and at most 12 history turns, with no hotel for the network concierge", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ reply: "Hi", model: "m", requestId: "r" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const history = Array.from({ length: 14 }, (_, i) => ({ role: "user" as const, content: `m${i}` }));

    await sendConciergeMessage("Hello", history);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/ai/concierge");
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({ message: "Hello", history: expect.any(Array) });
    expect(body.history).toHaveLength(12);
    expect(body.history[0].content).toBe("m2");
  });

  it("sends the hotel's public id, conversation and turn id when given", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ reply: "Hi", model: "m", requestId: "r" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await sendConciergeMessage("Hello", [], { publicHotelId: "lakeside-inn-a1b2c3d4", conversationId: "C".repeat(20), turnId: "t1" });
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body).toMatchObject({ publicHotelId: "lakeside-inn-a1b2c3d4", conversationId: "C".repeat(20), turnId: "t1" });
  });

  it("polls a thread with its scope only when it has one", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ handledBy: "ai", messages: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await fetchThreadUpdates("C".repeat(20), 5);
    await fetchThreadUpdates("C".repeat(20), 5, "lakeside-inn-a1b2c3d4");
    const urls = fetchMock.mock.calls.map((call) => String((call as unknown as [string])[0]));
    expect(urls[0]).toBe(`/api/ai/conversation?conversationId=${"C".repeat(20)}&after=5`);
    expect(urls[1]).toContain("publicHotelId=lakeside-inn-a1b2c3d4");
  });

  it("keeps a booking the server made even when the reply failed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "Try again.", code: "unavailable", booking: { reservationId: "RSV-1" } }), { status: 503 }))
    );
    await expect(sendConciergeMessage("Yes", [])).rejects.toMatchObject({ code: "unavailable", booking: { reservationId: "RSV-1" } });
  });

  it("surfaces the server's guest-facing error and marks bad hotels as not retryable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "I'm not sure which hotel this chat belongs to.", code: "invalid_request" }), { status: 400 }))
    );
    const error = await fetchConciergeHotel("nope-hotel-00000000").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConciergeError);
    expect(error).toMatchObject({ message: "I'm not sure which hotel this chat belongs to.", code: "invalid_request", retryable: false });
  });

  it("turns a timeout into a retryable error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "That took longer than expected.", code: "timeout" }), { status: 504 }))
    );
    await expect(sendConciergeMessage("hi", [])).rejects.toMatchObject({ code: "timeout", retryable: true });
  });

  it("gives a readable message when the network or the body fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    await expect(sendConciergeMessage("hi", [])).rejects.toMatchObject({ code: "network", retryable: true });

    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>502</html>", { status: 502 })));
    const error = (await sendConciergeMessage("hi", []).catch((e: unknown) => e)) as ConciergeError;
    expect(error.code).toBe("http_502");
    expect(error.message).toMatch(/can't reach the concierge/);
  });
});
