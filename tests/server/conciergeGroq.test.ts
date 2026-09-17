/**
 * POST /api/ai/concierge on the deployed configuration — AI_PROVIDER=groq —
 * with the Groq SDK scripted.
 *
 * Everything else is real: the handler, the network context, the six hotel
 * tools, the booking guards, the conversation record and Firestore (the
 * emulator). It proves the provider switch changed nothing above the
 * provider line: the golden path books through the same tools, the
 * confirmation barrier holds against a Groq-shaped model, and every
 * provider failure reaches the guest as the standard safe response.
 *
 *   firebase emulators:start --only firestore   (then)   npm run test:server
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const PROJECT_ID = "innpilot-concierge-groq-test";
const KEY = "gsk_test_key_not_real_1111111111111111111111111111111";
process.env.FIRESTORE_EMULATOR_HOST ??= "127.0.0.1:8080";
process.env.FIREBASE_PROJECT_ID = PROJECT_ID;
process.env.AI_PROVIDER = "groq";
process.env.GROQ_API_KEY = KEY;
delete process.env.GROQ_MODEL;
delete process.env.FIREBASE_SERVICE_ACCOUNT;

type Body = Record<string, unknown>;
type Step = Body | "hang" | Error | ((body: Body) => Body);
const groq = vi.hoisted(() => ({ script: [] as unknown[], requests: [] as Record<string, unknown>[] }));

vi.mock("groq-sdk", () => ({
  default: class {
    chat = {
      completions: {
        create: async (body: Record<string, unknown>, options: { signal?: AbortSignal }) => {
          const recorded = JSON.parse(JSON.stringify(body));
          groq.requests.push(recorded);
          const next = groq.script.shift() as Step | undefined;
          if (!next) throw new Error("No scripted Groq response left.");
          if (next instanceof Error) throw next;
          if (next === "hang") return new Promise((_, reject) => options.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
          return typeof next === "function" ? next(recorded) : next;
        },
      },
    };
  },
}));

import handler from "../../api/ai/concierge";
import { adminDb } from "../../server/admin";
import { resetGroqClient } from "../../server/ai/groq";
import { resetRateLimits } from "../../server/ai/rateLimit";
import { ALL_HOTEL_IDS, clearEmulator, GUEST, KABALE, MBARARA, seedNetwork, STAY } from "./fixtures/network";

let callNumber = 0;
/** A Groq completion asking for tools. */
function callTools(...calls: { name: string; args: Record<string, unknown> }[]): Body {
  return {
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          tool_calls: calls.map((call) => ({ id: `fc_${++callNumber}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } })),
        },
      },
    ],
    usage: { prompt_tokens: 2500, completion_tokens: 40 },
  };
}
const answer = (content: string): Body => ({ choices: [{ finish_reason: "stop", message: { role: "assistant", content } }], usage: { prompt_tokens: 2600, completion_tokens: 90 } });

/** The tool results sent back to Groq in a request, parsed. */
function toolResults(body: Body): Record<string, unknown>[] {
  const messages = body.messages as { role: string; content: string }[];
  const results: Record<string, unknown>[] = [];
  for (let i = messages.length - 1; i >= 0 && messages[i].role === "tool"; i--) results.unshift(JSON.parse(messages[i].content));
  return results;
}

function apiError(status: number, headers: Record<string, string> = {}, body: Record<string, unknown> = {}) {
  return Object.assign(new Error(`${status} ${JSON.stringify(body)}`), { status, headers: new Headers(headers), error: body });
}

async function post(body: Record<string, unknown>) {
  const res = {
    statusCode: 0,
    body: undefined as unknown as Record<string, unknown>,
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload as Record<string, unknown>;
    },
    end() {},
  };
  await handler({ method: "POST", headers: {}, body, socket: { remoteAddress: "10.0.0.9" }, async *[Symbol.asyncIterator]() {} }, res);
  return res;
}

function guest() {
  const history: { role: "user" | "assistant"; content: string }[] = [];
  let conversationId: string | undefined;
  return {
    get conversationId() {
      return conversationId;
    },
    async say(message: string) {
      const res = await post({ message, history: [...history], ...(conversationId ? { conversationId } : {}) });
      if (typeof res.body.conversationId === "string") conversationId = res.body.conversationId;
      if (res.statusCode === 200) history.push({ role: "user", content: message }, { role: "assistant", content: String(res.body.reply) });
      return res;
    },
  };
}

const kabaleDouble = { hotel: KABALE.publicId, roomType: "Double", ...STAY };
const bookingsAt = async (hotelId: string) => (await adminDb().collection(`hotels/${hotelId}/accomodation`).where("guestName", "==", GUEST.guestName).get()).docs.map((d) => d.data());

beforeEach(async () => {
  groq.script = [];
  groq.requests = [];
  resetGroqClient();
  resetRateLimits();
  vi.restoreAllMocks();
  await clearEmulator(PROJECT_ID);
  await seedNetwork(adminDb());
});

describe("the golden path on Groq", () => {
  it("search → select → guest details → summary → confirm → a real reservation", async () => {
    const browser = guest();

    /* 1 — search: the model's arguments reach the real search tool; figures come back from Firestore. */
    groq.script = [
      callTools({ name: "search_hotels", args: { destination: "Western Uganda", roomType: "Double", ...STAY } }),
      (body) => {
        const [search] = toolResults(body);
        const options = search.options as { hotelName: string; nightlyRate: number; nights: number; stayTotal: number }[];
        return answer(options.map((o, i) => `${i + 1}. ${o.hotelName} ${o.nightlyRate}×${o.nights}=${o.stayTotal}`).join("\n"));
      },
    ];
    const t1 = await browser.say("I need a double room between 10th and 15th October in Western Uganda.");
    expect(t1.statusCode).toBe(200);
    expect(t1.body.reply).toBe("1. K Hotels Kabale 180000×5=900000\n2. K Hotels Mbarara 210000×5=1050000");
    expect(t1.body.search).toMatchObject({
      checkIn: "2031-10-10",
      checkOut: "2031-10-15",
      nights: 5,
      options: [
        expect.objectContaining({ hotel: KABALE.publicId, nightlyRate: 180000, nights: 5, stayTotal: 900000 }),
        expect.objectContaining({ hotel: MBARARA.publicId, nightlyRate: 210000, stayTotal: 1050000 }),
      ],
    });
    // Groq was sent the concierge prompt and all six tools as functions, on the default model.
    const first = groq.requests[0] as { model: string; messages: { role: string; content: string }[]; tools: { type: string; function: { name: string } }[] };
    expect(first.model).toBe("openai/gpt-oss-120b");
    expect(first.messages[0].role).toBe("system");
    expect(first.messages[0].content).toContain("You are InnPilot AI Concierge");
    expect(first.tools.map((t) => `${t.type}:${t.function.name}`)).toEqual([
      "function:search_hotels",
      "function:check_availability",
      "function:get_hotel_info",
      "function:calculate_stay_price",
      "function:prepare_booking",
      "function:create_reservation",
    ]);

    /* 2 — select. */
    groq.script = [answer("Great choice. May I have your full name and phone number?")];
    expect((await browser.say("I'll take the Kabale one.")).statusCode).toBe(200);

    /* 3 — details → prepare_booking: a summary, and still no reservation. */
    groq.script = [callTools({ name: "prepare_booking", args: { ...kabaleDouble, ...GUEST } }), answer("Summary… Would you like me to confirm this booking?")];
    const t3 = await browser.say("Amina Okello, +256 772 123 456");
    expect(t3.body.quote).toMatchObject({ hotelName: "K Hotels Kabale", roomType: "Double", nights: 5, guestName: "Amina Okello", guestPhone: "+256 772 123 456", totalPrice: 900000 });
    expect(t3.body).not.toHaveProperty("booking");
    expect(await bookingsAt(KABALE.hotelId)).toHaveLength(0);

    /* 4 — explicit confirmation → create_reservation → the real reference. */
    groq.script = [
      callTools({ name: "create_reservation", args: { ...kabaleDouble, ...GUEST } }),
      (body) => answer(`Booking confirmed. Your reference is ${(toolResults(body)[0].booking as { reservationId: string }).reservationId}.`),
    ];
    const t4 = await browser.say("Yes, book it.");
    expect(t4.statusCode).toBe(200);
    const booking = t4.body.booking as { reservationId: string; totalPrice: number };
    expect(booking.reservationId).toMatch(/^RSV-\d{8}-[A-Z0-9]{6}$/);
    expect(booking.totalPrice).toBe(900000);
    expect(t4.body.reply).toBe(`Booking confirmed. Your reference is ${booking.reservationId}.`);
    expect(await bookingsAt(KABALE.hotelId)).toEqual([
      expect.objectContaining({ reservationId: booking.reservationId, source: "concierge", status: "Confirmed", quotedTotal: 900000 }),
    ]);

    // No workspace id reached the guest or Groq, at any turn.
    const everything = JSON.stringify([t1.body, t3.body, t4.body, groq.requests]);
    for (const hotelId of ALL_HOTEL_IDS) expect(everything).not.toContain(hotelId);
  });
});

describe("the confirmation barrier holds against the model", () => {
  it("refuses create_reservation in the same turn as prepare_booking", async () => {
    groq.script = [
      callTools({ name: "prepare_booking", args: { ...kabaleDouble, ...GUEST } }),
      callTools({ name: "create_reservation", args: { ...kabaleDouble, ...GUEST } }),
      (body) => answer(`Result: ${JSON.stringify(toolResults(body)[0])}`),
    ];
    const res = await guest().say("Book the Kabale double for Amina Okello, +256 772 123 456, yes confirm.");
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toHaveProperty("booking");
    expect(String(res.body.reply)).toContain('"reason":"needs_confirmation"');
    expect(await bookingsAt(KABALE.hotelId)).toHaveLength(0);
  });

  it("refuses create_reservation when the guest's message is not an explicit yes", async () => {
    const browser = guest();
    groq.script = [callTools({ name: "prepare_booking", args: { ...kabaleDouble, ...GUEST } }), answer("Would you like me to confirm this booking?")];
    await browser.say("Kabale double please. Amina Okello, +256 772 123 456");
    groq.script = [callTools({ name: "create_reservation", args: { ...kabaleDouble, ...GUEST } }), answer("Not booked.")];
    const res = await browser.say("Hmm, what's the cancellation policy?");
    expect(res.body).not.toHaveProperty("booking");
    expect(await bookingsAt(KABALE.hotelId)).toHaveLength(0);
  });
});

describe("provider failures reach the guest as the safe unavailable response", () => {
  const SAFE = "I can't reach the hotel assistant right now. Please try again in a moment, or contact the hotel team directly and they'll help you.";

  function expectNothingLeaked(body: Record<string, unknown>) {
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/groq|gsk_|openai|gpt-oss|rate_limit|Error:|\s+at\s+\S+:\d+|stack/i);
    for (const hotelId of ALL_HOTEL_IDS) expect(text).not.toContain(hotelId);
  }

  it("a missing GROQ_API_KEY", async () => {
    delete process.env.GROQ_API_KEY;
    try {
      const res = await guest().say("Any rooms in Kabale?");
      expect(res.statusCode).toBe(503);
      expect(res.body).toMatchObject({ error: SAFE, code: "not_configured" });
      expect(groq.requests).toHaveLength(0);
      expectNothingLeaked(res.body);
    } finally {
      process.env.GROQ_API_KEY = KEY;
    }
  });

  it("a Groq 429 with a long retry-after: one request, no retry storm", async () => {
    groq.script = [apiError(429, { "retry-after": "42" }, { error: { code: "rate_limit_exceeded", message: `Rate limit reached for model openai/gpt-oss-120b, key ${KEY}` } })];
    const logged: unknown[] = [];
    vi.spyOn(console, "error").mockImplementation((...args) => void logged.push(args));
    const res = await guest().say("Any rooms in Kabale?");
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ error: SAFE, code: "unavailable", conversationId: expect.any(String) });
    expect(groq.requests).toHaveLength(1);
    expectNothingLeaked(res.body);
    // The operator log has the diagnosis, and not the key.
    expect(JSON.stringify(logged)).toContain("HTTP 429, rate_limit_exceeded; retry-after 42000ms");
    expect(JSON.stringify(logged)).not.toContain(KEY);
  });

  it("a Groq timeout", async () => {
    process.env.GROQ_TIMEOUT_MS = "1000";
    try {
      groq.script = ["hang"];
      const res = await guest().say("Any rooms in Kabale?");
      expect(res.statusCode).toBe(504);
      expect(res.body.error).toBe("That took longer than expected and I had to stop waiting. Please try asking again.");
      expectNothingLeaked(res.body);
    } finally {
      delete process.env.GROQ_TIMEOUT_MS;
    }
  });

  it("an invalid model response", async () => {
    groq.script = [callTools({ name: "search_hotels", args: {} })];
    (groq.script[0] as { choices: { message: { tool_calls: { function: { arguments: string } }[] } }[] }).choices[0].message.tool_calls[0].function.arguments = "{broken";
    const res = await guest().say("Any rooms in Kabale?");
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ error: SAFE, code: "unavailable" });
    expectNothingLeaked(res.body);
  });

  it("a Groq outage (5xx twice)", async () => {
    groq.script = [apiError(500), apiError(503)];
    const res = await guest().say("Any rooms in Kabale?");
    expect(res.statusCode).toBe(503);
    expect(res.body.error).toBe(SAFE);
    expect(groq.requests).toHaveLength(2);
    expectNothingLeaked(res.body);
  });
});
