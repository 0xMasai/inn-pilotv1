/**
 * Append-only activity trail.
 *
 * logAction() is fire-and-forget: it must never break the user's action,
 * so failures are logged to the console and swallowed. Entries are
 * immutable by security rule (no update/delete for anyone).
 *
 * Workspaces have no user accounts, so an entry records what happened and
 * when, not who did it. Entries written before accounts were removed may
 * still carry `userEmail`, which the activity screen continues to show.
 */
import { addDoc, serverTimestamp } from "firebase/firestore";
import { COLLECTIONS } from "./collections";
import { hotelCollection } from "./hotelScope";

export type AuditEntity =
  | "booking"
  | "room"
  | "order"
  | "product"
  | "sale"
  | "transfer"
  | "parking"
  | "expense"
  | "conversation"
  | "settings";

export interface AuditEntry {
  action: string;
  entity: AuditEntity;
  entityId: string | null;
  details: string;
  at: unknown; // Firestore server timestamp
  hotelId: string;
  /** Present only on entries recorded before workspaces replaced accounts. */
  userEmail?: string;
}

export function logAction(
  hotelId: string | null,
  action: string,
  entity: AuditEntity,
  entityId?: string | null,
  details?: string
): void {
  if (!hotelId) {
    console.error("Audit log write skipped: no active workspace");
    return;
  }

  addDoc(hotelCollection(hotelId, COLLECTIONS.AUDIT), {
    action,
    entity,
    entityId: entityId ?? null,
    details: details ?? "",
    hotelId,
    at: serverTimestamp(),
  }).catch((err) => console.error("Audit log write failed:", err));
}
