/**
 * Follow-ups — which guests the hotel still owes something, and what to say.
 *
 * Phase 5 scores how close a guest is to booking. A score on its own changes
 * nothing, so this turns it into the one thing that converts an enquiry: a
 * reply that actually goes out. Two kinds of guest end up on the list:
 *
 *   waiting  the guest's message is the last one in the thread and nobody
 *            has answered it. The AI missed it, or staff took over and got
 *            pulled away. The hotter the lead, the sooner it counts.
 *   quiet    nobody owes a reply, but an interested guest stopped writing
 *            without booking. This is the lead a hotel normally loses.
 *
 * Deterministic, like the scoring it reads (DECISIONS D20, D21): the same
 * conversation always produces the same follow-up and the same suggested
 * message, with no model call, no cost and nothing to go wrong in a demo.
 * The draft is a suggestion — staff read it, edit it and send it. Nothing
 * is ever sent to a guest on its own.
 *
 * Pure — no Firestore import — so the app and the tests share one
 * definition.
 */
import { WEB_GUEST_NAME, type Conversation, type LeadScore } from "./conversations";

/** A guest waiting this long for a reply needs chasing, by how hot they are. */
export const FOLLOW_UP_AFTER_HOURS: Record<LeadScore, number> = { vip: 1, hot: 1, warm: 2, cold: 6 };
/** An interested guest who stopped writing is chased after this long. */
export const QUIET_AFTER_HOURS = 24;
/** "Not now" keeps a conversation off the list for a day. */
export const SNOOZE_HOURS = 24;
/** Suggested drafts stay short enough for staff to read and edit in one go. */
export const MAX_FOLLOW_UP_TEXT = 600;

const HOUR_MS = 3_600_000;

export type FollowUpKind = "waiting" | "quiet";

export interface FollowUp {
  kind: FollowUpKind;
  /** Whole hours since the thread last moved, for ordering and for staff to read. */
  hours: number;
  /** One line: why this conversation is on the list. */
  reason: string;
}

/** "3h" up to two days, then "2 days" — a wait a person can judge at a glance. */
export function waitedLabel(hours: number): string {
  const whole = Math.max(1, Math.floor(hours));
  if (whole < 48) return `${whole}h`;
  return `${Math.floor(whole / 24)} days`;
}

/**
 * The follow-up this conversation needs now, or null if it needs none.
 *
 * Read the two branches as "who owes whom": if the guest wrote last, the
 * hotel owes a reply; if the hotel wrote last, only an interested guest who
 * has gone quiet is worth chasing, and only once until they answer.
 */
export function dueFollowUp(conversation: Conversation, now: Date = new Date()): FollowUp | null {
  const last = conversation.lastMessage;
  if (!last) return null;
  if (conversation.followUpSnoozedUntil && conversation.followUpSnoozedUntil.getTime() > now.getTime()) return null;

  const score = conversation.lead?.score ?? "cold";
  const hoursSince = (date: Date) => (now.getTime() - date.getTime()) / HOUR_MS;

  if (last.role === "guest") {
    const hours = hoursSince(conversation.lastGuestAt ?? last.at);
    if (hours < FOLLOW_UP_AFTER_HOURS[score]) return null;
    return { kind: "waiting", hours, reason: `Waiting ${waitedLabel(hours)} for a reply` };
  }

  // Nobody owes a reply. Chase the guest who was interested and stopped.
  if (conversation.bookingStatus === "booked") return null;
  if (score !== "hot" && score !== "warm") return null;
  if (conversation.leadSignals.guestMessages === 0) return null;
  // One chase per guest message: a guest who hasn't answered the last
  // follow-up is not chased again.
  if (
    conversation.followUpSentAt &&
    !(conversation.lastGuestAt && conversation.lastGuestAt.getTime() > conversation.followUpSentAt.getTime())
  ) {
    return null;
  }
  const hours = hoursSince(last.at);
  if (hours < QUIET_AFTER_HOURS) return null;
  return { kind: "quiet", hours, reason: `Interested, quiet for ${waitedLabel(hours)}` };
}

/** Hottest first, then whoever has been left longest: the order to work down. */
const SCORE_RANK: Record<LeadScore, number> = { vip: 0, hot: 1, warm: 2, cold: 3 };

export function sortFollowUps(list: Conversation[], now: Date = new Date()): Conversation[] {
  const rank = (c: Conversation) => SCORE_RANK[c.lead?.score ?? "cold"];
  const hours = (c: Conversation) => dueFollowUp(c, now)?.hours ?? 0;
  return [...list].sort((a, b) => rank(a) - rank(b) || hours(b) - hours(a));
}

export function needsFollowUp(list: Conversation[], now: Date = new Date()): Conversation[] {
  return sortFollowUps(list.filter((c) => dueFollowUp(c, now) !== null), now);
}

/* ------------------------------------------------------------------ */
/* The suggested message                                                */
/* ------------------------------------------------------------------ */

/** "Grace Namusoke" → "Grace", "@safari.sam" → "Safari", an unnamed web guest → "there". */
function firstName(guestName: string): string {
  if (guestName === WEB_GUEST_NAME) return "there";
  const word = guestName.replace(/^@/, "").split(/[\s.,_-]+/)[0] ?? "";
  if (!word) return "there";
  return word[0].toUpperCase() + word.slice(1);
}

/**
 * What this guest was actually after, in their own terms. Only signals the
 * guest gave (D20) — never a rate, a room or a date the hotel would then
 * have to honour.
 */
function topic(conversation: Conversation): string {
  const s = conversation.leadSignals;
  if (s.premium) return "the suite";
  if (s.bigStay) return "your group";
  if (s.occasion) return "your celebration";
  if (s.gaveDates) return "the dates you mentioned";
  if (s.askedPrice) return "our rates";
  return "your enquiry";
}

/**
 * A suggested follow-up for staff to edit and send.
 *
 * It says nothing the hotel would have to stand behind: no prices, no room
 * numbers, no promise that anything is free. It offers to check — which is
 * what a person would do next anyway.
 */
export function draftFollowUp(conversation: Conversation, hotelName: string, kind: FollowUpKind): string {
  const name = firstName(conversation.guestName);
  const hotel = hotelName.trim() || "the hotel";
  const about = topic(conversation);

  const parts =
    kind === "waiting"
      ? [
          `Hi ${name}, ${hotel} here — sorry to keep you waiting.`,
          `I've picked up your message about ${about} and I'm looking into it now.`,
          conversation.bookingStatus === "booked" && conversation.reservationId
            ? `Your booking ${conversation.reservationId} is confirmed, so nothing to worry about there.`
            : "",
          "Is there anything else you'd like me to check for you?",
        ]
      : [
          `Hi ${name}, ${hotel} here.`,
          `You were asking about ${about} a little while ago — are you still planning the trip?`,
          "I'd be glad to check what we have free for you and hold a room while you decide.",
        ];

  return parts.filter(Boolean).join(" ").slice(0, MAX_FOLLOW_UP_TEXT);
}

export const FOLLOW_UP_KIND_LABEL: Record<FollowUpKind, string> = {
  waiting: "Waiting on a reply",
  quiet: "Went quiet",
};
