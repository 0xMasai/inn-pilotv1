/**
 * The inbox's live data and the few things staff can do to a conversation:
 * take it over, hand it back to the AI, reply, send a follow-up or put one
 * off, and add the sample threads for the MOCKED channels.
 *
 * Writes go through firestore.rules like every other module. A staff reply
 * on WhatsApp, Instagram or Email is recorded in the thread only: those
 * channels have no real integration in this build. On the web channel the
 * guest's concierge page picks the reply up.
 */
import { useEffect, useState } from "react";
import {
  collection,
  doc,
  increment,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  writeBatch,
} from "firebase/firestore";

import { db } from "../../firebase";
import { logAction } from "./audit";
import { COLLECTIONS } from "./collections";
import {
  MAX_MESSAGE_TEXT,
  sampleThreads,
  sortConversations,
  toConversation,
  toMessage,
  type Conversation,
  type ConversationMessage,
  type Handler,
} from "./conversations";
import { SNOOZE_HOURS } from "./followUps";
import { hotelCollection } from "./hotelScope";
import { detectSignals, mergeSignals, NO_SIGNALS, scoreLead } from "./leadScoring";
import { fail, ok, type ServiceResult } from "./serviceResult";

const LIST_LIMIT = 200;

/** A write still on its way shows with the local estimate of its server time, not as undated. */
const SNAPSHOT_OPTIONS = { serverTimestamps: "estimate" } as const;

export function useConversations(hotelId: string | null): { conversations: Conversation[]; loading: boolean; error: string } {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!hotelId) {
      setConversations([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const unsub = onSnapshot(
      query(hotelCollection(hotelId, COLLECTIONS.CONVERSATIONS), orderBy("updatedAt", "desc"), limit(LIST_LIMIT)),
      (snap) => {
        setConversations(sortConversations(snap.docs.map((d) => toConversation(d.id, d.data(SNAPSHOT_OPTIONS)))));
        setError("");
        setLoading(false);
      },
      (err) => {
        console.error("Failed to read conversations:", err);
        setError("Couldn't load conversations. Check your connection and try again.");
        setLoading(false);
      }
    );
    return () => unsub();
  }, [hotelId]);

  return { conversations, loading, error };
}

export function useMessages(hotelId: string | null, conversationId: string | null): { messages: ConversationMessage[]; loading: boolean } {
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!hotelId || !conversationId) {
      setMessages([]);
      return;
    }
    setLoading(true);
    const unsub = onSnapshot(
      query(collection(hotelCollection(hotelId, COLLECTIONS.CONVERSATIONS), conversationId, "messages"), orderBy("at"), limit(500)),
      (snap) => {
        setMessages(snap.docs.map((d) => toMessage(d.id, d.data(SNAPSHOT_OPTIONS))));
        setLoading(false);
      },
      (err) => {
        console.error("Failed to read messages:", err);
        setLoading(false);
      }
    );
    return () => unsub();
  }, [hotelId, conversationId]);

  return { messages, loading };
}

