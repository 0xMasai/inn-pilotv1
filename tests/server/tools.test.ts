/**
 * The concierge's network tools against the Firestore emulator through the
 * real Firebase Admin SDK. No Gemini: each tool is called the way the model
 * loop calls it, through the toolbox.
 *
 *   firebase emulators:start --only firestore   (then)   npm run test:server
 */
import { beforeEach, describe, expect, it } from "vitest";

const PROJECT_ID = "innpilot-tools-test";
process.env.FIRESTORE_EMULATOR_HOST ??= "127.0.0.1:8080";
process.env.FIREBASE_PROJECT_ID = PROJECT_ID;
delete process.env.FIREBASE_SERVICE_ACCOUNT;

import { adminDb } from "../../server/admin";
import { CONCIERGE_TOOLS, createToolbox, type ToolContext } from "../../server/ai/tools";
import { bookRoom, PENDING_BOOKING_TTL_MS } from "../../server/ai/tools/createReservation";
import { readStayDates } from "../../server/ai/tools/args";
import type { PendingBooking } from "../../server/ai/types";
import { resolveHotel } from "../../server/hotels";
import { createNetworkContext } from "../../server/network";
import { AiInvalidRequestError } from "../../server/ai/errors";
import {
  ALL_HOTEL_IDS,
  bookStay,
  clearEmulator,
  GUEST,
  HIDDEN,
  KABALE,
  KAMPALA,
  MBARARA,
  seedNetwork,
  STAY,
} from "./fixtures/network";

type Result = Record<string, unknown>;

async function context(overrides: Partial<ToolContext> = {}, scopedPublicId?: string): Promise<ToolContext> {
  return {
    network: await createNetworkContext(scopedPublicId),
    guestMessage: "",
    pendingBooking: null,
    now: new Date(),
    ...overrides,
  };
}

async function run(name: string, args: Record<string, unknown>, ctx?: ToolContext): Promise<Result> {
  return createToolbox(ctx ?? (await context())).execute({ name, args });
}

const kabaleDouble = { hotel: KABALE.publicId, roomType: "Double", ...STAY };

/** A summary the guest saw in an earlier turn, exactly as the gateway keeps it. */
async function pendingFor(args: Record<string, unknown> = { ...kabaleDouble, ...GUEST }): Promise<PendingBooking> {
  const prepared = await run("prepare_booking", args);
  expect(prepared.status).toBe("ready");
  return { ...(prepared.summary as PendingBooking), preparedAt: Date.now() };
}

async function confirm(pending: PendingBooking, message = "Yes, confirm", args: Record<string, unknown> = { ...kabaleDouble, ...GUEST }) {
  return run("create_reservation", args, await context({ pendingBooking: pending, guestMessage: message }));
}

const bookingsAt = async (hotelId: string) =>
  (await adminDb().collection(`hotels/${hotelId}/accomodation`).get()).docs.map((doc) => doc.data());

beforeEach(async () => {
  await clearEmulator(PROJECT_ID);
  await seedNetwork(adminDb());
});

describe("resolveHotel", () => {
  it.each([undefined, "", "../hotels/other", "a/b", 42])("rejects the malformed id %o", async (raw) => {
    await expect(resolveHotel(raw)).rejects.toBeInstanceOf(AiInvalidRequestError);
  });

  it("rejects a public id with no hotel behind it", async () => {
    await expect(resolveHotel("no-such-hotel-00000000")).rejects.toBeInstanceOf(AiInvalidRequestError);
  });
});

