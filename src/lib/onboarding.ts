/**
 * Hotel onboarding — turns three wizard steps into a working workspace.
 *
 * One atomic batch writes the hotel document and its starting room
 * inventory together. Either the hotel arrives with every room, or nothing
 * is written at all: a half-created workspace (a hotel with no rooms, or
 * rooms pointing at no hotel) would be worse than a failed attempt the
 * visitor can simply retry.
 *
 * The rooms written here are ordinary `rooms` documents — the same shape
 * `roomService.addRoom()` writes — so Accommodation, availability and the
 * dashboard treat them exactly like rooms a hotel added by hand.
 */
import { collection, doc, serverTimestamp, writeBatch } from "firebase/firestore";
import { db } from "../../firebase";
import { COLLECTIONS, ROOM_TYPES, type RoomStatus, type RoomType } from "./collections";
import { hotelCollection, HOTELS_COLLECTION } from "./hotelScope";
import { CURRENCIES } from "./hotelProfile";
import { DEFAULT_CURRENCY } from "./format";
import { makePublicHotelId, PUBLIC_HOTELS_COLLECTION } from "./publicHotel";
import { logAction } from "./audit";
import { describeWriteFailure, fail, ok, type ServiceResult } from "./serviceResult";

export interface WorkspaceSetupInput {
  hotelName: string;
  city: string;
  currency: string;
  phone: string;
  email: string;
  roomCount: number;
}

export const EMPTY_SETUP: WorkspaceSetupInput = {
  hotelName: "",
  city: "",
  currency: DEFAULT_CURRENCY,
  phone: "",
  email: "",
  roomCount: 20,
};

/** Firestore caps a batch at 500 writes; this keeps well clear of it. */
export const MIN_ROOMS = 1;
export const MAX_ROOMS = 200;

export type SetupErrors = Partial<Record<keyof WorkspaceSetupInput, string>>;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^\+?[\d\s()-]{7,20}$/;

/** Step 1 — who the hotel is. */
export function validateHotelStep(input: WorkspaceSetupInput): SetupErrors {
  const errors: SetupErrors = {};
  if (!input.hotelName.trim()) errors.hotelName = "Enter your hotel's name.";
  else if (input.hotelName.trim().length > 120) errors.hotelName = "Keep the name under 120 characters.";
  if (!input.city.trim()) errors.city = "Enter the city your hotel is in.";
  if (!CURRENCIES.includes(input.currency)) errors.currency = "Choose a currency.";
  return errors;
}

/** Step 2 — how to reach it, and how big it is. Contact details are optional. */
export function validateBusinessStep(input: WorkspaceSetupInput): SetupErrors {
  const errors: SetupErrors = {};
  if (input.phone.trim() && !PHONE_PATTERN.test(input.phone.trim())) {
    errors.phone = "Enter a valid phone number, e.g. +256 700 123 456.";
  }
  if (input.email.trim() && !EMAIL_PATTERN.test(input.email.trim())) {
    errors.email = "Enter a valid email address.";
  }
  if (!Number.isInteger(input.roomCount) || input.roomCount < MIN_ROOMS || input.roomCount > MAX_ROOMS) {
    errors.roomCount = `Enter between ${MIN_ROOMS} and ${MAX_ROOMS} rooms.`;
  }
  return errors;
}

/**
 * Starting nightly rates per room type, in each supported currency.
 *
 * Illustrative market-typical figures so a new workspace is usable on its
 * first screen — not a quote. Each room's rate is stored on the room
 * itself, which is where every screen already reads pricing from.
 */
const STARTING_RATES: Record<string, Record<RoomType, number>> = {
  UGX: { Single: 150_000, Double: 220_000, Suite: 420_000 },
  KES: { Single: 5_500, Double: 8_000, Suite: 15_000 },
  TZS: { Single: 100_000, Double: 150_000, Suite: 280_000 },
  RWF: { Single: 55_000, Double: 80_000, Suite: 150_000 },
  USD: { Single: 45, Double: 65, Suite: 120 },
  EUR: { Single: 42, Double: 60, Suite: 110 },
  GBP: { Single: 36, Double: 52, Suite: 95 },
};

