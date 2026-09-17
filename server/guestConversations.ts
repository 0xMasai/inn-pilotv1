/**
 * Network guest conversations (DECISIONS D29).
 *
 * A guest talking to the network concierge isn't any one hotel's guest until
 * they choose, so the conversation has two homes:
 *
 *   conciergeConversations/{id}              the CANONICAL thread
 *     hotelIds, selectedHotelId, pendingBooking, reservation, messageCount
 *     messages/{messageId}  role, text, at
 *
 *   hotels/{hotelId}/conversations/{id}      each involved hotel's inbox MIRROR
 *
 * The canonical thread is server-only: firestore.rules' catch-all denies it
 * to every client, because it holds the pending booking the guest must
 * confirm and the internal ids of the hotels involved. The mirrors are the
 * existing per-hotel inbox documents (D19), written by the existing
 * recordTurn(), so lead scoring, follow-ups and handoff work unchanged.
 *
 * A hotel is attached when it appears in the guest's search results or is
 * chosen. Its mirror is back-filled with the thread so far the first time,
 * then updated on every turn.
 */
import type { DocumentReference } from "firebase-admin/firestore";
import { toDate, toMessage, type ConversationMessage, type Handler, type MessageRole } from "../src/lib/conversations";
import { MAX_MESSAGE_TEXT } from "../src/lib/conversations";
import { adminDb } from "./admin";
import type { PendingBooking } from "./ai/types";
import { isTurnId, openMirror, readConversation, recordTurn, type HotelSelection } from "./conversations";
import { scopeForHotelId, type HotelScope } from "./hotels";

export const GUEST_CONVERSATIONS_COLLECTION = "conciergeConversations";
/** More hotels than one guest reasonably compares; bounds the writes per turn. */
export const MAX_ATTACHED_HOTELS = 10;
const BACKFILL_LIMIT = 200;

const CONVERSATION_ID = /^[A-Za-z0-9]{20}$/;

export interface GuestThread {
  id: string;
  ref: DocumentReference;
  exists: boolean;
  /**
   * The public id of the hotel whose own link started this thread, or "" for
   * the network concierge. A thread is only continued (or read) under the
   * same scope, so a thread from one hotel's page can't be carried to another.
   */
  scope: string;
  /** Internal ids of the hotels whose inboxes mirror this thread. Server-only. */
  hotelIds: string[];
  selectedHotelId: string;
  /** The summary the guest was shown and hasn't confirmed yet (D27). */
  pendingBooking: PendingBooking | null;
  reservation: { hotelId: string; reservationId: string } | null;
}

function readPendingBooking(value: unknown): PendingBooking | null {
  if (!value || typeof value !== "object") return null;
  const pending = value as Partial<PendingBooking>;
  return typeof pending.hotel === "string" &&
    typeof pending.roomType === "string" &&
    typeof pending.checkIn === "string" &&
    typeof pending.checkOut === "string" &&
    typeof pending.guestName === "string" &&
    typeof pending.guestPhone === "string" &&
    typeof pending.totalPrice === "number" &&
    typeof pending.preparedAt === "number"
    ? (pending as PendingBooking)
    : null;
}

const readIds = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((id): id is string => typeof id === "string" && id.length > 0) : [];

/** The guest's thread, or a new one when the id is absent, malformed, unknown or from another scope. */
export async function openGuestThread(rawId: unknown, scope = ""): Promise<GuestThread> {
  const collection = adminDb().collection(GUEST_CONVERSATIONS_COLLECTION);
  if (typeof rawId === "string" && CONVERSATION_ID.test(rawId)) {
    const ref = collection.doc(rawId);
    const snap = await ref.get();
    const data = snap.data();
    if (snap.exists && data && (typeof data.scope === "string" ? data.scope : "") === scope) {
      const reservation = data.reservation as GuestThread["reservation"] | undefined;
      return {
        id: rawId,
        ref,
        exists: true,
        scope,
        hotelIds: readIds(data.hotelIds),
        selectedHotelId: typeof data.selectedHotelId === "string" ? data.selectedHotelId : "",
        pendingBooking: readPendingBooking(data.pendingBooking),
        reservation: reservation?.hotelId && reservation?.reservationId ? reservation : null,
      };
    }
  }
  const ref = collection.doc();
  return { id: ref.id, ref, exists: false, scope, hotelIds: [], selectedHotelId: "", pendingBooking: null, reservation: null };
}

