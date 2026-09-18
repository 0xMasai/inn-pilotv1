/**
 * search_hotels — the network search (DECISIONS D24, D25).
 *
 * Every hotel this conversation may reach → those in the guest's destination
 * → each hotel's live rooms and stays → the room types free for the dates,
 * priced from their cheapest free room → a short, ranked list of options.
 *
 * Availability and prices come from offersFor(), the same rule every other
 * tool and the booking itself use. The result is a snapshot, and says so:
 * the booking re-checks everything.
 *
 * Ranking is deliberately plain: the requested room type, then rooms known
 * to fit the party, then price. At most two options per hotel, five in all,
 * so a guest sees a real choice across properties rather than one hotel's
 * whole inventory.
 */
import { matchesDestination, roomTypeMatches } from "../../../src/lib/hotelListing.js";
import type { HotelScope } from "../../hotels.js";
import type { ConciergeOption } from "../types.js";
import { MAX_GUESTS, readInteger, readStayDates, readString } from "./args.js";
import { offersFor, type RoomTypeOffer } from "./inventory.js";
import type { ConciergeTool } from "./types.js";

export const MAX_OPTIONS = 5;
const MAX_OPTIONS_PER_HOTEL = 2;
const MAX_AMENITIES_SHOWN = 6;

function describePlace(scope: HotelScope): string {
  const { location, region, country } = scope.profile;
  const where = [region && `${region} Region`, country].filter(Boolean).join(", ");
  return where ? `${location || scope.profile.name} (${where})` : location || scope.profile.name;
}

type Candidate = { scope: HotelScope; offer: RoomTypeOffer; matchesRequestedRoomType: boolean; exactRoomType: boolean };

function rank(candidates: Candidate[], guests: number | undefined): Candidate[] {
  const sorted = [...candidates].sort(
    (a, b) =>
      Number(b.matchesRequestedRoomType) - Number(a.matchesRequestedRoomType) ||
      // "Double" before "Deluxe Double" when the guest asked for a double.
      Number(b.exactRoomType) - Number(a.exactRoomType) ||
      // With a party size, rooms known to fit come before rooms that merely might.
      (guests ? Number(a.offer.capacity === null) - Number(b.offer.capacity === null) : 0) ||
      a.offer.stayTotal - b.offer.stayTotal
  );
  const perHotel = new Map<string, number>();
  const picked: Candidate[] = [];
  for (const candidate of sorted) {
    const count = perHotel.get(candidate.scope.publicId) ?? 0;
    if (count >= MAX_OPTIONS_PER_HOTEL) continue;
    perHotel.set(candidate.scope.publicId, count + 1);
    picked.push(candidate);
    if (picked.length >= MAX_OPTIONS) break;
  }
  return picked;
}

function toOption(candidate: Candidate, index: number, nights: number): ConciergeOption {
  const { scope, offer } = candidate;
  const amenities = [...new Set([...offer.amenities, ...scope.profile.amenities])].slice(0, MAX_AMENITIES_SHOWN);
  return {
    optionNumber: index + 1,
    hotel: scope.publicId,
    hotelName: scope.profile.name,
    city: scope.profile.location,
    region: scope.profile.region,
    roomType: offer.roomType,
    capacity: offer.capacity,
    availableRooms: offer.rooms.length,
    nightlyRate: offer.nightlyRate,
    nights,
    stayTotal: offer.stayTotal,
    currency: scope.profile.currency,
    amenities,
    matchesRequestedRoomType: candidate.matchesRequestedRoomType,
  };
}

