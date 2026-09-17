/**
 * Live concierge verification: the REAL Gemini API, against the Firestore
 * emulator or a real Firebase project (TEST_PLAN.md §5).
 *
 * The automated suites script the model. This script doesn't: it holds real
 * conversations through the real POST /api/ai/concierge handler, then reads
 * the emulator to check what actually happened. It proves Gemini chooses
 * and calls the tools, the tools reach Firestore through Firebase Admin, and
 * the answers come back from the results.
 *
 * Two modes.
 *
 * Emulator (default, TEST_PLAN §5 Part A). It only ever talks to a
 * Firestore emulator on this machine, refuses to start if
 * FIRESTORE_EMULATOR_HOST points anywhere else, and clears and seeds only
 * its own emulator project id.
 *
 *   npx firebase emulators:start --only firestore     (then)
 *   npm run verify:live
 *
 * Real project (`--real-firestore`, TEST_PLAN §5 Part B). Uses the Firebase
 * Admin credential in FIREBASE_SERVICE_ACCOUNT, and only when
 * LIVE_VERIFY_PROJECT names the same project id as that credential — a
 * typed confirmation of which project gets written. In that mode it:
 *   - creates two new test hotels under fresh random ids, with `create()`
 *     only, so no existing document can be overwritten;
 *   - reads and writes nothing outside those two hotels and their
 *     publicHotels entries;
 *   - deletes nothing, and prints every document path it created, for
 *     cleanup once someone decides to remove them.
 *
 *   LIVE_VERIFY_PROJECT=<project id> npm run verify:live -- --real-firestore
 *
 * Needs GEMINI_API_KEY in .env. Costs a few dozen real model calls. A model
 * is not deterministic, so each check states what it accepts; the script
 * exits non-zero if any check fails.
 */
import { config } from "dotenv";
import type { DocumentData } from "firebase-admin/firestore";
config({ quiet: true });

function refuse(reason: string): never {
  console.error(`Refusing to run: ${reason}`);
  process.exit(2);
}

const REAL = process.argv.includes("--real-firestore");
if (!process.env.GEMINI_API_KEY?.trim()) refuse("GEMINI_API_KEY is not set.");

let EMULATOR = "";
let PROJECT_ID: string;
if (REAL) {
  if (process.env.FIRESTORE_EMULATOR_HOST) refuse("--real-firestore was given but FIRESTORE_EMULATOR_HOST is set.");
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT?.trim() ?? "";
  let credentialProject: unknown;
  try {
    credentialProject = JSON.parse(raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8")).project_id;
  } catch {
    refuse("FIREBASE_SERVICE_ACCOUNT is not service-account key JSON (or base64 of it).");
  }
  if (typeof credentialProject !== "string" || !credentialProject) refuse("the service account has no project_id.");
  if (process.env.LIVE_VERIFY_PROJECT !== credentialProject) {
    refuse(`set LIVE_VERIFY_PROJECT=${credentialProject} to confirm that this project's Firestore is the one written.`);
  }
  PROJECT_ID = credentialProject;
  process.env.FIREBASE_PROJECT_ID = PROJECT_ID;
} else {
  EMULATOR = process.env.FIRESTORE_EMULATOR_HOST ??= "127.0.0.1:8080";
  if (!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(EMULATOR)) {
    refuse(`FIRESTORE_EMULATOR_HOST is '${EMULATOR}', not a local emulator.`);
  }
  PROJECT_ID = "innpilot-live-verify";
  process.env.FIREBASE_PROJECT_ID = PROJECT_ID;
}

/**
 * Gemini's free tier allows a handful of requests per minute per model, and
 * one tool-using guest turn makes 2–4 of them. The script paces itself
 * *between* turns (never inside one, which would eat the turn's timeout).
 * Set LIVE_VERIFY_RPM to your key's real limit; a paid key can go higher.
 */
const RPM = Number(process.env.LIVE_VERIFY_RPM ?? 5);
const CALLS_RESERVED_PER_TURN = Math.min(4, RPM);

/** Every Gemini HTTP call, timed — installed before the SDK is loaded. */
const geminiCalls: { at: number; ms: number; status: number }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.includes("generativelanguage.googleapis.com")) return realFetch(input, init);
  const at = Date.now();
  const entry = { at, ms: 0, status: 0 };
  geminiCalls.push(entry);
  try {
    const response = await realFetch(input, init);
    entry.status = response.status;
    return response;
  } finally {
    entry.ms = Date.now() - at;
  }
};