/**
 * Scopes for hotel ids, reusing any this turn already resolved. A hotel that
 * no longer exists is skipped.
 */
export async function scopesFor(hotelIds: string[], known: Map<string, HotelScope> = new Map()): Promise<HotelScope[]> {
  const scopes = await Promise.all(hotelIds.map(async (id) => known.get(id) ?? (await scopeForHotelId(id))));
  return scopes.filter((scope): scope is HotelScope => scope !== null);
}

/** "human" when staff at any attached hotel have taken this guest over. */
export async function threadHandledBy(thread: GuestThread, scopes: HotelScope[]): Promise<Handler> {
  if (!thread.exists || scopes.length === 0) return "ai";
  const mirrors = await Promise.all(scopes.map((scope) => openMirror(scope, thread.id)));
  return mirrors.some((mirror) => mirror.exists && mirror.handledBy === "human") ? "human" : "ai";
}

/** Existing hotels first, then new ones; the chosen and booked hotels are always kept. */
export function mergeAttached(existing: string[], added: string[], keep: string[]): string[] {
  const merged = [...new Set([...existing, ...added])];
  if (merged.length <= MAX_ATTACHED_HOTELS) return merged;
  const required = new Set(keep.filter(Boolean));
  const optional = merged.filter((id) => !required.has(id));
  return [...required, ...optional.slice(0, MAX_ATTACHED_HOTELS - required.size)];
}

export interface GuestTurn {
  guestText: string;
  receivedAt?: number;
  turnId?: string;
  /** Absent when the turn failed. */
  replyText?: string;
  replyRole?: MessageRole;
  /** Hotels shown to the guest this turn. */
  attach?: HotelScope[];
  /** Hotels that showed the guest live availability this turn. */
  quotedHotelIds?: Set<string>;
  /** The hotel the guest is now focused on (a summary, a booking, or one hotel's availability). */
  selected?: HotelScope;
  /** undefined leaves it as it is; null clears it. */
  pendingBooking?: PendingBooking | null;
  booking?: {
    scope: HotelScope;
    reservationId: string;
    guestName: string;
    guestPhone: string;
    nights: number;
    guests: number;
    roomType: string;
  };
}

/**
 * Records one guest turn: in the canonical thread (one transaction), then in
 * every attached hotel's inbox mirror. A mirror that fails to write is
 * logged and doesn't stop the others.
 */
