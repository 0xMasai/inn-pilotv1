/**
 * A small hotel network for server tests, written straight into the
 * emulator through the Admin SDK.
 *
 *   Kabale   listed · Western · Double ×3 (one booked 12–14 Oct, one in
 *            maintenance) · Family · Suite with no rate set
 *   Mbarara  listed · Western · Double (booked all of 10–15 Oct) · Deluxe Double
 *   Kampala  listed · Central · Double
 *   Hidden   NOT listed · Western · the cheapest Double of all
 *   Broken   listed, but its public-id mapping points at another hotel
 *
 * Dates are in 2031 so they never fall into the past.
 */
import type { Firestore } from "firebase-admin/firestore";

export const KABALE = { hotelId: "NetKabale00000000001", publicId: "k-hotels-kabale-test0001" };
export const MBARARA = { hotelId: "NetMbarara0000000001", publicId: "k-hotels-mbarara-test0001" };
export const KAMPALA = { hotelId: "NetKampala0000000001", publicId: "k-hotels-kampala-test0001" };
export const HIDDEN = { hotelId: "NetHidden00000000001", publicId: "hidden-lodge-test0001" };
export const BROKEN = { hotelId: "NetBroken00000000001", publicId: "broken-inn-test0001" };
export const ALL_HOTEL_IDS = [KABALE, MBARARA, KAMPALA, HIDDEN, BROKEN].map((hotel) => hotel.hotelId);

export const STAY = { checkIn: "2031-10-10", checkOut: "2031-10-15" };
export const GUEST = { guestName: "Amina Okello", guestPhoneNumber: "+256 772 123 456" };

const noon = (iso: string) => new Date(`${iso}T12:00:00Z`);

export async function clearEmulator(projectId: string): Promise<void> {
  const url = `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${projectId}/databases/(default)/documents`;
  const res = await fetch(url, { method: "DELETE" });
  if (!res.ok) throw new Error(`Could not clear the emulator: ${res.status}`);
}

type Room = { number: string | number; type: string; price: number; capacity?: number; status?: string; amenities?: string[] };

async function hotel(
  db: Firestore,
  ids: { hotelId: string; publicId: string },
  profile: Record<string, unknown>,
  rooms: Room[],
  mappingTo = ids.hotelId
) {
  await db.doc(`publicHotels/${ids.publicId}`).set({ hotelId: mappingTo });
  await db.doc(`hotels/${ids.hotelId}`).set({
    publicId: ids.publicId,
    currency: "UGX",
    country: "Uganda",
    taxId: "TIN-SECRET",
    subscription: { plan: "trial", status: "active" },
    ...profile,
  });
  for (const room of rooms) {
    await db.doc(`hotels/${ids.hotelId}/rooms/room-${room.number}`).set({ status: "Available", ...room, hotelId: ids.hotelId });
  }
}

export async function bookStay(db: Firestore, hotelId: string, roomNumber: string | number, checkIn: string, checkOut: string, collection = "accomodation") {
  await db.collection(`hotels/${hotelId}/${collection}`).add({
    roomNumber,
    guestName: "Existing Guest",
    checkIn: noon(checkIn),
    checkOut: noon(checkOut),
    status: "Confirmed",
    hotelId,
  });
}

export async function seedNetwork(db: Firestore): Promise<void> {
  await hotel(
    db,
    KABALE,
    {
      name: "K Hotels Kabale",
      location: "Kabale",
      region: "Western",
      listed: true,
      phone: "+256 700 100 201",
      email: "kabale@example.com",
      amenities: ["Free Wi-Fi", "Breakfast included", "Free parking"],
      checkInTime: "14:00",
      checkOutTime: "10:00",
      description: "Hillside hotel.",
    },
    [
      { number: "201", type: "Double", price: 180000, capacity: 2, amenities: ["Balcony"] },
      { number: "202", type: "Double", price: 180000, capacity: 2 },
      { number: "203", type: "Double", price: 180000, capacity: 2, status: "Maintenance" },
      { number: "301", type: "Family", price: 320000, capacity: 4 },
      { number: "401", type: "Suite", price: 0, capacity: 2 },
    ]
  );
  await bookStay(db, KABALE.hotelId, "201", "2031-10-12", "2031-10-14");

  await hotel(
    db,
    MBARARA,
    { name: "K Hotels Mbarara", location: "Mbarara", region: "Western", listed: true },
    [
      { number: "12", type: "Double", price: 150000, capacity: 2 },
      { number: "21", type: "Deluxe Double", price: 210000, capacity: 2 },
    ]
  );
  await bookStay(db, MBARARA.hotelId, "12", "2031-10-09", "2031-10-16");

  await hotel(db, KAMPALA, { name: "K Hotels Kampala", location: "Kampala", region: "Central", listed: true }, [
    { number: "502", type: "Double", price: 240000, capacity: 2 },
  ]);

  await hotel(db, HIDDEN, { name: "Hidden Lodge", location: "Hoima", region: "Western", listed: false }, [
    { number: "1", type: "Double", price: 50000, capacity: 2 },
  ]);

  // Claims to be listed, but its mapping points at Kampala: never searchable.
  await hotel(db, BROKEN, { name: "Broken Inn", location: "Kabale", region: "Western", listed: true }, [
    { number: "1", type: "Double", price: 60000, capacity: 2 },
  ], KAMPALA.hotelId);
}
