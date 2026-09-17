/**
 * Security-rule coverage for hotel workspaces themselves.
 *
 * InnPilot has no accounts, so every request here is unauthenticated —
 * exactly as the real app makes them. What these tests pin down is what
 * stands in for authentication: a workspace can only be created under an
 * unguessable id, can never be discovered by listing, and cannot be used
 * to upgrade its own plan or be deleted.
 *
 * Runs the real firestore.rules against the emulator:
 *   firebase emulators:start --only firestore   (then)   npm run test:rules
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  collection,
  collectionGroup,
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
} from "firebase/firestore";

let env: RulesTestEnvironment;

/** Firestore-style generated ids: 20 alphanumeric characters. */
const EXISTING = "ExistingHotel0000001";
const NEW_HOTEL = "NewHotelGeneratedId1";

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: "innpilot-workspace-rules-test",
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
    await setDoc(doc(db, "hotels", EXISTING), {
      name: "Kampala Grand",
      location: "Kampala",
      currency: "UGX",
      phone: "",
      email: "",
      taxId: "",
      subscription: { plan: "trial", status: "active" },
    });
    await setDoc(doc(db, "hotels", EXISTING, "rooms", "room1"), {
      number: "101",
      type: "Single",
      price: 150000,
      status: "Available",
      hotelId: EXISTING,
    });
    await setDoc(doc(db, "users", "legacy-user"), { role: "hotel_admin", hotelId: EXISTING });
  });
});

const db = () => env.unauthenticatedContext().firestore();

/** What src/lib/onboarding.ts writes. */
const newHotel = (overrides: Record<string, unknown> = {}) => ({
  name: "Entebbe Lakeside",
  location: "Entebbe",
  currency: "UGX",
  phone: "+256 700 123 456",
  email: "hello@lakeside.ug",
  taxId: "",
  subscription: { plan: "trial", status: "active" },
  createdAt: serverTimestamp(),
  ...overrides,
});

describe("Creating a workspace", () => {
  it("anyone can create a workspace under a generated id", async () => {
    await assertSucceeds(setDoc(doc(db(), "hotels", NEW_HOTEL), newHotel()));
  });

  it("onboarding can create the hotel and its starting rooms in one batch", async () => {
    const client = db();
    const batch = writeBatch(client);
    batch.set(doc(client, "hotels", NEW_HOTEL), newHotel());
    batch.set(doc(client, "hotels", NEW_HOTEL, "rooms", "r1"), {
      number: "101",
      type: "Single",
      price: 150000,
      status: "Available",
      hotelId: NEW_HOTEL,
      createdAt: serverTimestamp(),
    });
    batch.set(doc(client, "hotels", NEW_HOTEL, "rooms", "r2"), {
      number: "102",
      type: "Double",
      price: 220000,
      status: "Maintenance",
      hotelId: NEW_HOTEL,
      createdAt: serverTimestamp(),
    });
    await assertSucceeds(batch.commit());
  });

  it("CANNOT create a workspace under a readable, hand-picked id", async () => {
    await assertFails(setDoc(doc(db(), "hotels", "hilton"), newHotel()));
  });

  it("CANNOT start a workspace on a paid plan", async () => {
    await assertFails(
      setDoc(doc(db(), "hotels", NEW_HOTEL), newHotel({ subscription: { plan: "pro", status: "active" } }))
    );
  });

  it("CANNOT add undeclared fields to a workspace", async () => {
    await assertFails(setDoc(doc(db(), "hotels", NEW_HOTEL), newHotel({ role: "super_admin" })));
  });

  it("CANNOT create a workspace without a name", async () => {
    await assertFails(setDoc(doc(db(), "hotels", NEW_HOTEL), newHotel({ name: "" })));
  });

  it("CANNOT create a workspace in an unsupported currency", async () => {
    await assertFails(setDoc(doc(db(), "hotels", NEW_HOTEL), newHotel({ currency: "BTC" })));
  });

  it("CANNOT backdate a workspace's creation time", async () => {
    await assertFails(
      setDoc(doc(db(), "hotels", NEW_HOTEL), newHotel({ createdAt: new Date("2020-01-01") }))
    );
  });

  it("CANNOT overwrite an existing workspace by re-creating it", async () => {
    await assertFails(
      setDoc(doc(db(), "hotels", EXISTING), newHotel({ name: "Hijacked" }))
    );
  });
});

