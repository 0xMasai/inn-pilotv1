/**
 * get_hotel_info — one hotel's verified guest-facing details.
 *
 * Only what the hotel actually recorded in InnPilot: contact details,
 * location, description, amenities, check-in and check-out times, policies,
 * and its room types with rate and capacity ranges. Whatever it left empty
 * is listed in `notRecorded`, so the model has a fact to relay ("I can't
 * confirm that") instead of a gap to fill with a guess.
 */
import { capacityRange, groupByType, loadRooms, rateRange } from "./inventory.js";
import { placeOf, readHotelArg, type ConciergeTool } from "./types.js";

export const hotelInfoTool: ConciergeTool = {
  definition: {
    name: "get_hotel_info",
    description:
      "Get one hotel's verified details: location, description, contact phone and email, amenities (e.g. breakfast, " +
      "parking, Wi-Fi), check-in and check-out times, policies, and its room types with nightly rate ranges. Call it " +
      "before answering any question about a hotel itself. It says nothing about availability for dates.",
    parameters: {
      type: "object",
      properties: {
        hotel: { type: "string", description: "The hotel's `hotel` id from a search_hotels result, or its exact hotel name." },
      },
      required: ["hotel"],
    },
  },

  async run(context, args) {
    const hotel = await readHotelArg(context, args);
    if (hotel.ok === false) return hotel.result;
    const { scope } = hotel;
    const { profile } = scope;
    const rooms = await loadRooms(scope);

    const notRecorded = [
      !profile.description && "description",
      !profile.amenities.length && "amenities and facilities (including breakfast, parking and Wi-Fi)",
      !profile.checkInTime && "check-in time",
      !profile.checkOutTime && "check-out time",
      !profile.policies && "cancellation, payment, pet and child policies",
      !profile.phone && "phone number",
      !profile.email && "email address",
    ].filter(Boolean);

    return {
      ...placeOf(scope),
      country: profile.country || null,
      description: profile.description || null,
      contactPhone: profile.phone || null,
      contactEmail: profile.email || null,
      currency: profile.currency,
      amenities: profile.amenities,
      checkInTime: profile.checkInTime || null,
      checkOutTime: profile.checkOutTime || null,
      policies: profile.policies || null,
      roomTypes: [...groupByType(rooms)].map(([roomType, ofType]) => ({
        roomType,
        nightlyRate: rateRange(ofType),
        sleeps: capacityRange(ofType),
      })),
      notRecorded,
      guidance:
        "Answer only from these fields. Anything in notRecorded is unknown: say you can't confirm it and offer the " +
        "hotel's contact details. An amenity that isn't listed is not recorded — don't say the hotel lacks it or has it.",
    };
  },
};