export function startingRates(currency: string): Record<RoomType, number> {
  return STARTING_RATES[currency] ?? STARTING_RATES[DEFAULT_CURRENCY];
}

export interface PlannedRoom {
  number: string;
  type: RoomType;
  price: number;
  status: RoomStatus;
}

/**
 * The starting inventory for a hotel of `count` rooms.
 *
 * Roughly 45% single, 45% double and 10% suites (at least one suite from
 * five rooms up), numbered ten to a floor — 101…110, 201… — with the
 * larger rooms on the upper floors, the way most hotels are laid out.
 *
 * Every room starts Available: a new workspace has no real operational
 * state yet, and inventing some would make rooms look unbookable.
 */
export function planRooms(count: number, currency: string): PlannedRoom[] {
  const rates = startingRates(currency);
  const suites = count >= 5 ? Math.max(1, Math.round(count * 0.1)) : 0;
  const doubles = Math.round((count - suites) / 2);
  const singles = count - suites - doubles;

  const types: RoomType[] = [
    ...Array<RoomType>(singles).fill("Single"),
    ...Array<RoomType>(doubles).fill("Double"),
    ...Array<RoomType>(suites).fill("Suite"),
  ];

  return types.map((type, index) => {
    const floor = Math.floor(index / 10) + 1;
    const slot = (index % 10) + 1;

    return {
      number: `${floor}${String(slot).padStart(2, "0")}`,
      type,
      price: rates[type],
      status: "Available" as RoomStatus,
    };
  });
}

/** Room counts per type, for the review step. */
export function summarizeRooms(rooms: PlannedRoom[]): { type: RoomType; count: number; price: number }[] {
  return ROOM_TYPES.map((type) => {
    const ofType = rooms.filter((room) => room.type === type);
    return { type, count: ofType.length, price: ofType[0]?.price ?? 0 };
  }).filter((row) => row.count > 0);
}

/**
 * Creates the hotel, its public identifier and its starting inventory in
 * one batch.
 *
 * The id is Firestore's own 20-character random id. That matters more
 * than usual here: with no accounts, knowing a hotelId is what opens a
 * workspace, so it must be unguessable — firestore.rules refuses any
 * hand-picked id on create for the same reason.
 *
 * The public id (src/lib/publicHotel.ts) is what a guest-facing concierge
 * link carries instead of the hotelId, which must stay private.
 */
export async function createWorkspace(
  input: WorkspaceSetupInput
): Promise<ServiceResult<{ hotelId: string; publicId: string; roomCount: number }>> {
  const errors = { ...validateHotelStep(input), ...validateBusinessStep(input) };
  const firstError = Object.values(errors)[0];
  if (firstError) return fail(firstError);

  const hotelRef = doc(collection(db, HOTELS_COLLECTION));
  const hotelId = hotelRef.id;
  const hotelName = input.hotelName.trim();
  const publicId = makePublicHotelId(hotelName);
  const rooms = planRooms(input.roomCount, input.currency);

  const batch = writeBatch(db);
  batch.set(hotelRef, {
    name: hotelName,
    location: input.city.trim(),
    currency: input.currency,
    phone: input.phone.trim(),
    email: input.email.trim(),
    taxId: "",
    subscription: { plan: "trial", status: "active" },
    publicId,
    createdAt: serverTimestamp(),
  });
  batch.set(doc(db, PUBLIC_HOTELS_COLLECTION, publicId), { hotelId, createdAt: serverTimestamp() });

  const roomsCollection = hotelCollection(hotelId, COLLECTIONS.ROOMS);
  for (const room of rooms) {
    batch.set(doc(roomsCollection), {
      ...room,
      hotelId,
      createdAt: serverTimestamp(),
    });
  }

  try {
    await batch.commit();
  } catch (error) {
    console.error("Workspace creation failed:", error);
    return fail(describeWriteFailure(error, "We couldn't create your workspace. Please try again."));
  }

  logAction(hotelId, "Workspace created", "settings", hotelId, `${hotelName} · ${rooms.length} rooms`);
  return ok({ hotelId, publicId, roomCount: rooms.length });
}
