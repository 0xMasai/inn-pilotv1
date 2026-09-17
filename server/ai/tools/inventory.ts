/**
 * Reads of a hotel's rooms and stays, shared by the concierge tools.
 *
 * Always through a HotelScope, so they can only see the scoped hotel. The
 * shapes returned are exactly what the shared booking rules in
 * src/lib/booking.ts consume, so no tool interprets a room or a stay on
 * its own.
 *
 * `offersFor()` is the one answer to "what can this guest book here for
 * these dates": search, availability, pricing, the booking summary and the
 * booking itself all start from it, so they can never disagree about which
 * rooms are free or what they cost.
 */
import type { DocumentData, QueryDocumentSnapshot, Transaction } from "firebase-admin/firestore";
import { COLLECTIONS } from "../../../src/lib/collections";
import { isRoomBookable, nightlyRateOf, type BookableRoom, type BookingLike } from "../../../src/lib/booking";
import { readAmenities, roomCapacityOf, roomTypeIncludes, roomTypeMatches } from "../../../src/lib/hotelListing";
import type { HotelScope } from "../../hotels";

export interface InventoryRoom extends BookableRoom {
  id: string;
  type: string;
  status: string;
  /** Guests the room sleeps, when the hotel recorded it. */
  capacity: number | null;
  amenities: string[];
}

function toRoom(doc: QueryDocumentSnapshot<DocumentData>): InventoryRoom {
  const data = doc.data();
  return {
    id: doc.id,
    number: String(data.number ?? ""),
    type: typeof data.type === "string" ? data.type : "",
    price: data.price,
    status: String(data.status ?? "Available"),
    capacity: roomCapacityOf(data),
    amenities: readAmenities(data.amenities),
  };
}

/** Firestore Timestamps expose toDate(), which BookingLike already accepts. */
const toStay = (doc: QueryDocumentSnapshot<DocumentData>): BookingLike => doc.data() as BookingLike;

export async function loadRooms(scope: HotelScope): Promise<InventoryRoom[]> {
  const snap = await scope.collection(COLLECTIONS.ROOMS).get();
  return snap.docs
    .map(toRoom)
    .filter((room) => room.number)
    .sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }));
}

/**
 * Every stay that can hold a room: legacy `accomodation` records and
 * `reservations` together, as bookingOverlaps() requires.
 */
export async function loadStays(scope: HotelScope): Promise<BookingLike[]> {
  const [bookings, reservations] = await Promise.all([
    scope.collection(COLLECTIONS.BOOKINGS).get(),
    scope.collection(COLLECTIONS.RESERVATIONS).get(),
  ]);
  return [...bookings.docs, ...reservations.docs].map(toStay);
}

/** Room numbers are strings, but some legacy documents stored them as numbers. */
function roomNumberKeys(roomNumber: string): (string | number)[] {
  return /^\d+$/.test(roomNumber) ? [roomNumber, Number(roomNumber)] : [roomNumber];
}

/**
 * The room and every stay on it, read inside `tx` — so the transaction
 * fails and retries if any of them changes before the booking commits.
 */
export async function readRoomForBooking(
  scope: HotelScope,
  tx: Transaction,
  roomNumber: string
): Promise<{ room: InventoryRoom | null; stays: BookingLike[] }> {
  const keys = roomNumberKeys(roomNumber);
  const [rooms, bookings, reservations] = await Promise.all([
    tx.get(scope.collection(COLLECTIONS.ROOMS).where("number", "in", keys)),
    tx.get(scope.collection(COLLECTIONS.BOOKINGS).where("roomNumber", "in", keys)),
    tx.get(scope.collection(COLLECTIONS.RESERVATIONS).where("roomNumber", "in", keys)),
  ]);
  return {
    room: rooms.empty ? null : toRoom(rooms.docs[0]),
    stays: [...bookings.docs, ...reservations.docs].map(toStay),
  };
}

/* ------------------------------------------------------------------ */
/* Rates by type                                                        */
/* ------------------------------------------------------------------ */

export type RateRange = { from: number; to: number } | null;

/** Lowest and highest configured rate across `rooms`, or null if none is set. */
export function rateRange(rooms: InventoryRoom[]): RateRange {
  const rates = rooms.map(nightlyRateOf).filter((rate): rate is number => rate !== null);
  return rates.length ? { from: Math.min(...rates), to: Math.max(...rates) } : null;
}

/** Recorded capacities across `rooms`, or null when none is recorded. */
export function capacityRange(rooms: InventoryRoom[]): RateRange {
  const capacities = rooms.map((room) => room.capacity).filter((c): c is number => c !== null);
  return capacities.length ? { from: Math.min(...capacities), to: Math.max(...capacities) } : null;
}

/** Rooms grouped by type, in the order the types first appear. */
export function groupByType(rooms: InventoryRoom[]): Map<string, InventoryRoom[]> {
  const groups = new Map<string, InventoryRoom[]>();
  for (const room of rooms) {
    const type = room.type || "Unspecified";
    groups.set(type, [...(groups.get(type) ?? []), room]);
  }
  return groups;
}

/* ------------------------------------------------------------------ */
/* What a guest can book                                                */
/* ------------------------------------------------------------------ */

/** One room type a guest can book for a stay, priced from its cheapest free room. */
export interface RoomTypeOffer {
  roomType: string;
  /** Free, priced and big enough for the party; cheapest first. What a booking tries, in order. */
  rooms: InventoryRoom[];
  nightlyRate: number;
  stayTotal: number;
  /** The cheapest room's recorded capacity, or null. */
  capacity: number | null;
  amenities: string[];
}

export interface StayQuery {
  checkIn: Date;
  checkOut: Date;
  nights: number;
  roomType?: string;
  /** "exact" (default) for pricing and booking; "includes" for search ("double" finds "Deluxe Double"). */
  roomTypeMatch?: "exact" | "includes";
  guests?: number;
}

/**
 * Room types bookable for a stay at this hotel, cheapest first.
 *
 * A room counts when the shared isRoomBookable() rule says it's free, it has
 * a configured rate (a room with none can't be priced, so it can't be booked
 * here), and it isn't recorded as too small for the party. A room with no
 * recorded capacity isn't excluded — it just isn't claimed to fit.
 */
export async function offersFor(scope: HotelScope, query: StayQuery): Promise<RoomTypeOffer[]> {
  const [rooms, stays] = await Promise.all([loadRooms(scope), loadStays(scope)]);
  return offersFrom(rooms, stays, query);
}

export function offersFrom(rooms: InventoryRoom[], stays: BookingLike[], query: StayQuery): RoomTypeOffer[] {
  const free = rooms.filter(
    (room) =>
      (!query.roomType ||
        (query.roomTypeMatch === "includes" ? roomTypeIncludes : roomTypeMatches)(query.roomType, room.type)) &&
      nightlyRateOf(room) !== null &&
      !(query.guests && room.capacity !== null && room.capacity < query.guests) &&
      isRoomBookable(room, query.checkIn, query.checkOut, stays)
  );

  return [...groupByType(free)]
    .map(([roomType, ofType]) => {
      const sorted = [...ofType].sort((a, b) => (nightlyRateOf(a) ?? 0) - (nightlyRateOf(b) ?? 0));
      const cheapest = sorted[0];
      const nightlyRate = nightlyRateOf(cheapest) ?? 0;
      return {
        roomType,
        rooms: sorted,
        nightlyRate,
        stayTotal: nightlyRate * query.nights,
        capacity: cheapest.capacity,
        amenities: cheapest.amenities,
      };
    })
    .sort((a, b) => a.stayTotal - b.stayTotal);
}
