/**
 * Lead scoring — how close a guest is to booking, worked out from what they
 * actually said and did.
 *
 * Deterministic on purpose: the same conversation always scores the same,
 * a hotel can be told exactly why, and it costs no model call (DECISIONS
 * D20). Nothing here guesses — every reason shown to staff comes from a
 * signal the guest gave.
 *
 * Signals accumulate on the conversation as it goes, so a guest who gave
 * dates ten messages ago is still a guest who gave dates. Scoring reads
 * those signals plus how far the booking got.
 *
 * Pure — no Firestore import — so the app, the server and the tests share
 * one definition. Keep `lead` in sync with firestore.rules.
 */
import type { ConversationBookingState, LeadAssessment, LeadScore } from "./conversations.js";

/**
 * What a guest has shown so far. Booleans only ever turn on: a conversation
 * doesn't become less interested by talking about something else.
 */
export interface LeadSignals {
  /** How many messages the guest has sent. */
  guestMessages: number;
  /** The concierge showed them real rooms for real dates. */
  sawAvailability: boolean;
  /** They asked to book, reserve or hold a room. */
  askedToBook: boolean;
  /** They named dates or a stay. */
  gaveDates: boolean;
  /** They asked what it costs. */
  askedPrice: boolean;
  /** They left a phone number or an email address. */
  gaveContact: boolean;
  /** A group, an event, or a long stay: worth a person's attention. */
  bigStay: boolean;
  /** A honeymoon, anniversary or birthday. */
  occasion: boolean;
  /** They're after a suite or the best room. */
  premium: boolean;
}

export const NO_SIGNALS: LeadSignals = {
  guestMessages: 0,
  sawAvailability: false,
  askedToBook: false,
  gaveDates: false,
  askedPrice: false,
  gaveContact: false,
  bigStay: false,
  occasion: false,
  premium: false,
};

/** Guests count as a group — and a group is worth a person's attention — from here up. */
export const GROUP_GUESTS = 4;
/** Nights that make a stay a long one. */
export const LONG_STAY_NIGHTS = 3;
/** Reasons kept on a conversation. Mirrors the cap in firestore.rules. */
export const MAX_LEAD_REASONS = 8;

/* ------------------------------------------------------------------ */
/* Reading what the guest wrote                                         */
/* ------------------------------------------------------------------ */

const BOOK_WORDS =
  /\b(book|booking|reserve|reservation|i'?ll take|we'?ll take|hold (the|a|my) room|confirm (the|my|it)|sign me up)\b/;
const PRICE_WORDS = /\b(price|prices|pricing|cost|costs|rate|rates|how much|charge|per night|discount|deal|offer|budget|cheaper)\b/;
const PREMIUM_WORDS = /\b(suite|executive|deluxe|presidential|penthouse|best room|luxury|luxurious|upgrade)\b/;
const OCCASION_WORDS = /\b(honeymoon|anniversary|birthday|wedding|celebration|celebrating|proposal|graduation)\b/;
const GROUP_WORDS = /\b(group|groups|retreat|conference|delegation|team building|corporate|event|block of rooms|our team|colleagues)\b/;
const LONG_STAY_WORDS = /\b(a month|whole month|long stay|extended stay|(\d+)\s*weeks?)\b/;

const MONTHS =
  /\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|jun(e)?|jul(y)?|aug(ust)?|sep(t|tember)?|oct(ober)?|nov(ember)?|dec(ember)?)\b/;
const WEEKDAYS = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/;
const RELATIVE_DAYS = /\b(today|tonight|tomorrow|this (weekend|week|month)|next (weekend|week|month)|over the weekend)\b/;
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/;
const ISO_DATE_ALL = /\b\d{4}-\d{2}-\d{2}\b/g;
/** "on the 20th", "from the 3rd". */
const DAY_OF_MONTH = /\b(the )?\d{1,2}(st|nd|rd|th)\b/;
const NIGHTS = /\b(\d+)\s*nights?\b/;

const EMAIL = /[^\s@]+@[^\s@]+\.[a-z]{2,}/;
/** A run of digits a guest could be phoned on, however they space it. */
const PHONE = /\+?\d[\d\s()-]{6,}\d/;

/**
 * A phone number, not a date. "2031-06-10" is digits and dashes too, and a
 * guest typing dates isn't leaving a number to call back on.
 */
function hasPhone(text: string): boolean {
  const match = PHONE.exec(text.replace(ISO_DATE_ALL, " "));
  return match !== null && match[0].replace(/\D/g, "").length >= 9;
}

const GUEST_COUNT = /\b(\d{1,3})\s*(people|persons|guests|adults|pax|of us|rooms)\b/;
const GROUP_OF = /\bgroup of\s*(\d{1,3})\b/;

/** Guests write "three nights" as often as "3 nights". */
const WORD_NUMBERS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  a: 1,
  an: 1,
  "a couple of": 2,
  "a few": 3,
  several: 3,
};
const WORDS = Object.keys(WORD_NUMBERS).join("|");
const NIGHTS_IN_WORDS = new RegExp(`\\b(${WORDS})\\s+nights?\\b`);
const GUESTS_IN_WORDS = new RegExp(`\\b(?:group of\\s+)?(${WORDS})\\s+(?:people|persons|guests|adults|of us|rooms)\\b`);

function countFrom(text: string, pattern: RegExp): number {
  const match = pattern.exec(text);
  if (!match) return 0;
  return Number(match[1]) || WORD_NUMBERS[match[1]] || 0;
}

/**
 * The signals in one guest message. Staff and AI messages are never read:
 * a lead is what the guest showed, not what the hotel said.
 */