describe("Finding a workspace", () => {
  it("a workspace can be opened by its id", async () => {
    await assertSucceeds(getDoc(doc(db(), "hotels", EXISTING)));
  });

  it("CANNOT list workspaces", async () => {
    await assertFails(getDocs(collection(db(), "hotels")));
  });

  it("CANNOT query rooms across every hotel with a collection-group query", async () => {
    await assertFails(getDocs(collectionGroup(db(), "rooms")));
  });
});

describe("Changing a workspace", () => {
  it("can update how the hotel presents itself", async () => {
    await assertSucceeds(
      updateDoc(doc(db(), "hotels", EXISTING), { name: "Kampala Grand Ltd", currency: "KES" })
    );
  });

  it("CANNOT change its own subscription", async () => {
    await assertFails(
      updateDoc(doc(db(), "hotels", EXISTING), { subscription: { plan: "pro", status: "active" } })
    );
  });

  it("CANNOT blank out the hotel's name", async () => {
    await assertFails(updateDoc(doc(db(), "hotels", EXISTING), { name: "" }));
  });

  it("CANNOT switch to an unsupported currency", async () => {
    await assertFails(updateDoc(doc(db(), "hotels", EXISTING), { currency: "BTC" }));
  });

  it("CANNOT list itself for guests before it has a public id", async () => {
    await assertFails(updateDoc(doc(db(), "hotels", EXISTING), { listed: true }));
  });

  it("can set its concierge listing to unlisted without a public id", async () => {
    await assertSucceeds(updateDoc(doc(db(), "hotels", EXISTING), { listed: false, region: "Central" }));
  });

  it("CANNOT delete a workspace", async () => {
    await assertFails(deleteDoc(doc(db(), "hotels", EXISTING)));
  });
});

