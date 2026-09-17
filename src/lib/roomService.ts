/**
 * Room inventory service.
 *
 * Extracted from src/Accommodation.tsx so room writes — and the audit
 * entries that must accompany them — happen the same way at every call
 * site, rather than being re-implemented per screen.
 */
import {
  addDoc,
  getDocs,
  serverTimestamp,
  updateDoc,
  type QueryDocumentSnapshot,
} from "firebase/firestore";
import { COLLECTIONS, ROOM_STATUSES, type RoomStatus } from "./collections";
import { hotelCollection, hotelDoc } from "./hotelScope";
import { logAction } from "./audit";
import { describeWriteFailure, errorMessage, fail, ok, type ServiceResult } from "./serviceResult";

/** hotels/{hotelId}/rooms/{id}, as the UI consumes it. */
export interface RoomInventoryDoc {
  id: string;
  number: string;
  type?: string;
  price?: number;
  status: string;
}

export function isRoomStatus(value: string): value is RoomStatus {
  return (ROOM_STATUSES as string[]).includes(value);
}

/** Reads the hotel's room inventory, sorted the way the UI sorts it. */
export async function loadRooms(hotelId: string): Promise<RoomInventoryDoc[]> {
  const snapshot = await getDocs(hotelCollection(hotelId, COLLECTIONS.ROOMS));
  const rooms = snapshot.docs.map((doc: QueryDocumentSnapshot) => {
    const data = doc.data() as Record<string, unknown>;
    return {
      id: doc.id,
      number: String(data.number ?? ""),
      type: typeof data.type === "string" ? data.type : undefined,
      price: typeof data.price === "number" ? data.price : undefined,
      status: String(data.status ?? "Available"),
    };
  });
  rooms.sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }));
  return rooms;
}

/**
 * Why a nightly rate is unusable, or null when it is fine. Zero is allowed:
 * it is how a room with no rate set yet has always been stored.
 */
export function roomRateError(price: unknown): string | null {
  if (typeof price !== "number" || !Number.isFinite(price)) return "Enter a nightly rate.";
  if (price < 0) return "The nightly rate can't be negative.";
  return null;
}

export interface AddRoomInput {
  hotelId: string;
  number: string;
  type: string;
  price?: number;
  status: RoomStatus;
  /** Existing inventory, used to reject a duplicate room number. */
  existingRooms: RoomInventoryDoc[];
}

export async function addRoom(input: AddRoomInput): Promise<ServiceResult<{ id: string }>> {
  const number = input.number.trim();
  if (!number) return fail("Enter a room number.");
  if (input.existingRooms.some((room) => room.number === number)) {
    return fail(`Room ${number} already exists.`);
  }
  const rateError = input.price === undefined ? null : roomRateError(input.price);
  if (rateError) return fail(rateError);

  try {
    const ref = await addDoc(hotelCollection(input.hotelId, COLLECTIONS.ROOMS), {
      number,
      type: input.type,
      price: input.price || 0,
      status: input.status,
      hotelId: input.hotelId,
      createdAt: serverTimestamp(),
    });
    logAction(input.hotelId, "Room added", "room", ref.id, `${number} (${input.type})`);
    return ok({ id: ref.id });
  } catch (error) {
    console.error("Failed to add room:", error);
    return fail("Failed to add room. Please try again.");
  }
}

export interface RoomChanges {
  type: string;
  price: number | undefined;
}

/**
 * Edits a room's type and nightly rate in place.
 *
 * Only those two fields are written, so the room keeps its id, number,
 * status and every other field. A no-op (reported as success) when nothing
 * actually changed.
 */
export async function updateRoom(
  hotelId: string,
  room: RoomInventoryDoc,
  changes: RoomChanges
): Promise<ServiceResult<{ changed: boolean }>> {
  const type = changes.type.trim();
  if (!type) return fail("Choose a room type.");
  const rateError = roomRateError(changes.price);
  if (rateError) return fail(rateError);
  const price = changes.price as number;

  if (room.type === type && room.price === price) return ok({ changed: false });

  try {
    await updateDoc(hotelDoc(hotelId, COLLECTIONS.ROOMS, room.id), { type, price });
    logAction(
      hotelId,
      "Room updated",
      "room",
      room.id,
      `${room.number}: ${room.type ?? "-"} · ${room.price ?? 0} → ${type} · ${price}`
    );
    return ok({ changed: true });
  } catch (error) {
    console.error("Failed to update room:", error);
    return fail(describeWriteFailure(error, "Room could not be updated. Please try again."));
  }
}

/**
 * Changes a room's status and records it in the audit trail.
 * A no-op (reported as success) when the room already has that status,
 * matching the guard the UI has always applied.
 */
export async function setRoomStatus(
  hotelId: string,
  room: RoomInventoryDoc,
  status: RoomStatus
): Promise<ServiceResult<{ changed: boolean }>> {
  if (room.status === status) return ok({ changed: false });

  try {
    await updateDoc(hotelDoc(hotelId, COLLECTIONS.ROOMS, room.id), { status });
    logAction(
      hotelId,
      "Room status changed",
      "room",
      room.id,
      `${room.number}: ${room.status} → ${status}`
    );
    return ok({ changed: true });
  } catch (error) {
    console.error("Failed to update room status:", error);
    return fail(errorMessage(error) || "Room status could not be updated.");
  }
}
