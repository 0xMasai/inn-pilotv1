/**
 * check_availability — room types free at ONE hotel for a stay.
 *
 * For a guest who has picked a hotel and wants to see what else it has, or
 * who changed dates. Computed at call time with offersFor(), the same rule
 * search, the booking summary and the booking use. The result is a snapshot,
 * and says so: create_reservation re-checks inside its transaction.
 *
 * Room types, counts and prices only — no room numbers (the hotel assigns the
 * room, D26) and nothing about other guests.
 */
import { MAX_GUESTS, readInteger, readStayDates, readString } from "./args.js";
import { offersFor } from "./inventory.js";
import { placeOf, readHotelArg, type ConciergeTool } from "./types.js";

export const availabilityTool: ConciergeTool = {
  definition: {
    name: "check_availability",
    description:
      "Check which room types are free at one specific hotel for a stay, with live nightly rates and stay totals. " +
      "Use it when the guest is focused on one hotel or changes dates. Availability changes as other bookings come in.",
    parameters: {
      type: "object",
      properties: {
        hotel: { type: "string", description: "The hotel's `hotel` id from a search_hotels result, or its exact hotel name." },
        checkIn: { type: "string", description: "Arrival date, YYYY-MM-DD." },
        checkOut: { type: "string", description: "Departure date, YYYY-MM-DD. Must be after checkIn." },
        guests: { type: "integer", description: "Optional. Number of guests staying." },
        roomType: { type: "string", description: "Optional. Only this room type, e.g. \"Double\"." },
      },
      required: ["hotel", "checkIn", "checkOut"],
    },
  },

  async run(context, args) {
    const hotel = await readHotelArg(context, args);
    if (!hotel.ok) return hotel.result;
    const { scope } = hotel;

    const parsed = readStayDates(args, context.now);
    if (!parsed.ok) return { error: "invalid_dates", message: parsed.message };
    const { checkIn, checkOut, checkInDate, checkOutDate, nights } = parsed.dates;

    const guests = readInteger(args, "guests", 1, MAX_GUESTS);
    if (guests === null) return { error: "invalid_guests", message: `guests must be a whole number from 1 to ${MAX_GUESTS}.` };
    const roomType = readString(args, "roomType", 40);

    const offers = await offersFor(scope, { checkIn, checkOut, nights, guests, roomType: roomType || undefined, roomTypeMatch: "includes" });

    return {
      ...placeOf(scope),
      checkIn: checkInDate,
      checkOut: checkOutDate,
      nights,
      ...(guests !== undefined ? { guests } : {}),
      currency: scope.profile.currency,
      totalAvailable: offers.reduce((sum, offer) => sum + offer.rooms.length, 0),
      roomTypes: offers.map((offer) => ({
        roomType: offer.roomType,
        availableRooms: offer.rooms.length,
        capacity: offer.capacity,
        nightlyRate: offer.nightlyRate,
        stayTotal: offer.stayTotal,
      })),
      guidance: [
        "This is a snapshot taken just now. Never promise a room is held — only create_reservation books one.",
        "capacity null means it isn't recorded: don't claim the room fits the party.",
        offers.length === 0
          ? "Nothing matching is free here for those dates. Say so and offer other dates, or search_hotels for other hotels."
          : "Quote only these figures.",
      ],
    };
  },
};