describe("search_hotels", () => {
  it("finds a double in Western Uganda across hotels, from live availability and rates", async () => {
    const result = await run("search_hotels", { destination: "Western Uganda", roomType: "Double", ...STAY });

    expect(result).toMatchObject({ status: "ok", nights: 5, hotelsSearched: 2, requestedRoomTypeAvailable: true });
    expect(result.options).toEqual([
      {
        optionNumber: 1,
        hotel: KABALE.publicId,
        hotelName: "K Hotels Kabale",
        city: "Kabale",
        region: "Western",
        roomType: "Double",
        capacity: 2,
        // 201 is booked 12–14 Oct and 203 is in maintenance: only 202 is free.
        availableRooms: 1,
        nightlyRate: 180000,
        nights: 5,
        stayTotal: 900000,
        currency: "UGX",
        amenities: ["Free Wi-Fi", "Breakfast included", "Free parking"],
        matchesRequestedRoomType: true,
      },
      expect.objectContaining({
        optionNumber: 2,
        hotel: MBARARA.publicId,
        // Its plain Double is booked all week; the Deluxe Double is the double it has.
        roomType: "Deluxe Double",
        availableRooms: 1,
        nightlyRate: 210000,
        stayTotal: 1050000,
      }),
    ]);
  });

  it("never offers an unlisted hotel, a hotel with a broken mapping, or another region", async () => {
    const json = JSON.stringify(await run("search_hotels", { destination: "Western Uganda", ...STAY }));
    expect(json).not.toMatch(/Hidden Lodge|Broken Inn|Kampala/);
    for (const hotelId of ALL_HOTEL_IDS) expect(json).not.toContain(hotelId);
  });

  it("searches every listed hotel when no destination is given", async () => {
    const result = await run("search_hotels", { roomType: "Double", ...STAY });
    const hotels = (result.options as Result[]).map((option) => option.hotelName);
    expect(new Set(hotels)).toEqual(new Set(["K Hotels Kabale", "K Hotels Mbarara", "K Hotels Kampala"]));
  });

  it("only offers rooms recorded as big enough for the party", async () => {
    const result = await run("search_hotels", { destination: "Kabale", guests: 3, ...STAY });
    expect((result.options as Result[]).map((option) => [option.roomType, option.capacity])).toEqual([["Family", 4]]);
  });

  it("offers at most two options per hotel and five in all", async () => {
    const db = adminDb();
    for (const [number, type] of [["601", "Twin"], ["602", "Triple"], ["603", "Studio"]]) {
      await db.doc(`hotels/${KAMPALA.hotelId}/rooms/room-${number}`).set({ number, type, price: 100000, status: "Available", hotelId: KAMPALA.hotelId });
    }
    const options = (await run("search_hotels", STAY)).options as Result[];
    expect(options.length).toBeLessThanOrEqual(5);
    const perHotel = options.reduce<Record<string, number>>((counts, option) => {
      counts[String(option.hotel)] = (counts[String(option.hotel)] ?? 0) + 1;
      return counts;
    }, {});
    expect(Math.max(...Object.values(perHotel))).toBeLessThanOrEqual(2);
  });

  it("says so, and offers other room types, when the requested type isn't free anywhere", async () => {
    // Kabale's suite has no rate set, so it can't be booked through the concierge.
    const result = await run("search_hotels", { destination: "Kabale", roomType: "Suite", ...STAY });
    expect(result).toMatchObject({ status: "ok", requestedRoomTypeAvailable: false });
    expect((result.options as Result[]).every((option) => option.matchesRequestedRoomType === false)).toBe(true);
    expect(JSON.stringify(result.options)).not.toContain("Suite");
  });

  it("names the destinations it serves when none match", async () => {
    const result = await run("search_hotels", { destination: "Gulu", ...STAY });
    expect(result).toMatchObject({ status: "no_hotels_in_destination" });
    expect(result.destinationsServed).toEqual(
      expect.arrayContaining(["Kabale (Western Region, Uganda)", "Kampala (Central Region, Uganda)"])
    );
    expect(JSON.stringify(result)).not.toMatch(/Hoima|Hidden/);
  });

  it("reports no availability when everything matching is taken", async () => {
    await bookStay(adminDb(), KAMPALA.hotelId, "502", "2031-10-01", "2031-10-30");
    const result = await run("search_hotels", { destination: "Kampala", ...STAY });
    expect(result).toMatchObject({ status: "no_availability", hotelsSearched: 1 });
    expect(result).not.toHaveProperty("options");
  });

  it.each([
    [{ checkIn: "2031-10-15", checkOut: "2031-10-10" }],
    [{ checkIn: "2031-02-30", checkOut: "2031-03-02" }],
    [{ checkIn: "2020-01-01", checkOut: "2020-01-03" }],
    [{ checkIn: "next friday", checkOut: "2031-03-02" }],
    [{ checkIn: "2031-03-01", checkOut: "2031-06-01" }],
  ])("rejects invalid or past dates %o", async (dates) => {
    expect(await run("search_hotels", dates)).toMatchObject({ error: "invalid_dates" });
  });
});