export const searchHotelsTool: ConciergeTool = {
  definition: {
    name: "search_hotels",
    description:
      "Search every participating hotel for rooms that are free for a stay, with live nightly rates and stay totals. " +
      "Call it as soon as you know the check-in and check-out dates. Destination, room type and guest count are optional " +
      "filters: pass whatever the guest said. Returns at most 5 ranked options.",
    parameters: {
      type: "object",
      properties: {
        destination: {
          type: "string",
          description: "Optional. Where the guest wants to stay, in their words: a city, region or country, e.g. \"Western Uganda\" or \"Kabale\".",
        },
        checkIn: { type: "string", description: "Arrival date, YYYY-MM-DD." },
        checkOut: { type: "string", description: "Departure date, YYYY-MM-DD. Must be after checkIn." },
        roomType: { type: "string", description: "Optional. The room type asked for, e.g. \"Double\", \"Family\", \"Suite\"." },
        guests: { type: "integer", description: "Optional. Number of guests staying." },
      },
      required: ["checkIn", "checkOut"],
    },
  },

  async run(context, args) {
    const parsed = readStayDates(args, context.now);
    if (!parsed.ok) return { error: "invalid_dates", message: parsed.message };
    const { checkIn, checkOut, checkInDate, checkOutDate, nights } = parsed.dates;

    const guests = readInteger(args, "guests", 1, MAX_GUESTS);
    if (guests === null) return { error: "invalid_guests", message: `guests must be a whole number from 1 to ${MAX_GUESTS}.` };
    const destination = readString(args, "destination", 120);
    const roomType = readString(args, "roomType", 40);

    const hotels = await context.network.searchableHotels();
    if (hotels.length === 0) {
      return {
        status: "no_hotels",
        message: "No hotels are taking bookings through you right now. Apologise and say the team can be contacted directly.",
      };
    }

    const inDestination = hotels.filter((scope) =>
      matchesDestination(destination, {
        city: scope.profile.location,
        region: scope.profile.region,
        country: scope.profile.country,
      })
    );
    if (inDestination.length === 0) {
      return {
        status: "no_hotels_in_destination",
        destination,
        destinationsServed: [...new Set(hotels.map(describePlace))],
        guidance:
          "No participating hotel is in that destination. Tell the guest where hotels are available (destinationsServed) " +
          "and ask if one of those works. Don't suggest hotels that aren't in that list.",
      };
    }

    const query = { checkIn, checkOut, nights, guests };
    const perHotel = await Promise.all(
      inDestination.map(async (scope) => ({
        scope,
        wanted: await offersFor(scope, { ...query, roomType: roomType || undefined, roomTypeMatch: "includes" }),
        any: roomType ? await offersFor(scope, query) : [],
      }))
    );

    let candidates: Candidate[] = perHotel.flatMap(({ scope, wanted }) =>
      wanted.map((offer) => ({
        scope,
        offer,
        matchesRequestedRoomType: true,
        exactRoomType: !roomType || roomTypeMatches(roomType, offer.roomType),
      }))
    );
    const foundRequestedType = !roomType || candidates.length > 0;
    if (!foundRequestedType) {
      candidates = perHotel.flatMap(({ scope, any }) =>
        any.map((offer) => ({ scope, offer, matchesRequestedRoomType: false, exactRoomType: false }))
      );
    }

    const options = rank(candidates, guests).map((candidate, index) => toOption(candidate, index, nights));
    const base = {
      destination,
      checkIn: checkInDate,
      checkOut: checkOutDate,
      nights,
      roomType,
      guests: guests ?? null,
      hotelsSearched: inDestination.length,
      hotelNamesSearched: inDestination.map((scope) => scope.profile.name),
    };

    if (options.length === 0) {
      return {
        status: "no_availability",
        ...base,
        guidance:
          "Nothing is free at any matching hotel for those dates. Say so plainly and offer to search other dates " +
          "or a nearby destination.",
      };
    }

    return {
      status: "ok",
      ...base,
      requestedRoomTypeAvailable: foundRequestedType,
      options,
      guidance: [
        "This is a live snapshot, not a hold. Nothing is booked until create_reservation confirms it.",
        foundRequestedType
          ? "Present the options briefly, numbered, with hotel, location, room type, price per night and stay total. Say \"Here are N available options\" — don't call any option the best."
          : `No ${roomType} room is free; these are other room types at matching hotels. Say that first.`,
        "capacity null means the hotel hasn't recorded how many the room sleeps: don't claim it fits the party.",
        "Use the `hotel` value of the chosen option in every later tool call.",
      ],
    };
  },
};
