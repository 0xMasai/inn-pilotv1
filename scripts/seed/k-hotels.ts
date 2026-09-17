/**
 * Seeds the K Hotels DEMO network (DECISIONS D28).
 *
 * Five illustrative properties — Kabale, Mbarara and Fort Portal in the
 * Western Region, Kampala, Jinja — with rooms, capacities, UGX rates,
 * amenities, a few existing bookings (so availability is real, not
 * "everything free"), public ids and `listed: true`. Every hotel carries
 * `demo: true`. Names, prices and details are illustrative, not K Hotels'
 * real data. Nothing in the app hardcodes any of it: the concierge reads it
 * from Firestore exactly as it would a real hotel's.
 *
 * Local emulator (the default; refuses anything else):
 *
 *   npx firebase emulators:start --only firestore
 *   npm run seed:k-hotels                         # project innpilot-demo
 *   npm run seed:k-hotels -- --reset              # clear the emulator project first
 *
 * A real Firebase project — only on purpose, never by accident:
 *
 *   FIREBASE_SERVICE_ACCOUNT=… npm run seed:k-hotels -- --confirm-real-project=<projectId>
 *
 * In a real project hotel ids are random (they are workspace keys, D3) and a
 * hotel whose public id already exists is skipped, so re-running adds nothing.
 */
import { config } from "dotenv";

