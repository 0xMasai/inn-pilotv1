/**
 * The unified inbox's domain rules (pure; no emulator).
 */
import { NO_SIGNALS } from "../../src/lib/leadScoring";
import { describe, expect, it } from "vitest";
import {
  advanceBookingState,
  conversationStatus,
  selectedHotelLabel,
  channelCounts,
  leadCounts,
  CHANNELS,
  filterConversations,
  isConversationId,
  MOCK_CHANNELS,
  relativeTime,
  sampleThreads,
  snippet,
  sortConversations,
  toConversation,
  toMessage,
  type Conversation,
} from "../../src/lib/conversations";
import { newStaffEntries } from "../../src/lib/concierge";

const at = (iso: string) => new Date(iso);

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "c",
    channel: "web",
    guestName: "Web visitor",
    guestContact: "",
    handledBy: "ai",
    bookingStatus: "none",
    reservationId: "",
    lead: null,
    leadSignals: NO_SIGNALS,
    lastMessage: { role: "guest", text: "Hello", at: at("2031-01-01T10:00:00Z") },
    lastGuestAt: at("2031-01-01T10:00:00Z"),
    followUpSentAt: null,
    followUpSnoozedUntil: null,
    messageCount: 1,
    mock: false,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

describe("toConversation", () => {
  it("reads a stored conversation, with Firestore-style timestamps", () => {
    const stamp = { toDate: () => at("2031-01-01T10:00:00Z") };
    expect(
      toConversation("abc", {
        channel: "whatsapp",
        guestName: "Grace",
        handledBy: "human",
        bookingStatus: "quoted",
        lead: { score: "hot", reasons: ["asked for dates", 3] },
        lastMessage: { role: "staff", text: "Hi Grace", at: stamp },
        lastGuestAt: stamp,
        followUpSentAt: stamp,
        messageCount: 4,
        mock: true,
        updatedAt: stamp,
      })
    ).toMatchObject({
      id: "abc",
      channel: "whatsapp",
      guestName: "Grace",
      handledBy: "human",
      bookingStatus: "quoted",
      lead: { score: "hot", reasons: ["asked for dates"] },
      lastMessage: { role: "staff", text: "Hi Grace", at: at("2031-01-01T10:00:00Z") },
      lastGuestAt: at("2031-01-01T10:00:00Z"),
      followUpSentAt: at("2031-01-01T10:00:00Z"),
      followUpSnoozedUntil: null,
      messageCount: 4,
      mock: true,
    });
  });

  it("falls back safely for anything unknown or missing", () => {
    expect(toConversation("x", { channel: "telegram", handledBy: "robot", bookingStatus: "maybe", lead: { score: "lukewarm" } })).toMatchObject({
      channel: "web",
      guestName: "Web visitor",
      handledBy: "ai",
      bookingStatus: "none",
      lead: null,
      lastMessage: null,
      lastGuestAt: null,
      followUpSentAt: null,
      followUpSnoozedUntil: null,
      messageCount: 0,
      mock: false,
    });
  });

  it("reads a message", () => {
    expect(toMessage("m", { role: "staff", text: "Hi", at: 1_000 })).toEqual({ id: "m", role: "staff", text: "Hi", at: new Date(1_000) });
    expect(toMessage("m", { role: "system" }).role).toBe("guest");
  });
});

describe("booking progress", () => {
  it("only ever moves forward", () => {
    expect(advanceBookingState("none", "quoted")).toBe("quoted");
    expect(advanceBookingState("quoted", "booked")).toBe("booked");
    expect(advanceBookingState("booked", "none")).toBe("booked");
    expect(advanceBookingState("booked", "quoted")).toBe("booked");
    expect(advanceBookingState("quoted", "none")).toBe("quoted");
  });
});

