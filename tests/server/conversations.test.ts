/**
 * Web conversations reaching the inbox: the concierge gateway records each
 * turn, staff take-over silences the AI, and the guest page can pick up
 * staff replies — all bound to the resolved hotel.
 *
 * Real handlers and Admin SDK against the emulator; Gemini scripted.
 *
 *   firebase emulators:start --only firestore   (then)   npm run test:server
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const PROJECT_ID = "innpilot-conversations-test";
process.env.FIRESTORE_EMULATOR_HOST ??= "127.0.0.1:8080";
process.env.FIREBASE_PROJECT_ID = PROJECT_ID;
process.env.GEMINI_API_KEY = "test-key-not-real";
// These suites script the Gemini SDK; the Groq adapter has its own (groq*.test.ts).
process.env.AI_PROVIDER = "gemini";
delete process.env.FIREBASE_SERVICE_ACCOUNT;

type Scripted =
  | Record<string, unknown>
  | ((request: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>)
  | "fail";
const gemini = vi.hoisted(() => ({ responses: [] as unknown[], requests: [] as unknown[] }));

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = {
      generateContent: async (request: { config?: Record<string, unknown> }) => {
        const config = { ...request.config };
        delete config.abortSignal;
        const recorded = JSON.parse(JSON.stringify({ ...request, config }));
        gemini.requests.push(recorded);
        const next = gemini.responses.shift() as Scripted | undefined;
        if (!next) throw new Error("No scripted Gemini response left.");
        if (next === "fail") throw Object.assign(new Error("model down"), { status: 401 });
        return typeof next === "function" ? next(recorded) : next;
      },
    };
  },
}));

import conciergeHandler from "../../api/ai/concierge";
import conversationHandler from "../../api/ai/conversation";
import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "../../server/admin";
import { resetGeminiClient } from "../../server/ai/gemini";
import { resetRateLimits } from "../../server/ai/rateLimit";
import { HUMAN_HOLDING_REPLY } from "../../src/lib/conversations";

const HOTEL_A = "ConvHotelA0000000001";
const HOTEL_B = "ConvHotelB0000000001";
const PUBLIC_A = "lakeside-inn-conv000a";
const PUBLIC_B = "savannah-lodge-conv00b";

const answer = (text: string) => ({
  candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }],
});
const callTool = (name: string, args: Record<string, unknown>) => {
  const functionCall = { name, args, id: "c1" };
  return { candidates: [{ content: { role: "model", parts: [{ functionCall }] } }], functionCalls: [functionCall] };
};

function fakeRes() {
  return {
    statusCode: 0,
    body: undefined as unknown as Record<string, unknown>,
    setHeader() {},
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload as Record<string, unknown>;
    },
    end() {},
  };
}

async function chat(body: Record<string, unknown>) {
  const res = fakeRes();
  await conciergeHandler({ method: "POST", headers: {}, body, socket: { remoteAddress: "10.1.0.1" }, async *[Symbol.asyncIterator]() {} }, res);
  return res;
}

async function poll(query: string) {
  const res = fakeRes();
  await conversationHandler(
    { method: "GET", url: `/api/ai/conversation?${query}`, headers: {}, socket: { remoteAddress: "10.1.0.2" }, async *[Symbol.asyncIterator]() {} },
    res
  );
  return res;
}

const threadsOf = (hotelId: string) => adminDb().collection(`hotels/${hotelId}/conversations`);
async function messagesOf(hotelId: string, id: string) {
  const snap = await threadsOf(hotelId).doc(id).collection("messages").orderBy("at").get();
  return snap.docs.map((d) => d.data());
}

beforeEach(async () => {
  gemini.responses = [];
  gemini.requests = [];
  resetGeminiClient();
  resetRateLimits();
  const url = `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
  await fetch(url, { method: "DELETE" });
  const db = adminDb();
  await db.doc(`publicHotels/${PUBLIC_A}`).set({ hotelId: HOTEL_A });
  await db.doc(`publicHotels/${PUBLIC_B}`).set({ hotelId: HOTEL_B });
  await db.doc(`hotels/${HOTEL_A}`).set({ publicId: PUBLIC_A, name: "Lakeside Inn", currency: "UGX" });
  await db.doc(`hotels/${HOTEL_B}`).set({ publicId: PUBLIC_B, name: "Savannah Lodge", currency: "KES" });
  await db.doc(`hotels/${HOTEL_A}/rooms/r1`).set({ number: "101", type: "Double", price: 200000, status: "Available", hotelId: HOTEL_A });
});

describe("recording web conversations", () => {
  it("the first message opens a web conversation with both sides of the turn", async () => {
    gemini.responses = [answer("Hello! What dates are you thinking of?")];
    const res = await chat({ publicHotelId: PUBLIC_A, message: "Hi, do you have rooms?" });

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ handledBy: "ai", conversationId: expect.stringMatching(/^[A-Za-z0-9]{20}$/) });
    expect(JSON.stringify(res.body)).not.toContain(HOTEL_A);

    const id = String(res.body.conversationId);
    const thread = (await threadsOf(HOTEL_A).doc(id).get()).data()!;
    expect(thread).toMatchObject({
      channel: "web",
      guestName: "Web visitor",
      handledBy: "ai",
      bookingStatus: "none",
      messageCount: 2,
      mock: false,
      lead: { score: "cold", reasons: ["General questions only so far"] },
      hotelId: HOTEL_A,
      lastMessage: { role: "ai", text: "Hello! What dates are you thinking of?" },
    });
    expect((await messagesOf(HOTEL_A, id)).map((m) => [m.role, m.text])).toEqual([
      ["guest", "Hi, do you have rooms?"],
      ["ai", "Hello! What dates are you thinking of?"],
    ]);
  });

  it("the next message continues the same conversation", async () => {
    gemini.responses = [answer("Hello!"), answer("Sure, which dates?")];
    const first = await chat({ publicHotelId: PUBLIC_A, message: "Hi" });
    const id = first.body.conversationId;
    const second = await chat({ publicHotelId: PUBLIC_A, message: "A room please", conversationId: id });

    expect(second.body.conversationId).toBe(id);
    expect((await threadsOf(HOTEL_A).get()).size).toBe(1);
    expect((await threadsOf(HOTEL_A).doc(String(id)).get()).data()).toMatchObject({ messageCount: 4 });
  });

  it("marks a guest who saw availability as quoted, then as booked under their name — and never moves back", async () => {
    const stay = { hotel: PUBLIC_A, roomType: "Double", checkIn: "2031-06-01", checkOut: "2031-06-03" };
    const guest = { guestName: "Amina Okello", guestPhoneNumber: "+256 772 123 456" };
    gemini.responses = [
      callTool("check_availability", { hotel: PUBLIC_A, checkIn: "2031-06-01", checkOut: "2031-06-03" }),
      answer("A Double is free."),
      callTool("prepare_booking", { ...stay, ...guest }),
      answer("Here is your summary. Would you like me to confirm this booking?"),
      callTool("create_reservation", { ...stay, ...guest }),
      answer("Booked!"),
      answer("You're welcome."),
    ];
    const t1 = await chat({ publicHotelId: PUBLIC_A, message: "Free 1-3 June 2031?" });
    const id = String(t1.body.conversationId);
    expect((await threadsOf(HOTEL_A).doc(id).get()).data()).toMatchObject({ bookingStatus: "quoted" });

    await chat({ publicHotelId: PUBLIC_A, message: "Book it for Amina Okello, +256 772 123 456", conversationId: id });
    const t2 = await chat({ publicHotelId: PUBLIC_A, message: "Yes, confirm", conversationId: id });
    const booked = (await threadsOf(HOTEL_A).doc(id).get()).data()!;
    expect(booked).toMatchObject({
      bookingStatus: "booked",
      reservationId: (t2.body.booking as { reservationId: string }).reservationId,
      guestName: "Amina Okello",
      guestContact: "+256 772 123 456",
    });

    await chat({ publicHotelId: PUBLIC_A, message: "Thanks", conversationId: id });
    expect((await threadsOf(HOTEL_A).doc(id).get()).data()).toMatchObject({ bookingStatus: "booked", guestName: "Amina Okello" });
  });

  it("a turn the AI couldn't answer still reaches the inbox, with the guest's message", async () => {
    gemini.responses = ["fail"];
    const res = await chat({ publicHotelId: PUBLIC_A, message: "Hello?" });

    expect(res.statusCode).toBe(503);
    const id = String(res.body.conversationId);
    expect(id).toMatch(/^[A-Za-z0-9]{20}$/);
    expect((await threadsOf(HOTEL_A).doc(id).get()).data()).toMatchObject({
      messageCount: 1,
      lastMessage: { role: "guest", text: "Hello?" },
    });
  });

  it("retrying a message whose turn failed doesn't record it twice", async () => {
    gemini.responses = ["fail", "fail", answer("Yes, we do.")];
    const first = await chat({ publicHotelId: PUBLIC_A, message: "Do you have parking?", turnId: "abc123" });
    const id = String(first.body.conversationId);
    // The retry fails too, then succeeds: same message, same turn id.
    await chat({ publicHotelId: PUBLIC_A, message: "Do you have parking?", conversationId: id, turnId: "abc123" });
    const last = await chat({ publicHotelId: PUBLIC_A, message: "Do you have parking?", conversationId: id, turnId: "abc123" });

    expect(last.statusCode).toBe(200);
    expect((await messagesOf(HOTEL_A, id)).map((m) => [m.role, m.text])).toEqual([
      ["guest", "Do you have parking?"],
      ["ai", "Yes, we do."],
    ]);
    expect((await threadsOf(HOTEL_A).doc(id).get()).data()).toMatchObject({ messageCount: 2, pendingTurnId: "" });

    // A new message with a new id is recorded as usual.
    gemini.responses = [answer("Anything else?")];
    await chat({ publicHotelId: PUBLIC_A, message: "Great", conversationId: id, turnId: "def456" });
    expect((await threadsOf(HOTEL_A).doc(id).get()).data()).toMatchObject({ messageCount: 4 });
  });

  it("a staff reply written while the AI is still answering keeps its place and its count", async () => {
    gemini.responses = [answer("Hello!")];
    const first = await chat({ publicHotelId: PUBLIC_A, message: "Hi" });
    const id = String(first.body.conversationId);
    const ref = threadsOf(HOTEL_A).doc(id);

    gemini.responses = [
      async () => {
        // Staff step in during the model call, the way the inbox writes a reply.
        const at = new Date();
        await ref.collection("messages").add({ role: "staff", text: "Ruth here, I can help.", at, hotelId: HOTEL_A });
        await ref.update({ handledBy: "human", messageCount: FieldValue.increment(1), lastMessage: { role: "staff", text: "Ruth here, I can help.", at }, updatedAt: at });
        return answer("Our rooms start at 200,000.");
      },
    ];
    await chat({ publicHotelId: PUBLIC_A, message: "What are your prices?", conversationId: id });

    expect((await ref.get()).data()).toMatchObject({ messageCount: 5, handledBy: "human" });
    expect((await messagesOf(HOTEL_A, id)).map((m) => m.role)).toEqual(["guest", "ai", "guest", "staff", "ai"]);
  });

  it("an invalid hotel records nothing", async () => {
    const res = await chat({ publicHotelId: "no-such-hotel-00000000", message: "Hello" });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toHaveProperty("conversationId");
  });
});

describe("lead scoring", () => {
  it("scores a general question cold, and says why", async () => {
    gemini.responses = [answer("Yes, we have free parking.")];
    const res = await chat({ publicHotelId: PUBLIC_A, message: "Do you have parking?" });
    const thread = (await threadsOf(HOTEL_A).doc(String(res.body.conversationId)).get()).data()!;
    expect(thread.lead).toEqual({ score: "cold", reasons: ["General questions only so far"] });
  });

  it("warms up as the guest gives dates, then runs hot when they ask to book", async () => {
    gemini.responses = [answer("What dates suit you?"), answer("I can book that for you.")];
    const first = await chat({ publicHotelId: PUBLIC_A, message: "What do your double rooms cost next Friday?" });
    const id = String(first.body.conversationId);
    expect((await threadsOf(HOTEL_A).doc(id).get()).data()!.lead).toMatchObject({ score: "warm" });

    await chat({ publicHotelId: PUBLIC_A, message: "Please book it", conversationId: id });
    const thread = (await threadsOf(HOTEL_A).doc(id).get()).data()!;
    expect(thread.lead).toMatchObject({ score: "hot" });
    // Signals from the first message are still counted in the second score.
    expect(thread.lead.reasons).toEqual(expect.arrayContaining(["Asked to book", "Gave dates", "Asked about prices"]));
    expect(thread.leadSignals).toMatchObject({ askedPrice: true, gaveDates: true, askedToBook: true, guestMessages: 2 });
  });

  it("a confirmed suite booking for a special occasion is VIP", async () => {
    const booking = {
      hotel: PUBLIC_A,
      roomType: "Suite",
      checkIn: "2031-06-01",
      checkOut: "2031-06-04",
      guestName: "Amina Okello",
      guestPhoneNumber: "+256 772 123 456",
    };
    gemini.responses = [
      callTool("prepare_booking", booking),
      answer("Would you like me to confirm this booking?"),
      callTool("create_reservation", booking),
      answer("Booked!"),
    ];
    await adminDb().doc(`hotels/${HOTEL_A}/rooms/r2`).set({ number: "301", type: "Suite", price: 420000, status: "Available", hotelId: HOTEL_A });
    const first = await chat({ publicHotelId: PUBLIC_A, message: "Book the suite for our anniversary, 1-4 June 2031. Amina Okello, +256 772 123 456" });
    const res = await chat({ publicHotelId: PUBLIC_A, message: "Yes please", conversationId: first.body.conversationId });

    const thread = (await threadsOf(HOTEL_A).doc(String(res.body.conversationId)).get()).data()!;
    expect(thread.lead).toMatchObject({ score: "vip" });
    expect(thread.lead.reasons).toEqual(expect.arrayContaining(["Booked a room", "Wants a suite or an upgrade", "Travelling for a special occasion"]));
  });

  it("a turn the AI couldn't answer is still scored from what the guest said", async () => {
    gemini.responses = ["fail"];
    const res = await chat({ publicHotelId: PUBLIC_A, message: "I want to book a room for 6 people next weekend" });
    const thread = (await threadsOf(HOTEL_A).doc(String(res.body.conversationId)).get()).data()!;
    expect(thread.lead).toMatchObject({ score: "hot" });
  });
});

describe("follow-ups (D21)", () => {
  const millis = (value: unknown) => (value as { toMillis: () => number }).toMillis();

  it("records when the guest last wrote, which is what a wait is measured from", async () => {
    gemini.responses = [answer("Hello!")];
    const first = await chat({ publicHotelId: PUBLIC_A, message: "Hi" });
    const id = String(first.body.conversationId);

    const thread = (await threadsOf(HOTEL_A).doc(id).get()).data()!;
    const [guestMessage, aiMessage] = await messagesOf(HOTEL_A, id);
    expect(millis(thread.lastGuestAt)).toBe(millis(guestMessage.at));
    // Not the thread's last change: the AI answered after the guest.
    expect(millis(thread.lastGuestAt)).toBeLessThan(millis(aiMessage.at));
  });

  it("moves it forward as the guest writes again", async () => {
    gemini.responses = [answer("Hello!"), answer("Sure.")];
    const first = await chat({ publicHotelId: PUBLIC_A, message: "Hi" });
    const id = String(first.body.conversationId);
    const before = millis((await threadsOf(HOTEL_A).doc(id).get()).data()!.lastGuestAt);

    await chat({ publicHotelId: PUBLIC_A, message: "Any rooms next Friday?", conversationId: id });
    expect(millis((await threadsOf(HOTEL_A).doc(id).get()).data()!.lastGuestAt)).toBeGreaterThan(before);
  });

  it("a retried message doesn't move it: the guest has been waiting since they first wrote", async () => {
    gemini.responses = ["fail", answer("Yes, we do.")];
    const first = await chat({ publicHotelId: PUBLIC_A, message: "Do you have parking?", turnId: "abc123" });
    const id = String(first.body.conversationId);
    const waitingSince = millis((await threadsOf(HOTEL_A).doc(id).get()).data()!.lastGuestAt);

    await chat({ publicHotelId: PUBLIC_A, message: "Do you have parking?", conversationId: id, turnId: "abc123" });
    expect(millis((await threadsOf(HOTEL_A).doc(id).get()).data()!.lastGuestAt)).toBe(waitingSince);
  });
});

describe("staff take-over", () => {
  it("while staff handle a conversation the AI is not called and the guest gets the holding reply", async () => {
    gemini.responses = [answer("Hello!")];
    const first = await chat({ publicHotelId: PUBLIC_A, message: "Hi" });
    const id = String(first.body.conversationId);
    await threadsOf(HOTEL_A).doc(id).update({ handledBy: "human" });
    gemini.requests = [];

    const res = await chat({ publicHotelId: PUBLIC_A, message: "Can I bring my dog?", conversationId: id });

    expect(gemini.requests).toHaveLength(0);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ reply: HUMAN_HOLDING_REPLY, handledBy: "human", conversationId: id });
    const last = (await messagesOf(HOTEL_A, id)).slice(-2).map((m) => [m.role, m.text]);
    expect(last).toEqual([
      ["guest", "Can I bring my dog?"],
      ["ai", HUMAN_HOLDING_REPLY],
    ]);
  });
});

describe("conversation isolation", () => {
  it("another hotel's conversation id starts a fresh conversation instead of continuing it", async () => {
    gemini.responses = [answer("Hi from B"), answer("Hi from A")];
    const inB = await chat({ publicHotelId: PUBLIC_B, message: "Hello B" });
    const idB = String(inB.body.conversationId);

    const inA = await chat({ publicHotelId: PUBLIC_A, message: "Hello A", conversationId: idB });

    expect(inA.body.conversationId).not.toBe(idB);
    expect((await threadsOf(HOTEL_B).doc(idB).get()).data()).toMatchObject({ messageCount: 2 });
    expect((await threadsOf(HOTEL_A).doc(idB).get()).exists).toBe(false);
  });

  it("a mocked-channel thread can't be continued from the web concierge", async () => {
    await threadsOf(HOTEL_A).doc("WhatsAppThread000001").set({ channel: "whatsapp", handledBy: "ai", messageCount: 3, hotelId: HOTEL_A });
    gemini.responses = [answer("Hello!")];
    const res = await chat({ publicHotelId: PUBLIC_A, message: "Hi", conversationId: "WhatsAppThread000001" });
    expect(res.body.conversationId).not.toBe("WhatsAppThread000001");
    expect((await threadsOf(HOTEL_A).doc("WhatsAppThread000001").get()).data()).toMatchObject({ messageCount: 3 });
  });
});

describe("GET /api/ai/conversation", () => {
  async function staffReplied() {
    gemini.responses = [answer("Hello!")];
    const first = await chat({ publicHotelId: PUBLIC_A, message: "Hi" });
    const id = String(first.body.conversationId);
    const ref = threadsOf(HOTEL_A).doc(id);
    await ref.update({ handledBy: "human" });
    const at = Date.now() + 5_000;
    await ref.collection("messages").add({ role: "staff", text: "Hi, Ruth here from reservations.", at: new Date(at), hotelId: HOTEL_A });
    return { id, at };
  }

  it("returns messages after a point in time, and who is handling the chat", async () => {
    const { id, at } = await staffReplied();
    const res = await poll(`publicHotelId=${PUBLIC_A}&conversationId=${id}&after=${at - 1}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      handledBy: "human",
      messages: [{ role: "staff", text: "Hi, Ruth here from reservations.", at }],
    });
    expect(JSON.stringify(res.body)).not.toContain(HOTEL_A);
  });

  it("returns only staff replies — the guest's page already has its own side of the thread", async () => {
    const { id } = await staffReplied();
    const res = await poll(`publicHotelId=${PUBLIC_A}&conversationId=${id}`);
    expect((res.body.messages as { role: string }[]).map((m) => m.role)).toEqual(["staff"]);
  });

  it("can't read a conversation through another hotel's public id", async () => {
    const { id } = await staffReplied();
    const res = await poll(`publicHotelId=${PUBLIC_B}&conversationId=${id}`);
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain("Ruth");
  });

  it.each([
    ["an unknown id", "NoSuchThread00000001"],
    ["a malformed id", "../../x"],
    ["no id", ""],
  ])("fails safely for %s", async (_label, id) => {
    const res = await poll(`publicHotelId=${PUBLIC_A}&conversationId=${id}`);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ code: "invalid_request" });
  });
});
