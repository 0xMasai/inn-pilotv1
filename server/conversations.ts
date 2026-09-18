/**
 * Web conversations, recorded by the concierge gateway so the hotel's inbox
 * sees every guest chat (src/lib/conversations.ts has the shape).
 *
 * Always through a HotelScope: a conversation id from the browser is only
 * ever looked up under the resolved hotel's own `conversations`, so an id
 * from another hotel simply isn't found and a fresh conversation starts.
 * The id is a 20-character Firestore auto-id handed to the guest's tab; it
 * is not guessable, and it grants nothing but posting to and reading that
 * one thread.
 */
import type { DocumentReference } from "firebase-admin/firestore";
import { COLLECTIONS } from "../src/lib/collections.js";
import {
  advanceBookingState,
  isConversationId,
  MAX_MESSAGE_TEXT,
  toConversation,
  toMessage,
  WEB_GUEST_NAME,
  type ConversationBookingState,
  type HotelSelection,
  type ConversationMessage,
  type Handler,
  type MessageRole,
} from "../src/lib/conversations.js";
import {
  bookingSignals,
  detectSignals,
  mergeSignals,
  scoreLead,
  toLeadSignals,
} from "../src/lib/leadScoring.js";
import type { HotelScope } from "./hotels.js";

export type { HotelSelection } from "../src/lib/conversations.js";

export interface OpenConversation {
  id: string;
  ref: DocumentReference;
  /** False until the first turn is written. */
  exists: boolean;
  handledBy: Handler;
  bookingStatus: ConversationBookingState;
  messageCount: number;
}

/**
 * This hotel's mirror of a network guest thread (DECISIONS D29): the
 * conversation with exactly this id, whether or not it exists yet. The id is
 * the canonical thread's, so a thread has the same id in every hotel's inbox.
 */
export async function openMirror(scope: HotelScope, id: string): Promise<OpenConversation> {
  const ref = scope.collection(COLLECTIONS.CONVERSATIONS).doc(id);
  const snap = await ref.get();
  const data = snap.data();
  if (snap.exists && data) {
    const conversation = toConversation(snap.id, data);
    return {
      id,
      ref,
      exists: true,
      handledBy: conversation.handledBy,
      bookingStatus: conversation.bookingStatus,
      messageCount: conversation.messageCount,
    };
  }
  return { id, ref, exists: false, handledBy: "ai", bookingStatus: "none", messageCount: 0 };
}

/** The guest's conversation in this hotel, or a new one when the id is absent, malformed or unknown here. */
export async function openConversation(scope: HotelScope, rawId: unknown): Promise<OpenConversation> {
  const conversations = scope.collection(COLLECTIONS.CONVERSATIONS);
  if (isConversationId(rawId)) {
    const ref = conversations.doc(rawId);
    const snap = await ref.get();
    const data = snap.data();
    // Only a web thread can be continued from the web concierge.
    if (snap.exists && data && data.channel === "web") {
      const conversation = toConversation(snap.id, data);
      return {
        id: snap.id,
        ref,
        exists: true,
        handledBy: conversation.handledBy,
        bookingStatus: conversation.bookingStatus,
        messageCount: conversation.messageCount,
      };
    }
  }
  const ref = conversations.doc();
  return { id: ref.id, ref, exists: false, handledBy: "ai", bookingStatus: "none", messageCount: 0 };
}

export interface TurnRecord {
  guestText: string;
  /** When the gateway received the guest's message (ms). Defaults to now. */
  receivedAt?: number;
  /**
   * The browser's id for this guest message. When a turn fails, the message
   * is recorded and its id kept, so a retry of the same message isn't
   * recorded a second time.
   */
  turnId?: string;
  /** The AI's reply, or the holding reply in human mode. Absent when the turn failed. */
  replyText?: string;
  replyRole?: MessageRole;
  /** check_availability returned rooms this turn. */
  quoted?: boolean;
  /**
   * The thread so far, for a hotel whose inbox is seeing this guest for the
   * first time. Written only when the mirror doesn't exist yet.
   */
  backfill?: { role: MessageRole; text: string; at: Date }[];
  /** Whether the guest has chosen this hotel, another one, or none yet. */
  selection?: HotelSelection;
  selectedHotelName?: string;
  /** The guest booked at another hotel in the network. */
  bookedElsewhere?: boolean;
  /** Who the guest said they are, before any booking (from a booking summary). */
  guest?: { name: string; phone: string };
  booking?: {
    reservationId: string;
    guestName: string;
    guestPhone: string;
    /** For lead scoring: the stay the guest actually committed to. */
    nights?: number;
    guests?: number;
    roomType?: string;
  };
}

/** What a browser may send as a turn id. */
export function isTurnId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(value);
}

/**
 * Writes one guest turn — the guest's message, the reply if there was one,
 * and the conversation's summary — in one transaction.
 *
 * A transaction, because a turn can take many seconds of model time and
 * staff may reply meanwhile: the count and booking progress are worked out
 * from the conversation as it is now, not as it was when the turn began.
 * The guest's message carries the time it arrived, so a staff reply sent
 * during the turn still reads after it. Booking progress only moves forward,
 * and the lead score is worked out from every signal seen so far (D20).
 */
