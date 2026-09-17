// The challenge's golden path in a real browser, against the REAL local stack:
// UI (vite) → /api (dev-server) → the configured model (Groq by default) → Firebase Admin → Firestore emulator.
// Nothing is mocked. Offline alternative when no model quota is left: AI_PROVIDER=gemini with
// scripts/verify/fake-gemini.mjs and GEMINI_BASE_URL=http://127.0.0.1:8787 (replaces only the model).
//
// Quota: one run is about 8–10 model requests and ~25K tokens. Run it once per change, not in a loop;
// on Groq's free plan (8K tokens/minute) keep TURN_GAP_MS at its default so turns don't collide.
//
//   npx firebase emulators:start --only firestore
//   npm run seed:k-hotels -- --reset
//   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_PROJECT_ID=innpilot-demo AI_PROVIDER=groq npm run dev:api
//   VITE_FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 VITE_FIREBASE_PROJECT_ID=innpilot-demo npm run dev
//   SHOTS=<dir> node scripts/verify/golden-path-ui.mjs
//
// Uses playwright-core with the installed Edge. The model's wording varies, so
// the script asserts on what the SYSTEM shows (cards from tool results, the
// booking in the PMS), and allows one extra guest turn if the model asks a
// reasonable extra question before the summary.
import { chromium } from "playwright-core";

const BASE = process.env.BASE ?? "http://localhost:5173";
const SHOTS = process.env.SHOTS ?? ".";
const DEMO = "I need a double room between 10th and 15th October in Western Uganda.";
const WORKSPACES = {
  "K Hotels Kabale": "KHotelsKabale0000001",
  "K Hotels Mbarara": "KHotelsMbarara000001",
  "K Hotels Fort Portal": "KHotelsFortPortal001",
  "K Hotels Kampala": "KHotelsKampala000001",
  "K Hotels Jinja": "KHotelsJinja00000001",
};
// A turn is ~5K tokens; Groq's free 8K tokens/minute bucket needs ~40s to refill between turns.
const TURN_GAP_MS = Number(process.env.TURN_GAP_MS ?? 40_000);
const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080";
const PROJECT = process.env.FIREBASE_PROJECT_ID ?? "innpilot-demo";

/** The guest's reservations at a hotel, read straight from Firestore (the emulator's REST API, as owner). */
async function reservationsInFirestore(hotelId, guestName) {
  const res = await fetch(`http://${EMULATOR}/v1/projects/${PROJECT}/databases/(default)/documents/hotels/${hotelId}:runQuery`, {
    method: "POST",
    headers: { Authorization: "Bearer owner", "Content-Type": "application/json" },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: "accomodation" }],
        where: { fieldFilter: { field: { fieldPath: "guestName" }, op: "EQUAL", value: { stringValue: guestName } } },
      },
    }),
  });
  const rows = await res.json();
  return rows.filter((row) => row.document).map((row) => Object.fromEntries(Object.entries(row.document.fields).map(([k, v]) => [k, Object.values(v)[0]])));
}

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass: Boolean(pass) });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch({ channel: "msedge", headless: true });
const consoleErrors = [];

async function newPage(viewport = { width: 1366, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (m.type() === "error" && !/element\.ref was removed/.test(m.text())) consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  return page;
}

/** Sends a guest message and waits for the gateway's answer. */
async function say(page, text, { viaButton } = {}) {
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/api/ai/concierge") && r.request().method() === "POST", { timeout: 90_000 }),
    viaButton
      ? viaButton.click()
      : (async () => {
          await page.locator("#concierge-input").fill(text);
          await page.keyboard.press("Enter");
        })(),
  ]);
  const body = await response.json().catch(() => ({}));
  await page.waitForTimeout(700);
  return { status: response.status(), body };
}

