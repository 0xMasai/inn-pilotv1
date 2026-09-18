/**
 * create_reservation — book the stay the guest confirmed.
 *
 * The only tool that writes a booking, and the only way the concierge books.
 *
 *   1. Consent (D27). There must be a pending booking summary from an
 *      EARLIER turn that matches these arguments, and the guest's message in
 *      this turn must be an explicit confirmation. Otherwise nothing happens
 *      and the model is told to show the summary and ask.
 *   2. Room choice (D26). The hotel's free rooms of that type are tried
 *      cheapest first. Each attempt is one Admin SDK transaction that
 *      re-reads the room and every stay on it and runs the shared
 *      checkRoomBookable() rule against that fresh state before writing —
 *      nothing earlier lookups said is trusted. If another booking lands on
 *      the room first, Firestore retries the transaction, which then refuses,
 *      and the next room is tried.
 *   3. Price. A room is only booked at the total the guest confirmed. If the
 *      only free rooms now cost something else, nothing is booked and the new
 *      figure is returned.
 *   4. The booking is an ordinary `accomodation` document built by the
 *      shared buildBookingDoc(), marked `source: "concierge"`, with an audit
 *      entry in the same commit — so the front desk sees, checks in and
 *      cancels it like any other.
 *
 * Failures are returned, not thrown, as `status: "not_booked"` with a
 * machine-readable reason, so the model can explain and recover.
 */
import {
  buildBookingDoc,
  checkRoomBookable,
  makeReservationId,
  nightlyRateOf,
  validateBookingDetails,
} from "../../../src/lib/booking.js";
import { COLLECTIONS } from "../../../src/lib/collections.js";
import { isExplicitConfirmation } from "../../../src/lib/confirmation.js";
import { normalizeRoomType } from "../../../src/lib/hotelListing.js";
import type { HotelScope } from "../../hotels.js";
import type { ConciergeBooking, PendingBooking } from "../types.js";
import { readStayDates, readString, type StayDates } from "./args.js";
import { offersFor, readRoomForBooking } from "./inventory.js";
import { readGuestDetails } from "./prepareBooking.js";
import { readHotelArg, type ConciergeTool } from "./types.js";

/** A summary older than this must be prepared (and re-checked) again. */
export const PENDING_BOOKING_TTL_MS = 60 * 60_000;

export type NotBookedReason =
  | "needs_confirmation"
  | "missing_information"
  | "invalid_dates"
  | "unknown_hotel"
  | "room_not_found"
  | "room_unavailable"
  | "dates_taken"
  | "no_longer_available"
  | "price_changed"
  | "rate_not_configured";

const notBooked = (reason: NotBookedReason, message: string, extra: Record<string, unknown> = {}) => ({
  status: "not_booked" as const,
  reason,
  message,
  ...extra,
});

export type BookRoomResult =
  | { status: "not_booked"; reason: NotBookedReason; message: string; totalPrice?: number }
  | {
      status: "confirmed";
      reservationId: string;
      roomNumber: string;
      roomType: string;
      checkIn: string;
      checkOut: string;
      nights: number;
      numberOfGuests: number;
      nightlyRate: number;
      totalPrice: number;
    };

const digits = (value: string) => value.replace(/\D/g, "");
const sameName = (a: string, b: string) => a.trim().replace(/\s+/g, " ").toLowerCase() === b.trim().replace(/\s+/g, " ").toLowerCase();

/** The detail in which `args` differ from the confirmed summary, or null when they agree. */
export function pendingMismatch(pending: PendingBooking, args: Record<string, unknown>): string | null {
  // The summary's own hotel, named by its public id or its exact name (see server/network.ts).
  const hotel = readString(args, "hotel", 120);
  if (hotel !== pending.hotel && !sameName(hotel, pending.hotelName)) return "hotel";
  if (normalizeRoomType(readString(args, "roomType", 40)) !== normalizeRoomType(pending.roomType)) return "roomType";
  if (readString(args, "checkIn", 10) !== pending.checkIn) return "checkIn";
  if (readString(args, "checkOut", 10) !== pending.checkOut) return "checkOut";
  if (!sameName(readString(args, "guestName", 120), pending.guestName)) return "guestName";
  if (digits(readString(args, "guestPhoneNumber", 40)) !== digits(pending.guestPhone)) return "guestPhoneNumber";
  return null;
}