const { default: handler } = await import("../../api/ai/concierge");
const { adminDb } = await import("../../server/admin");
const { checkHealth } = await import("../../server/ai/gemini");

type Message = { role: "user" | "assistant"; content: string };
type ToolLog = { tool: string; outcome: string };
type Turn = {
  status: number;
  body: Record<string, unknown>;
  /** Tools run, from the handler's success log. */
  tools: string[];
  /** Every tool run with its outcome, from the per-tool log — present even when the turn failed. */
  toolLog: ToolLog[];
  failure?: string;
  calls: { ms: number; status: number }[];
  ms: number;
};

const { makePublicHotelId } = await import("../../src/lib/publicHotel");

/** A fresh Firestore-style 20-character id, so a real-project run can't collide with a real hotel. */
function freshHotelId(prefix: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(20 - prefix.length));
  return prefix + Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

const HOTEL_A = REAL ? freshHotelId("VerifyA") : "LiveVerifyHotelA0001";
const HOTEL_B = REAL ? freshHotelId("VerifyB") : "LiveVerifyHotelB0001";
const PUBLIC_A = REAL ? makePublicHotelId("verify lakeside inn") : "lakeside-inn-live000a";
const PUBLIC_B = REAL ? makePublicHotelId("verify savannah lodge") : "savannah-lodge-live00b";
/** Every document this run created, printed at the end of a real-project run. */
const created: string[] = [];

/** A stay safely in the future, as YYYY-MM-DD and as a phrase a guest would type. */
function futureDate(daysAhead: number) {
  const date = new Date(Date.now() + daysAhead * 86_400_000);
  const iso = date.toISOString().slice(0, 10);
  const words = date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  return { iso, words, at: new Date(`${iso}T12:00:00Z`) };
}
const CHECK_IN = futureDate(60);
const CHECK_OUT = futureDate(62);

/* ---------------------------------------------------------------- */
/* Log capture: the handler logs which tools ran on each turn.       */
/* ---------------------------------------------------------------- */

const captured: { level: string; args: unknown[] }[] = [];
for (const level of ["info", "error", "warn", "log"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    captured.push({ level, args });
    if (level === "error") original(...args);
  };
}
const print = (...args: unknown[]) => process.stdout.write(`${args.join(" ")}\n`);

/* ---------------------------------------------------------------- */
/* Seed                                                              */
/* ---------------------------------------------------------------- */

