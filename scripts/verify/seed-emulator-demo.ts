/**
 * Seeds a demo hotel into the LOCAL Firestore emulator, for trying the guest
 * concierge on its own link (/#/c/lakeside-inn-ui00demo). For the network
 * concierge and the golden path, use npm run seed:k-hotels instead.
 *
 * Refuses anything but a local emulator. Clears and seeds only its own
 * emulator project id, which `npm run dev:api` must use too:
 *
 *   npx firebase emulators:start --only firestore
 *   npm run seed:emulator
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_PROJECT_ID=innpilot-ui-verify npm run dev:api
 *   npm run dev      →  http://localhost:5173/#/c/lakeside-inn-ui00demo
 */
const EMULATOR = (process.env.FIRESTORE_EMULATOR_HOST ??= "127.0.0.1:8080");
if (!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(EMULATOR)) {
  console.error(`Refusing to run: FIRESTORE_EMULATOR_HOST is '${EMULATOR}', not a local emulator.`);
  process.exit(2);
}
const PROJECT_ID = "innpilot-ui-verify";
process.env.FIREBASE_PROJECT_ID = PROJECT_ID;

const { readFileSync } = await import("node:fs");
const { adminDb } = await import("../../server/admin");

const HOTEL_ID = "UiVerifyHotel0000001";
const PUBLIC_ID = "lakeside-inn-ui00demo";
/** A workspace created before public ids, for the Settings "Create concierge link" flow. */
const LEGACY_HOTEL_ID = "UiVerifyHotel0000002";

const res = await fetch(`http://${EMULATOR}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`, {
  method: "DELETE",
});
if (!res.ok) throw new Error(`Could not clear the emulator project: ${res.status}`);

// The browser app talks to the emulator through firestore.rules; load the
// current file for this project so a long-running emulator isn't stale.
const rules = await fetch(`http://${EMULATOR}/emulator/v1/projects/${PROJECT_ID}:securityRules`, {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ rules: { files: [{ name: "firestore.rules", content: readFileSync("firestore.rules", "utf8") }] } }),
});
if (!rules.ok) throw new Error(`Could not load firestore.rules into the emulator: ${rules.status} ${await rules.text()}`);

const db = adminDb();
await db.doc(`publicHotels/${PUBLIC_ID}`).set({ hotelId: HOTEL_ID });
await db.doc(`hotels/${HOTEL_ID}`).set({
  publicId: PUBLIC_ID,
  name: "Lakeside Inn & Spa",
  location: "Entebbe, Uganda",
  currency: "UGX",
  phone: "+256 700 111 222",
  email: "stay@lakeside.example",
  subscription: { plan: "trial", status: "active" },
});
const rooms = [
  ["101", "Single", 150000],
  ["102", "Single", 150000],
  ["201", "Double", 220000],
  ["202", "Double", 240000],
  ["301", "Suite", 420000],
] as const;
for (const [number, type, price] of rooms) {
  await db.doc(`hotels/${HOTEL_ID}/rooms/r${number}`).set({ number, type, price, status: "Available", hotelId: HOTEL_ID });
}

await db.doc(`hotels/${LEGACY_HOTEL_ID}`).set({
  name: "Savannah Lodge",
  location: "Nairobi, Kenya",
  currency: "KES",
  phone: "",
  email: "",
  subscription: { plan: "trial", status: "active" },
});
await db.doc(`hotels/${LEGACY_HOTEL_ID}/rooms/r1`).set({ number: "101", type: "Suite", price: 15000, status: "Available", hotelId: LEGACY_HOTEL_ID });

process.stdout.write(
  `Seeded ${PUBLIC_ID} (workspace ${HOTEL_ID}) and a workspace with no public id (${LEGACY_HOTEL_ID}) in emulator project ${PROJECT_ID}.\n`
);
process.exit(0);
