/**
 * Parking service layer.
 *
 * A parking record is a vehicle's stay: it opens on arrival and closes on
 * release, when the fee is finalised. Revenue is recognised on release
 * (see metrics.parkingDate) so a car still on the lot does not inflate
 * today's takings.
 */
import { addDoc, serverTimestamp, Timestamp, updateDoc } from "firebase/firestore";
import { COLLECTIONS, type PaymentMethod } from "./collections";
import { hotelCollection, hotelDoc } from "./hotelScope";
import { logAction } from "./audit";
import { errorMessage, fail, ok, type ServiceResult } from "./serviceResult";
import { toDateSafe } from "./metrics";

export const VEHICLE_TYPES = ["Car", "Motorcycle", "Van", "Bus", "Truck"] as const;
export type VehicleType = (typeof VEHICLE_TYPES)[number];

export const RATE_TYPES = ["Hourly", "Daily", "Flat"] as const;
export type RateType = (typeof RATE_TYPES)[number];

export type ParkingStatus = "Parked" | "Released";

/** hotels/{hotelId}/parking/{id} */
export interface ParkingEntry {
  id: string;
  vehiclePlate: string;
  vehicleType: string;
  driverName?: string;
  /** Free-text link to a guest; parking does not require a reservation. */
  guestName?: string;
  slot?: string;
  rateType: RateType;
  /** Per hour, per day, or the flat fee — depending on rateType. */
  rate: number;
  /** What was actually charged. Zero while parked on an hourly/daily rate. */
  amount: number;
  paymentMethod?: PaymentMethod;
  status: ParkingStatus;
  checkIn?: unknown;
  checkOut?: unknown;
  note?: string;
  createdAt?: unknown;
  userId?: string;
}

export function toParkingEntry(id: string, data: Record<string, unknown>): ParkingEntry {
  return {
    id,
    vehiclePlate: String(data.vehiclePlate ?? ""),
    vehicleType: String(data.vehicleType ?? "Car"),
    driverName: typeof data.driverName === "string" ? data.driverName : undefined,
    guestName: typeof data.guestName === "string" ? data.guestName : undefined,
    slot: typeof data.slot === "string" ? data.slot : undefined,
    rateType: (data.rateType as RateType) ?? "Flat",
    rate: Number(data.rate) || 0,
    amount: Number(data.amount) || 0,
    paymentMethod: data.paymentMethod as PaymentMethod | undefined,
    status: data.status === "Released" ? "Released" : "Parked",
    checkIn: data.checkIn,
    checkOut: data.checkOut,
    note: typeof data.note === "string" ? data.note : undefined,
    createdAt: data.createdAt,
    userId: typeof data.userId === "string" ? data.userId : undefined,
  };
}

/**
 * What a stay costs at a given moment.
 *
 * Hourly and daily rates always bill at least one unit — a car that
 * parked for ten minutes still occupied a bay — and part-units round up,
 * which is how attended lots actually charge.
 */
export function computeFee(entry: ParkingEntry, until = new Date()): number {
  if (entry.rateType === "Flat") return entry.rate;
  const start = toDateSafe(entry.checkIn);
  if (!start) return entry.rate;
  const ms = Math.max(0, until.getTime() - start.getTime());
  const unitMs = entry.rateType === "Hourly" ? 3_600_000 : 86_400_000;
  return Math.max(1, Math.ceil(ms / unitMs)) * entry.rate;
}

/** How long a vehicle has been on the lot, as "3h 20m" / "2d 4h". */
export function formatDuration(entry: ParkingEntry, until = new Date()): string {
  const start = toDateSafe(entry.checkIn);
  const end = toDateSafe(entry.checkOut) ?? until;
  if (!start) return "—";
  const minutes = Math.max(0, Math.round((end.getTime() - start.getTime()) / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

export interface CheckInInput {
  vehiclePlate: string;
  vehicleType: string;
  driverName?: string;
  guestName?: string;
  slot?: string;
  rateType: RateType;
  rate: number;
  note?: string;
}

export async function checkInVehicle(
  hotelId: string,
  input: CheckInInput,
  parked: ParkingEntry[]
): Promise<ServiceResult<{ id: string }>> {
  const plate = input.vehiclePlate.trim().toUpperCase();
  if (!plate) return fail("Enter the vehicle's number plate.");
  if (input.rate < 0) return fail("Rate cannot be negative.");
  if (parked.some((p) => p.status === "Parked" && p.vehiclePlate.toUpperCase() === plate)) {
    return fail(`${plate} is already checked in. Release it before checking it in again.`);
  }

  try {
    const ref = await addDoc(hotelCollection(hotelId, COLLECTIONS.PARKING), {
      vehiclePlate: plate,
      vehicleType: input.vehicleType,
      driverName: input.driverName?.trim() ?? "",
      guestName: input.guestName?.trim() ?? "",
      slot: input.slot?.trim() ?? "",
      rateType: input.rateType,
      rate: input.rate,
      // A flat fee is known on arrival; metered rates are priced on release.
      amount: input.rateType === "Flat" ? input.rate : 0,
      status: "Parked",
      note: input.note ?? "",
      checkIn: Timestamp.now(),
      createdAt: serverTimestamp(),
    });
    logAction(hotelId, "Vehicle checked in", "parking", ref.id, `${plate} · ${input.vehicleType}`);
    return ok({ id: ref.id });
  } catch (err) {
    console.error("Failed to check in vehicle:", err);
    return fail(errorMessage(err) || "Could not check in this vehicle.");
  }
}

export async function releaseVehicle(
  hotelId: string,
  entry: ParkingEntry,
  paymentMethod: PaymentMethod,
  amountOverride?: number
): Promise<ServiceResult<{ amount: number }>> {
  if (entry.status === "Released") return fail("This vehicle has already been released.");

  const checkOut = new Date();
  const amount = amountOverride ?? computeFee(entry, checkOut);
  if (amount < 0) return fail("Amount cannot be negative.");

  try {
    await updateDoc(hotelDoc(hotelId, COLLECTIONS.PARKING, entry.id), {
      status: "Released",
      amount,
      paymentMethod,
      checkOut: Timestamp.fromDate(checkOut),
    });
    logAction(
      hotelId,
      "Vehicle released",
      "parking",
      entry.id,
      `${entry.vehiclePlate} · ${amount.toLocaleString()}`
    );
    return ok({ amount });
  } catch (err) {
    console.error("Failed to release vehicle:", err);
    return fail(errorMessage(err) || "Could not release this vehicle.");
  }
}
