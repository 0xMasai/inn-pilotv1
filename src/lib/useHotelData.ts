/**
 * Live hotel-wide operational data, as one subscription set.
 *
 * The Dashboard and Reports both need every department's records at once.
 * Subscribing here rather than in each page means the two screens can
 * never diverge on *what* they read, only on how they present it.
 *
 * Bookings are read from two collections: the legacy `accomodation`
 * documents and the `reservations` written by the retired front-desk
 * flow. Both shapes satisfy BookingRecord, so they are combined — reading
 * only one would silently under-report any hotel that used the other.
 */
import { useEffect, useMemo, useState } from "react";
import { onSnapshot } from "firebase/firestore";
import { COLLECTIONS } from "./collections";
import { hotelCollection } from "./hotelScope";
import { emptyMetricsInput, type MetricsInput } from "./metrics";

export interface HotelDataState {
  data: MetricsInput;
  loading: boolean;
  /** Set when a collection could not be read — usually a permissions issue. */
  error: string | null;
}

export function useHotelData(hotelId: string | null): HotelDataState {
  const [core, setCore] = useState<MetricsInput>(emptyMetricsInput);
  const [legacyBookings, setLegacyBookings] = useState<MetricsInput["bookings"]>([]);
  const [reservations, setReservations] = useState<MetricsInput["bookings"]>([]);
  const [pending, setPending] = useState(7);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!hotelId) return;

    setCore(emptyMetricsInput);
    setLegacyBookings([]);
    setReservations([]);
    setPending(7);
    setError(null);

    // Each listener resolves its own slice of the loading count, so the
    // page can render as soon as everything has reported once.
    let settled = new Set<string>();
    const settle = (key: string) => {
      if (settled.has(key)) return;
      settled.add(key);
      setPending((n) => Math.max(0, n - 1));
    };
    const onError = (key: string) => (err: unknown) => {
      console.error(`Failed to read ${key}:`, err);
      setError("Some records could not be loaded. Check your connection or permissions.");
      settle(key);
    };

    const subs = [
      onSnapshot(
        hotelCollection(hotelId, COLLECTIONS.BOOKINGS),
        (s) => {
          setLegacyBookings(s.docs.map((d) => d.data() as MetricsInput["bookings"][number]));
          settle("bookings");
        },
        onError("bookings")
      ),
      onSnapshot(
        hotelCollection(hotelId, COLLECTIONS.RESERVATIONS),
        (s) => {
          setReservations(s.docs.map((d) => d.data() as MetricsInput["bookings"][number]));
          settle("reservations");
        },
        onError("reservations")
      ),
      onSnapshot(
        hotelCollection(hotelId, COLLECTIONS.RESTAURANT),
        (s) => {
          setCore((p) => ({ ...p, orders: s.docs.map((d) => d.data() as MetricsInput["orders"][number]) }));
          settle("restaurant");
        },
        onError("restaurant")
      ),
      onSnapshot(
        hotelCollection(hotelId, COLLECTIONS.BAR_SALES),
        (s) => {
          setCore((p) => ({ ...p, barSales: s.docs.map((d) => d.data() as MetricsInput["barSales"][number]) }));
          settle("barSales");
        },
        onError("bar sales")
      ),
      onSnapshot(
        hotelCollection(hotelId, COLLECTIONS.BAR_PRODUCTS),
        (s) => {
          setCore((p) => ({
            ...p,
            barProducts: s.docs.map((d) => d.data() as MetricsInput["barProducts"][number]),
          }));
          settle("barProducts");
        },
        onError("bar products")
      ),
      onSnapshot(
        hotelCollection(hotelId, COLLECTIONS.PARKING),
        (s) => {
          setCore((p) => ({ ...p, parking: s.docs.map((d) => d.data() as MetricsInput["parking"][number]) }));
          settle("parking");
        },
        onError("parking")
      ),
      onSnapshot(
        hotelCollection(hotelId, COLLECTIONS.EXPENSES),
        (s) => {
          setCore((p) => ({ ...p, expenses: s.docs.map((d) => d.data() as MetricsInput["expenses"][number]) }));
          settle("expenses");
        },
        onError("expenses")
      ),
      onSnapshot(
        hotelCollection(hotelId, COLLECTIONS.ROOMS),
        (s) => setCore((p) => ({ ...p, rooms: s.docs.map((d) => d.data() as MetricsInput["rooms"][number]) })),
        onError("rooms")
      ),
    ];

    return () => {
      settled = new Set();
      subs.forEach((u) => u());
    };
  }, [hotelId]);

  const data = useMemo<MetricsInput>(
    () => ({ ...core, bookings: [...legacyBookings, ...reservations] }),
    [core, legacyBookings, reservations]
  );

  return { data, loading: pending > 0, error };
}