describe("the inbox list", () => {
  const list = [
    conversation({ id: "old", channel: "email", guestName: "Daniel", lastMessage: { role: "guest", text: "Flowers please", at: at("2031-01-01T08:00:00Z") } }),
    conversation({ id: "new", channel: "whatsapp", guestName: "Grace", lastMessage: { role: "ai", text: "Double rooms are free", at: at("2031-01-01T12:00:00Z") } }),
    conversation({ id: "mid", channel: "web", reservationId: "RSV-20310101-ABCDEF", lastMessage: { role: "guest", text: "Book it", at: at("2031-01-01T10:00:00Z") } }),
    conversation({ id: "empty", channel: "instagram", guestName: "@sam", lastMessage: null }),
  ];

  it("sorts newest activity first, empty threads last", () => {
    expect(sortConversations(list).map((c) => c.id)).toEqual(["new", "mid", "old", "empty"]);
  });

  it("filters by channel", () => {
    expect(filterConversations(list, { channel: "email" }).map((c) => c.id)).toEqual(["old"]);
  });

  it("searches guest name, message and reservation reference, case-insensitively", () => {
    expect(filterConversations(list, { query: "grace" }).map((c) => c.id)).toEqual(["new"]);
    expect(filterConversations(list, { query: "FLOWERS" }).map((c) => c.id)).toEqual(["old"]);
    expect(filterConversations(list, { query: "rsv-2031" }).map((c) => c.id)).toEqual(["mid"]);
  });

  it("counts conversations per channel", () => {
    expect(channelCounts(list)).toEqual({ all: 4, web: 1, whatsapp: 1, instagram: 1, email: 1 });
  });

  const scored = [
    conversation({ id: "hot", lead: { score: "hot", reasons: ["Asked to book"] }, guestName: "Grace" }),
    conversation({ id: "vip", channel: "email", lead: { score: "vip", reasons: ["Booked a room"] } }),
    conversation({ id: "cold", lead: { score: "cold", reasons: [] } }),
    conversation({ id: "unscored", lead: null }),
  ];

  it("filters by lead score, and an unscored conversation is in none of them", () => {
    expect(filterConversations(scored, { lead: "hot" }).map((c) => c.id)).toEqual(["hot"]);
    expect(filterConversations(scored, { lead: "vip" }).map((c) => c.id)).toEqual(["vip"]);
    expect(filterConversations(scored, { lead: "warm" })).toEqual([]);
    expect(filterConversations(scored, { lead: "all" }).map((c) => c.id)).toHaveLength(4);
  });

  it("combines the lead filter with channel and search", () => {
    expect(filterConversations(scored, { lead: "vip", channel: "email" }).map((c) => c.id)).toEqual(["vip"]);
    expect(filterConversations(scored, { lead: "vip", channel: "web" })).toEqual([]);
    expect(filterConversations(scored, { lead: "hot", query: "grace" }).map((c) => c.id)).toEqual(["hot"]);
  });

  it("counts leads per score, counting unscored ones only in the total", () => {
    expect(leadCounts(scored)).toEqual({ all: 4, hot: 1, warm: 0, cold: 1, vip: 1 });
  });

  it("shortens a message for a row", () => {
    expect(snippet("  **Double**   rooms\nare free  ")).toBe("Double rooms are free");
    expect(snippet("x".repeat(200), 10)).toBe(`${"x".repeat(9)}…`);
  });

  it("gives compact relative times", () => {
    const now = at("2031-01-10T12:00:00Z");
    expect(relativeTime(at("2031-01-10T11:59:40Z"), now)).toBe("now");
    expect(relativeTime(at("2031-01-10T11:15:00Z"), now)).toBe("45m");
    expect(relativeTime(at("2031-01-10T07:00:00Z"), now)).toBe("5h");
    expect(relativeTime(at("2031-01-01T12:00:00Z"), now)).toBe("1 Jan");
    expect(relativeTime(null, now)).toBe("");
  });
});

