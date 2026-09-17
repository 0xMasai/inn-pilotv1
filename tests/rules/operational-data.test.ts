/**
 * Security-rule coverage for a workspace's operational data: rooms,
 * bookings, reservations, restaurant orders, expenses and the audit log.
 *
 * With no accounts, these rules are what keep the data trustworthy for
 * any client — including one that skips the app entirely: every write must
 * land in a hotel that exists and match that hotel, statuses stay within
 * their enums, and nothing the app never deletes can be deleted.
 *
 * Bar and parking are covered in bar-parking.test.ts; the workspace
 * document itself in workspace.test.ts.
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { deleteDoc, doc, getDoc, getDocs, collection, setDoc, updateDoc } from "firebase/firestore";

let env: RulesTestEnvironment;
const HOTEL = "hotel-a";
const OTHER_HOTEL = "hotel-b";
const MISSING_HOTEL = "hotel-that-does-not-exist";

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: "innpilot-operational-rules-test",
    firestore: {
      rules: readFileSync("firestore.rules", "utf8"),
      host: "127.0.0.1",
      port: 8080,
    },
  });
});

afterAll(async () => {
  await env.cleanup();
});

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "hotels", HOTEL), { name: "Hotel A", currency: "UGX" });
    await setDoc(doc(db, "hotels", OTHER_HOTEL), { name: "Hotel B", currency: "UGX" });
    await setDoc(doc(db, "hotels", HOTEL, "rooms", "room1"), {
      number: "101",
      type: "Single",
      price: 150000,
      status: "Available",
      hotelId: HOTEL,
    });
    await setDoc(doc(db, "hotels", HOTEL, "accomodation", "booking1"), {
      guestName: "Alice",
      roomNumber: "101",
      status: "Confirmed",
      hotelId: HOTEL,
    });
    await setDoc(doc(db, "hotels", HOTEL, "reservations", "r1"), {
      guestName: "Bob",
      roomNumber: "101",
      status: "Confirmed",
    });
    await setDoc(doc(db, "hotels", HOTEL, "restaurant", "o1"), {
      clientName: "Walk-in",
      price: 25000,
      status: "Open",
    });
    await setDoc(doc(db, "hotels", HOTEL, "expenses", "e1"), { amount: 10000, department: "Kitchen" });
    await setDoc(doc(db, "hotels", HOTEL, "auditLog", "log1"), { action: "Room added" });
    await setDoc(doc(db, "hotels", HOTEL, "payments", "p1"), { amount: 1000 });
  });
});

const db = () => env.unauthenticatedContext().firestore();

describe("Rooms", () => {
  it("rooms can be read", async () => {
    await assertSucceeds(getDocs(collection(db(), "hotels", HOTEL, "rooms")));
  });

  it("a room can be added to an existing hotel", async () => {
    await assertSucceeds(
      setDoc(doc(db(), "hotels", HOTEL, "rooms", "room2"), {
        number: "102",
        type: "Double",
        price: 220000,
        status: "Available",
        hotelId: HOTEL,
      })
    );
  });

  it("a room's status can change", async () => {
    await assertSucceeds(updateDoc(doc(db(), "hotels", HOTEL, "rooms", "room1"), { status: "Cleaning" }));
  });

  it("CANNOT write an unknown room status", async () => {
    await assertFails(updateDoc(doc(db(), "hotels", HOTEL, "rooms", "room1"), { status: "OnFire" }));
  });

  it("CANNOT file a room under one hotel while stamping another hotel's id", async () => {
    await assertFails(
      setDoc(doc(db(), "hotels", HOTEL, "rooms", "room3"), {
        number: "103",
        status: "Available",
        hotelId: OTHER_HOTEL,
      })
    );
  });

  it("CANNOT add rooms to a hotel that doesn't exist", async () => {
    await assertFails(
      setDoc(doc(db(), "hotels", MISSING_HOTEL, "rooms", "room1"), {
        number: "101",
        status: "Available",
      })
    );
  });

  it("CANNOT delete a room", async () => {
    await assertFails(deleteDoc(doc(db(), "hotels", HOTEL, "rooms", "room1")));
  });

  it("CANNOT write an oversized document", async () => {
    const bloated: Record<string, unknown> = { status: "Available" };
    for (let i = 0; i < 60; i++) bloated[`field${i}`] = i;
    await assertFails(setDoc(doc(db(), "hotels", HOTEL, "rooms", "bloated"), bloated));
  });
});

describe("Bookings (Accommodation)", () => {
  it("a booking can be created", async () => {
    await assertSucceeds(
      setDoc(doc(db(), "hotels", HOTEL, "accomodation", "booking2"), {
        guestName: "Carol",
        roomNumber: "101",
        status: "Confirmed",
        hotelId: HOTEL,
      })
    );
  });

  it("every supported booking status is accepted", async () => {
    for (const status of ["Checked In", "Checked Out", "Cancelled", "No Show", "Confirmed"]) {
      await assertSucceeds(
        updateDoc(doc(db(), "hotels", HOTEL, "accomodation", "booking1"), { status })
      );
    }
  });

  it("CANNOT write an unknown booking status", async () => {
    await assertFails(
      updateDoc(doc(db(), "hotels", HOTEL, "accomodation", "booking1"), { status: "Definitely Not A Status" })
    );
  });

  it("CANNOT delete a booking", async () => {
    await assertFails(deleteDoc(doc(db(), "hotels", HOTEL, "accomodation", "booking1")));
  });
});

describe("Reservations (server-written)", () => {
  it("reservations can be read, so availability sees them", async () => {
    await assertSucceeds(getDoc(doc(db(), "hotels", HOTEL, "reservations", "r1")));
  });

  it("CANNOT create a reservation from the browser", async () => {
    await assertFails(
      setDoc(doc(db(), "hotels", HOTEL, "reservations", "r2"), {
        guestName: "Forged",
        status: "Confirmed",
        hotelId: HOTEL,
      })
    );
  });

  it("CANNOT alter a reservation from the browser", async () => {
    await assertFails(updateDoc(doc(db(), "hotels", HOTEL, "reservations", "r1"), { status: "Cancelled" }));
  });
});

describe("Restaurant orders", () => {
  it("an order can move through its lifecycle", async () => {
    await assertSucceeds(updateDoc(doc(db(), "hotels", HOTEL, "restaurant", "o1"), { status: "Paid" }));
  });

  it("CANNOT write an unknown order status", async () => {
    await assertFails(updateDoc(doc(db(), "hotels", HOTEL, "restaurant", "o1"), { status: "Eaten" }));
  });

  it("CANNOT delete an order", async () => {
    await assertFails(deleteDoc(doc(db(), "hotels", HOTEL, "restaurant", "o1")));
  });
});

describe("Expenses", () => {
  it("an expense can be recorded", async () => {
    await assertSucceeds(
      setDoc(doc(db(), "hotels", HOTEL, "expenses", "e2"), { amount: 5000, department: "Cleaning", hotelId: HOTEL })
    );
  });

  it("CANNOT edit a recorded expense", async () => {
    await assertFails(updateDoc(doc(db(), "hotels", HOTEL, "expenses", "e1"), { amount: 1 }));
  });

  it("CANNOT delete a recorded expense", async () => {
    await assertFails(deleteDoc(doc(db(), "hotels", HOTEL, "expenses", "e1")));
  });

  it("CANNOT record an expense against a hotel that doesn't exist", async () => {
    await assertFails(
      setDoc(doc(db(), "hotels", MISSING_HOTEL, "expenses", "e1"), { amount: 5000 })
    );
  });
});

describe("Audit log — append-only", () => {
  it("an action can be logged", async () => {
    await assertSucceeds(
      setDoc(doc(db(), "hotels", HOTEL, "auditLog", "log2"), { action: "Booking created", hotelId: HOTEL })
    );
  });

  it("the activity log can be read", async () => {
    await assertSucceeds(getDoc(doc(db(), "hotels", HOTEL, "auditLog", "log1")));
  });

  it("CANNOT rewrite an audit entry", async () => {
    await assertFails(updateDoc(doc(db(), "hotels", HOTEL, "auditLog", "log1"), { action: "Edited" }));
  });

  it("CANNOT delete an audit entry", async () => {
    await assertFails(deleteDoc(doc(db(), "hotels", HOTEL, "auditLog", "log1")));
  });
});

describe("Retired collections", () => {
  it("CANNOT read payments, which the app no longer uses", async () => {
    await assertFails(getDoc(doc(db(), "hotels", HOTEL, "payments", "p1")));
  });
});
