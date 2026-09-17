/**
 * Multi-tenant Firestore paths.
 *
 * Operational data (rooms, bookings, restaurant, bar, parking, expenses,
 * audit log) lives under hotels/{hotelId}/{collection}/{docId}. This is
 * the tenant boundary: every module reads and writes through the active
 * workspace's hotelId (see src/workspace/), and firestore.rules keys off
 * the {hotelId} path segment — a document's hotelId must match its path,
 * and workspaces cannot be listed, so a hotel's data is only reachable
 * through that hotel's own id.
 */
import { collection, doc, type CollectionReference, type DocumentReference } from "firebase/firestore";
import { db } from "../../firebase";

export const HOTELS_COLLECTION = "hotels";

/** hotels/{hotelId} */
export function hotelDocRef(hotelId: string): DocumentReference {
  return doc(db, HOTELS_COLLECTION, hotelId);
}

/** hotels/{hotelId}/{name} — e.g. hotelCollection(hotelId, COLLECTIONS.ROOMS) */
export function hotelCollection(hotelId: string, name: string): CollectionReference {
  return collection(db, HOTELS_COLLECTION, hotelId, name);
}

/** hotels/{hotelId}/{name}/{docId} */
export function hotelDoc(hotelId: string, name: string, docId: string): DocumentReference {
  return doc(db, HOTELS_COLLECTION, hotelId, name, docId);
}