describe("ids and samples", () => {
  it("accepts only 20-character auto-ids as conversation ids", () => {
    expect(isConversationId("AbCdEfGhIj0123456789")).toBe(true);
    for (const bad of ["short", "../hotels/abc/conversations", "AbCdEfGhIj012345678!", 42, null]) {
      expect(isConversationId(bad)).toBe(false);
    }
  });

  it("offers one sample thread per MOCKED channel, and none for web", () => {
    const threads = sampleThreads("Lakeside Inn");
    expect(threads.map((t) => t.conversation.channel).sort()).toEqual([...MOCK_CHANNELS].sort());
    expect(threads.every((t) => CHANNELS.includes(t.conversation.channel) && t.messages.length > 0)).toBe(true);
    // Oldest first, so the last message is the latest.
    for (const t of threads) {
      const ages = t.messages.map((m) => m.minutesAgo);
      expect([...ages].sort((a, b) => b - a)).toEqual(ages);
    }
    // Samples never quote a price, so they can't contradict the hotel's live rates.
    expect(JSON.stringify(threads)).not.toMatch(/UGX|KES|USD|\d{2,3},\d{3}/);
  });

  it("shows the three states a follow-up list sorts out (D21)", () => {
    const last = (channel: string) => {
      const thread = sampleThreads("Lakeside Inn").find((t) => t.conversation.channel === channel)!;
      return thread.messages[thread.messages.length - 1];
    };
    // Just written: nobody is late yet.
    expect(last("whatsapp")).toMatchObject({ role: "guest" });
    expect(last("whatsapp").minutesAgo).toBeLessThan(60);
    // Answered, then silence: an interested guest who went quiet.
    expect(last("instagram")).toMatchObject({ role: "staff" });
    expect(last("instagram").minutesAgo).toBeGreaterThan(24 * 60);
    // Asked hours ago and still waiting on the hotel.
    expect(last("email")).toMatchObject({ role: "guest" });
    expect(last("email").minutesAgo).toBeGreaterThan(60);
  });
});

describe("staff replies on the guest page", () => {
  const update = {
    handledBy: "human" as const,
    messages: [
      { id: "g1", role: "guest" as const, text: "Hi", at: 100 },
      { id: "s1", role: "staff" as const, text: "Hello, Ruth here", at: 200 },
      { id: "s2", role: "staff" as const, text: "How can I help?", at: 300 },
    ],
  };

  it("shows only staff messages not yet on screen, and advances the cursor to the newest server time", () => {
    const first = newStaffEntries(update, [], 0);
    expect(first.entries.map((e) => [e.id, e.from, e.role])).toEqual([
      ["s1", "staff", "assistant"],
      ["s2", "staff", "assistant"],
    ]);
    expect(first.after).toBe(300);
  });

  it("never shows the same reply twice", () => {
    const shown = newStaffEntries(update, [], 0).entries;
    expect(newStaffEntries(update, shown, 0).entries).toEqual([]);
  });

  it("keeps the cursor when nothing new arrived", () => {
    expect(newStaffEntries({ handledBy: "human", messages: [] }, [], 450).after).toBe(450);
  });
});

describe("conversation status (D29)", () => {
  const base = { bookingStatus: "none", closed: false, bookedElsewhere: false, selection: "none" } as const;

  it.each([
    [{}, "new"],
    [{ bookingStatus: "quoted" }, "active"],
    [{ selection: "this" }, "active"],
    [{ bookingStatus: "booked" }, "booked"],
    [{ bookingStatus: "quoted", bookedElsewhere: true, selection: "other" }, "closed"],
    [{ bookingStatus: "quoted", closed: true }, "closed"],
    // Booked here stays Booked even if staff close it.
    [{ bookingStatus: "booked", closed: true }, "booked"],
  ] as const)("%o is %s", (change, expected) => {
    expect(conversationStatus({ ...base, ...change })).toBe(expected);
  });

  it("names the chosen hotel from this hotel's point of view", () => {
    expect(selectedHotelLabel({ selection: "this", selectedHotelName: "K Hotels Kabale" }, "K Hotels Kabale")).toBe("K Hotels Kabale");
    expect(selectedHotelLabel({ selection: "other", selectedHotelName: "K Hotels Kabale" }, "K Hotels Mbarara")).toBe("K Hotels Kabale");
    expect(selectedHotelLabel({ selection: "none", selectedHotelName: "" }, "K Hotels Mbarara")).toBe("");
  });

  it("reads mirror fields safely from any document", () => {
    expect(toConversation("x", { selection: "bogus", closed: "yes" })).toMatchObject({
      selection: "none",
      closed: false,
      bookedElsewhere: false,
      selectedHotelName: "",
    });
  });
});
