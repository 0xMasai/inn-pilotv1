/**
 * Guest conversations — the unified inbox's domain.
 *
 * One conversation per guest thread, whatever channel it arrived on:
 *
 *   hotels/{hotelId}/conversations/{conversationId}
 *     channel, guestName, handledBy, bookingStatus, lead, lastMessage, …
 *   hotels/{hotelId}/conversations/{conversationId}/messages/{messageId}
 *     role, text, at   (append-only)
 *
 * Web conversations are written by the concierge gateway on the server as
 * real guests chat. WhatsApp, Instagram and Email are MOCKED for the
 * challenge: sample threads a hotel can add from the inbox, flagged
 * `mock: true`, with no real integration behind them.
 *
 * Pure — no Firestore import — so the app, the server and the tests share
 * one definition. Keep the enums in sync with firestore.rules.
 */
import { toLeadSignals, type LeadSignals } from "./leadScoring.js";


export const CHANNELS = ["web", "whatsapp", "instagram", "email"] as const;
export type Channel = (typeof CHANNELS)[number];

/** Channels with no real integration in this build. */
export const MOCK_CHANNELS: readonly Channel[] = ["whatsapp", "instagram", "email"];

export const HANDLERS = ["ai", "human"] as const;
/** Who answers the guest: the AI concierge, or a member of staff who took over. */
export type Handler = (typeof HANDLERS)[number];

export const CONVERSATION_BOOKING_STATES = ["none", "quoted", "booked"] as const;
/** How far the guest got: nothing yet, shown live availability, or booked. */
export type ConversationBookingState = (typeof CONVERSATION_BOOKING_STATES)[number];

/** Whether a network guest has chosen this hotel, another one, or none yet (D29). */
export const HOTEL_SELECTIONS = ["none", "this", "other"] as const;
export type HotelSelection = (typeof HOTEL_SELECTIONS)[number];

export const MESSAGE_ROLES = ["guest", "ai", "staff"] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

export const LEAD_SCORES = ["hot", "warm", "cold", "vip"] as const;
export type LeadScore = (typeof LEAD_SCORES)[number];

/** How close this guest is to booking, and why (see src/lib/leadScoring.ts). */
export interface LeadAssessment {
  score: LeadScore;
  reasons: string[];
}

export const MAX_MESSAGE_TEXT = 4_000;
export const SNIPPET_LENGTH = 90;

/** Web guests are anonymous until they book under a name. */
export const WEB_GUEST_NAME = "Web visitor";

/** What a web guest reads while a member of staff is handling their chat. */
export const HUMAN_HOLDING_REPLY =
  "Thanks for your message. A member of our team is looking after this conversation and will reply here shortly.";

export interface LastMessage {
  role: MessageRole;
  text: string;
  at: Date;
}

export interface Conversation {
  id: string;
  channel: Channel;
  guestName: string;
  /** Phone, handle or email, when known. */
  guestContact: string;
  handledBy: Handler;
  bookingStatus: ConversationBookingState;
  reservationId: string;
  lead: LeadAssessment | null;
  /** What the guest has shown so far, which is what the score is worked out from. */
  leadSignals: LeadSignals;
  lastMessage: LastMessage | null;
  /** When the guest last wrote, which is what a follow-up's wait is measured from. */
  lastGuestAt: Date | null;
  /** When staff last sent a follow-up, so a guest isn't chased twice over (D21). */
  followUpSentAt: Date | null;
  /** "Not now": this conversation stays off the follow-up list until then. */
  followUpSnoozedUntil: Date | null;
  messageCount: number;
  mock: boolean;
  /** Network concierge (D29): has the guest chosen this hotel, another, or none yet. */
  selection: HotelSelection;
  /** The hotel the guest chose, when they chose one. */
  selectedHotelName: string;
  /** The guest booked at another hotel in the network. */
  bookedElsewhere: boolean;
  /** Staff marked the conversation closed. */
  closed: boolean;
  createdAt: Date | null;
  updatedAt: Date | null;
}

export interface ConversationMessage {
  id: string;
  role: MessageRole;
  text: string;
  at: Date | null;
}

/* ------------------------------------------------------------------ */
/* Reading documents                                                    */
/* ------------------------------------------------------------------ */

const oneOf = <T extends string>(allowed: readonly T[], value: unknown, fallback: T): T =>
  (allowed as readonly unknown[]).includes(value) ? (value as T) : fallback;

/** Firestore Timestamps (either SDK), Dates and millis all become a Date. */
export function toDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function") {
    const date = (value as { toDate: () => Date }).toDate();
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === "number") return new Date(value);
  return null;
}

function toLead(value: unknown): LeadAssessment | null {
  if (!value || typeof value !== "object") return null;
  const { score, reasons } = value as { score?: unknown; reasons?: unknown };
  if (!(LEAD_SCORES as readonly unknown[]).includes(score)) return null;
  return {
    score: score as LeadScore,
    reasons: Array.isArray(reasons) ? reasons.filter((r): r is string => typeof r === "string") : [],
  };
}