export async function setHandler(hotelId: string, conversation: Conversation, handledBy: Handler): Promise<ServiceResult<null>> {
  try {
    await updateDoc(doc(hotelCollection(hotelId, COLLECTIONS.CONVERSATIONS), conversation.id), {
      handledBy,
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    console.error("Failed to change who handles the conversation:", err);
    return fail("Couldn't update this conversation. Please try again.");
  }
  logAction(
    hotelId,
    handledBy === "human" ? "Conversation taken over" : "Conversation returned to AI",
    "conversation",
    conversation.id,
    conversation.guestName
  );
  return ok(null);
}

/** Staff mark a conversation closed, or reopen it. A label only: the AI still answers a guest who writes again. */
export async function setClosed(hotelId: string, conversation: Conversation, closed: boolean): Promise<ServiceResult<null>> {
  try {
    await updateDoc(doc(hotelCollection(hotelId, COLLECTIONS.CONVERSATIONS), conversation.id), { closed });
  } catch (err) {
    console.error("Failed to close the conversation:", err);
    return fail("Couldn't update this conversation. Please try again.");
  }
  logAction(hotelId, closed ? "Conversation closed" : "Conversation reopened", "conversation", conversation.id, conversation.guestName);
  return ok(null);
}

/**
 * Writes a message from the hotel into a thread. One path for both a reply
 * and a follow-up, so they agree on the clock and on the summary.
 *
 * The time is the server's, like every other message in the thread: the
 * guest's page asks for messages after a server time, and a staff browser's
 * clock can be off.
 */
async function writeStaffMessage(
  hotelId: string,
  conversation: Conversation,
  body: string,
  summary: Record<string, unknown>,
  failure: string
): Promise<ServiceResult<null>> {
  const at = serverTimestamp();
  const ref = doc(hotelCollection(hotelId, COLLECTIONS.CONVERSATIONS), conversation.id);
  const batch = writeBatch(db);
  batch.set(doc(collection(ref, "messages")), { role: "staff", text: body, at, hotelId });
  batch.update(ref, {
    lastMessage: { role: "staff", text: body, at },
    messageCount: increment(1),
    updatedAt: at,
    ...summary,
  });
  try {
    await batch.commit();
  } catch (err) {
    console.error(failure, err);
    return fail(failure);
  }
  return ok(null);
}

/** Records a staff reply. Replying takes the conversation over, so the AI stops answering. */
export async function sendStaffReply(hotelId: string, conversation: Conversation, text: string): Promise<ServiceResult<null>> {
  const body = text.trim();
  if (!body) return fail("Write a reply first.");
  if (body.length > MAX_MESSAGE_TEXT) return fail(`Keep replies under ${MAX_MESSAGE_TEXT} characters.`);
  return writeStaffMessage(hotelId, conversation, body, { handledBy: "human" }, "Couldn't send the reply. Please try again.");
}

/**
 * Sends a follow-up (D21). Unlike a reply, it does not take the conversation
 * over: the point of reaching out is that the guest answers, and the AI
 * concierge can take that answer straight through to a booking.
 *
 * `followUpSentAt` records that this guest has been chased, so the list
 * doesn't ask again until they write back.
 */
export async function sendFollowUp(hotelId: string, conversation: Conversation, text: string): Promise<ServiceResult<null>> {
  const body = text.trim();
  if (!body) return fail("Write a follow-up first.");
  if (body.length > MAX_MESSAGE_TEXT) return fail(`Keep follow-ups under ${MAX_MESSAGE_TEXT} characters.`);

  const result = await writeStaffMessage(
    hotelId,
    conversation,
    body,
    { followUpSentAt: serverTimestamp(), followUpSnoozedUntil: null },
    "Couldn't send the follow-up. Please try again."
  );
  if (result.ok) logAction(hotelId, "Follow-up sent", "conversation", conversation.id, conversation.guestName);
  return result;
}

/** "Not now": keeps a conversation off the follow-up list for a day, without touching the thread. */
export async function snoozeFollowUp(hotelId: string, conversation: Conversation): Promise<ServiceResult<null>> {
  try {
    await updateDoc(doc(hotelCollection(hotelId, COLLECTIONS.CONVERSATIONS), conversation.id), {
      followUpSnoozedUntil: new Date(Date.now() + SNOOZE_HOURS * 3_600_000),
    });
  } catch (err) {
    console.error("Failed to snooze the follow-up:", err);
    return fail("Couldn't update this conversation. Please try again.");
  }
  return ok(null);
}

/** Adds the sample WhatsApp, Instagram and Email threads (MOCKED channels). */
export async function addSampleConversations(hotelId: string, hotelName: string): Promise<ServiceResult<{ added: number }>> {
  const now = Date.now();
  const threads = sampleThreads(hotelName);
  const batch = writeBatch(db);
  for (const thread of threads) {
    const ref = doc(hotelCollection(hotelId, COLLECTIONS.CONVERSATIONS));
    const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000);
    const last = thread.messages[thread.messages.length - 1];
    // When the guest last wrote: a follow-up's wait is measured from it (D21).
    const lastGuest = [...thread.messages].reverse().find((message) => message.role === "guest") ?? last;
    // Scored by the same rules as a real conversation, from what the sample
    // guest says: a quoted or booked thread has seen availability.
    const { bookingStatus } = thread.conversation;
    const leadSignals = mergeSignals(
      thread.messages
        .filter((message) => message.role === "guest")
        .reduce((signals, message) => mergeSignals(signals, detectSignals(message.text)), NO_SIGNALS),
      { sawAvailability: bookingStatus !== "none" }
    );
    batch.set(ref, {
      ...thread.conversation,
      lead: scoreLead({ bookingStatus, signals: leadSignals }),
      leadSignals,
      mock: true,
      messageCount: thread.messages.length,
      lastMessage: { role: last.role, text: last.text, at: at(last.minutesAgo) },
      lastGuestAt: at(lastGuest.minutesAgo),
      hotelId,
      createdAt: at(thread.messages[0].minutesAgo),
      updatedAt: at(last.minutesAgo),
    });
    for (const message of thread.messages) {
      batch.set(doc(collection(ref, "messages")), { role: message.role, text: message.text, at: at(message.minutesAgo), hotelId });
    }
  }
  try {
    await batch.commit();
  } catch (err) {
    console.error("Failed to add sample conversations:", err);
    return fail("Couldn't add the sample conversations. Please try again.");
  }
  logAction(hotelId, "Sample conversations added", "conversation", null, `${threads.length} mocked-channel threads`);
  return ok({ added: threads.length });
}
