/**
 * Follow-ups (Phase 6, DECISIONS D21).
 *
 * The rules are deterministic, so these tests are the specification: who
 * ends up on the follow-up list, how long they have to have been left, when
 * a guest must NOT be chased again, and what the suggested message may say.
 * Nothing here touches Firestore or a model.
 */
import { describe, expect, it } from "vitest";

import { NO_SIGNALS, type LeadSignals } from "../../src/lib/leadScoring";
import { WEB_GUEST_NAME, type Conversation, type LeadScore, type MessageRole } from "../../src/lib/conversations";
import {
  draftFollowUp,
  dueFollowUp,
  FOLLOW_UP_AFTER_HOURS,
  MAX_FOLLOW_UP_TEXT,
  needsFollowUp,
  QUIET_AFTER_HOURS,
  waitedLabel,
} from "../../src/lib/followUps";

const NOW = new Date("2031-06-10T12:00:00Z");
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);

function conversation({
  score = "warm" as LeadScore | null,
  lastRole = "guest" as MessageRole,
  lastHoursAgo = 0,
  signals = { ...NO_SIGNALS, guestMessages: 2 } as LeadSignals,
  ...rest
}: Partial<Conversation> & {
  score?: LeadScore | null;
  lastRole?: MessageRole;
  lastHoursAgo?: number;
  signals?: LeadSignals;
} = {}): Conversation {
  return {
    id: "c1",
    channel: "whatsapp",
    guestName: "Grace Namusoke",
    guestContact: "+256 772 555 010",
    handledBy: "ai",
    bookingStatus: "none",
    reservationId: "",
    lead: score ? { score, reasons: ["Gave dates"] } : null,
    leadSignals: signals,
    lastMessage: { role: lastRole, text: "Hello", at: hoursAgo(lastHoursAgo) },
    lastGuestAt: lastRole === "guest" ? hoursAgo(lastHoursAgo) : hoursAgo(lastHoursAgo + 1),
    followUpSentAt: null,
    followUpSnoozedUntil: null,
    messageCount: 3,
    mock: true,
    createdAt: hoursAgo(lastHoursAgo + 2),
    updatedAt: hoursAgo(lastHoursAgo),
    ...rest,
  };
}

describe("a guest left waiting for a reply", () => {
  it("is chased once the wait passes the threshold for how hot they are", () => {
    for (const [score, threshold] of Object.entries(FOLLOW_UP_AFTER_HOURS) as [LeadScore, number][]) {
      const justBefore = dueFollowUp(conversation({ score, lastHoursAgo: threshold - 0.1 }), NOW);
      const justAfter = dueFollowUp(conversation({ score, lastHoursAgo: threshold + 0.1 }), NOW);
      expect(justBefore, `${score} before`).toBeNull();
      expect(justAfter?.kind, `${score} after`).toBe("waiting");
    }
  });

  it("says how long they have been waiting", () => {
    expect(dueFollowUp(conversation({ score: "hot", lastHoursAgo: 5 }), NOW)?.reason).toBe("Waiting 5h for a reply");
    expect(dueFollowUp(conversation({ score: "hot", lastHoursAgo: 70 }), NOW)?.reason).toBe("Waiting 2 days for a reply");
  });

  it("measures the wait from when the guest wrote, not from the thread's last change", () => {
    const retried = conversation({ score: "hot", lastHoursAgo: 0.2, lastGuestAt: hoursAgo(6) });
    expect(dueFollowUp(retried, NOW)?.reason).toBe("Waiting 6h for a reply");
  });

  it("chases a booked guest too: an unanswered question is unanswered", () => {
    const booked = conversation({ score: "vip", bookingStatus: "booked", reservationId: "RSV-1", lastHoursAgo: 5 });
    expect(dueFollowUp(booked, NOW)?.kind).toBe("waiting");
  });

  it("leaves a conversation with nothing in it alone", () => {
    expect(dueFollowUp(conversation({ lastMessage: null }), NOW)).toBeNull();
  });
});

describe("an interested guest who went quiet", () => {
  const quiet = (over: Partial<Conversation> & { score?: LeadScore | null; lastHoursAgo?: number } = {}) =>
    conversation({ score: "hot", lastRole: "staff", lastHoursAgo: QUIET_AFTER_HOURS + 6, ...over });

  it("is chased a day after the hotel's last word", () => {
    expect(dueFollowUp(quiet(), NOW)?.kind).toBe("quiet");
    expect(dueFollowUp(quiet({ lastHoursAgo: QUIET_AFTER_HOURS - 1 }), NOW)).toBeNull();
    expect(dueFollowUp(quiet(), NOW)?.reason).toBe("Interested, quiet for 30h");
  });

  it("is only chased when there was something to convert", () => {
    expect(dueFollowUp(quiet({ score: "cold" }), NOW)).toBeNull();
    expect(dueFollowUp(quiet({ score: null }), NOW)).toBeNull();
    expect(dueFollowUp(quiet({ bookingStatus: "booked" }), NOW)).toBeNull();
    expect(dueFollowUp(quiet({ leadSignals: NO_SIGNALS }), NOW)).toBeNull();
  });

  it("is not chased twice over: not until they write back", () => {
    const chased = quiet({ followUpSentAt: hoursAgo(20), lastGuestAt: hoursAgo(40) });
    expect(dueFollowUp(chased, NOW)).toBeNull();
    const answeredSince = quiet({ followUpSentAt: hoursAgo(40), lastGuestAt: hoursAgo(30) });
    expect(dueFollowUp(answeredSince, NOW)?.kind).toBe("quiet");
  });
});