const args = process.argv.slice(2);
const flag = (name: string) => args.find((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
const realProject = flag("confirm-real-project")?.split("=")[1]?.trim() ?? "";
const reset = Boolean(flag("reset"));

if (realProject) {
  config();
  delete process.env.FIRESTORE_EMULATOR_HOST;
  process.env.FIREBASE_PROJECT_ID = realProject;
} else {
  process.env.FIRESTORE_EMULATOR_HOST ??= "127.0.0.1:8080";
  if (!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST)) {
    console.error(`Refusing to run: FIRESTORE_EMULATOR_HOST is '${process.env.FIRESTORE_EMULATOR_HOST}', not a local emulator.`);
    process.exit(2);
  }
  process.env.FIREBASE_PROJECT_ID ||= "innpilot-demo";
  delete process.env.FIREBASE_SERVICE_ACCOUNT;
}

const { readFileSync } = await import("node:fs");
const { FieldValue } = await import("firebase-admin/firestore");
const { adminDb } = await import("../../server/admin");
const { buildBookingDoc, makeReservationId } = await import("../../src/lib/booking");
const { PUBLIC_HOTELS_COLLECTION } = await import("../../src/lib/publicHotel");

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;

type RoomSeed = { number: string; type: string; price: number; capacity: number; status?: string; amenities?: string[] };
type StaySeed = { roomNumber: string; guestName: string; checkIn: string; checkOut: string };
interface HotelSeed {
  /** Fixed id used only in the emulator. */
  emulatorId: string;
  publicId: string;
  name: string;
  city: string;
  region: string;
  description: string;
  phone: string;
  email: string;
  amenities: string[];
  checkInTime: string;
  checkOutTime: string;
  policies: string;
  rooms: RoomSeed[];
  stays: StaySeed[];
}

const POLICIES =
  "Payment is settled at the hotel on arrival (cash, mobile money or card). Free cancellation up to 48 hours before " +
  "check-in. Children under 5 stay free in their parents' room.";

const HOTELS: HotelSeed[] = [
  {
    emulatorId: "KHotelsKabale0000001",
    publicId: "k-hotels-kabale-kh26demo",
    name: "K Hotels Kabale",
    city: "Kabale",
    region: "Western",
    description: "Hillside hotel in Kabale town, a short drive from Lake Bunyonyi.",
    phone: "+256 700 100 201",
    email: "kabale@khotels.example",
    amenities: ["Free Wi-Fi", "Breakfast included", "Free parking", "Restaurant", "Airport shuttle on request"],
    checkInTime: "14:00",
    checkOutTime: "10:00",
    policies: POLICIES,
    rooms: [
      { number: "101", type: "Single", price: 120_000, capacity: 1 },
      { number: "102", type: "Single", price: 120_000, capacity: 1 },
      { number: "201", type: "Double", price: 180_000, capacity: 2, amenities: ["Queen bed", "Balcony"] },
      { number: "202", type: "Double", price: 180_000, capacity: 2, amenities: ["Queen bed"] },
      { number: "203", type: "Double", price: 180_000, capacity: 2, amenities: ["Queen bed"], status: "Maintenance" },
      { number: "301", type: "Family", price: 320_000, capacity: 4, amenities: ["Two queen beds"] },
      { number: "401", type: "Suite", price: 380_000, capacity: 2, amenities: ["King bed", "Lake view", "Sitting room"] },
    ],
    stays: [{ roomNumber: "201", guestName: "Demo Guest — Kabale", checkIn: "2026-10-12", checkOut: "2026-10-14" }],
  },
  {
    emulatorId: "KHotelsMbarara000001",
    publicId: "k-hotels-mbarara-kh26demo",
    name: "K Hotels Mbarara",
    city: "Mbarara",
    region: "Western",
    description: "Business and leisure hotel in central Mbarara, near the Mbarara–Kabale highway.",
    phone: "+256 700 100 202",
    email: "mbarara@khotels.example",
    amenities: ["Free Wi-Fi", "Breakfast included", "Free parking", "Swimming pool", "Conference room"],
    checkInTime: "13:00",
    checkOutTime: "11:00",
    policies: POLICIES,
    rooms: [
      { number: "11", type: "Single", price: 110_000, capacity: 1 },
      { number: "12", type: "Double", price: 150_000, capacity: 2 },
      { number: "14", type: "Double", price: 150_000, capacity: 2 },
      { number: "21", type: "Deluxe Double", price: 210_000, capacity: 2, amenities: ["King bed", "Pool view"] },
      { number: "22", type: "Deluxe Double", price: 210_000, capacity: 2, amenities: ["King bed"] },
      { number: "31", type: "Family", price: 280_000, capacity: 4 },
    ],
    stays: [
      { roomNumber: "12", guestName: "Demo Guest — Mbarara A", checkIn: "2026-10-09", checkOut: "2026-10-16" },
      { roomNumber: "14", guestName: "Demo Guest — Mbarara B", checkIn: "2026-10-10", checkOut: "2026-10-13" },
    ],
  },
  {
    emulatorId: "KHotelsFortPortal001",
    publicId: "k-hotels-fort-portal-kh26demo",
    name: "K Hotels Fort Portal",
    city: "Fort Portal",
    region: "Western",
    description: "Garden hotel in Fort Portal, the gateway to Kibale Forest and the crater lakes.",
    phone: "+256 700 100 203",
    email: "fortportal@khotels.example",
    amenities: ["Free Wi-Fi", "Breakfast included", "Garden", "Free parking"],
    checkInTime: "14:00",
    checkOutTime: "10:00",
    policies: POLICIES,
    rooms: [
      { number: "A1", type: "Double", price: 170_000, capacity: 2 },
      { number: "A2", type: "Double", price: 170_000, capacity: 2 },
      { number: "A3", type: "Twin", price: 170_000, capacity: 2, amenities: ["Two single beds"] },
      { number: "B1", type: "Suite", price: 350_000, capacity: 3, amenities: ["Mountain view"] },
    ],
    stays: [{ roomNumber: "A2", guestName: "Demo Guest — Fort Portal", checkIn: "2026-10-11", checkOut: "2026-10-12" }],
  },
  {
    emulatorId: "KHotelsKampala000001",
    publicId: "k-hotels-kampala-kh26demo",
    name: "K Hotels Kampala",
    city: "Kampala",
    region: "Central",
    description: "City hotel in Kampala, 10 minutes from the central business district.",
    phone: "+256 700 100 204",
    email: "kampala@khotels.example",
    amenities: ["Free Wi-Fi", "Breakfast included", "Gym", "Paid parking", "Restaurant & bar"],
    checkInTime: "14:00",
    checkOutTime: "11:00",
    policies: POLICIES,
    rooms: [
      { number: "501", type: "Single", price: 160_000, capacity: 1 },
      { number: "502", type: "Double", price: 240_000, capacity: 2 },
      { number: "503", type: "Double", price: 240_000, capacity: 2 },
      { number: "504", type: "Double", price: 260_000, capacity: 2 },
      { number: "601", type: "Family", price: 380_000, capacity: 5 },
      { number: "701", type: "Suite", price: 450_000, capacity: 2 },
    ],
    stays: [],
  },
  {
    emulatorId: "KHotelsJinja00000001",
    publicId: "k-hotels-jinja-kh26demo",
    name: "K Hotels Jinja",
    city: "Jinja",
    region: "Eastern",
    description: "Riverside hotel in Jinja near the source of the Nile.",
    phone: "+256 700 100 205",
    email: "jinja@khotels.example",
    amenities: ["Free Wi-Fi", "Breakfast included", "River view terrace", "Free parking"],
    checkInTime: "14:00",
    checkOutTime: "10:00",
    policies: POLICIES,
    rooms: [
      { number: "1", type: "Double", price: 200_000, capacity: 2 },
      { number: "2", type: "Double", price: 200_000, capacity: 2 },
      { number: "3", type: "Family", price: 300_000, capacity: 4 },
    ],
    stays: [],
  },
];

/** YYYY-MM-DD → 12:00 UTC, the concierge's stay-date convention (server/ai/tools/args.ts). */
const stayDate = (iso: string) => new Date(`${iso}T12:00:00Z`);

if (!realProject && reset) {
  const res = await fetch(`http://${EMULATOR}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Could not clear the emulator project: ${res.status}`);
}

if (!realProject) {
  // The browser app talks to the emulator through firestore.rules; load the current file.
  const rules = await fetch(`http://${EMULATOR}/emulator/v1/projects/${PROJECT_ID}:securityRules`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rules: { files: [{ name: "firestore.rules", content: readFileSync("firestore.rules", "utf8") }] } }),
  });
  if (!rules.ok) throw new Error(`Could not load firestore.rules into the emulator: ${rules.status} ${await rules.text()}`);
}