export async function recordGuestTurn(thread: GuestThread, turn: GuestTurn): Promise<void> {
  const now = Date.now();
  const receivedAt = Math.min(turn.receivedAt ?? now, now);
  const known = new Map<string, HotelScope>();
  for (const scope of [...(turn.attach ?? []), turn.selected, turn.booking?.scope]) {
    if (scope) known.set(scope.hotelId, scope);
  }

  const written = await adminDb().runTransaction(async (tx) => {
    const snap = await tx.get(thread.ref);
    const data = snap.data();
    const repeat = isTurnId(turn.turnId) && data?.pendingTurnId === turn.turnId;

    const entries: { role: MessageRole; text: string; at: Date }[] = [];
    if (!repeat) entries.push({ role: "guest", text: turn.guestText, at: new Date(receivedAt) });
    if (turn.replyText) {
      entries.push({ role: turn.replyRole ?? "ai", text: turn.replyText, at: new Date(Math.max(now, receivedAt + 1)) });
    }
    const createdIds: string[] = [];
    for (const entry of entries) {
      const ref = thread.ref.collection("messages").doc();
      tx.create(ref, { ...entry, text: entry.text.slice(0, MAX_MESSAGE_TEXT) });
      createdIds.push(ref.id);
    }

    const bookedHotelId = turn.booking?.scope.hotelId ?? "";
    const selectedHotelId =
      bookedHotelId || turn.selected?.hotelId || (typeof data?.selectedHotelId === "string" ? data.selectedHotelId : "");
    const previous = data?.reservation as GuestThread["reservation"] | undefined;
    const reservation = turn.booking
      ? { hotelId: bookedHotelId, reservationId: turn.booking.reservationId }
      : previous?.hotelId
        ? previous
        : null;
    const hotelIds = mergeAttached(
      readIds(data?.hotelIds),
      [...(turn.attach ?? []).map((scope) => scope.hotelId), selectedHotelId].filter(Boolean),
      [selectedHotelId, reservation?.hotelId ?? ""]
    );

    const summary: Record<string, unknown> = {
      hotelIds,
      selectedHotelId,
      reservation,
      messageCount: (typeof data?.messageCount === "number" ? data.messageCount : 0) + entries.length,
      pendingTurnId: !turn.replyText && isTurnId(turn.turnId) ? turn.turnId : "",
      updatedAt: new Date(now),
      ...(turn.pendingBooking !== undefined ? { pendingBooking: turn.pendingBooking } : {}),
    };
    if (snap.exists) tx.update(thread.ref, summary);
    else tx.create(thread.ref, { ...summary, scope: thread.scope, createdAt: new Date(receivedAt) });
    return { hotelIds, selectedHotelId, reservation, createdIds };
  });

  thread.exists = true;
  thread.hotelIds = written.hotelIds;
  thread.selectedHotelId = written.selectedHotelId;
  thread.reservation = written.reservation;
  if (turn.pendingBooking !== undefined) thread.pendingBooking = turn.pendingBooking;

  const scopes = await scopesFor(written.hotelIds, known);
  if (scopes.length === 0) return;
  const selected = scopes.find((scope) => scope.hotelId === written.selectedHotelId);

  const mirrors = await Promise.all(scopes.map((scope) => openMirror(scope, thread.id)));
  let history: { role: MessageRole; text: string; at: Date }[] | null = null;
  if (mirrors.some((mirror) => !mirror.exists)) {
    const created = new Set(written.createdIds);
    const snap = await thread.ref.collection("messages").orderBy("at").limit(BACKFILL_LIMIT).get();
    history = snap.docs
      .filter((doc) => !created.has(doc.id))
      .map((doc) => {
        const message = toMessage(doc.id, doc.data());
        return { role: message.role, text: message.text, at: toDate(doc.data().at) ?? new Date(receivedAt - 1) };
      });
  }

  const guest = turn.pendingBooking ? { name: turn.pendingBooking.guestName, phone: turn.pendingBooking.guestPhone } : undefined;

  await Promise.all(
    scopes.map(async (scope, index) => {
      const mirror = mirrors[index];
      const selection: HotelSelection = !selected ? "none" : selected.hotelId === scope.hotelId ? "this" : "other";
      const booking = turn.booking && turn.booking.scope.hotelId === scope.hotelId ? turn.booking : undefined;
      try {
        await recordTurn(scope, mirror, {
          guestText: turn.guestText,
          receivedAt,
          turnId: turn.turnId,
          replyText: turn.replyText,
          replyRole: turn.replyRole,
          quoted: turn.quotedHotelIds?.has(scope.hotelId) ?? false,
          backfill: mirror.exists ? undefined : (history ?? undefined),
          selection,
          selectedHotelName: selected?.profile.name ?? "",
          bookedElsewhere: Boolean(written.reservation && written.reservation.hotelId !== scope.hotelId),
          guest,
          ...(booking
            ? {
                booking: {
                  reservationId: booking.reservationId,
                  guestName: booking.guestName,
                  guestPhone: booking.guestPhone,
                  nights: booking.nights,
                  guests: booking.guests,
                  roomType: booking.roomType,
                },
              }
            : {}),
        });
      } catch (error) {
        console.error("[concierge] inbox mirror write failed", {
          conversationId: thread.id,
          hotelId: scope.hotelId,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    })
  );
}

/**
 * Staff replies for the guest's page, from every attached hotel's mirror,
 * newer than `afterMs` (server time), and whether staff are handling it.
 * Null when the thread doesn't exist in this scope.
 */
export async function readGuestThreadUpdates(
  rawId: unknown,
  afterMs = 0,
  scope = ""
): Promise<{ handledBy: Handler; messages: ConversationMessage[] } | null> {
  if (typeof rawId !== "string" || !CONVERSATION_ID.test(rawId)) return null;
  const thread = await openGuestThread(rawId, scope);
  if (!thread.exists) return null;

  const scopes = await scopesFor(thread.hotelIds);
  const threads = await Promise.all(scopes.map((scope) => readConversation(scope, rawId, afterMs)));
  const found = threads.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  const messages = found
    .flatMap((entry) => entry.messages)
    .filter((message) => message.role === "staff")
    .sort((a, b) => (a.at?.getTime() ?? 0) - (b.at?.getTime() ?? 0));
  return { handledBy: found.some((entry) => entry.handledBy === "human") ? "human" : "ai", messages };
}
