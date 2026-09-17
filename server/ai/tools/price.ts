/**
 * calculate_stay_price — what a stay in one room type at one hotel costs.
 *
 * nightly rate × nights, from the cheapest room of that type that is free
 * for the dates right now (offersFor()). It re-checks availability because
 * a price for a room that's gone is not a price. Books nothing.
 */
import { MAX_GUESTS, readInteger, readStayDates, readString } from "./args";
import { offersFor } from "./inventory";
import { placeOf, readHotelArg, type ConciergeTool } from "./types";

export const stayPriceTool: ConciergeTool = {
  definition: {
    name: "calculate_stay_price",
    description:
      "Calculate the live price of a stay: nightly rate, number of nights and total, for one room type at one hotel. " +
      "It re-checks that the room type is still free. Use it when the guest asks what a specific stay costs.",
    parameters: {
      type: "object",
      properties: {
        hotel: { type: "string", description: "The hotel's `hotel` id from a search_hotels result, or its exact hotel name." },
        roomType: { type: "string", description: "The room type, exactly as a result named it." },
        checkIn: { type: "string", description: "Arrival date, YYYY-MM-DD." },
        checkOut: { type: "string", description: "Departure date, YYYY-MM-DD." },
        guests: { type: "integer", description: "Optional. Number of guests staying." },
      },
      required: ["hotel", "roomType", "checkIn", "checkOut"],
    },
  },

  async run(context, args) {
    const hotel = await readHotelArg(context, args);
    if (!hotel.ok) return hotel.result;
    const { scope } = hotel;

    const roomType = readString(args, "roomType", 40);
    if (!roomType) return { error: "missing_room_type", message: "roomType is required." };
    const parsed = readStayDates(args, context.now);
    if (!parsed.ok) return { error: "invalid_dates", message: parsed.message };
    const { checkIn, checkOut, checkInDate, checkOutDate, nights } = parsed.dates;
    const guests = readInteger(args, "guests", 1, MAX_GUESTS);
    if (guests === null) return { error: "invalid_guests", message: `guests must be a whole number from 1 to ${MAX_GUESTS}.` };

    const [offer] = await offersFor(scope, { checkIn, checkOut, nights, roomType, guests });
    const base = { ...placeOf(scope), roomType, checkIn: checkInDate, checkOut: checkOutDate, nights, currency: scope.profile.currency };
    if (!offer) {
      return {
        ...base,
        available: false,
        message: `No ${roomType} room is free at ${scope.profile.name} for those dates. Offer to search again.`,
      };
    }
    return {
      ...base,
      roomType: offer.roomType,
      available: true,
      availableRooms: offer.rooms.length,
      capacity: offer.capacity,
      nightlyRate: offer.nightlyRate,
      stayTotal: offer.stayTotal,
      calculation: `${offer.nightlyRate} × ${nights} night${nights === 1 ? "" : "s"} = ${offer.stayTotal}`,
      guidance: "Quote exactly these figures. This is not a hold.",
    };
  },
};