export function detectSignals(text: string): LeadSignals {
  const t = text.toLowerCase();
  const guests = Math.max(countFrom(t, GUEST_COUNT), countFrom(t, GROUP_OF), countFrom(t, GUESTS_IN_WORDS));
  const nights = Math.max(countFrom(t, NIGHTS), countFrom(t, NIGHTS_IN_WORDS));

  return {
    guestMessages: 1,
    sawAvailability: false,
    askedToBook: BOOK_WORDS.test(t),
    gaveDates:
      ISO_DATE.test(t) || MONTHS.test(t) || WEEKDAYS.test(t) || RELATIVE_DAYS.test(t) || DAY_OF_MONTH.test(t) || nights > 0,
    askedPrice: PRICE_WORDS.test(t),
    gaveContact: EMAIL.test(text) || hasPhone(text),
    bigStay: guests >= GROUP_GUESTS || nights >= LONG_STAY_NIGHTS || GROUP_WORDS.test(t) || LONG_STAY_WORDS.test(t),
    occasion: OCCASION_WORDS.test(t),
    premium: PREMIUM_WORDS.test(t),
  };
}

/** Signals from a confirmed booking, which speaks louder than anything typed. */
export function bookingSignals({
  nights = 0,
  guests = 0,
  roomType = "",
}: {
  nights?: number;
  guests?: number;
  roomType?: string;
}): LeadSignals {
  return {
    ...NO_SIGNALS,
    sawAvailability: true,
    askedToBook: true,
    gaveDates: true,
    bigStay: guests >= GROUP_GUESTS || nights >= LONG_STAY_NIGHTS,
    premium: PREMIUM_WORDS.test(roomType.toLowerCase()),
  };
}

/** Everything seen so far, plus what this turn showed. Counts add; the rest only turn on. */
export function mergeSignals(current: LeadSignals, next: Partial<LeadSignals>): LeadSignals {
  const merged = { ...current };
  for (const key of Object.keys(NO_SIGNALS) as (keyof LeadSignals)[]) {
    if (key === "guestMessages") merged.guestMessages = current.guestMessages + (next.guestMessages ?? 0);
    else if (next[key]) merged[key] = true;
  }
  return merged;
}

/** Signals as stored, with anything missing or malformed treated as not shown. */
export function toLeadSignals(value: unknown): LeadSignals {
  if (!value || typeof value !== "object") return NO_SIGNALS;
  const data = value as Record<string, unknown>;
  const signals = { ...NO_SIGNALS };
  for (const key of Object.keys(NO_SIGNALS) as (keyof LeadSignals)[]) {
    if (key === "guestMessages") {
      signals.guestMessages = typeof data.guestMessages === "number" && data.guestMessages > 0 ? Math.floor(data.guestMessages) : 0;
    } else if (data[key] === true) {
      signals[key] = true;
    }
  }
  return signals;
}

/* ------------------------------------------------------------------ */
/* Scoring                                                              */
/* ------------------------------------------------------------------ */

export interface LeadInput {
  bookingStatus: ConversationBookingState;
  signals: LeadSignals;
}

/**
 * The rules, in order. The first score that fits wins, so read them
 * top-down:
 *
 *   ⭐ VIP   booked, and the stay is one the hotel should look after by
 *            hand: a suite, a group, a long stay or a special occasion.
 *   🔥 Hot   booked; or ready to book — asked to book, or saw real
 *            availability and left contact details; or a group enquiry
 *            already talking dates or money.
 *   🌤 Warm  interested: saw availability, gave dates, asked prices or
 *            asked to book without the rest.
 *   ❄ Cold  everything else — general questions, nothing committing.
 */
export function scoreLead({ bookingStatus, signals }: LeadInput): LeadAssessment {
  const booked = bookingStatus === "booked";
  const reasons: string[] = [];
  const add = (reason: string) => {
    if (reasons.length < MAX_LEAD_REASONS) reasons.push(reason);
  };

  if (booked) add("Booked a room");
  if (signals.premium) add("Wants a suite or an upgrade");
  if (signals.bigStay) add("Group, event or long stay");
  if (signals.occasion) add("Travelling for a special occasion");
  if (signals.askedToBook && !booked) add("Asked to book");
  if (signals.sawAvailability && !booked) add("Saw live availability");
  if (signals.gaveDates && !booked) add("Gave dates");
  if (signals.askedPrice) add("Asked about prices");
  if (signals.gaveContact) add("Left contact details");

  const score: LeadScore = booked
    ? signals.premium || signals.bigStay || signals.occasion
      ? "vip"
      : "hot"
    : signals.askedToBook ||
        (signals.sawAvailability && signals.gaveContact) ||
        (signals.bigStay && (signals.gaveDates || signals.askedPrice))
      ? "hot"
      : signals.sawAvailability || signals.gaveDates || signals.askedPrice
        ? "warm"
        : "cold";

  if (reasons.length === 0) {
    add(signals.guestMessages > 0 ? "General questions only so far" : "No guest messages yet");
  }
  return { score, reasons };
}

/** The badge's face: the whole point is that staff can read the inbox at a glance. */
export const LEAD_EMOJI: Record<LeadScore, string> = {
  hot: "🔥",
  warm: "🌤",
  cold: "❄",
  vip: "⭐",
};

/** What each score means, for the filter's tooltip and the thread header. */
export const LEAD_MEANING: Record<LeadScore, string> = {
  vip: "Booked a stay worth looking after by hand",
  hot: "Ready to book, or already booked",
  warm: "Interested: dates, prices or availability",
  cold: "General questions so far",
};
