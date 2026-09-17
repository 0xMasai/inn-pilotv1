/**
 * Security-rule coverage for guest conversations (the unified inbox).
 *
 *   firebase emulators:start --only firestore   (then)   npm run test:rules
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { addDoc, collection, deleteDoc, doc, getDoc, getDocs, setDoc, updateDoc, writeBatch } from "firebase/firestore";

let env: RulesTestEnvironment;

const HOTEL = "ConversationHotel001";
const OTHER = "ConversationHotel002";
const THREAD = "ExistingThread000001";

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: "innpilot-conversation-rules-test",
    firestore: { rules: readFileSync("firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 },
  });
});

afterAll(async () => {
  await env.cleanup();
});

const conversation = (overrides: Record<string, unknown> = {}) => ({
  channel: "whatsapp",
  guestName: "Grace Namusoke",
  guestContact: "+256 772 555 010",
  handledBy: "ai",
  bookingStatus: "quoted",
  reservationId: "",
  lead: null,
  mock: true,
  messageCount: 1,
  lastMessage: { role: "guest", text: "Hello", at: new Date() },
  hotelId: HOTEL,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "hotels", HOTEL), { name: "Hotel A", currency: "UGX" });
    await setDoc(doc(db, "hotels", OTHER), { name: "Hotel B", currency: "UGX" });
    await setDoc(doc(db, "hotels", HOTEL, "conversations", THREAD), conversation({ channel: "web", mock: false }));
    await setDoc(doc(db, "hotels", HOTEL, "conversations", THREAD, "messages", "m1"), {
      role: "guest",
      text: "Is a room free?",
      at: new Date(),
      hotelId: HOTEL,
    });
  });
});

const db = () => env.unauthenticatedContext().firestore();
const threads = (hotelId = HOTEL) => collection(db(), "hotels", hotelId, "conversations");
const messages = (thread = THREAD) => collection(db(), "hotels", HOTEL, "conversations", thread, "messages");

describe("Conversations", () => {
  it("the workspace can list its conversations and read a thread", async () => {
    await assertSucceeds(getDocs(threads()));
    await assertSucceeds(getDocs(messages()));
  });

  it("the workspace can add a sample thread with its first message in one batch", async () => {
    const client = db();
    const batch = writeBatch(client);
    const ref = doc(collection(client, "hotels", HOTEL, "conversations"));
    batch.set(ref, conversation());
    batch.set(doc(collection(ref, "messages")), { role: "guest", text: "Hello", at: new Date(), hotelId: HOTEL });
    await assertSucceeds(batch.commit());
  });

  it("staff can take a thread over and hand it back", async () => {
    await assertSucceeds(updateDoc(doc(threads(), THREAD), { handledBy: "human" }));
    await assertSucceeds(updateDoc(doc(threads(), THREAD), { handledBy: "ai" }));
  });

  it("CANNOT create a conversation for a hotel that doesn't exist", async () => {
    await assertFails(addDoc(threads("NoSuchHotel000000001"), conversation({ hotelId: "NoSuchHotel000000001" })));
  });

  it("CANNOT file a conversation under another hotel's id", async () => {
    await assertFails(addDoc(threads(OTHER), conversation({ hotelId: HOTEL })));
  });

  it.each([
    ["an unknown channel", { channel: "telegram" }],
    ["an unknown handler", { handledBy: "robot" }],
    ["an unknown booking state", { bookingStatus: "maybe" }],
    ["an over-long guest name", { guestName: "x".repeat(121) }],
  ])("CANNOT create a conversation with %s", async (_label, overrides) => {
    await assertFails(addDoc(threads(), conversation(overrides)));
  });

  it("CANNOT change the channel a thread arrived on", async () => {
    await assertFails(updateDoc(doc(threads(), THREAD), { channel: "email" }));
  });

  it("CANNOT set an unknown handler on a thread", async () => {
    await assertFails(updateDoc(doc(threads(), THREAD), { handledBy: "robot" }));
  });

  it("CANNOT delete a conversation", async () => {
    await assertFails(deleteDoc(doc(threads(), THREAD)));
  });

  /* ---- Lead scoring (Phase 5) ---- */

  it("can store a lead score with its reasons, and can clear it", async () => {
    await assertSucceeds(updateDoc(doc(threads(), THREAD), { lead: { score: "hot", reasons: ["Asked to book", "Gave dates"] } }));
    await assertSucceeds(updateDoc(doc(threads(), THREAD), { lead: { score: "vip", reasons: [] } }));
    await assertSucceeds(updateDoc(doc(threads(), THREAD), { lead: null }));
    await assertSucceeds(addDoc(threads(), conversation({ lead: { score: "cold", reasons: ["General questions only so far"] } })));
  });

  it("CANNOT store a score outside the four, or a malformed lead", async () => {
    await assertFails(updateDoc(doc(threads(), THREAD), { lead: { score: "lukewarm", reasons: [] } }));
    await assertFails(updateDoc(doc(threads(), THREAD), { lead: { score: "hot" } }));
    await assertFails(updateDoc(doc(threads(), THREAD), { lead: { score: "hot", reasons: "lots" } }));
    await assertFails(updateDoc(doc(threads(), THREAD), { lead: { score: "hot", reasons: [], note: "extra" } }));
    await assertFails(updateDoc(doc(threads(), THREAD), { lead: "hot" }));
  });

  it("CANNOT store more reasons than the cap", async () => {
    const reasons = Array.from({ length: 9 }, (_, i) => `Reason ${i}`);
    await assertFails(updateDoc(doc(threads(), THREAD), { lead: { score: "hot", reasons } }));
    await assertSucceeds(updateDoc(doc(threads(), THREAD), { lead: { score: "hot", reasons: reasons.slice(0, 8) } }));
  });

  /* ---- Follow-ups (Phase 6) ---- */

  it("can record when the guest last wrote, when they were chased, and how long a follow-up is put off", async () => {
    await assertSucceeds(
      updateDoc(doc(threads(), THREAD), {
        lastGuestAt: new Date(),
        followUpSentAt: new Date(),
        followUpSnoozedUntil: new Date(Date.now() + 86_400_000),
      })
    );
    // Clearing them is how a sent follow-up ends a snooze.
    await assertSucceeds(updateDoc(doc(threads(), THREAD), { followUpSnoozedUntil: null }));
    await assertSucceeds(addDoc(threads(), conversation({ lastGuestAt: new Date(), followUpSentAt: null })));
  });

  it("CANNOT store a follow-up moment that isn't a time", async () => {
    await assertFails(updateDoc(doc(threads(), THREAD), { lastGuestAt: "yesterday" }));
    await assertFails(updateDoc(doc(threads(), THREAD), { followUpSentAt: 1_700_000_000 }));
    await assertFails(updateDoc(doc(threads(), THREAD), { followUpSnoozedUntil: { until: "tomorrow" } }));
    await assertFails(addDoc(threads(), conversation({ lastGuestAt: true })));
  });
});