describe("Public hotel identity", () => {
  const PUBLIC_ID = "entebbe-lakeside-k7m2qp9x";
  const EXISTING_PUBLIC_ID = "kampala-grand-a1b2c3d4";

  const mapping = (hotelId: string) => ({ hotelId, createdAt: serverTimestamp() });

  /** What onboarding writes: hotel + public id mapping in one batch. */
  function onboardingBatch(hotelId = NEW_HOTEL, publicId = PUBLIC_ID, mappedHotelId = hotelId) {
    const client = db();
    const batch = writeBatch(client);
    batch.set(doc(client, "hotels", hotelId), newHotel({ publicId }));
    batch.set(doc(client, "publicHotels", publicId), mapping(mappedHotelId));
    return batch;
  }

  /** Adds a public id to the existing workspace, as a workspace created before public ids would. */
  function publishBatch(publicId = EXISTING_PUBLIC_ID, mappedHotelId = EXISTING) {
    const client = db();
    const batch = writeBatch(client);
    batch.update(doc(client, "hotels", EXISTING), { publicId });
    batch.set(doc(client, "publicHotels", publicId), mapping(mappedHotelId));
    return batch;
  }

  it("onboarding can create the hotel with its public id and mapping in one batch", async () => {
    await assertSucceeds(onboardingBatch().commit());
  });

  it("CANNOT create a hotel with a public id that has no mapping", async () => {
    await assertFails(setDoc(doc(db(), "hotels", NEW_HOTEL), newHotel({ publicId: PUBLIC_ID })));
  });

  it("CANNOT create a mapping on its own, for a hotel that doesn't claim it", async () => {
    await assertFails(setDoc(doc(db(), "publicHotels", PUBLIC_ID), mapping(EXISTING)));
  });

  it("CANNOT point a new public id at another existing hotel", async () => {
    await assertFails(onboardingBatch(NEW_HOTEL, PUBLIC_ID, EXISTING).commit());
  });

  it("CANNOT create a mapping for a hotel that doesn't exist", async () => {
    await assertFails(setDoc(doc(db(), "publicHotels", PUBLIC_ID), mapping("NoSuchHotel000000001")));
  });

  it.each(["Entebbe-Lakeside-k7m2", "nohyphen", "ExistingHotel0000001", "-leading-hyphen", `a-${"b".repeat(80)}`])(
    "CANNOT use the malformed public id %s",
    async (publicId) => {
      await assertFails(onboardingBatch(NEW_HOTEL, publicId).commit());
    }
  );

  it("CANNOT add undeclared fields to a mapping", async () => {
    const client = db();
    const batch = writeBatch(client);
    batch.set(doc(client, "hotels", NEW_HOTEL), newHotel({ publicId: PUBLIC_ID }));
    batch.set(doc(client, "publicHotels", PUBLIC_ID), { ...mapping(NEW_HOTEL), enabled: true });
    await assertFails(batch.commit());
  });

  it("an existing workspace can add its public id once", async () => {
    await assertSucceeds(publishBatch().commit());
  });

  describe("once published", () => {
    beforeEach(async () => {
      await env.withSecurityRulesDisabled(async (ctx) => {
        const admin = ctx.firestore();
        await setDoc(doc(admin, "publicHotels", EXISTING_PUBLIC_ID), { hotelId: EXISTING });
        await updateDoc(doc(admin, "hotels", EXISTING), { publicId: EXISTING_PUBLIC_ID });
      });
    });

    it("CANNOT read a mapping (it would reveal the workspace key)", async () => {
      await assertFails(getDoc(doc(db(), "publicHotels", EXISTING_PUBLIC_ID)));
    });

    it("CANNOT list mappings", async () => {
      await assertFails(getDocs(collection(db(), "publicHotels")));
    });

    it("CANNOT change a hotel's public id", async () => {
      await assertFails(publishBatch("kampala-grand-zzzz9999").commit());
    });

    it("CANNOT remove a hotel's public id", async () => {
      await assertFails(updateDoc(doc(db(), "hotels", EXISTING), { publicId: deleteField() }));
    });

    it("CANNOT repoint a mapping at another hotel", async () => {
      await assertFails(setDoc(doc(db(), "publicHotels", EXISTING_PUBLIC_ID), mapping(NEW_HOTEL)));
    });

    it("CANNOT delete a mapping", async () => {
      await assertFails(deleteDoc(doc(db(), "publicHotels", EXISTING_PUBLIC_ID)));
    });

    it("CANNOT take over the public id with a new hotel", async () => {
      await assertFails(onboardingBatch(NEW_HOTEL, EXISTING_PUBLIC_ID).commit());
    });

    it("profile updates still work on a published hotel", async () => {
      await assertSucceeds(updateDoc(doc(db(), "hotels", EXISTING), { name: "Kampala Grand Ltd" }));
    });

    it("can publish its AI Concierge listing (D24)", async () => {
      await assertSucceeds(
        updateDoc(doc(db(), "hotels", EXISTING), {
          listed: true,
          region: "Central",
          country: "Uganda",
          description: "City hotel.",
          amenities: ["Free Wi-Fi", "Breakfast included"],
          checkInTime: "14:00",
          checkOutTime: "10:00",
          policies: "Pay on arrival.",
        })
      );
    });

    it.each([
      ["listed that isn't a boolean", { listed: "yes" }],
      ["more than 30 amenities", { amenities: Array.from({ length: 31 }, (_, i) => `Amenity ${i}`) }],
      ["amenities that aren't a list", { amenities: "Wi-Fi" }],
      ["an oversized description", { description: "x".repeat(501) }],
      ["oversized policies", { policies: "x".repeat(1001) }],
      ["a region that isn't text", { region: 7 }],
    ])("CANNOT publish a listing with %s", async (_label, change) => {
      await assertFails(updateDoc(doc(db(), "hotels", EXISTING), change));
    });
  });
});

describe("Room capacity (D24)", () => {
  it("can record how many guests a room sleeps", async () => {
    await assertSucceeds(updateDoc(doc(db(), "hotels", EXISTING, "rooms", "room1"), { capacity: 2 }));
  });

  it.each([0, 21, 2.5, "2"])("CANNOT record a capacity of %o", async (capacity) => {
    await assertFails(updateDoc(doc(db(), "hotels", EXISTING, "rooms", "room1"), { capacity }));
  });
});

describe("Network concierge threads (D29)", () => {
  it.each(["read", "list", "write"])("CANNOT %s the server-only guest threads", async (action) => {
    const ref = doc(db(), "conciergeConversations", "SomeGuestThread00001");
    if (action === "read") await assertFails(getDoc(ref));
    if (action === "list") await assertFails(getDocs(collection(db(), "conciergeConversations")));
    if (action === "write") await assertFails(setDoc(ref, { hotelIds: [EXISTING], pendingBooking: null }));
  });

  it("CANNOT read a guest thread's messages", async () => {
    await assertFails(getDocs(collection(db(), "conciergeConversations", "SomeGuestThread00001", "messages")));
  });
});

describe("Retired account data", () => {
  it("CANNOT read the retired users collection", async () => {
    await assertFails(getDoc(doc(db(), "users", "legacy-user")));
  });

  it("CANNOT write to the retired users collection", async () => {
    await assertFails(
      setDoc(doc(db(), "users", "attacker"), { role: "super_admin", hotelId: null })
    );
  });
});
