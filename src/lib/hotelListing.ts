/**
 * How a hotel presents itself to the network AI Concierge (DECISIONS D24).
 *
 * A hotel is searchable when it has opted in (`listed: true`) and has a
 * public id. Its guest-facing profile — region, amenities, check-in times,
 * policies — lives on the hotel document next to the fields onboarding
 * already writes, and room capacity lives on each room.
 *
 * Everything here is pure (no Firestore import), so the Settings screen, the
 * server tools and the tests share one reading of those fields. A field a
 * hotel hasn't filled in is reported as absent, never defaulted: the
 * concierge must not claim a room sleeps two because rooms usually do.
 */

export const MAX_AMENITIES = 30;
export const MAX_AMENITY_LENGTH = 60;
export const MAX_POLICIES_LENGTH = 1_000;
export const MAX_DESCRIPTION_LENGTH = 500;
export const MAX_ROOM_CAPACITY = 20;

/** The guest-facing listing fields of hotels/{hotelId}. */
export interface HotelListing {
  listed: boolean;
  region: string;
  country: string;
  description: string;
  amenities: string[];
  checkInTime: string;
  checkOutTime: string;
  policies: string;
}

const text = (value: unknown, max = 200): string => (typeof value === "string" ? value.trim().slice(0, max) : "");

export function readAmenities(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const amenities: string[] = [];
  for (const entry of value) {
    const amenity = text(entry, MAX_AMENITY_LENGTH);
    const key = amenity.toLowerCase();
    if (!amenity || seen.has(key)) continue;
    seen.add(key);
    amenities.push(amenity);
    if (amenities.length >= MAX_AMENITIES) break;
  }
  return amenities;
}

/** "Free Wi-Fi, Parking\nPool" → ["Free Wi-Fi", "Parking", "Pool"], for a settings textarea. */
export function parseAmenityList(input: string): string[] {
  return readAmenities(input.split(/[,\n]/));
}

export function toHotelListing(data: Record<string, unknown>): HotelListing {
  return {
    listed: data.listed === true,
    region: text(data.region, 60),
    country: text(data.country, 60),
    description: text(data.description, MAX_DESCRIPTION_LENGTH),
    amenities: readAmenities(data.amenities),
    checkInTime: text(data.checkInTime, 20),
    checkOutTime: text(data.checkOutTime, 20),
    policies: text(data.policies, MAX_POLICIES_LENGTH),
  };
}

/** A room's recorded capacity, or null when the hotel hasn't set one. */
export function roomCapacityOf(room: { capacity?: unknown }): number | null {
  const capacity = room.capacity;
  return typeof capacity === "number" && Number.isInteger(capacity) && capacity >= 1 && capacity <= MAX_ROOM_CAPACITY
    ? capacity
    : null;
}

/* ------------------------------------------------------------------ */
/* Destinations                                                         */
/* ------------------------------------------------------------------ */

/** Words that say "somewhere" without saying where. */
const PLACE_STOP_WORDS = new Set([
  "a", "an", "the", "in", "at", "on", "near", "around", "of", "to", "and", "or", "by",
  "region", "area", "city", "town", "district", "province", "side", "part", "parts",
  "hotel", "hotels", "k", "somewhere", "anywhere", "please",
]);

/** Common ways guests say a direction; the data uses the adjective form. */
const PLACE_ALIASES: Record<string, string> = {
  west: "western",
  east: "eastern",
  north: "northern",
  south: "southern",
  centre: "central",
  center: "central",
  southwest: "southwestern",
  "south-west": "southwestern",
  "south-western": "southwestern",
};

export function placeTokens(value: string): string[] {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/south[\s-]+west(ern)?/g, "southwestern")
    .split(/[^a-z0-9-]+/)
    .map((token) => token.replace(/^-+|-+$/g, ""))
    .map((token) => PLACE_ALIASES[token] ?? token)
    .filter((token) => token && !PLACE_STOP_WORDS.has(token));
}

export interface PlaceFields {
  city: string;
  region: string;
  country: string;
}

/**
 * Whether a guest's destination names this hotel's place: every meaningful
 * word of the destination must appear in the hotel's city, region or
 * country. "Western Uganda" matches Kabale (Western, Uganda) and not Kampala
 * (Central, Uganda). A south-western hotel also answers to "western".
 * An empty destination matches everywhere.
 */
export function matchesDestination(destination: string, place: PlaceFields): boolean {
  const wanted = placeTokens(destination);
  if (wanted.length === 0) return true;
  const have = new Set(placeTokens(`${place.city} ${place.region} ${place.country}`));
  if (have.has("southwestern")) have.add("western");
  return wanted.every((token) => have.has(token));
}

/* ------------------------------------------------------------------ */
/* Room types                                                           */
/* ------------------------------------------------------------------ */

/** "a double room" → "double"; "Family rooms" → "family". */
export function normalizeRoomType(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b(a|an|the|room|rooms|bed|beds|bedroom)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/s$/, "");
}

/** Exactly the type asked for ("double" = "Double Room"). What a price or a booking needs. */
export function roomTypeMatches(wanted: string, actual: string): boolean {
  const want = normalizeRoomType(wanted);
  return !want || normalizeRoomType(actual) === want;
}

/**
 * A type that includes every word asked for: "double" also finds "Deluxe
 * Double". What a search needs, so a guest isn't told nothing is free when a
 * variant of the room they asked for is.
 */
export function roomTypeIncludes(wanted: string, actual: string): boolean {
  const want = normalizeRoomType(wanted).split(" ").filter(Boolean);
  const have = new Set(normalizeRoomType(actual).split(" "));
  return want.every((word) => have.has(word));
}