export async function recordTurn(scope: HotelScope, conversation: OpenConversation, turn: TurnRecord): Promise<void> {
  const now = Date.now();
  const receivedAt = Math.min(turn.receivedAt ?? now, now);
  const messages = conversation.ref.collection("messages");

  const written = await scope.runTransaction(async (tx) => {
    const snap = await tx.get(conversation.ref);
    const data = snap.exists ? snap.data() : undefined;
    const current = data ? toConversation(snap.id, data) : null;

    // The retry of a message already recorded when its turn failed.
    const repeat = isTurnId(turn.turnId) && data?.pendingTurnId === turn.turnId;
    const backfill = current ? [] : (turn.backfill ?? []).filter((entry) => entry.text.trim());
    const entries: { role: MessageRole; text: string; at: Date }[] = [...backfill];
    if (!repeat) entries.push({ role: "guest", text: turn.guestText, at: new Date(receivedAt) });
    if (turn.replyText) {
      entries.push({ role: turn.replyRole ?? "ai", text: turn.replyText, at: new Date(Math.max(now, receivedAt + 1)) });
    }
    if (entries.length === 0) return null;

    for (const entry of entries) {
      tx.create(messages.doc(), { ...entry, text: entry.text.slice(0, MAX_MESSAGE_TEXT), hotelId: scope.hotelId });
    }

    const last = entries[entries.length - 1];
    const lastBackfillGuest = [...backfill].reverse().find((entry) => entry.role === "guest");
    const guestAt = repeat ? (lastBackfillGuest?.at ?? null) : new Date(receivedAt);
    // A failed turn's guest message can be older than a staff reply written meanwhile.
    const newest = !current?.lastMessage || last.at.getTime() >= current.lastMessage.at.getTime();
    const bookingStatus = advanceBookingState(
      current?.bookingStatus ?? "none",
      turn.booking ? "booked" : turn.quoted ? "quoted" : "none"
    );
    const messageCount = (current?.messageCount ?? 0) + entries.length;

    // What this guest has shown, this turn on top of every turn before it.
    let signals = toLeadSignals(data?.leadSignals);
    for (const entry of backfill) if (entry.role === "guest") signals = mergeSignals(signals, detectSignals(entry.text));
    if (!repeat) signals = mergeSignals(signals, detectSignals(turn.guestText));
    if (turn.quoted) signals = mergeSignals(signals, { sawAvailability: true });
    if (turn.booking) signals = mergeSignals(signals, bookingSignals(turn.booking));
    const lead = scoreLead({ bookingStatus, signals });
    const summary: Record<string, unknown> = {
      bookingStatus,
      messageCount,
      lead,
      leadSignals: signals,
      pendingTurnId: !turn.replyText && isTurnId(turn.turnId) ? turn.turnId : "",
      // When the guest last wrote: what a follow-up's wait is measured from
      // (D21). A retry writes no guest message, so it doesn't move it.
      ...(guestAt && (!current?.lastGuestAt || guestAt.getTime() >= current.lastGuestAt.getTime())
        ? { lastGuestAt: guestAt }
        : {}),
      ...(newest
        ? { lastMessage: { role: last.role, text: last.text.slice(0, MAX_MESSAGE_TEXT), at: last.at }, updatedAt: last.at }
        : {}),
      ...(turn.selection ? { selection: turn.selection, selectedHotelName: turn.selectedHotelName ?? "" } : {}),
      ...(turn.bookedElsewhere !== undefined ? { bookedElsewhere: turn.bookedElsewhere } : {}),
      ...(turn.guest && !turn.booking && current?.bookingStatus !== "booked"
        ? { guestName: turn.guest.name || WEB_GUEST_NAME, guestContact: turn.guest.phone }
        : {}),
      ...(turn.booking
        ? {
            reservationId: turn.booking.reservationId,
            guestName: turn.booking.guestName || WEB_GUEST_NAME,
            guestContact: turn.booking.guestPhone,
          }
        : {}),
    };

    if (current) {
      tx.update(conversation.ref, summary);
    } else {
      tx.create(conversation.ref, {
        channel: "web",
        guestName: WEB_GUEST_NAME,
        guestContact: "",
        selection: "none",
        selectedHotelName: "",
        bookedElsewhere: false,
        closed: false,
        handledBy: "ai",
        reservationId: "",
        mock: false,
        hotelId: scope.hotelId,
        createdAt: new Date(receivedAt),
        ...summary,
      });
    }
    return { bookingStatus, messageCount };
  });

  if (written) {
    conversation.exists = true;
    conversation.bookingStatus = written.bookingStatus;
    conversation.messageCount = written.messageCount;
  }
}

/** A web thread's messages after `afterMs`, for the guest page to pick up staff replies. */
export async function readConversation(
  scope: HotelScope,
  rawId: unknown,
  afterMs = 0
): Promise<{ handledBy: Handler; messages: ConversationMessage[] } | null> {
  if (!isConversationId(rawId)) return null;
  const ref = scope.collection(COLLECTIONS.CONVERSATIONS).doc(rawId);
  const snap = await ref.get();
  const data = snap.data();
  if (!snap.exists || !data || data.channel !== "web") return null;

  const messages = await ref
    .collection("messages")
    .where("at", ">", new Date(afterMs))
    .orderBy("at")
    .limit(50)
    .get();
  return {
    handledBy: toConversation(snap.id, data).handledBy,
    messages: messages.docs.map((doc) => toMessage(doc.id, doc.data())),
  };
}