describe("Messages", () => {
  const message = (overrides: Record<string, unknown> = {}) => ({
    role: "staff",
    text: "Hi, this is Ruth from reservations.",
    at: new Date(),
    hotelId: HOTEL,
    ...overrides,
  });

  it("staff can reply in a thread", async () => {
    await assertSucceeds(addDoc(messages(), message()));
  });

  it("CANNOT post into a conversation that doesn't exist", async () => {
    await assertFails(addDoc(messages("NoSuchThread00000001"), message()));
  });

  it.each([
    ["an unknown role", { role: "system" }],
    ["empty text", { text: "" }],
    ["text over 4000 characters", { text: "x".repeat(4001) }],
    ["another hotel's id", { hotelId: OTHER }],
  ])("CANNOT post a message with %s", async (_label, overrides) => {
    await assertFails(addDoc(messages(), message(overrides)));
  });

  it("CANNOT post a message without a timestamp", async () => {
    await assertFails(addDoc(messages(), { role: "staff", text: "Hi", hotelId: HOTEL }));
  });

  it("CANNOT edit a message", async () => {
    await assertFails(updateDoc(doc(messages(), "m1"), { text: "I never said that" }));
  });

  it("CANNOT delete a message", async () => {
    await assertFails(deleteDoc(doc(messages(), "m1")));
  });

  it("can read a single message", async () => {
    await assertSucceeds(getDoc(doc(messages(), "m1")));
  });
});

describe("Network concierge mirrors (D29)", () => {
  it("staff can close a conversation, and reopen it", async () => {
    await assertSucceeds(updateDoc(doc(threads(), THREAD), { closed: true }));
    await assertSucceeds(updateDoc(doc(threads(), THREAD), { closed: false }));
  });

  it("the server's selection fields are valid on a mirror", async () => {
    await assertSucceeds(updateDoc(doc(threads(), THREAD), { selection: "other", selectedHotelName: "K Hotels Kabale", bookedElsewhere: true }));
  });

  it.each([
    ["an unknown selection", { selection: "maybe" }],
    ["closed that isn't a boolean", { closed: "yes" }],
    ["bookedElsewhere that isn't a boolean", { bookedElsewhere: 1 }],
    ["an oversized hotel name", { selectedHotelName: "x".repeat(121) }],
  ])("CANNOT set %s", async (_label, change) => {
    await assertFails(updateDoc(doc(threads(), THREAD), change));
  });
});