async function seed() {
  if (!REAL) {
    const res = await fetch(`http://${EMULATOR}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`, {
      method: "DELETE",
    });
    if (!res.ok) throw new Error(`Could not clear the emulator project: ${res.status}`);
  }

  const db = adminDb();
  // create(), never set(): fails instead of overwriting anything that already exists.
  const put = async (path: string, data: DocumentData) => {
    await db.doc(path).create(data);
    created.push(path);
  };
  const label = REAL ? " (InnPilot verification test data)" : "";

  await put(`publicHotels/${PUBLIC_A}`, { hotelId: HOTEL_A });
  await put(`publicHotels/${PUBLIC_B}`, { hotelId: HOTEL_B });
  await put(`hotels/${HOTEL_A}`, {
    publicId: PUBLIC_A,
    name: `Lakeside Inn${label}`,
    location: "Entebbe",
    currency: "UGX",
    phone: "+256 700 111 222",
    email: "stay@lakeside.example",
    subscription: { plan: "trial", status: "active" },
  });
  await put(`hotels/${HOTEL_B}`, {
    publicId: PUBLIC_B,
    name: `Savannah Lodge${label}`,
    location: "Nairobi",
    currency: "KES",
    phone: "+254 700 333 444",
    email: "hello@savannah.example",
    subscription: { plan: "trial", status: "active" },
  });

  const roomsA = [
    { id: "a101", number: "101", type: "Single", price: 150000, status: "Available" },
    { id: "a201", number: "201", type: "Double", price: 220000, status: "Available" },
    { id: "a202", number: "202", type: "Double", price: 240000, status: "Available" },
    { id: "a301", number: "301", type: "Suite", price: 420000, status: "Maintenance" },
  ];
  for (const { id, ...room } of roomsA) await put(`hotels/${HOTEL_A}/rooms/${id}`, { ...room, hotelId: HOTEL_A });
  await put(`hotels/${HOTEL_B}/rooms/b901`, { number: "901", type: "Suite", price: 15000, status: "Available", hotelId: HOTEL_B });

  // Room 201 is already taken for the stay dates by a front-desk booking.
  await put(`hotels/${HOTEL_A}/accomodation/frontdesk1`, {
    guestName: "Front Desk Guest",
    roomNumber: "201",
    checkIn: CHECK_IN.at,
    checkOut: CHECK_OUT.at,
    status: "Confirmed",
    hotelId: HOTEL_A,
  });
}

/* ---------------------------------------------------------------- */
/* Calling the real handler                                          */
/* ---------------------------------------------------------------- */

let callerSeq = 0;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until a whole turn's worth of calls fits in the key's per-minute quota. */
async function paceForQuota() {
  for (;;) {
    const windowStart = Date.now() - 61_000;
    const recent = geminiCalls.filter((call) => call.at > windowStart);
    if (recent.length + CALLS_RESERVED_PER_TURN <= RPM) return;
    const waitMs = recent[recent.length + CALLS_RESERVED_PER_TURN - RPM - 1].at - windowStart + 250;
    print(`  … pacing ${Math.ceil(waitMs / 1000)}s for the Gemini quota (${RPM}/min)`);
    await sleep(waitMs);
  }
}

