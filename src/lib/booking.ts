/**
 * Booking domain rules.
 *
 * Pure functions with no Firestore dependency — no SDK import, no
 * `firebase.ts` — so the Accommodation page (browser, client SDK) and the
 * concierge's server tools (Node, Admin SDK) share one definition of "this
 * room is taken", "this booking is complete" and "this is what a booking
 * document looks like". Change a booking rule here, and both follow.
 */
import type { BookingStatus } from "./collections.js";

export interface DateLikeValue {
  toDate?: () => Date;
}

export interface BookingLike {
  roomNumber?: string;
  guestName?: string;
  checkIn?: Date | DateLikeValue | string | number;
  checkOut?: Date | DateLikeValue | string | number;
  status?: BookingStatus;
  /**
   * Legacy `accomodation` records predate `status` and carry only this
   * flag. Kept so one overlap rule covers both collections.
   */
  isOccupied?: boolean;
}

export function toBookingDate(value: BookingLike["checkIn"]): Date | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "object") {
    if (typeof value.toDate !== "function") return null;
    const date = value.toDate();
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** A booking only holds inventory while it is confirmed or in-house. */
export function isActiveBooking(status?: BookingStatus): boolean {
  return status === "Confirmed" || status === "Checked In";
}

/**
 * The status a record behaves as. Matches metrics.bookingStatusOf(), but
 * stated in domain terms here so this module stays dependency-free: a
 * legacy document written before `status` existed is still a real stay
 * and must block inventory.
 */
export function effectiveBookingStatus(booking: BookingLike): BookingStatus {
  return booking.status ?? (booking.isOccupied ? "Checked In" : "Confirmed");
}

/**
 * The first active booking that collides with [checkIn, checkOut) on this
 * room, or undefined when the room is free.
 *
 * `bookings` must carry every collection that can hold a stay — the
 * legacy `accomodation` records AND `reservations` — or a booking made
 * through one flow looks free to the other.
 */
export function bookingOverlaps(
  roomNumber: string,
  checkIn: Date,
  checkOut: Date,
  bookings: BookingLike[]
): BookingLike | undefined {
  return bookings.find((booking) => {
    if (String(booking.roomNumber ?? "") !== roomNumber) return false;
    if (!isActiveBooking(effectiveBookingStatus(booking))) return false;
    const existingIn = toBookingDate(booking.checkIn);
    const existingOut = toBookingDate(booking.checkOut);
    if (!existingIn || !existingOut) return false;
    return checkIn < existingOut && existingIn < checkOut;
  });
}

/** Nights in a stay; always at least 1 for a valid range. */
export function bookingNights(checkIn: Date | null, checkOut: Date | null): number {
  if (!checkIn || !checkOut || checkOut <= checkIn) return 0;
  return Math.max(1, Math.ceil((checkOut.getTime() - checkIn.getTime()) / 86_400_000));
}

/* ------------------------------------------------------------------ */
/* Rooms                                                                */
/* ------------------------------------------------------------------ */

/** The parts of a room document the booking rules look at. */
export interface BookableRoom {
  number: string;
  type?: string;
  price?: unknown;
  status?: string;
}

/** Rooms in these states take no booking, on any date. */
export const UNBOOKABLE_ROOM_STATUSES = ["Maintenance", "Out of Service"] as const;

export function isRoomOutOfService(status?: string): boolean {
  return (UNBOOKABLE_ROOM_STATUSES as readonly string[]).includes(status ?? "");
}

export type RoomBookability =
  | { bookable: true }
  | { bookable: false; reason: "room-out-of-service"; status: string }
  | { bookable: false; reason: "dates-taken"; conflict: BookingLike };

/**
 * Whether `room` can take a stay over [checkIn, checkOut), and if not, why.
 *
 * `stays` must hold every stay that can occupy a room — both `accomodation`
 * and `reservations` — for the same reason bookingOverlaps() requires it.
 */
export function checkRoomBookable(
  room: BookableRoom,
  checkIn: Date,
  checkOut: Date,
  stays: BookingLike[]
): RoomBookability {
  if (isRoomOutOfService(room.status)) {
    return { bookable: false, reason: "room-out-of-service", status: String(room.status) };
  }
  const conflict = bookingOverlaps(String(room.number), checkIn, checkOut, stays);
  return conflict ? { bookable: false, reason: "dates-taken", conflict } : { bookable: true };
}

export function isRoomBookable(
  room: BookableRoom,
  checkIn: Date,
  checkOut: Date,
  stays: BookingLike[]
): boolean {
  return checkRoomBookable(room, checkIn, checkOut, stays).bookable;
}

/**
 * The room's nightly rate when one is actually configured, else null.
 * Zero is how a room with no rate set is stored, so it is not a price.
 */
export function nightlyRateOf(room: BookableRoom): number | null {
  const price = room.price;
  return typeof price === "number" && Number.isFinite(price) && price > 0 ? price : null;
}

/* ------------------------------------------------------------------ */
/* New bookings                                                         */
/* ------------------------------------------------------------------ */

/** Human-friendly reservation reference, e.g. RSV-20260915-A1B2C3. */
export function makeReservationId(now: Date = new Date()): string {
  const stamp = now.toISOString().slice(0, 10).replace(/-/g, "");
  const random = typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()
    : Math.random().toString(36).slice(2, 8).toUpperCase();
  return `RSV-${stamp}-${random}`;
}

/** The details every booking must have, however it is made. */
export interface BookingDetails {
  guestName?: string;
  roomNumber?: string;
  checkIn?: Date | null;
  checkOut?: Date | null;
}

/** The first thing missing or wrong with a booking's details, or null. */
export function validateBookingDetails(details: BookingDetails): string | null {
  if (!details.guestName?.trim()) return "Enter the guest's name.";
  const { checkIn, checkOut } = details;
  if (!(checkIn instanceof Date) || !(checkOut instanceof Date)) {
    return "Select check-in and check-out dates.";
  }
  if (Number.isNaN(checkIn.getTime()) || Number.isNaN(checkOut.getTime())) {
    return "Select check-in and check-out dates.";
  }
  if (checkOut <= checkIn) return "Check-out must be after check-in.";
  if (!details.roomNumber?.trim()) return "Select a room.";
  return null;
}

/** Where a booking came from. Front-desk bookings carry no source. */
export type BookingSource = "concierge";

export interface NewBookingInput {
  hotelId: string;
  reservationId: string;
  room: BookableRoom;
  guestName: string;
  guestPhoneNumber?: string;
  guestEmail?: string;
  numberOfGuests?: number;
  checkIn: Date;
  checkOut: Date;
  pricePaid?: number;
  paymentStatus: "Paid" | "Pending";
  notes?: string;
  source?: BookingSource;
  /** The stay total the guest was quoted, when a system (not staff) priced it. */
  quotedTotal?: number;
}

/**
 * The `accomodation` document for a new booking.
 *
 * Pure: dates stay JS Dates (both Firestore SDKs store them as
 * Timestamps), and the caller passes its own SDK's server-timestamp
 * sentinel as `createdAt`. Optional fields are omitted rather than set to
 * undefined, which Firestore rejects.
 */
export function buildBookingDoc<CreatedAt>(input: NewBookingInput, createdAt: CreatedAt) {
  const guests = Math.floor(Number(input.numberOfGuests));
  return {
    reservationId: input.reservationId,
    guestName: input.guestName.trim(),
    guestPhoneNumber: input.guestPhoneNumber?.trim() ?? "",
    ...(input.guestEmail?.trim() ? { guestEmail: input.guestEmail.trim() } : {}),
    roomNumber: String(input.room.number),
    roomType: input.room.type ?? "",
    numberOfGuests: guests >= 1 ? guests : 1,
    checkIn: input.checkIn,
    checkOut: input.checkOut,
    pricePaid: input.pricePaid || 0,
    paymentStatus: input.paymentStatus,
    notes: input.notes?.trim() ?? "",
    status: "Confirmed" as BookingStatus,
    isOccupied: false,
    hotelId: input.hotelId,
    createdAt,
    ...(input.source ? { source: input.source } : {}),
    ...(input.quotedTotal !== undefined ? { quotedTotal: input.quotedTotal } : {}),
  };
}
