/**
 * prepare_booking — everything a booking needs, checked, with nothing booked.
 *
 * The step between "I'll take that one" and "yes, confirm":
 *   1. the guest's details are complete and plausible;
 *   2. the dates are valid;
 *   3. the room type is still free at that hotel (availability re-checked);
 *   4. the price is re-calculated from the live rate.
 *
 * A "ready" result is the booking summary the guest must confirm. The gateway
 * keeps it on the server's copy of the conversation as the pending booking,
 * and create_reservation will only book that exact summary, in a later turn,
 * after an explicit yes (DECISIONS D27).
 */
import type { ConciergeQuote } from "../types.js";
import { MAX_GUESTS, readInteger, readStayDates, readString } from "./args.js";
import { offersFor } from "./inventory.js";
import { readHotelArg, type ConciergeTool } from "./types.js";

export const PHONE_PATTERN = /^\+?[\d\s()-]{7,20}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NAME_PATTERN = /\p{L}.*\p{L}/u;

/** Test failure with `guest.ok === false`, not `!guest.ok`: Vercel type-checks with strict off, where only the former narrows. */
export type GuestDetails =
  | { ok: true; guestName: string; guestPhone: string; guestEmail: string; numberOfGuests: number }
  | { ok: false; missing: string[]; message: string };

/** The guest's details from tool arguments, validated the same way for summary and booking. */
export function readGuestDetails(args: Record<string, unknown>): GuestDetails {
  const guestName = readString(args, "guestName", 120).replace(/\s+/g, " ");
  const guestPhone = readString(args, "guestPhoneNumber", 40);
  const guestEmail = readString(args, "guestEmail", 254);
  const missing = [!guestName && "guestName", !guestPhone && "guestPhoneNumber"].filter((m): m is string => Boolean(m));
  if (missing.length) {
    return { ok: false, missing, message: "Ask the guest for the missing details (full name and phone number) before continuing." };
  }
  if (!NAME_PATTERN.test(guestName)) {
    return { ok: false, missing: ["guestName"], message: "That doesn't look like a name. Ask the guest for their full name." };
  }
  if (!PHONE_PATTERN.test(guestPhone) || guestPhone.replace(/\D/g, "").length < 7) {
    return { ok: false, missing: ["guestPhoneNumber"], message: "The phone number doesn't look valid. Ask the guest to check it." };
  }
  if (guestEmail && !EMAIL_PATTERN.test(guestEmail)) {
    return { ok: false, missing: ["guestEmail"], message: "The email address doesn't look valid. Ask the guest to check it, or leave it out." };
  }
  const numberOfGuests = readInteger(args, "numberOfGuests", 1, MAX_GUESTS);
  if (numberOfGuests === null) {
    return { ok: false, missing: ["numberOfGuests"], message: `numberOfGuests must be a whole number from 1 to ${MAX_GUESTS}.` };
  }
  return { ok: true, guestName, guestPhone, guestEmail, numberOfGuests: numberOfGuests ?? 1 };
}

const notReady = (reason: string, message: string, extra: Record<string, unknown> = {}) => ({
  status: "not_ready",
  reason,
  message,
  ...extra,
});

export const prepareBookingTool: ConciergeTool = {
  definition: {
    name: "prepare_booking",
    description:
      "Prepare a booking for the guest to confirm. Re-checks that the room type is still free, re-calculates the price and " +
      "validates the guest's details. Books NOTHING. Call it once the guest has chosen a hotel and room type and given their " +
      "full name and phone number. If it returns status \"ready\", show the summary and ask the guest to confirm; never " +
      "call create_reservation in the same turn.",
    parameters: {
      type: "object",
      properties: {
        hotel: { type: "string", description: "The hotel's `hotel` id from a search_hotels result, or its exact hotel name." },
        roomType: { type: "string", description: "The room type, exactly as a result named it." },
        checkIn: { type: "string", description: "Arrival date, YYYY-MM-DD." },
        checkOut: { type: "string", description: "Departure date, YYYY-MM-DD." },
        guestName: { type: "string", description: "The guest's full name, as they gave it." },
        guestPhoneNumber: { type: "string", description: "The guest's phone number, as they gave it." },
        guestEmail: { type: "string", description: "Optional. The guest's email, if they gave one." },
        numberOfGuests: { type: "integer", description: "Optional. How many people are staying. Defaults to 1." },
      },
      required: ["hotel", "roomType", "checkIn", "checkOut", "guestName", "guestPhoneNumber"],
    },
  },

  async run(context, args) {
    const hotel = await readHotelArg(context, args);
    if (hotel.ok === false) return notReady("unknown_hotel", String(hotel.result.message));
    const { scope } = hotel;

    const roomType = readString(args, "roomType", 40);
    if (!roomType) return notReady("missing_information", "Which room type did the guest choose?", { missing: ["roomType"] });

    const parsed = readStayDates(args, context.now);
    if (parsed.ok === false) return notReady("invalid_dates", parsed.message);
    const { checkIn, checkOut, checkInDate, checkOutDate, nights } = parsed.dates;

    const guest = readGuestDetails(args);
    if (guest.ok === false) return notReady("missing_information", guest.message, { missing: guest.missing });

    const [offer] = await offersFor(scope, { checkIn, checkOut, nights, roomType, guests: guest.numberOfGuests });
    if (!offer) {
      return notReady(
        "no_longer_available",
        `No ${roomType} room for ${guest.numberOfGuests} is free at ${scope.profile.name} for those dates any more. ` +
          "Tell the guest, then search again for alternatives."
      );
    }

    const summary: ConciergeQuote = {
      hotel: scope.publicId,
      hotelName: scope.profile.name,
      city: scope.profile.location,
      roomType: offer.roomType,
      checkIn: checkInDate,
      checkOut: checkOutDate,
      nights,
      numberOfGuests: guest.numberOfGuests,
      guestName: guest.guestName,
      guestPhone: guest.guestPhone,
      guestEmail: guest.guestEmail,
      nightlyRate: offer.nightlyRate,
      totalPrice: offer.stayTotal,
      currency: scope.profile.currency,
    };

    return {
      status: "ready",
      summary,
      guidance:
        "Show this booking summary (hotel, room, check-in, check-out, nights, guest, total) and ask exactly: " +
        "\"Would you like me to confirm this booking?\" Nothing is booked yet. Do not call create_reservation until the " +
        "guest replies with a clear yes in their next message.",
    };
  },
};
