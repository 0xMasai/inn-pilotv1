/**
 * Security-rule coverage for the Bar and Parking collections.
 *
 * These run the real firestore.rules against the emulator, unauthenticated,
 * exactly as the app makes its requests. The stock assertions matter most:
 * the app runs every movement inside a transaction, but the rule is what
 * makes "inventory never goes negative" true for any client, including one
 * that skips the app entirely.
 */
import { readFileSync } from "node:fs";
import { beforeAll, afterAll, beforeEach, describe, it } from "vitest";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { deleteDoc, doc, getDoc, setDoc, updateDoc } from "firebase/firestore";

let env: RulesTestEnvironment;
const A = "hotel-a";
const B = "hotel-b";

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: "innpilot-bar-parking-rules-test",
    firestore: {
      rules: readFileSync("firestore.rules", "utf8"),
      host: "127.0.0.1",
      port: 8080,
    },
  });
});

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, "hotels", A), { name: "Hotel A", currency: "UGX" });
    await setDoc(doc(db, "hotels", B), { name: "Hotel B", currency: "UGX" });

    await setDoc(doc(db, "hotels", A, "barProducts", "p1"), {
      name: "Nile Special",
      unit: "Bottle",
      costPrice: 2500,
      sellingPrice: 4000,
      barStock: 24,
      storeStock: 96,
      reorderLevel: 12,
      archived: false,
    });
    await setDoc(doc(db, "hotels", A, "barSales", "s1"), {
      reference: "BAR-1",
      total: 8000,
      cost: 5000,
    });
    await setDoc(doc(db, "hotels", A, "barTransfers", "t1"), {
      productId: "p1",
      quantity: 12,
    });
    await setDoc(doc(db, "hotels", A, "parking", "v1"), {
      vehiclePlate: "UAX 123B",
      status: "Parked",
      amount: 0,
    });
  });
});

afterAll(async () => {
  await env.cleanup();
});

const db = () => env.unauthenticatedContext().firestore();

describe("Bar products", () => {
  it("products can be read", async () => {
    await assertSucceeds(getDoc(doc(db(), "hotels", A, "barProducts", "p1")));
  });

  it("a product can be added", async () => {
    await assertSucceeds(
      setDoc(doc(db(), "hotels", A, "barProducts", "p2"), {
        name: "Coke 300ml",
        unit: "Bottle",
        costPrice: 800,
        sellingPrice: 1500,
        barStock: 40,
        storeStock: 0,
        reorderLevel: 10,
        archived: false,
      })
    );
  });

  it("CANNOT add a product with negative stock", async () => {
    await assertFails(
      setDoc(doc(db(), "hotels", A, "barProducts", "p3"), { name: "Forged", barStock: -3, storeStock: 0 })
    );
  });

  it("CANNOT push bar stock negative", async () => {
    await assertFails(updateDoc(doc(db(), "hotels", A, "barProducts", "p1"), { barStock: -1 }));
  });

  it("CANNOT push store stock negative", async () => {
    await assertFails(updateDoc(doc(db(), "hotels", A, "barProducts", "p1"), { storeStock: -5 }));
  });

  it("stock CAN be deducted down to zero", async () => {
    await assertSucceeds(updateDoc(doc(db(), "hotels", A, "barProducts", "p1"), { barStock: 0 }));
  });

  it("CANNOT stamp another hotel's id onto a product", async () => {
    await assertFails(updateDoc(doc(db(), "hotels", A, "barProducts", "p1"), { hotelId: B }));
  });

  it("nobody can delete a product — archiving is the only removal", async () => {
    await assertFails(deleteDoc(doc(db(), "hotels", A, "barProducts", "p1")));
  });
});

describe("Bar sales — the revenue record", () => {
  it("a sale can be recorded", async () => {
    await assertSucceeds(
      setDoc(doc(db(), "hotels", A, "barSales", "s2"), {
        reference: "BAR-2",
        total: 4000,
        cost: 2500,
        paymentMethod: "Cash",
      })
    );
  });

  it("CANNOT edit a recorded sale", async () => {
    await assertFails(updateDoc(doc(db(), "hotels", A, "barSales", "s1"), { total: 1 }));
  });

  it("CANNOT delete a sale", async () => {
    await assertFails(deleteDoc(doc(db(), "hotels", A, "barSales", "s1")));
  });
});

describe("Bar transfers — append-only audit trail", () => {
  it("a transfer can be recorded", async () => {
    await assertSucceeds(
      setDoc(doc(db(), "hotels", A, "barTransfers", "t2"), {
        productId: "p1",
        productName: "Nile Special",
        quantity: 24,
        storeStockAfter: 72,
        barStockAfter: 48,
      })
    );
  });

  it("nobody can rewrite a transfer", async () => {
    await assertFails(updateDoc(doc(db(), "hotels", A, "barTransfers", "t1"), { quantity: 999 }));
  });

  it("nobody can delete a transfer", async () => {
    await assertFails(deleteDoc(doc(db(), "hotels", A, "barTransfers", "t1")));
  });
});

describe("Parking", () => {
  it("a vehicle can be checked in", async () => {
    await assertSucceeds(
      setDoc(doc(db(), "hotels", A, "parking", "v2"), {
        vehiclePlate: "UBK 900X",
        status: "Parked",
        amount: 0,
      })
    );
  });

  it("CANNOT write an unknown parking status", async () => {
    await assertFails(updateDoc(doc(db(), "hotels", A, "parking", "v1"), { status: "Towed" }));
  });

  it("a parked vehicle CAN be released", async () => {
    await assertSucceeds(
      updateDoc(doc(db(), "hotels", A, "parking", "v1"), {
        status: "Released",
        amount: 5000,
        paymentMethod: "Cash",
      })
    );
  });

  it("CANNOT delete a parking record", async () => {
    await assertFails(deleteDoc(doc(db(), "hotels", A, "parking", "v1")));
  });
});