async function sendOnce(body: Record<string, unknown>, caller: string): Promise<Turn> {
  const res = {
    statusCode: 0,
    body: {} as Record<string, unknown>,
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
  const req = { method: "POST", headers: {}, body, socket: { remoteAddress: caller }, async *[Symbol.asyncIterator]() {} };

  await paceForQuota();
  const before = captured.length;
  const callsBefore = geminiCalls.length;
  const started = Date.now();
  await handler(req, res);

  const logs = captured.slice(before);
  const payload = (tag: string) => logs.filter((entry) => entry.args[0] === tag).map((entry) => entry.args[1] as Record<string, unknown>);
  return {
    status: res.statusCode,
    body: res.body,
    tools: (payload("[concierge] ok")[0]?.tools as string[] | undefined) ?? [],
    toolLog: payload("[concierge] tool").map((log) => ({ tool: String(log.tool), outcome: String(log.outcome) })),
    failure: payload("[concierge] failed")[0]?.detail as string | undefined,
    calls: geminiCalls.slice(callsBefore).map(({ ms, status }) => ({ ms, status })),
    ms: Date.now() - started,
  };
}

/**
 * One guest turn. A turn Gemini's quota refused *before any tool ran* is
 * retried once after the quota window — a turn that already ran a tool
 * never is, since repeating it could repeat a booking.
 */
async function send(body: Record<string, unknown>, caller: string): Promise<Turn> {
  const turn = await sendOnce(body, caller);
  if (turn.status === 200 || turn.toolLog.length > 0 || !/HTTP 429/.test(turn.failure ?? "")) return turn;
  print(`  … Gemini quota refused the turn before any tool ran; retrying once in 61s`);
  await sleep(61_000);
  return sendOnce(body, caller);
}

class Conversation {
  readonly history: Message[] = [];
  readonly turns: Turn[] = [];
  private readonly caller = `10.9.0.${++callerSeq}`;
  private readonly publicHotelId: string;
  constructor(publicHotelId: string) {
    this.publicHotelId = publicHotelId;
  }

  async say(message: string): Promise<Turn> {
    const turn = await send({ publicHotelId: this.publicHotelId, message, history: this.history }, this.caller);
    this.turns.push(turn);
    print(`\n  guest › ${message}`);
    print(
      `  [${turn.status}] ${turn.ms}ms tools=${JSON.stringify(turn.toolLog.map((t) => `${t.tool}:${t.outcome}`))} ` +
        `gemini calls=${JSON.stringify(turn.calls.map((c) => `${c.status}/${c.ms}ms`))}`
    );
    if (turn.failure) print(`  failure: ${turn.failure.slice(0, 160)}`);
    print(`  concierge › ${String(turn.body.reply ?? turn.body.error).replace(/\n+/g, "\n              ")}`);
    if (turn.status === 200) {
      this.history.push({ role: "user", content: message }, { role: "assistant", content: String(turn.body.reply) });
    }
    return turn;
  }

  get allTools(): string[] {
    return this.turns.flatMap((turn) => turn.toolLog.map((t) => t.tool));
  }

  get allAnswered(): boolean {
    return this.turns.length > 0 && this.turns.every((turn) => turn.status === 200);
  }
}

/* ---------------------------------------------------------------- */
/* Checks                                                            */
/* ---------------------------------------------------------------- */

const results: { name: string; pass: boolean; detail: string }[] = [];
function check(name: string, pass: boolean, detail = "") {
  results.push({ name, pass, detail });
  print(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

/** "UGX 220,000" / "220 000" / "220000" all contain 220000 once separators are gone. */
const digits = (text: unknown) => String(text).replace(/(?<=\d)[,\s.](?=\d{3}\b)/g, "");

const bookingsIn = async (hotelId: string) =>
  (await adminDb().collection(`hotels/${hotelId}/accomodation`).get()).docs.map((doc) => doc.data());
const conciergeBookings = async (hotelId: string) => (await bookingsIn(hotelId)).filter((b) => b.source === "concierge");
const auditIn = async (hotelId: string) =>
  (await adminDb().collection(`hotels/${hotelId}/auditLog`).get()).docs.map((doc) => doc.data());

async function run() {
  print(`Live concierge verification — real Gemini, ${REAL ? "REAL Firestore" : `emulator ${EMULATOR}`}, project ${PROJECT_ID}`);
  print(`Stay under test: ${CHECK_IN.iso} → ${CHECK_OUT.iso}`);

  print("\n[0] Health");
  const health = await checkHealth({ probe: true });
  check("health probe reaches Gemini", health.reachable === true, `model=${health.model} finish=${health.finishReason ?? "-"} ${health.latencyMs}ms${health.error ? ` error=${health.error.slice(0, 160)}` : ""}`);

  await seed();

  print("\n[1] Hotel information");
  const info = new Conversation(PUBLIC_A);
  const t1 = await info.say("Hi! Where is the hotel, and how can I contact you?");
  check("200 reply", t1.status === 200);
  check("Gemini called get_hotel_info", t1.tools.includes("get_hotel_info"), JSON.stringify(t1.tools));
  check("reply uses the stored city or contact", /Entebbe|700 111 222|stay@lakeside\.example/.test(String(t1.body.reply)));

  print("\n[2] Room types and rates");
  const rates = new Conversation(PUBLIC_A);
  const t2 = await rates.say("What kinds of rooms do you have and what do they cost per night?");
  check("200 reply", t2.status === 200);
  check("Gemini called a rate/room tool", t2.tools.some((t) => t === "get_room_rates" || t === "check_availability"), JSON.stringify(t2.tools));
  const t2text = digits(t2.body.reply);
  check("reply quotes the seeded rates", ["150000", "220000", "240000"].every((rate) => t2text.includes(rate)), "expects 150000, 220000 and 240000");

  print("\n[3] Availability, then booking");
  const guest = new Conversation(PUBLIC_A);
  const t3 = await guest.say(`Is a Double room available from ${CHECK_IN.words} to ${CHECK_OUT.words}?`);
  check("200 reply", t3.status === 200);
  check("Gemini called check_availability", t3.tools.includes("check_availability"), JSON.stringify(t3.tools));
  const t3text = String(t3.body.reply);
  check("reply offers the free Double (202)", /\b202\b/.test(t3text) || digits(t3text).includes("240000"));
  check("reply does not offer the booked Double (201)", !/\b201\b/.test(t3text) || /not available|unavailable|booked|taken/i.test(t3text));

  await guest.say("Great, I'd like to book room 202 for those dates. My name is Amina Okello, phone +256 772 123 456, and we are 2 guests.");
  for (let attempt = 0; attempt < 3 && (await conciergeBookings(HOTEL_A)).length === 0; attempt++) {
    await guest.say("Yes, that's all correct. Please confirm the booking.");
  }

  const booked = await conciergeBookings(HOTEL_A);
  check("Gemini called create_reservation", guest.allTools.includes("create_reservation"), JSON.stringify(guest.allTools));
  check("exactly one concierge booking in Firestore", booked.length === 1, `found ${booked.length}`);
  const booking: DocumentData = booked[0] ?? {};
  check("booking: room 202, Double", booking.roomNumber === "202" && booking.roomType === "Double");
  check(
    "booking: the requested dates",
    booking.checkIn?.toDate?.().toISOString().slice(0, 10) === CHECK_IN.iso &&
      booking.checkOut?.toDate?.().toISOString().slice(0, 10) === CHECK_OUT.iso,
    `${booking.checkIn?.toDate?.().toISOString()} → ${booking.checkOut?.toDate?.().toISOString()}`
  );
  check("booking: guest name and phone", /amina okello/i.test(String(booking.guestName)) && /772\s?123\s?456/.test(String(booking.guestPhoneNumber)));
  check("booking: priced from the room (2 × 240000)", booking.quotedTotal === 480000, `quotedTotal=${booking.quotedTotal}`);
  check("booking: source concierge, Confirmed, payment Pending", booking.source === "concierge" && booking.status === "Confirmed" && booking.paymentStatus === "Pending");
  check("booking: hotelId matches its path", booking.hotelId === HOTEL_A);
  const reference = String(booking.reservationId ?? "");
  check("guest was given the reservation reference", guest.turns.some((turn) => String(turn.body.reply).includes(reference)) && reference.startsWith("RSV-"), reference);
  const audit = (await auditIn(HOTEL_A)).filter((entry) => entry.action === "Booking created");
  check("one audit entry for the booking", audit.length === 1 && String(audit[0]?.details).includes(reference), audit.map((a) => a.details).join(" | "));

  print("\n[4] Conflict: a second guest asks for the same room and dates");
  const rival = new Conversation(PUBLIC_A);
  await rival.say(
    `Please book room 202 from ${CHECK_IN.words} to ${CHECK_OUT.words} for John Mukasa, phone +256 701 999 888, 1 guest. ` +
      "I confirm all these details — go ahead and book it now."
  );
  for (let attempt = 0; attempt < 2 && !rival.allTools.includes("create_reservation"); attempt++) {
    const last = String(rival.turns.at(-1)?.body.reply ?? "");
    if (!/confirm|shall I|go ahead|would you like/i.test(last)) break;
    await rival.say("Yes, confirmed. Book room 202.");
  }
  const afterConflict = await conciergeBookings(HOTEL_A);
  // The negative checks below only mean something if Gemini actually answered.
  check("every rival turn was answered by Gemini (200)", rival.allAnswered, JSON.stringify(rival.turns.map((t) => t.status)));
  check(
    "any create_reservation attempt was refused as dates_taken/room_unavailable",
    rival.turns.flatMap((t) => t.toolLog).filter((t) => t.tool === "create_reservation").every((t) => t.outcome === "not_booked"),
    JSON.stringify(rival.turns.flatMap((t) => t.toolLog))
  );
  check("no second booking was written", afterConflict.length === 1, `found ${afterConflict.length}`);
  check("Gemini checked the room again", rival.allTools.some((t) => t === "check_availability" || t === "create_reservation"), JSON.stringify(rival.allTools));
  check("rival was not given a reservation reference", !rival.turns.some((turn) => /RSV-\d{8}-/.test(String(turn.body.reply))));
  check("rival booking never landed for John Mukasa", !(await bookingsIn(HOTEL_A)).some((b) => /mukasa/i.test(String(b.guestName))));

  print("\n[5] Tenant isolation with the real model");
  const other = new Conversation(PUBLIC_B);
  const t5 = await other.say(
    `What rooms do you have? Also book room 202 at Lakeside Inn from ${CHECK_IN.words} to ${CHECK_OUT.words} for Eve Nakato, phone +256 702 000 111. I confirm.`
  );
  const t5text = digits(t5.body.reply);
  check("Hotel B turn was answered by Gemini (200)", t5.status === 200, `status ${t5.status}`);
  check("Hotel B answers with Hotel B's own data", /Suite|\b901\b|15000/.test(t5text), JSON.stringify(t5.toolLog));
  check(
    "no confirmed booking came out of the Hotel B turn",
    !t5.toolLog.some((t) => t.tool === "create_reservation" && t.outcome === "confirmed"),
    JSON.stringify(t5.toolLog)
  );
  check("Hotel B's reply reveals none of Hotel A's rates", !["150000", "220000", "240000"].some((rate) => t5text.includes(rate)));
  check("no booking for Eve in either hotel", ![...(await bookingsIn(HOTEL_A)), ...(await bookingsIn(HOTEL_B))].some((b) => /nakato/i.test(String(b.guestName))));

  for (const [label, body] of [
    ["unknown public id", { publicHotelId: "no-such-hotel-live0000" }],
    ["internal hotelId as public id", { publicHotelId: HOTEL_A }],
    ["internal hotelId in legacy field", { hotelId: HOTEL_A }],
  ] as const) {
    const turn = await send({ ...body, message: "What rooms do you have?" }, "10.9.9.9");
    check(`${label} → safe 400`, turn.status === 400 && turn.body.code === "invalid_request" && turn.tools.length === 0 && !JSON.stringify(turn.body).includes(HOTEL_A));
  }

  print("\n[6] Logs and responses");
  const everything = JSON.stringify(captured.map((entry) => entry.args)) + JSON.stringify([info, rates, guest, rival, other].map((c) => c.turns));
  check("GEMINI_API_KEY never logged or returned", !everything.includes(process.env.GEMINI_API_KEY!.trim()));
  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT?.trim();
  check("FIREBASE_SERVICE_ACCOUNT never logged or returned", !serviceAccount || !everything.includes(serviceAccount));
  const responses = JSON.stringify([info, rates, guest, rival, other].map((c) => c.turns.map((t) => t.body)));
  check("no internal hotelId in any response", ![HOTEL_A, HOTEL_B].some((id) => responses.includes(id)));

  if (REAL) {
    // Everything this run left behind in the real project, including what the concierge wrote.
    for (const hotelId of [HOTEL_A, HOTEL_B]) {
      for (const name of ["accomodation", "auditLog"]) {
        const snap = await adminDb().collection(`hotels/${hotelId}/${name}`).get();
        for (const doc of snap.docs) if (!created.includes(doc.ref.path)) created.push(doc.ref.path);
      }
    }
    print(`\nDocuments created in project ${PROJECT_ID} (nothing was deleted):`);
    for (const path of created) print(`  ${path}`);
  }

  const failed = results.filter((r) => !r.pass);
  print(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) {
    print("Failed:");
    for (const f of failed) print(`  - ${f.name}${f.detail ? ` (${f.detail})` : ""}`);
  }
  return failed.length === 0;
}

run()
  .then((passed) => process.exit(passed ? 0 : 1))
  .catch((error) => {
    process.stderr.write(`Verification crashed: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