export function toConversation(id: string, data: Record<string, unknown>): Conversation {
  const last = data.lastMessage as Record<string, unknown> | undefined;
  return {
    id,
    channel: oneOf(CHANNELS, data.channel, "web"),
    guestName: typeof data.guestName === "string" && data.guestName.trim() ? data.guestName : WEB_GUEST_NAME,
    guestContact: typeof data.guestContact === "string" ? data.guestContact : "",
    handledBy: oneOf(HANDLERS, data.handledBy, "ai"),
    bookingStatus: oneOf(CONVERSATION_BOOKING_STATES, data.bookingStatus, "none"),
    reservationId: typeof data.reservationId === "string" ? data.reservationId : "",
    lead: toLead(data.lead),
    leadSignals: toLeadSignals(data.leadSignals),
    lastMessage:
      last && typeof last.text === "string"
        ? { role: oneOf(MESSAGE_ROLES, last.role, "guest"), text: last.text, at: toDate(last.at) ?? new Date(0) }
        : null,
    lastGuestAt: toDate(data.lastGuestAt),
    followUpSentAt: toDate(data.followUpSentAt),
    followUpSnoozedUntil: toDate(data.followUpSnoozedUntil),
    messageCount: typeof data.messageCount === "number" ? data.messageCount : 0,
    mock: data.mock === true,
    selection: oneOf(HOTEL_SELECTIONS, data.selection, "none"),
    selectedHotelName: typeof data.selectedHotelName === "string" ? data.selectedHotelName : "",
    bookedElsewhere: data.bookedElsewhere === true,
    closed: data.closed === true,
    createdAt: toDate(data.createdAt),
    updatedAt: toDate(data.updatedAt),
  };
}

export function toMessage(id: string, data: Record<string, unknown>): ConversationMessage {
  return {
    id,
    role: oneOf(MESSAGE_ROLES, data.role, "guest"),
    text: typeof data.text === "string" ? data.text : "",
    at: toDate(data.at),
  };
}

/* ------------------------------------------------------------------ */
/* Rules of the domain                                                  */
/* ------------------------------------------------------------------ */

/** Firestore auto-ids: what the server hands a web guest as their conversation id. */
export function isConversationId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9]{20}$/.test(value);
}

/** Booking progress only moves forward: a booked guest who asks another question stays booked. */
export function advanceBookingState(
  current: ConversationBookingState,
  next: ConversationBookingState
): ConversationBookingState {
  const rank = CONVERSATION_BOOKING_STATES.indexOf.bind(CONVERSATION_BOOKING_STATES);
  return rank(next) > rank(current) ? next : current;
}