describe("check_availability", () => {
  it("lists one hotel's free room types for the stay, with no room numbers", async () => {
    const result = await run("check_availability", { hotel: KABALE.publicId, ...STAY });
    expect(result).toMatchObject({
      hotel: KABALE.publicId,
      hotelName: "K Hotels Kabale",
      nights: 5,
      totalAvailable: 2,
      roomTypes: [
        { roomType: "Double", availableRooms: 1, capacity: 2, nightlyRate: 180000, stayTotal: 900000 },
        { roomType: "Family", availableRooms: 1, capacity: 4, nightlyRate: 320000, stayTotal: 1600000 },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/"20[123]"|roomNumber|Existing Guest/);
  });

  it("sees stays from the reservations collection, including numeric legacy room numbers", async () => {
    await bookStay(adminDb(), KABALE.hotelId, 202, "2031-10-11", "2031-10-12", "reservations");
    const result = await run("check_availability", { hotel: KABALE.publicId, roomType: "Double", ...STAY });
    expect(result).toMatchObject({ totalAvailable: 0, roomTypes: [] });
  });
});

describe("get_hotel_info", () => {
  it("returns only what the hotel recorded, and names what it didn't", async () => {
    const result = await run("get_hotel_info", { hotel: KABALE.publicId });
    expect(result).toMatchObject({
      hotelName: "K Hotels Kabale",
      city: "Kabale",
      country: "Uganda",
      amenities: ["Free Wi-Fi", "Breakfast included", "Free parking"],
      checkInTime: "14:00",
      checkOutTime: "10:00",
      policies: null,
      contactPhone: "+256 700 100 201",
      roomTypes: expect.arrayContaining([{ roomType: "Suite", nightlyRate: null, sleeps: { from: 2, to: 2 } }]),
      notRecorded: ["cancellation, payment, pet and child policies"],
    });
    expect(JSON.stringify(result)).not.toMatch(/TIN-SECRET|subscription|NetKabale/);
  });

  it("flags amenities as not recorded for a hotel that has none", async () => {
    const result = await run("get_hotel_info", { hotel: MBARARA.publicId });
    expect(result.amenities).toEqual([]);
    expect(result.notRecorded).toEqual(expect.arrayContaining(["amenities and facilities (including breakfast, parking and Wi-Fi)", "check-in time"]));
  });
});

describe("calculate_stay_price", () => {
  it("is the nightly rate times the nights, from the cheapest free room of that type", async () => {
    expect(await run("calculate_stay_price", kabaleDouble)).toMatchObject({
      available: true,
      nightlyRate: 180000,
      nights: 5,
      stayTotal: 900000,
      calculation: "180000 × 5 nights = 900000",
    });
  });

  it("re-checks availability: a type with nothing free has no price", async () => {
    const result = await run("calculate_stay_price", { hotel: MBARARA.publicId, roomType: "Double", ...STAY });
    expect(result).toMatchObject({ available: false });
    expect(result).not.toHaveProperty("stayTotal");
  });
});

describe("prepare_booking", () => {
  it("returns the summary to confirm and writes nothing", async () => {
    const result = await run("prepare_booking", { ...kabaleDouble, ...GUEST, guestEmail: "amina@example.com", numberOfGuests: 2 });
    expect(result).toMatchObject({
      status: "ready",
      summary: {
        hotel: KABALE.publicId,
        hotelName: "K Hotels Kabale",
        roomType: "Double",
        checkIn: "2031-10-10",
        checkOut: "2031-10-15",
        nights: 5,
        numberOfGuests: 2,
        guestName: "Amina Okello",
        guestPhone: "+256 772 123 456",
        guestEmail: "amina@example.com",
        nightlyRate: 180000,
        totalPrice: 900000,
        currency: "UGX",
      },
    });
    expect(await bookingsAt(KABALE.hotelId)).toHaveLength(1); // only the fixture's existing stay
  });

  it.each([
    [{ guestName: "" }, ["guestName"]],
    [{ guestPhoneNumber: undefined }, ["guestPhoneNumber"]],
    [{ guestPhoneNumber: "call me" }, ["guestPhoneNumber"]],
    [{ guestName: "12" }, ["guestName"]],
    [{ guestEmail: "not-an-email" }, ["guestEmail"]],
  ])("asks for missing or invalid details %o", async (override, missing) => {
    const result = await run("prepare_booking", { ...kabaleDouble, ...GUEST, ...override });
    expect(result).toMatchObject({ status: "not_ready", reason: "missing_information", missing });
  });

  it("re-checks availability: a room taken since the search can't be summarised", async () => {
    await bookStay(adminDb(), KABALE.hotelId, "202", "2031-10-10", "2031-10-11");
    expect(await run("prepare_booking", { ...kabaleDouble, ...GUEST })).toMatchObject({ status: "not_ready", reason: "no_longer_available" });
  });

  it("refuses too many guests for any room of that type", async () => {
    expect(await run("prepare_booking", { ...kabaleDouble, ...GUEST, numberOfGuests: 3 })).toMatchObject({ reason: "no_longer_available" });
  });
});

describe("create_reservation: consent (D27)", () => {
  it("refuses without a summary from an earlier turn, and writes nothing", async () => {
    const result = await run("create_reservation", { ...kabaleDouble, ...GUEST }, await context({ guestMessage: "Yes, confirm" }));
    expect(result).toMatchObject({ status: "not_booked", reason: "needs_confirmation" });
    expect(await bookingsAt(KABALE.hotelId)).toHaveLength(1);
  });

  it.each(["I'll take the first one", "No, wait", "Can you confirm?", "Yes but change the dates", ""])(
    "refuses when the guest's message %o isn't an explicit yes",
    async (message) => {
      const result = await confirm(await pendingFor(), message);
      expect(result).toMatchObject({ status: "not_booked", reason: "needs_confirmation" });
      expect(await bookingsAt(KABALE.hotelId)).toHaveLength(1);
    }
  );

  it.each([
    ["dates", { checkOut: "2031-10-16" }],
    ["hotel", { hotel: MBARARA.publicId }],
    ["hotel name", { hotel: "K Hotels Mbarara" }],
    ["room type", { roomType: "Family" }],
    ["name", { guestName: "Someone Else" }],
    ["phone", { guestPhoneNumber: "+256 700 000 999" }],
  ])("refuses when the %s differ from the confirmed summary", async (_label, change) => {
    const result = await confirm(await pendingFor(), "Yes, confirm", { ...kabaleDouble, ...GUEST, ...change });
    expect(result).toMatchObject({ status: "not_booked", reason: "needs_confirmation" });
  });

  it("accepts the summary's hotel by its exact name as well as its id", async () => {
    const result = await confirm(await pendingFor(), "Yes, confirm", { ...kabaleDouble, ...GUEST, hotel: "K Hotels Kabale" });
    expect(result).toMatchObject({ status: "confirmed", booking: { hotel: KABALE.publicId } });
    expect(await bookingsAt(KABALE.hotelId)).toHaveLength(2);
  });

  it("refuses a summary that has gone stale", async () => {
    const pending = await pendingFor();
    const result = await confirm({ ...pending, preparedAt: Date.now() - PENDING_BOOKING_TTL_MS - 1 });
    expect(result).toMatchObject({ reason: "needs_confirmation" });
  });
});

describe("create_reservation: booking", () => {
  it("books the confirmed stay into accomodation with source concierge, an audit entry and the real reference", async () => {
    const pending = await pendingFor({ ...kabaleDouble, ...GUEST, guestEmail: "amina@example.com", numberOfGuests: 2 });
    const result = await confirm(pending, "Yes, please book it", { ...kabaleDouble, ...GUEST, notes: "Late arrival" });

    expect(result).toMatchObject({
      status: "confirmed",
      booking: {
        reservationId: expect.stringMatching(/^RSV-\d{8}-[A-Z0-9]{6}$/),
        hotel: KABALE.publicId,
        hotelName: "K Hotels Kabale",
        roomType: "Double",
        checkIn: "2031-10-10",
        checkOut: "2031-10-15",
        nights: 5,
        numberOfGuests: 2,
        guestName: "Amina Okello",
        nightlyRate: 180000,
        totalPrice: 900000,
        currency: "UGX",
        paymentStatus: "Pending",
      },
    });
    const { reservationId } = result.booking as { reservationId: string };
    expect(JSON.stringify(result)).not.toMatch(/NetKabale|roomNumber|"202"/);

    const created = (await bookingsAt(KABALE.hotelId)).find((booking) => booking.reservationId === reservationId);
    expect(created).toMatchObject({
      source: "concierge",
      roomNumber: "202",
      roomType: "Double",
      guestName: "Amina Okello",
      guestPhoneNumber: "+256 772 123 456",
      guestEmail: "amina@example.com",
      numberOfGuests: 2,
      status: "Confirmed",
      paymentStatus: "Pending",
      quotedTotal: 900000,
      notes: "Late arrival",
      hotelId: KABALE.hotelId,
    });
    const audit = (await adminDb().collection(`hotels/${KABALE.hotelId}/auditLog`).get()).docs.map((doc) => doc.data());
    expect(audit).toEqual([expect.objectContaining({ action: "Booking created", details: expect.stringContaining(reservationId) })]);
  });

  it("the new booking immediately blocks the room for search and for a second booking", async () => {
    const pending = await pendingFor();
    expect(await confirm(pending)).toMatchObject({ status: "confirmed" });

    expect(await run("calculate_stay_price", kabaleDouble)).toMatchObject({ available: false });
    expect(await confirm(pending)).toMatchObject({ status: "not_booked", reason: "no_longer_available" });
  });

  it("falls through to an equally priced room when the first choice was just taken", async () => {
    await adminDb().doc(`hotels/${KABALE.hotelId}/rooms/room-204`).set({ number: "204", type: "Double", price: 180000, status: "Available", hotelId: KABALE.hotelId });
    const pending = await pendingFor();
    // Someone else books 202 at the front desk between the summary and the yes.
    const parsed = readStayDates(STAY);
    if (!parsed.ok) throw new Error(parsed.message);
    const scope = await resolveHotel(KABALE.publicId);
    expect(await bookRoom(scope, { roomNumber: "202", dates: parsed.dates, guestName: "Walk-in", guestPhoneNumber: "+256700000001", numberOfGuests: 1 })).toMatchObject({ status: "confirmed" });

    const result = await confirm(pending);
    expect(result).toMatchObject({ status: "confirmed", booking: { totalPrice: 900000 } });
    expect((await bookingsAt(KABALE.hotelId)).find((b) => b.guestName === "Amina Okello")).toMatchObject({ roomNumber: "204" });
  });

  it("never books at a price the guest didn't confirm", async () => {
    await adminDb().doc(`hotels/${KABALE.hotelId}/rooms/room-205`).set({ number: "205", type: "Double", price: 200000, status: "Available", hotelId: KABALE.hotelId });
    const pending = await pendingFor();
    await bookStay(adminDb(), KABALE.hotelId, "202", "2031-10-10", "2031-10-11");

    const result = await confirm(pending);
    expect(result).toMatchObject({ status: "not_booked", reason: "price_changed", newTotalPrice: 1000000 });
    expect((await bookingsAt(KABALE.hotelId)).some((b) => b.guestName === "Amina Okello")).toBe(false);
  });

  it("re-checks at booking time: a room taken out of service after the summary is refused", async () => {
    const pending = await pendingFor();
    await adminDb().doc(`hotels/${KABALE.hotelId}/rooms/room-202`).update({ status: "Out of Service" });
    expect(await confirm(pending)).toMatchObject({ status: "not_booked", reason: "no_longer_available" });
  });

  it("of two simultaneous confirmations for the last room, exactly one books", async () => {
    const pending = await pendingFor();
    const results = await Promise.all([confirm(pending), confirm(pending), confirm(pending)]);
    expect(results.filter((r) => r.status === "confirmed")).toHaveLength(1);
    expect(results.filter((r) => r.status === "not_booked")).toHaveLength(2);
    expect((await bookingsAt(KABALE.hotelId)).filter((b) => b.guestName === "Amina Okello")).toHaveLength(1);
  });
});

describe("the toolbox", () => {
  it("answers an unknown tool with an error the model can read", async () => {
    expect(await run("drop_database", {})).toMatchObject({ error: "unknown_tool" });
  });

  it("offers exactly the six concierge tools, none of which takes a hotelId", () => {
    expect(CONCIERGE_TOOLS.map((tool) => tool.definition.name)).toEqual([
      "search_hotels",
      "check_availability",
      "get_hotel_info",
      "calculate_stay_price",
      "prepare_booking",
      "create_reservation",
    ]);
    expect(JSON.stringify(CONCIERGE_TOOLS.map((tool) => tool.definition))).not.toMatch(/hotelId/);
  });
});

describe("unreachable hotels", () => {
  it.each([
    ["an unlisted hotel", HIDDEN.publicId],
    ["an internal hotelId", KABALE.hotelId],
    ["an unknown id", "no-such-hotel-00000000"],
    ["nothing", undefined],
  ])("every hotel tool refuses %s the same way", async (_label, hotel) => {
    for (const name of ["check_availability", "get_hotel_info", "calculate_stay_price"]) {
      expect(await run(name, { hotel, roomType: "Double", ...STAY })).toMatchObject({ error: "unknown_hotel" });
    }
    expect(await run("prepare_booking", { hotel, roomType: "Double", ...STAY, ...GUEST })).toMatchObject({ reason: "unknown_hotel" });
  });

  it("a hotel's own concierge reaches that hotel only", async () => {
    const scoped = await context({}, KABALE.publicId);
    const search = await run("search_hotels", STAY, scoped);
    expect(new Set((search.options as Result[]).map((o) => o.hotel))).toEqual(new Set([KABALE.publicId]));
    expect(await run("get_hotel_info", { hotel: MBARARA.publicId }, scoped)).toMatchObject({ error: "unknown_hotel" });
  });

  it("a hotel's exact name works like its public id, but never reaches further", async () => {
    // A later turn has text history only, so the model may know the name and not the id.
    expect(await run("get_hotel_info", { hotel: "  k hotels   KABALE " })).toMatchObject({ hotel: KABALE.publicId, hotelName: "K Hotels Kabale" });
    expect(await run("calculate_stay_price", { hotel: "K Hotels Kabale", roomType: "Double", ...STAY })).toMatchObject({ stayTotal: 900000 });
    // The same boundary as ids: an unlisted hotel, a hotel whose mapping is broken, a partial name, another hotel on a scoped link.
    for (const hotel of ["Hidden Lodge", "Broken Inn", "Kabale", "K Hotels"]) {
      expect(await run("get_hotel_info", { hotel })).toMatchObject({ error: "unknown_hotel" });
    }
    const scoped = await context({}, KABALE.publicId);
    expect(await run("get_hotel_info", { hotel: "K Hotels Mbarara" }, scoped)).toMatchObject({ error: "unknown_hotel" });
    expect(await run("get_hotel_info", { hotel: "K Hotels Kabale" }, scoped)).toMatchObject({ hotelName: "K Hotels Kabale" });
  });

  it("a name shared by two reachable hotels resolves to neither", async () => {
    await adminDb().doc(`hotels/${MBARARA.hotelId}`).update({ name: "K Hotels Kabale" });
    expect(await run("get_hotel_info", { hotel: "K Hotels Kabale" })).toMatchObject({ error: "unknown_hotel" });
    expect(await run("get_hotel_info", { hotel: KABALE.publicId })).toMatchObject({ hotelName: "K Hotels Kabale" });
  });

  it("an unlisted hotel's own concierge link still reaches it", async () => {
    const scoped = await context({}, HIDDEN.publicId);
    expect(await run("get_hotel_info", { hotel: HIDDEN.publicId }, scoped)).toMatchObject({ hotelName: "Hidden Lodge" });
  });
});
