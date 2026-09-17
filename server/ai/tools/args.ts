/**
 * Reading tool arguments.
 *
 * Arguments come from the model, so they are untrusted input exactly like a
 * request body: every tool reads them through these helpers and never uses
 * a raw value.
 *
 * Stay dates. Guests talk in calendar days ("the 3rd to the 5th"), while
 * InnPilot stores stays as instants. A date-only YYYY-MM-DD is read as
 * 12:00 UTC on that day, for check-in and check-out alike. Hotels record no
 * timezone or check-in time yet, so this is a convention, not the hotel's
 * policy: it keeps back-to-back stays from colliding, and any front-desk
 * booking whose times straddle it can only make a room look *less*
 * available — never double-book it.
 */

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Longest stay the concierge will quote or book in one go. */
export const MAX_NIGHTS = 60;
export const MAX_GUESTS = 20;

export function readString(args: Record<string, unknown>, key: string, maxLength = 200): string {
  const value = args[key];
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

/** A whole number within [min, max], `undefined` when absent, `null` when invalid. */
export function readInteger(
  args: Record<string, unknown>,
  key: string,
  min: number,
  max: number
): number | undefined | null {
  const raw = args[key];
  if (raw === undefined || raw === null || raw === "") return undefined;
  const value = typeof raw === "string" ? Number(raw) : raw;
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : null;
}

/** YYYY-MM-DD → 12:00 UTC that day; null for anything else or an impossible date. */
export function parseStayDate(value: string): Date | null {
  const match = DATE_PATTERN.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? date
    : null;
}

export interface StayDates {
  checkIn: Date;
  checkOut: Date;
  checkInDate: string;
  checkOutDate: string;
  nights: number;
}

export type StayDatesResult = { ok: true; dates: StayDates } | { ok: false; message: string };

export function readStayDates(args: Record<string, unknown>, now: Date = new Date()): StayDatesResult {
  const checkInDate = readString(args, "checkIn", 10);
  const checkOutDate = readString(args, "checkOut", 10);
  const checkIn = parseStayDate(checkInDate);
  const checkOut = parseStayDate(checkOutDate);

  if (!checkIn || !checkOut) {
    return { ok: false, message: "checkIn and checkOut must both be calendar dates in YYYY-MM-DD format." };
  }
  if (checkOut <= checkIn) {
    return { ok: false, message: "checkOut must be at least one day after checkIn." };
  }
  if (checkInDate < now.toISOString().slice(0, 10)) {
    return { ok: false, message: "checkIn is in the past. Ask the guest for dates from today onwards." };
  }
  const nights = Math.round((checkOut.getTime() - checkIn.getTime()) / 86_400_000);
  if (nights > MAX_NIGHTS) {
    return {
      ok: false,
      message: `Stays longer than ${MAX_NIGHTS} nights can't be handled here. Offer to connect the guest with the hotel team.`,
    };
  }
  return { ok: true, dates: { checkIn, checkOut, checkInDate, checkOutDate, nights } };
}