try {
  /* ---------------- Guest: home ---------------- */
  const guest = await newPage();
  await guest.goto(`${BASE}/#/`, { waitUntil: "networkidle" });
  check("home: headline “Find your stay with AI”", await guest.getByRole("heading", { name: /Find your stay\s*with AI/ }).isVisible());
  for (const prompt of ["Find me a room tonight", "Double room in Western Uganda this weekend", "Family room from 10–15 October", "Find the cheapest available room in Kabale"]) {
    check(`home: suggested prompt “${prompt}”`, await guest.getByRole("button", { name: prompt }).isVisible());
  }
  await guest.getByText("K Hotels Kabale").first().waitFor({ timeout: 15_000 });
  const homeText = await guest.locator("main").innerText();
  check("home: participating properties come from the live API", Object.keys(WORKSPACES).every((name) => homeText.includes(name)));
  check("home: no PMS navigation for guests", !(await guest.getByText("Accommodation").count()) && !(await guest.getByText("Dashboard").count()));
  const html = await guest.content();
  check("home: no workspace hotelId in the page", !Object.values(WORKSPACES).some((id) => html.includes(id)));
  await guest.screenshot({ path: `${SHOTS}/g1-home-desktop.png`, fullPage: false });

  /* ---------------- Turn 1: the request ---------------- */
  const t1 = await say(guest, DEMO);
  check("turn 1: gateway answered", t1.status === 200, `HTTP ${t1.status} ${t1.body.code ?? ""}`);
  const options = t1.body.search?.options ?? [];
  check("turn 1: real options returned from search_hotels", options.length >= 2, options.map((o) => `${o.hotelName} ${o.roomType} ${o.stayTotal}`).join(" | "));
  check("turn 1: dates understood as 10–15 Oct, 5 nights", t1.body.search?.checkIn?.endsWith("-10-10") && t1.body.search?.checkOut?.endsWith("-10-15") && t1.body.search?.nights === 5);
  check("turn 1: only Western Region hotels", options.length > 0 && options.every((o) => o.region === "Western"));
  check("turn 1: prices = nightly × nights", options.every((o) => o.stayTotal === o.nightlyRate * o.nights));
  const cards = guest.getByRole("article");
  check("turn 1: result cards rendered", (await cards.count()) === options.length);
  const firstCard = await cards.first().innerText();
  check("turn 1: card shows hotel, room, price/night, nights and total", firstCard.includes(options[0]?.hotelName) && firstCard.includes("/ night") && firstCard.includes("5 nights") && firstCard.includes("total"));
  check("turn 1: reply text is shown", (await guest.locator("main").innerText()).length > 50, String(t1.body.reply).slice(0, 160));
  await guest.screenshot({ path: `${SHOTS}/g2-results.png` });

  /* ---------------- Turn 2: choose the first option ---------------- */
  await sleep(TURN_GAP_MS);
  const chosen = options[0];
  const t2 = await say(guest, "", { viaButton: cards.first().getByRole("button", { name: "Choose" }) });
  check("turn 2: choosing an option asks for guest details", t2.status === 200 && !t2.body.booking && /name|phone/i.test(String(t2.body.reply)), String(t2.body.reply).slice(0, 160));

  /* ---------------- Turn 3: details → summary ---------------- */
  await sleep(TURN_GAP_MS);
  let t3 = await say(guest, "Amina Okello, +256 772 123 456. Just me, 1 guest.");
  if (t3.status === 200 && !t3.body.quote && !t3.body.booking) {
    console.log(`note: no summary yet — model said: ${String(t3.body.reply).slice(0, 200)}`);
    await sleep(TURN_GAP_MS);
    t3 = await say(guest, "That's all the details. Please show me the booking summary.");
  }
  check("turn 3: booking summary from prepare_booking", t3.status === 200 && t3.body.quote?.hotelName === chosen.hotelName, JSON.stringify(t3.body.quote ?? t3.body).slice(0, 220));
  check("turn 3: summary total matches the chosen option", t3.body.quote?.totalPrice === chosen.stayTotal);
  check("turn 3: nothing booked before confirmation", !t3.body.booking);
  const before = await reservationsInFirestore(WORKSPACES[chosen.hotelName], "Amina Okello");
  check("turn 3: Firestore has no reservation for the guest before confirmation", before.length === 0, `${before.length} found`);
  const summary = guest.getByRole("region", { name: "Booking summary" }).or(guest.locator('[aria-label="Booking summary"]'));
  check("turn 3: summary card asks “Would you like me to confirm this booking?”", (await summary.last().innerText()).includes("Would you like me to confirm this booking?"));
  await guest.screenshot({ path: `${SHOTS}/g3-summary.png` });

  /* ---------------- Turn 4: confirm ---------------- */
  await sleep(TURN_GAP_MS);
  const t4 = await say(guest, "", { viaButton: summary.last().getByRole("button", { name: "Confirm booking" }) });
  const booking = t4.body.booking;
  check("turn 4: booking confirmed by create_reservation", t4.status === 200 && /^RSV-\d{8}-[A-Z0-9]{6}$/.test(booking?.reservationId ?? ""), JSON.stringify(t4.body).slice(0, 220));
  const confirmation = guest.locator('[aria-label="Booking confirmation"]');
  const confirmationText = booking ? await confirmation.last().innerText() : "";
  check("turn 4: “Booking Confirmed” card with the real reference", confirmationText.includes("Booking Confirmed") && confirmationText.includes(booking?.reservationId));
  check("turn 4: card shows hotel, room, guest, dates and total", ["Hotel", "Room", "Guest", "Check-in", "Check-out", "Total", "Amina Okello", chosen.hotelName].every((t) => confirmationText.includes(t)));
  await guest.screenshot({ path: `${SHOTS}/g4-confirmed.png` });
  const after = await reservationsInFirestore(WORKSPACES[chosen.hotelName], "Amina Okello");
  check(
    "turn 4: Firestore holds exactly that reservation, with the confirmed dates and total",
    after.length === 1 &&
      after[0].reservationId === booking?.reservationId &&
      Number(after[0].quotedTotal) === chosen.stayTotal &&
      Math.round((Date.parse(after[0].checkOut) - Date.parse(after[0].checkIn)) / 86_400_000) === 5 &&
      new Date(Date.parse(after[0].checkIn)).toISOString().slice(5, 10) === "10-10" &&
      after[0].source === "concierge",
    JSON.stringify(after.map((r) => ({ reservationId: r.reservationId, roomType: r.roomType, quotedTotal: r.quotedTotal, checkIn: r.checkIn, checkOut: r.checkOut, source: r.source })))
  );

  /* ---------------- Staff: the reservation is in the PMS ---------------- */
  const hotelId = WORKSPACES[chosen.hotelName];
  const staff = await newPage();
  await staff.goto(`${BASE}/#/staff`, { waitUntil: "networkidle" });
  await staff.locator("#workspace-id").fill(hotelId);
  await staff.getByRole("button", { name: /Open workspace/ }).last().click();
  await staff.waitForURL(/#\/dashboard/, { timeout: 20_000 });
  check("staff: workspace opens by id at /staff", staff.url().includes("#/dashboard"));

  await staff.goto(`${BASE}/#/dashboard/accommodation`, { waitUntil: "networkidle" });
  await staff.waitForTimeout(2500);
  const pms = await staff.locator("body").innerText();
  check("staff: the reservation is visible in Accommodation", pms.includes("Amina Okello"));
  await staff.screenshot({ path: `${SHOTS}/s1-accommodation.png` });

  await staff.goto(`${BASE}/#/dashboard/inbox`, { waitUntil: "networkidle" });
  const row = staff.getByRole("button", { name: /Amina Okello/ }).first();
  await row.waitFor({ timeout: 15_000 });
  const rowText = await row.innerText();
  check("staff inbox: conversation shows guest, Booked status and selected hotel", rowText.includes("Booked") && rowText.includes(chosen.hotelName), rowText.replace(/\s+/g, " "));
  check("staff inbox: lead label and AI handler shown", /Hot|VIP|Warm/.test(rowText) && rowText.includes("AI"));
  await row.click();
  await staff.waitForTimeout(1500);
  const threadText = await staff.locator("section[aria-label='Conversation']").innerText();
  check("staff inbox: full thread including the demo request", threadText.includes("Western Uganda"));
  await staff.screenshot({ path: `${SHOTS}/s2-inbox.png` });

  /* ---------------- Handoff: staff take over and reply ---------------- */
  await staff.getByRole("button", { name: "Take over" }).first().click();
  await staff.locator("#staff-reply").waitFor({ timeout: 10_000 });
  await staff.locator("#staff-reply").fill("Hello Amina, this is Ruth from reservations. We look forward to your stay!");
  await staff.getByRole("button", { name: "Send" }).click();
  await staff.waitForTimeout(1500);
  const ruth = guest.getByText("this is Ruth from reservations");
  let seen = false;
  for (let i = 0; i < 12 && !seen; i++) {
    await guest.waitForTimeout(2500);
    seen = await ruth.isVisible().catch(() => false);
  }
  check("handoff: staff reply reaches the guest page", seen);
  check("handoff: guest sees the hotel team is handling the chat", await guest.getByText("A member of the hotel team is handling your chat").isVisible().catch(() => false));
  const held = await say(guest, "Can I arrive at 9pm?");
  check("handoff: the AI stays quiet while staff handle it", held.status === 200 && held.body.handledBy === "human" && held.body.model === "staff");
  await guest.screenshot({ path: `${SHOTS}/g5-handoff.png` });

  /* ---------------- Guests can't reach staff routes ---------------- */
  const stranger = await newPage();
  await stranger.goto(`${BASE}/#/dashboard/accommodation`, { waitUntil: "networkidle" });
  await stranger.waitForTimeout(1000);
  check("security: a guest opening /dashboard is sent to /staff", stranger.url().includes("#/staff"));

  /* ---------------- Mobile ---------------- */
  const phone = await newPage({ width: 390, height: 844 });
  await phone.goto(`${BASE}/#/`, { waitUntil: "networkidle" });
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check("mobile: home has no horizontal overflow", overflow <= 0, `overflow ${overflow}px`);
  await phone.screenshot({ path: `${SHOTS}/m1-home-mobile.png` });

  /* ---------------- A hotel's own link ---------------- */
  const scoped = await newPage();
  await scoped.goto(`${BASE}/#/c/k-hotels-jinja-kh26demo`, { waitUntil: "networkidle" });
  check("hotel link: /c/:publicHotelId shows that hotel", await scoped.getByRole("heading", { name: /Book your stay at\s*K Hotels Jinja/ }).isVisible());
  // Its 400 is the expected answer for an unknown id, so this page isn't counted for console errors.
  const unknown = await browser.newPage();
  await unknown.goto(`${BASE}/#/c/not-a-real-hotel-0000`, { waitUntil: "networkidle" });
  const notFound = await unknown.getByRole("heading", { name: "We couldn't find this hotel" }).waitFor({ timeout: 15_000 }).then(() => true, () => false);
  await unknown.screenshot({ path: `${SHOTS}/g6-unknown-hotel.png` });
  check("hotel link: unknown id shows a safe not-found screen", notFound);
} catch (error) {
  check("script completed", false, String(error).slice(0, 400));
} finally {
  check("no console errors", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));
  await browser.close();
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}