export interface BookRoomInput {
  roomNumber: string;
  dates: StayDates;
  guestName: string;
  guestPhoneNumber: string;
  guestEmail?: string;
  numberOfGuests: number;
  notes?: string;
  /** Refuse to book unless the room's stay total is exactly this. */
  expectedTotal?: number;
}

/**
 * One room, one transaction: re-read, re-check, book. The booking core the
 * concierge has always used (D9), unchanged in substance.
 */
export async function bookRoom(scope: HotelScope, input: BookRoomInput): Promise<BookRoomResult> {
  const { roomNumber, dates } = input;
  const { checkIn, checkOut, checkInDate, checkOutDate, nights } = dates;
  const detailsError = validateBookingDetails({ guestName: input.guestName, roomNumber, checkIn, checkOut });
  if (detailsError) return notBooked("missing_information", detailsError);

  const reservationId = makeReservationId();

  return scope.runTransaction(async (tx): Promise<BookRoomResult> => {
    const { room, stays } = await readRoomForBooking(scope, tx, roomNumber);
    if (!room) return notBooked("room_not_found", `Room ${roomNumber} doesn't exist.`);

    const bookability = checkRoomBookable(room, checkIn, checkOut, stays);
    if (bookability.bookable === false) {
      return bookability.reason === "room-out-of-service"
        ? notBooked("room_unavailable", "That room can't be booked right now.")
        : notBooked("dates_taken", "That room was just booked for those dates.");
    }

    const nightlyRate = nightlyRateOf(room);
    if (nightlyRate === null) return notBooked("rate_not_configured", "That room has no rate set.");
    const totalPrice = nightlyRate * nights;
    if (input.expectedTotal !== undefined && totalPrice !== input.expectedTotal) {
      return { ...notBooked("price_changed", "The price changed."), totalPrice };
    }

    const bookingRef = scope.collection(COLLECTIONS.BOOKINGS).doc();
    tx.create(
      bookingRef,
      buildBookingDoc(
        {
          hotelId: scope.hotelId,
          reservationId,
          room,
          guestName: input.guestName,
          guestPhoneNumber: input.guestPhoneNumber,
          guestEmail: input.guestEmail,
          numberOfGuests: input.numberOfGuests,
          checkIn,
          checkOut,
          pricePaid: 0,
          paymentStatus: "Pending",
          notes: input.notes,
          source: "concierge",
          quotedTotal: totalPrice,
        },
        scope.serverTimestamp()
      )
    );
    // Same shape as src/lib/audit.ts logAction(), written in the same commit.
    tx.create(scope.collection(COLLECTIONS.AUDIT).doc(), {
      action: "Booking created",
      entity: "booking",
      entityId: bookingRef.id,
      details: `${reservationId} · ${input.guestName} · room ${room.number} · via AI concierge`,
      hotelId: scope.hotelId,
      at: scope.serverTimestamp(),
    });

    return {
      status: "confirmed" as const,
      reservationId,
      roomNumber: room.number,
      roomType: room.type,
      checkIn: checkInDate,
      checkOut: checkOutDate,
      nights,
      numberOfGuests: input.numberOfGuests,
      nightlyRate,
      totalPrice,
    };
  });
}

