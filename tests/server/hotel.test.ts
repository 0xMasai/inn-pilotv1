/**
 * GET /api/ai/hotel — the concierge page's hotel details and room rates.
 *
 * Real handler, real resolveHotel() and the Admin SDK against the emulator.
 * No model involved.
 *
 *   firebase emulators:start --only firestore   (then)   npm run test:server
 */
import { beforeEach, describe, expect, it } from "vitest";

const PROJECT_ID = "innpilot-hotel-endpoint-test";
process.env.FIRESTORE_EMULATOR_HOST ??= "127.0.0.1:8080";
process.env.FIREBASE_PROJECT_ID = PROJECT_ID;
delete process.env.FIREBASE_SERVICE_ACCOUNT;

import handler from "../../api/ai/hotel";
import { adminDb } from "../../server/admin";
import { resetRateLimits } from "../../server/ai/rateLimit";

const HOTEL_A = "HotelEndpointA000001";
const HOTEL_B = "HotelEndpointB000001";
const PUBLIC_A = "lakeside-inn-hotelep1";
const PUBLIC_B = "savannah-lodge-hotelep2";

async function get(url: string, method = "GET") {
  const res = {
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
  const req = { method, url, headers: {}, socket: { remoteAddress: "10.0.0.4" }, async *[Symbol.asyncIterator]() {} };
  await handler(req, res);
  return res;
}

beforeEach(async () => {
  resetRateLimits();
  const url = `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
  await fetch(url, { method: "DELETE" });
  const db = adminDb();
  await db.doc(`publicHotels/${PUBLIC_A}`).set({ hotelId: HOTEL_A });
  await db.doc(`publicHotels/${PUBLIC_B}`).set({ hotelId: HOTEL_B });
  await db.doc(`hotels/${HOTEL_A}`).set({
    publicId: PUBLIC_A,
    name: "Lakeside Inn",
    location: "Entebbe",
    currency: "UGX",
    phone: "+256 700 000 001",
    email: "",
    taxId: "TIN-SECRET-1",
    subscription: { plan: "trial", status: "active" },
  });
  await db.doc(`hotels/${HOTEL_B}`).set({ publicId: PUBLIC_B, name: "Savannah Lodge", currency: "KES" });
  const rooms = db.collection(`hotels/${HOTEL_A}/rooms`);
  await rooms.doc("a").set({ number: "101", type: "Single", price: 150000, status: "Available", hotelId: HOTEL_A });
  await rooms.doc("b").set({ number: "201", type: "Double", price: 220000, status: "Available", hotelId: HOTEL_A });
  await rooms.doc("c").set({ number: "202", type: "Double", price: 240000, status: "Maintenance", hotelId: HOTEL_A });
  await rooms.doc("d").set({ number: "301", type: "Suite", price: 0, status: "Available", hotelId: HOTEL_A });
  await db.doc(`hotels/${HOTEL_B}/rooms/x`).set({ number: "901", type: "Suite", price: 15000, status: "Available", hotelId: HOTEL_B });
});

describe("GET /api/ai/hotel", () => {
  it("returns the hotel's public details and room rates, from its own rooms", async () => {
    const res = await get(`/api/ai/hotel?publicHotelId=${PUBLIC_A}`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      publicHotelId: PUBLIC_A,
      name: "Lakeside Inn",
      city: "Entebbe",
      region: null,
      country: null,
      description: null,
      phone: "+256 700 000 001",
      email: null,
      currency: "UGX",
      amenities: [],
      roomTypes: [
        { roomType: "Single", roomCount: 1, nightlyRate: { from: 150000, to: 150000 }, capacity: null },
        { roomType: "Double", roomCount: 2, nightlyRate: { from: 220000, to: 240000 }, capacity: null },
        { roomType: "Suite", roomCount: 1, nightlyRate: null, capacity: null },
      ],
      requestId: expect.any(String),
    });
  });

  it("never returns the workspace id or private fields", async () => {
    const res = await get(`/api/ai/hotel?publicHotelId=${PUBLIC_A}`);
    const json = JSON.stringify(res.body);
    expect(json).not.toContain(HOTEL_A);
    expect(json).not.toMatch(/TIN-SECRET|subscription|trial/);
  });

  it("serves each hotel only its own data", async () => {
    const res = await get(`/api/ai/hotel?publicHotelId=${PUBLIC_B}`);
    expect(res.body).toMatchObject({ name: "Savannah Lodge", currency: "KES", roomTypes: [{ roomType: "Suite", roomCount: 1 }] });
    expect(JSON.stringify(res.body)).not.toMatch(/Lakeside|150000/);
  });

  it.each([
    ["missing", "/api/ai/hotel"],
    ["unknown", "/api/ai/hotel?publicHotelId=no-such-hotel-00000000"],
    ["an internal hotelId", `/api/ai/hotel?publicHotelId=${HOTEL_A}`],
  ])("fails safely for a %s public id", async (_label, url) => {
    const res = await get(url);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error: "I'm not sure which hotel this chat belongs to. Please reopen it from the hotel's page.",
      code: "invalid_request",
      requestId: expect.any(String),
    });
  });

  it("only answers GET", async () => {
    expect((await get(`/api/ai/hotel?publicHotelId=${PUBLIC_A}`, "POST")).statusCode).toBe(405);
  });
});
