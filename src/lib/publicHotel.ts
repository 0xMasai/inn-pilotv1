/**
 * The hotel's public identifier — what a guest-facing link carries.
 *
 * A workspace's `hotelId` is its key (DECISIONS D2): anyone holding it can
 * read and write the whole workspace. So it must never appear in a link a
 * hotel publishes for guests. The public id stands in for it:
 *
 *   publicHotels/{publicId}  →  { hotelId }      (server-readable only)
 *   hotels/{hotelId}.publicId = publicId          (set once)
 *
 * The two point at each other, and both firestore.rules and the server's
 * resolveHotel() require that they agree, so a mapping can't be pointed at
 * someone else's hotel.
 *
 * Shape: a slug of the hotel's name plus a random suffix, e.g.
 * `lakeside-inn-k7m2qp9x`. Always lowercase with at least one hyphen, so it
 * can never be mistaken for (or be) a 20-character Firestore hotelId.
 *
 * Pure — no Firestore import — so the app and the server share it.
 */

export const PUBLIC_HOTELS_COLLECTION = "publicHotels";

/** Keep in sync with the publicId pattern in firestore.rules. */
export const PUBLIC_HOTEL_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)+$/;
export const PUBLIC_HOTEL_ID_MAX_LENGTH = 64;

const SUFFIX_LENGTH = 8;
const SLUG_MAX_LENGTH = 40;
const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function isPublicHotelId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= PUBLIC_HOTEL_ID_MAX_LENGTH &&
    PUBLIC_HOTEL_ID_PATTERN.test(value)
  );
}

/** "Lakeside Inn & Spa" → "lakeside-inn-spa"; "hotel" when nothing usable is left. */
export function slugifyHotelName(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/^-+|-+$/g, "");
  return slug || "hotel";
}

function randomSuffix(): string {
  const bytes = new Uint8Array(SUFFIX_LENGTH);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => ALPHABET[byte % ALPHABET.length]).join("");
}

/** A new public id for a hotel called `name`. The suffix keeps ids unique and unguessable. */
export function makePublicHotelId(name: string, suffix: string = randomSuffix()): string {
  return `${slugifyHotelName(name)}-${suffix}`;
}