export const createReservationTool: ConciergeTool = {
  definition: {
    name: "create_reservation",
    description:
      "Create the real reservation for a booking summary the guest has ALREADY seen (from prepare_booking in an earlier " +
      "message) and has just explicitly confirmed. Pass exactly the same hotel, room type, dates, name and phone as the " +
      "summary. It re-checks availability and price itself. If it returns not_booked, nothing was booked.",
    parameters: {
      type: "object",
      properties: {
        hotel: { type: "string", description: "The hotel's `hotel` id or exact name, as in the summary." },
        roomType: { type: "string", description: "The room type, as in the summary." },
        checkIn: { type: "string", description: "Arrival date, YYYY-MM-DD." },
        checkOut: { type: "string", description: "Departure date, YYYY-MM-DD." },
        guestName: { type: "string", description: "The guest's full name, as in the summary." },
        guestPhoneNumber: { type: "string", description: "The guest's phone number, as in the summary." },
        notes: { type: "string", description: "Optional. Special requests the guest asked to pass on." },
      },
      required: ["hotel", "roomType", "checkIn", "checkOut", "guestName", "guestPhoneNumber"],
    },
  },

  async run(context, args) {
    const pending = context.pendingBooking;
    if (!pending || context.now.getTime() - pending.preparedAt > PENDING_BOOKING_TTL_MS) {
      return notBooked(
        "needs_confirmation",
        "There is no booking summary for the guest to confirm. Call prepare_booking, show the summary, and ask the " +
          "guest to confirm. Book only after they say yes in their next message."
      );
    }
    const mismatch = pendingMismatch(pending, args);
    if (mismatch) {
      return notBooked(
        "needs_confirmation",
        `These details differ from the summary the guest saw (${mismatch}). Call prepare_booking with the correct ` +
          "details and ask the guest to confirm the new summary."
      );
    }
    if (!isExplicitConfirmation(context.guestMessage)) {
      return notBooked(
        "needs_confirmation",
        "The guest hasn't clearly confirmed in their latest message. Ask: \"Would you like me to confirm this booking?\" " +
          "and wait for a clear yes."
      );
    }

    const hotel = await readHotelArg(context, args);
    if (hotel.ok === false) return notBooked("unknown_hotel", String(hotel.result.message));
    const { scope } = hotel;

    const parsed = readStayDates(args, context.now);
    if (parsed.ok === false) return notBooked("invalid_dates", parsed.message);
    const guest = readGuestDetails({ ...args, guestEmail: pending.guestEmail, numberOfGuests: pending.numberOfGuests });
    if (guest.ok === false) return notBooked("missing_information", guest.message, { missing: guest.missing });

    const [offer] = await offersFor(scope, { ...parsed.dates, roomType: pending.roomType, guests: pending.numberOfGuests });
    const candidates = offer?.rooms ?? [];
    let newTotal: number | null = null;

    for (const room of candidates) {
      const result = await bookRoom(scope, {
        roomNumber: room.number,
        dates: parsed.dates,
        guestName: pending.guestName,
        guestPhoneNumber: pending.guestPhone,
        guestEmail: pending.guestEmail,
        numberOfGuests: pending.numberOfGuests,
        notes: readString(args, "notes", 500),
        expectedTotal: pending.totalPrice,
      });
      if (result.status === "confirmed") {
        const booking: ConciergeBooking = {
          reservationId: String(result.reservationId),
          hotel: scope.publicId,
          hotelName: scope.profile.name,
          city: scope.profile.location,
          hotelPhone: scope.profile.phone,
          hotelEmail: scope.profile.email,
          roomType: String(result.roomType || pending.roomType),
          checkIn: parsed.dates.checkInDate,
          checkOut: parsed.dates.checkOutDate,
          nights: parsed.dates.nights,
          numberOfGuests: pending.numberOfGuests,
          guestName: pending.guestName,
          nightlyRate: Number(result.nightlyRate),
          totalPrice: Number(result.totalPrice),
          currency: scope.profile.currency,
          paymentStatus: "Pending",
        };
        return {
          status: "confirmed",
          booking,
          guidance:
            "The reservation exists. Give the guest the reservation reference, hotel, room type, dates and total, and say " +
            "payment is settled with the hotel — nothing has been charged.",
        };
      }
      if (result.reason === "price_changed" && typeof result.totalPrice === "number") newTotal = result.totalPrice;
      // dates_taken, room_unavailable, price_changed: try the next room.
    }

    if (newTotal !== null) {
      return notBooked(
        "price_changed",
        `Nothing was booked: the only free ${pending.roomType} rooms now cost ${newTotal} ${scope.profile.currency} for the stay, ` +
          `not ${pending.totalPrice}. Tell the guest and, if they want it, call prepare_booking again for a new summary.`,
        { newTotalPrice: newTotal, currency: scope.profile.currency }
      );
    }
    return notBooked(
      "no_longer_available",
      `Nothing was booked: no ${pending.roomType} room is free at ${scope.profile.name} for those dates any more — ` +
        "someone else booked it. Apologise, then call search_hotels again with the same dates and offer the alternatives."
    );
  },
};
