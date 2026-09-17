/**
 * Hotel resolution — the one way the server decides which hotel it serves.
 *
 * `resolveHotel()` turns an untrusted identifier into a HotelScope: proof
 * the hotel exists, plus data access that can only reach that hotel's own
 * `hotels/{hotelId}/…` subtree. Server tools are given a scope, never the
 * database handle and never a hotelId to build paths from, so a tool has
 * no way to name another hotel's data — not by bug, and not because a
 * model put a different id into its arguments.
 *
 * The identifier is the hotel's public id (src/lib/publicHotel.ts), never
 * its hotelId: the hotelId is the workspace key and stays on the server.
 * Resolution follows publicHotels/{publicId} to the hotel and then requires
 * the hotel to name the same publicId back, so a stray or planted mapping
 * can't open another hotel. A workspace hotelId sent in its place fails the
 * format check before anything is read.
 *
 * Every way of failing — malformed, unknown, unbound — gives the same
 * guest-facing error, so the endpoint can't be used to probe which ids exist.
 *
 * Two server-internal ways in, never reachable from a request:
 *   - listNetworkHotels(): every hotel that opted in to the network
 *     concierge (DECISIONS D24), for search.
 *   - scopeForHotelId(): a hotel the server already knows by its internal id
 *     (a conversation's attached hotels, D29).
 */
import {
  FieldValue,
  type CollectionReference,
  type DocumentData,
  type DocumentSnapshot,
  type Transaction,
} from "firebase-admin/firestore";
import { COLLECTIONS } from "../src/lib/collections";
import { DEFAULT_CURRENCY } from "../src/lib/format";
import { toHotelListing, type HotelListing } from "../src/lib/hotelListing";
import { isPublicHotelId, PUBLIC_HOTELS_COLLECTION } from "../src/lib/publicHotel";
import { adminDb } from "./admin";
import { AiInvalidRequestError } from "./ai/errors";

/** Firestore document ids: no slashes, no traversal, nothing exotic. */
const HOTEL_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** More than any real network; a guard against an unbounded read. */
const MAX_NETWORK_HOTELS = 200;

export type HotelCollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];

/** The guest-facing parts of hotels/{hotelId}. */
export interface HotelProfileSummary extends HotelListing {
  name: string;
  /** City, as entered during onboarding. */
  location: string;
  currency: string;
  phone: string;
  email: string;
}

export interface HotelScope {
  /** Internal workspace key. Server-side only: never in a response, a tool result or a prompt. */
  readonly hotelId: string;
  /** The guest-facing id this scope was resolved from ("" for a hotel that has none). */
  readonly publicId: string;
  readonly profile: HotelProfileSummary;
  /** hotels/{hotelId}/{name} — the only collections a scope can reach. */
  collection(name: HotelCollectionName): CollectionReference;
  runTransaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T>;
  serverTimestamp(): FieldValue;
}

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

function unknownHotel(detail: string): AiInvalidRequestError {
  return new AiInvalidRequestError(
    detail,
    "I'm not sure which hotel this chat belongs to. Please reopen it from the hotel's page."
  );
}

function buildScope(hotelId: string, snap: DocumentSnapshot<DocumentData>): HotelScope {
  const db = adminDb();
  const data = snap.data() ?? {};
  const profile: HotelProfileSummary = Object.freeze({
    name: text(data.name),
    location: text(data.location),
    currency: text(data.currency) || DEFAULT_CURRENCY,
    phone: text(data.phone),
    email: text(data.email),
    ...toHotelListing(data),
  });
  const hotelRef = db.collection("hotels").doc(hotelId);

  return Object.freeze({
    hotelId,
    publicId: text(data.publicId),
    profile,
    collection: (name: HotelCollectionName) => hotelRef.collection(name),
    runTransaction: <T>(work: (tx: Transaction) => Promise<T>) => db.runTransaction(work),
    serverTimestamp: () => FieldValue.serverTimestamp(),
  });
}

export async function resolveHotel(rawPublicId: unknown): Promise<HotelScope> {
  const publicId = typeof rawPublicId === "string" ? rawPublicId.trim() : "";
  if (!isPublicHotelId(publicId)) {
    throw unknownHotel("'publicHotelId' is required and must be a public hotel identifier.");
  }

  const db = adminDb();
  const mapping = await db.collection(PUBLIC_HOTELS_COLLECTION).doc(publicId).get();
  const hotelId = mapping.exists ? text(mapping.data()?.hotelId) : "";
  if (!HOTEL_ID_PATTERN.test(hotelId)) {
    throw unknownHotel(`No hotel is published under public id '${publicId}'.`);
  }

  const snap = await db.collection("hotels").doc(hotelId).get();
  if (!snap.exists) throw unknownHotel(`Public id '${publicId}' maps to a hotel that doesn't exist.`);
  if (snap.data()?.publicId !== publicId) {
    throw unknownHotel(`Public id '${publicId}' maps to a hotel that doesn't claim it.`);
  }
  return buildScope(hotelId, snap);
}

/** A hotel the server already holds the internal id of. Null when it no longer exists. */
export async function scopeForHotelId(hotelId: string): Promise<HotelScope | null> {
  if (!HOTEL_ID_PATTERN.test(hotelId)) return null;
  const snap = await adminDb().collection("hotels").doc(hotelId).get();
  return snap.exists ? buildScope(hotelId, snap) : null;
}

/**
 * Every hotel in the network concierge: opted in, and reachable by a public
 * id whose mapping points back at it. A hotel with a broken or missing
 * mapping is left out rather than exposed under an id guests can't use.
 */
export async function listNetworkHotels(): Promise<HotelScope[]> {
  const db = adminDb();
  const snap = await db.collection("hotels").where("listed", "==", true).limit(MAX_NETWORK_HOTELS).get();
  const candidates = snap.docs.filter((doc) => isPublicHotelId(doc.data().publicId));
  const mappings = candidates.length
    ? await db.getAll(...candidates.map((doc) => db.collection(PUBLIC_HOTELS_COLLECTION).doc(doc.data().publicId)))
    : [];
  return candidates
    .filter((doc, index) => mappings[index]?.exists && mappings[index].data()?.hotelId === doc.id)
    .map((doc) => buildScope(doc.id, doc))
    .sort((a, b) => a.profile.name.localeCompare(b.profile.name));
}