export function snippet(text: string, max = SNIPPET_LENGTH): string {
  const flat = text.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/* ------------------------------------------------------------------ */
/* Presentation                                                         */
/* ------------------------------------------------------------------ */

export const CHANNEL_LABEL: Record<Channel, string> = {
  web: "Web",
  whatsapp: "WhatsApp",
  instagram: "Instagram",
  email: "Email",
};

export const BOOKING_STATE_LABEL: Record<ConversationBookingState, string> = {
  none: "No booking",
  quoted: "Quoted",
  booked: "Booked",
};

export const LEAD_LABEL: Record<LeadScore, string> = {
  hot: "Hot",
  warm: "Warm",
  cold: "Cold",
  vip: "VIP",
};

/**
 * Where a conversation stands, for the inbox (D29):
 *   Booked  — booked at this hotel;
 *   Closed  — staff closed it, or the guest booked at another hotel;
 *   Active  — the guest has seen live availability or chosen a hotel;
 *   New     — nothing yet.
 */
export const CONVERSATION_STATUSES = ["new", "active", "booked", "closed"] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

export function conversationStatus(c: Pick<Conversation, "bookingStatus" | "closed" | "bookedElsewhere" | "selection">): ConversationStatus {
  if (c.bookingStatus === "booked") return "booked";
  if (c.closed || c.bookedElsewhere) return "closed";
  if (c.bookingStatus === "quoted" || c.selection !== "none") return "active";
  return "new";
}

export const STATUS_LABEL: Record<ConversationStatus, string> = {
  new: "New",
  active: "Active",
  booked: "Booked",
  closed: "Closed",
};

/** What the inbox shows as the guest's chosen hotel. */
export function selectedHotelLabel(c: Pick<Conversation, "selection" | "selectedHotelName">, hotelName: string): string {
  if (c.selection === "this") return hotelName || "This hotel";
  if (c.selection === "other") return c.selectedHotelName || "Another property";
  return "";
}

export type StatusFilter = ConversationStatus | "all";

export function statusCounts(list: Conversation[]): Record<StatusFilter, number> {
  const counts = { all: list.length, new: 0, active: 0, booked: 0, closed: 0 };
  for (const c of list) counts[conversationStatus(c)]++;
  return counts;
}

export type ChannelFilter = Channel | "all";
export type LeadFilter = LeadScore | "all";

/** Newest activity first; a conversation with no activity yet sorts last. */
export function sortConversations(list: Conversation[]): Conversation[] {
  const time = (c: Conversation) => (c.lastMessage?.at ?? c.updatedAt ?? c.createdAt)?.getTime() ?? 0;
  return [...list].sort((a, b) => time(b) - time(a));
}

export function filterConversations(
  list: Conversation[],
  {
    channel = "all",
    lead = "all",
    status = "all",
    query = "",
  }: { channel?: ChannelFilter; lead?: LeadFilter; status?: StatusFilter; query?: string }
): Conversation[] {
  const q = query.trim().toLowerCase();
  return list.filter(
    (c) =>
      (channel === "all" || c.channel === channel) &&
      (lead === "all" || c.lead?.score === lead) &&
      (status === "all" || conversationStatus(c) === status) &&
      (!q ||
        c.guestName.toLowerCase().includes(q) ||
        c.guestContact.toLowerCase().includes(q) ||
        (c.lastMessage?.text.toLowerCase().includes(q) ?? false) ||
        (c.selectedHotelName ?? "").toLowerCase().includes(q) ||
        c.reservationId.toLowerCase().includes(q))
  );
}

export function channelCounts(list: Conversation[]): Record<ChannelFilter, number> {
  const counts = { all: list.length, web: 0, whatsapp: 0, instagram: 0, email: 0 };
  for (const c of list) counts[c.channel]++;
  return counts;
}

/** Leads by score. Unscored conversations count only in `all`. */
export function leadCounts(list: Conversation[]): Record<LeadFilter, number> {
  const counts = { all: list.length, hot: 0, warm: 0, cold: 0, vip: 0 };
  for (const c of list) if (c.lead) counts[c.lead.score]++;
  return counts;
}

/** "now", "5m", "3h", "Tue", "12 Sep" — compact, for list rows. */
export function relativeTime(date: Date | null, now: Date = new Date()): string {
  if (!date) return "";
  const minutes = Math.floor((now.getTime() - date.getTime()) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h`;
  if (minutes < 7 * 24 * 60) return date.toLocaleDateString("en-GB", { weekday: "short" });
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/* ------------------------------------------------------------------ */
/* Mocked channels                                                      */
/* ------------------------------------------------------------------ */

export interface SampleThread {
  conversation: {
    channel: Channel;
    guestName: string;
    guestContact: string;
    handledBy: Handler;
    bookingStatus: ConversationBookingState;
    reservationId: string;
  };
  /** Minutes before now each message was sent, oldest first. */
  messages: { role: MessageRole; text: string; minutesAgo: number }[];
}

/**
 * Sample threads for the MOCKED channels, in the shape real ones would
 * take. They describe questions and answers only in general terms — no
 * rates or availability — so they can't contradict a hotel's live data.
 *
 * Their ages are part of the sample: one guest has just written, one has
 * been waiting hours for an answer, and one interested guest went quiet
 * after the hotel replied — the three states the follow-up list sorts out.
 */
export function sampleThreads(hotelName: string): SampleThread[] {
  const name = hotelName.trim() || "the hotel";
  return [
    {
      conversation: {
        channel: "whatsapp",
        guestName: "Grace Namusoke",
        guestContact: "+256 772 555 010",
        handledBy: "ai",
        bookingStatus: "quoted",
        reservationId: "",
      },
      messages: [
        { role: "guest", text: `Hello! Do you have a double room at ${name} for next Friday and Saturday?`, minutesAgo: 42 },
        { role: "ai", text: "Hi Grace! Yes, we have Double rooms free for those two nights. Would you like me to reserve one for you?", minutesAgo: 41 },
        { role: "guest", text: "Maybe. Is breakfast included? I'll confirm with my husband tonight.", minutesAgo: 25 },
      ],
    },
    {
      conversation: {
        channel: "instagram",
        guestName: "@safari.sam",
        guestContact: "@safari.sam",
        handledBy: "human",
        bookingStatus: "none",
        reservationId: "",
      },
      messages: [
        { role: "guest", text: "We're planning a team retreat for 12 people in December. Can you do a group rate?", minutesAgo: 60 * 32 },
        { role: "ai", text: "That sounds great! Group rates are arranged by our team, so I've passed your request on. Someone will reply here shortly.", minutesAgo: 60 * 32 - 1 },
        // Answered, then silence: the interested guest a hotel normally loses (D21).
        { role: "staff", text: "Hi Sam, this is Ruth from reservations. Happy to help. Which dates are you looking at?", minutesAgo: 60 * 30 },
      ],
    },
    {
      conversation: {
        channel: "email",
        guestName: "Daniel Otieno",
        guestContact: "daniel.otieno@example.com",
        handledBy: "ai",
        bookingStatus: "booked",
        reservationId: "RSV-SAMPLE-EMAIL1",
      },
      messages: [
        { role: "guest", text: "Please book a suite for my anniversary, arriving on the 20th for three nights.", minutesAgo: 60 * 26 },
        { role: "ai", text: "Congratulations! Your suite is booked. Your reservation reference is RSV-SAMPLE-EMAIL1.", minutesAgo: 60 * 26 - 2 },
        { role: "guest", text: "Thank you! Could you arrange flowers in the room?", minutesAgo: 60 * 5 },
      ],
    },
  ];
}
