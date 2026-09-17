/**
 * Lead scoring (Phase 5, DECISIONS D20).
 *
 * The rules are deterministic, so these tests are the specification: what a
 * guest has to say or do to reach each score, and what staff are told about
 * why. Nothing here touches Firestore or a model.
 */
import { describe, expect, it } from "vitest";

import { NO_SIGNALS, bookingSignals, detectSignals, mergeSignals, scoreLead, toLeadSignals } from "../../src/lib/leadScoring";
import type { ConversationBookingState } from "../../src/lib/conversations";

const score = (text: string, bookingStatus: ConversationBookingState = "none") =>
  scoreLead({ bookingStatus, signals: mergeSignals(NO_SIGNALS, detectSignals(text)) });

describe("reading a guest's message", () => {
  it("sees a request to book", () => {
    for (const text of ["I'd like to book a room", "Please reserve it for me", "I'll take the double", "Can you hold the room?"]) {
      expect(detectSignals(text).askedToBook, text).toBe(true);
    }
    expect(detectSignals("Is breakfast included?").askedToBook).toBe(false);
  });

  it("sees dates, however they're written", () => {
    for (const text of [
      "from 2031-06-10 to 2031-06-12",
      "arriving on the 20th",
      "next Friday",
      "this weekend",
      "in December",
      "for three nights",
      "for 3 nights",
    ]) {
      expect(detectSignals(text).gaveDates, text).toBe(true);
    }
    expect(detectSignals("Do you have a pool?").gaveDates).toBe(false);
  });

  it("sees a price question", () => {
    expect(detectSignals("How much is a double?").askedPrice).toBe(true);
    expect(detectSignals("What are your rates?").askedPrice).toBe(true);
    expect(detectSignals("Where are you located?").askedPrice).toBe(false);
  });

  it("sees contact details, but not a date mistaken for a phone number", () => {
    expect(detectSignals("Call me on +256 772 555 010").gaveContact).toBe(true);
    expect(detectSignals("daniel.otieno@example.com works").gaveContact).toBe(true);
    expect(detectSignals("Is a Suite available from 2031-06-10 to 2031-06-12 for 2 guests?").gaveContact).toBe(false);
    expect(detectSignals("A room for 2 people").gaveContact).toBe(false);
  });

  it("sees a stay worth a person's attention", () => {
    for (const text of ["a team retreat for 12 people", "we need 6 rooms", "staying for 5 nights", "a group of 20", "for a month"]) {
      expect(detectSignals(text).bigStay, text).toBe(true);
    }
    expect(detectSignals("a room for 2 people for 1 night").bigStay).toBe(false);
  });

  it("sees a suite and an occasion", () => {
    expect(detectSignals("Do you have a suite?").premium).toBe(true);
    expect(detectSignals("It's our anniversary").occasion).toBe(true);
    expect(detectSignals("A single room please").premium).toBe(false);
  });

  it("counts the guest's messages and never reads the hotel's", () => {
    expect(detectSignals("Hi").guestMessages).toBe(1);
  });
});

describe("signals accumulate", () => {
  it("keeps what an earlier message showed and adds up the guest's turns", () => {
    const first = mergeSignals(NO_SIGNALS, detectSignals("What are your rates?"));
    const second = mergeSignals(first, detectSignals("Do you have a pool?"));
    expect(second).toMatchObject({ askedPrice: true, guestMessages: 2 });
  });

  it("a confirmed booking speaks for itself", () => {
    const signals = bookingSignals({ nights: 3, guests: 2, roomType: "Suite" });
    expect(signals).toMatchObject({ sawAvailability: true, askedToBook: true, gaveDates: true, bigStay: true, premium: true });
    expect(bookingSignals({ nights: 1, guests: 2, roomType: "Double" })).toMatchObject({ bigStay: false, premium: false });
  });

  it("reads stored signals, ignoring anything malformed", () => {
    expect(toLeadSignals({ askedPrice: true, guestMessages: 3, nonsense: true })).toMatchObject({ askedPrice: true, guestMessages: 3 });
    expect(toLeadSignals(null)).toEqual(NO_SIGNALS);
    expect(toLeadSignals({ askedPrice: "yes", guestMessages: -2 })).toEqual(NO_SIGNALS);
  });
});

describe("the score", () => {
  it("⭐ VIP: booked a stay to look after by hand", () => {
    const suite = scoreLead({ bookingStatus: "booked", signals: bookingSignals({ nights: 3, guests: 2, roomType: "Suite" }) });
    expect(suite.score).toBe("vip");
    expect(suite.reasons).toContain("Booked a room");
    expect(suite.reasons).toContain("Wants a suite or an upgrade");
  });

  it("🔥 Hot: booked an ordinary stay", () => {
    expect(scoreLead({ bookingStatus: "booked", signals: bookingSignals({ nights: 1, guests: 2, roomType: "Double" }) }).score).toBe("hot");
  });

  it("🔥 Hot: asked to book", () => {
    expect(score("I'd like to book a room for next Friday").score).toBe("hot");
  });

  it("🔥 Hot: saw availability and left a number", () => {
    const signals = mergeSignals(mergeSignals(NO_SIGNALS, detectSignals("Call me on 0772 555 010")), { sawAvailability: true });
    expect(scoreLead({ bookingStatus: "quoted", signals }).score).toBe("hot");
  });

  it("🔥 Hot: a group enquiry already talking dates or money", () => {
    expect(score("We're planning a team retreat for 12 people in December. Can you do a group rate?").score).toBe("hot");
  });

  it("🌤 Warm: interested, but nothing committing yet", () => {
    expect(score("What do your rooms cost?").score).toBe("warm");
    expect(score("Do you have anything next weekend?").score).toBe("warm");
    expect(scoreLead({ bookingStatus: "quoted", signals: mergeSignals(NO_SIGNALS, { sawAvailability: true }) }).score).toBe("warm");
  });

  it("❄ Cold: general questions only", () => {
    const cold = score("Do you have parking and wifi?");
    expect(cold.score).toBe("cold");
    expect(cold.reasons).toEqual(["General questions only so far"]);
  });

  it("says why, in what staff can read, and never runs on", () => {
    const signals = mergeSignals(
      mergeSignals(NO_SIGNALS, detectSignals("Our anniversary, a suite for 4 people for 5 nights, my number is 0772555010, how much?")),
      { sawAvailability: true }
    );
    const assessment = scoreLead({ bookingStatus: "booked", signals });
    expect(assessment.score).toBe("vip");
    expect(assessment.reasons.length).toBeLessThanOrEqual(8);
    expect(assessment.reasons).toEqual([
      "Booked a room",
      "Wants a suite or an upgrade",
      "Group, event or long stay",
      "Travelling for a special occasion",
      "Asked about prices",
      "Left contact details",
    ]);
  });

  it("is the same every time, for the same conversation", () => {
    const text = "Suite for our honeymoon, 3 nights from the 20th";
    expect(score(text)).toEqual(score(text));
  });

  it("scores a conversation with nothing in it as cold", () => {
    expect(scoreLead({ bookingStatus: "none", signals: NO_SIGNALS })).toEqual({ score: "cold", reasons: ["No guest messages yet"] });
  });
});
