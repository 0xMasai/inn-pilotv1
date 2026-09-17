/**
 * The shared booking rules (src/lib/booking.ts) — pure, no emulator.
 *
 * The Accommodation screen and the concierge's server tools both run these,
 * so these tests pin the one definition both depend on.
 */
import { describe, expect, it } from "vitest";
import {
  buildBookingDoc,
  checkRoomBookable,
  isRoomBookable,
  makeReservationId,
  nightlyRateOf,
  validateBookingDetails,
  type BookingLike,
} from "../../src/lib/booking";

const d = (iso: string) => new Date(iso);
const room = { number: "101", type: "Double", price: 220000, status: "Available" };

describe("makeReservationId", () => {
  it("stamps the date and adds a random suffix", () => {
    const id = makeReservationId(d("2026-09-15T10:00:00Z"));
    expect(id).toMatch(/^RSV-20260915-[A-Z0-9]{6}$/);
    expect(makeReservationId()).not.toBe(makeReservationId());
  });
});

describe("validateBookingDetails", () => {
  const complete = { guestName: "Amina", roomNumber: "101", checkIn: d("2026-10-01"), checkOut: d("2026-10-03") };

  it("accepts a complete booking", () => {
    expect(validateBookingDetails(complete)).toBeNull();
  });

  it.each([
    [{ ...complete, guestName: "  " }, "Enter the guest's name."],
    [{ ...complete, checkIn: null }, "Select check-in and check-out dates."],
    [{ ...complete, checkOut: d("invalid") }, "Select check-in and check-out dates."],
    [{ ...complete, checkOut: complete.checkIn }, "Check-out must be after check-in."],
    [{ ...complete, roomNumber: "" }, "Select a room."],
  ])("rejects %o", (details, message) => {
    expect(validateBookingDetails(details)).toBe(message);
  });
});

describe("checkRoomBookable / isRoomBookable", () => {
  const stay = (overrides: Partial<BookingLike>): BookingLike => ({
    roomNumber: "101",
    checkIn: d("2026-10-02T12:00:00Z"),
    checkOut: d("2026-10-04T12:00:00Z"),
    status: "Confirmed",
    ...overrides,
  });
  const inDate = d("2026-10-01T12:00:00Z");
  const outDate = d("2026-10-03T12:00:00Z");

  it("a free room is bookable", () => {
    expect(checkRoomBookable(room, inDate, outDate, [])).toEqual({ bookable: true });
  });

  it.each(["Maintenance", "Out of Service"])("a room in %s is not bookable on any date", (status) => {
    expect(checkRoomBookable({ ...room, status }, inDate, outDate, [])).toEqual({
      bookable: false,
      reason: "room-out-of-service",
      status,
    });
  });

  it("a room being cleaned can still be booked", () => {
    expect(isRoomBookable({ ...room, status: "Cleaning" }, inDate, outDate, [])).toBe(true);
  });

  it("an overlapping active stay blocks the room", () => {
    const result = checkRoomBookable(room, inDate, outDate, [stay({ guestName: "Bob" })]);
    expect(result).toMatchObject({ bookable: false, reason: "dates-taken", conflict: { guestName: "Bob" } });
  });

  it("cancelled and no-show stays do not block", () => {
    const stays = [stay({ status: "Cancelled" }), stay({ status: "No Show" })];
    expect(isRoomBookable(room, inDate, outDate, stays)).toBe(true);
  });

  it("a legacy stay with no status still blocks", () => {
    expect(isRoomBookable(room, inDate, outDate, [stay({ status: undefined })])).toBe(false);
  });

  it("back-to-back stays do not collide", () => {
    const earlier = stay({ checkIn: d("2026-09-29T12:00:00Z"), checkOut: inDate });
    expect(isRoomBookable(room, inDate, outDate, [earlier])).toBe(true);
  });

  it("stays on other rooms are ignored, including numeric legacy room numbers", () => {
    expect(isRoomBookable(room, inDate, outDate, [stay({ roomNumber: "102" })])).toBe(true);
    expect(isRoomBookable(room, inDate, outDate, [stay({ roomNumber: 101 as unknown as string })])).toBe(false);
  });
});

describe("nightlyRateOf", () => {
  it.each([
    [220000, 220000],
    [45.5, 45.5],
    [0, null],
    [-10, null],
    ["220000", null],
    [undefined, null],
    [Number.NaN, null],
  ])("price %o → %o", (price, expected) => {
    expect(nightlyRateOf({ ...room, price })).toBe(expected);
  });
});

describe("buildBookingDoc", () => {
  const base = {
    hotelId: "HotelA",
    reservationId: "RSV-20261001-ABC123",
    room,
    guestName: "  Amina Okello ",
    checkIn: d("2026-10-01T12:00:00Z"),
    checkOut: d("2026-10-03T12:00:00Z"),
    paymentStatus: "Pending" as const,
  };

  it("builds a Confirmed booking with the room's type and sensible defaults", () => {
    const createdAt = Symbol("server-timestamp");
    expect(buildBookingDoc(base, createdAt)).toEqual({
      reservationId: "RSV-20261001-ABC123",
      guestName: "Amina Okello",
      guestPhoneNumber: "",
      roomNumber: "101",
      roomType: "Double",
      numberOfGuests: 1,
      checkIn: base.checkIn,
      checkOut: base.checkOut,
      pricePaid: 0,
      paymentStatus: "Pending",
      notes: "",
      status: "Confirmed",
      isOccupied: false,
      hotelId: "HotelA",
      createdAt,
    });
  });

  it("adds source and quotedTotal only when given — never undefined", () => {
    const front = buildBookingDoc(base, null);
    expect("source" in front).toBe(false);
    expect("quotedTotal" in front).toBe(false);

    const concierge = buildBookingDoc({ ...base, source: "concierge", quotedTotal: 440000, numberOfGuests: 2.7 }, null);
    expect(concierge).toMatchObject({ source: "concierge", quotedTotal: 440000, numberOfGuests: 2 });
    expect(Object.values(concierge).includes(undefined)).toBe(false);
  });
});