describe("putting a follow-up off", () => {
  it("keeps it off the list until the snooze runs out", () => {
    const waiting = conversation({ score: "hot", lastHoursAgo: 5 });
    expect(dueFollowUp({ ...waiting, followUpSnoozedUntil: new Date(NOW.getTime() + 3_600_000) }, NOW)).toBeNull();
    expect(dueFollowUp({ ...waiting, followUpSnoozedUntil: hoursAgo(1) }, NOW)?.kind).toBe("waiting");
  });
});

describe("the order to work down", () => {
  it("is hottest first, then whoever has been left longest", () => {
    const list = [
      conversation({ id: "warm-2d", score: "warm", lastHoursAgo: 48 }),
      conversation({ id: "hot-3h", score: "hot", lastHoursAgo: 3 }),
      conversation({ id: "vip-2h", score: "vip", lastHoursAgo: 2, bookingStatus: "booked" }),
      conversation({ id: "hot-20h", score: "hot", lastHoursAgo: 20 }),
      conversation({ id: "nothing-due", score: "warm", lastHoursAgo: 0.1 }),
    ];
    expect(needsFollowUp(list, NOW).map((c) => c.id)).toEqual(["vip-2h", "hot-20h", "hot-3h", "warm-2d"]);
  });

  it("reads a wait the way a person would", () => {
    expect([waitedLabel(0.2), waitedLabel(3.7), waitedLabel(47), waitedLabel(52)]).toEqual(["1h", "3h", "47h", "2 days"]);
  });
});

describe("the suggested message", () => {
  const hotel = "Lakeside Inn & Spa";

  it("greets the guest by name and comes from the hotel", () => {
    expect(draftFollowUp(conversation(), hotel, "waiting")).toContain("Hi Grace, Lakeside Inn & Spa here");
    expect(draftFollowUp(conversation({ guestName: "@safari.sam" }), hotel, "quiet")).toContain("Hi Safari");
    expect(draftFollowUp(conversation({ guestName: WEB_GUEST_NAME }), hotel, "quiet")).toContain("Hi there");
  });

  it("refers to what the guest themselves asked about", () => {
    const about = (signals: Partial<LeadSignals>) =>
      draftFollowUp(conversation({ signals: { ...NO_SIGNALS, guestMessages: 1, ...signals } }), hotel, "quiet");
    expect(about({ premium: true })).toContain("the suite");
    expect(about({ bigStay: true })).toContain("your group");
    expect(about({ occasion: true })).toContain("your celebration");
    expect(about({ gaveDates: true })).toContain("the dates you mentioned");
    expect(about({ askedPrice: true })).toContain("our rates");
    expect(about({})).toContain("your enquiry");
  });

  it("promises nothing the hotel would have to honour", () => {
    for (const kind of ["waiting", "quiet"] as const) {
      const draft = draftFollowUp(conversation({ signals: { ...NO_SIGNALS, guestMessages: 1, askedPrice: true } }), hotel, kind);
      // No rate, no room number, no date: a follow-up offers to check, it doesn't quote.
      expect(draft, kind).not.toMatch(/\d/);
      expect(draft.length, kind).toBeLessThanOrEqual(MAX_FOLLOW_UP_TEXT);
    }
  });

  it("apologises for a wait, and asks a quiet guest whether they are still coming", () => {
    expect(draftFollowUp(conversation(), hotel, "waiting")).toContain("sorry to keep you waiting");
    expect(draftFollowUp(conversation(), hotel, "quiet")).toContain("are you still planning the trip?");
  });

  it("reassures a guest who has already booked", () => {
    const booked = conversation({ guestName: "Daniel Otieno", bookingStatus: "booked", reservationId: "RSV-SAMPLE-EMAIL1" });
    expect(draftFollowUp(booked, hotel, "waiting")).toContain("Your booking RSV-SAMPLE-EMAIL1 is confirmed");
  });

  it("is the same every time, for the same conversation", () => {
    expect(draftFollowUp(conversation(), hotel, "quiet")).toBe(draftFollowUp(conversation(), hotel, "quiet"));
  });
});
