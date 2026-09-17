/**
 * Single source of truth for Firestore collection names.
 *
 * Every operational collection lives under hotels/{hotelId}/… — see
 * src/lib/hotelScope.ts for why that path is the tenant boundary.
 *
 * BOOKINGS ("accomodation") is the misspelled legacy name. It is kept
 * verbatim because live hotels have documents there; renaming the
 * constant would orphan their booking history. RESERVATIONS is the newer
 * collection: nothing writes it any more, but it is still read so a hotel
 * that used the retired front-desk flow keeps its revenue and occupancy.
 */
export const COLLECTIONS = {
  ROOMS: "rooms",
  BOOKINGS: "accomodation",
  RESERVATIONS: "reservations",
  RESTAURANT: "restaurant",
  PARKING: "parking",
  EXPENSES: "expenses",
  BAR_PRODUCTS: "barProducts",
  BAR_SALES: "barSales",
  BAR_TRANSFERS: "barTransfers",
  AUDIT: "auditLog",
  /** Guest conversations for the inbox; see src/lib/conversations.ts. */
  CONVERSATIONS: "conversations",
} as const;

export type BookingStatus = "Confirmed" | "Checked In" | "Checked Out" | "Cancelled" | "No Show";
export type RoomStatus = "Available" | "Occupied" | "Cleaning" | "Maintenance" | "Out of Service";

export const BOOKING_STATUSES: BookingStatus[] = ["Confirmed", "Checked In", "Checked Out", "Cancelled", "No Show"];
export const ROOM_STATUSES: RoomStatus[] = ["Available", "Occupied", "Cleaning", "Maintenance", "Out of Service"];
export const ACTIVE_BOOKING_STATUSES: BookingStatus[] = ["Confirmed", "Checked In"];

/** The room types a hotel can register, smallest to largest. */
export const ROOM_TYPES = ["Single", "Double", "Suite"] as const;
export type RoomType = (typeof ROOM_TYPES)[number];

/** Every module that takes money accepts the same set of tenders. */
export type PaymentMethod = "Cash" | "Mobile Money" | "Card" | "Bank Transfer";
export const PAYMENT_METHODS: PaymentMethod[] = ["Cash", "Mobile Money", "Card", "Bank Transfer"];