const db = adminDb();
const report: { name: string; hotelId: string; publicId: string; status: string }[] = [];

for (const seed of HOTELS) {
  const mapping = await db.collection(PUBLIC_HOTELS_COLLECTION).doc(seed.publicId).get();
  const existingId = mapping.exists ? String(mapping.data()?.hotelId ?? "") : "";
  if (realProject && existingId) {
    report.push({ name: seed.name, hotelId: existingId, publicId: seed.publicId, status: "already present, skipped" });
    continue;
  }
  const hotelId = realProject ? db.collection("hotels").doc().id : seed.emulatorId;
  const hotelRef = db.collection("hotels").doc(hotelId);

  const batch = db.batch();
  batch.set(hotelRef, {
    name: seed.name,
    location: seed.city,
    currency: "UGX",
    phone: seed.phone,
    email: seed.email,
    taxId: "",
    subscription: { plan: "trial", status: "active" },
    publicId: seed.publicId,
    createdAt: FieldValue.serverTimestamp(),
    listed: true,
    region: seed.region,
    country: "Uganda",
    description: seed.description,
    amenities: seed.amenities,
    checkInTime: seed.checkInTime,
    checkOutTime: seed.checkOutTime,
    policies: seed.policies,
    demo: true,
  });
  batch.set(db.collection(PUBLIC_HOTELS_COLLECTION).doc(seed.publicId), { hotelId, createdAt: FieldValue.serverTimestamp() });

  for (const room of seed.rooms) {
    batch.set(hotelRef.collection("rooms").doc(`room-${room.number}`), {
      number: room.number,
      type: room.type,
      price: room.price,
      capacity: room.capacity,
      status: room.status ?? "Available",
      ...(room.amenities ? { amenities: room.amenities } : {}),
      hotelId,
      createdAt: FieldValue.serverTimestamp(),
    });
  }
  for (const [index, stay] of seed.stays.entries()) {
    const room = seed.rooms.find((candidate) => candidate.number === stay.roomNumber)!;
    batch.set(
      hotelRef.collection("accomodation").doc(`demo-stay-${index + 1}`),
      buildBookingDoc(
        {
          hotelId,
          reservationId: makeReservationId(stayDate(stay.checkIn)),
          room,
          guestName: stay.guestName,
          guestPhoneNumber: "+256 700 000 000",
          numberOfGuests: 1,
          checkIn: stayDate(stay.checkIn),
          checkOut: stayDate(stay.checkOut),
          pricePaid: 0,
          paymentStatus: "Pending",
          notes: "Demo booking seeded with the K Hotels demo network.",
        },
        FieldValue.serverTimestamp()
      )
    );
  }
  await batch.commit();
  report.push({ name: seed.name, hotelId, publicId: seed.publicId, status: `seeded: ${seed.rooms.length} rooms, ${seed.stays.length} bookings` });
}

console.log(`\nK Hotels demo network → ${realProject ? `REAL project ${realProject}` : `emulator ${EMULATOR}, project ${PROJECT_ID}`}\n`);
console.table(report);
console.log("Guest concierge:   http://localhost:5173/#/");
console.log("Staff workspace:   http://localhost:5173/#/staff  → paste a hotelId above into “Open your workspace”.");
console.log("Hotel ids are workspace keys: share them only with that hotel's staff.\n");
process.exit(0);
