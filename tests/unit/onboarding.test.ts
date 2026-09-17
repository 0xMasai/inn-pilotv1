/**
 * Onboarding's starting inventory and the documents it writes (pure; no
 * emulator needed — the Firestore client SDK is replaced by a recorder).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const firestore = vi.hoisted(() => ({
  writes: [] as { path: string; data: Record<string, unknown> }[],
  committed: 0,
  nextAutoId: 0,
}));

// onboarding.ts imports the app's Firestore handle; the recorder never uses it.
vi.mock("../../firebase", () => ({ db: {} }));

vi.mock("firebase/firestore", () => {
  const ref = (path: string) => ({ path, id: path.split("/").at(-1)! });
  return {
    serverTimestamp: () => "<serverTimestamp>",
    collection: (_db: unknown, ...segments: string[]) => ({ path: segments.join("/") }),
    doc: (parent: { path?: string }, ...segments: string[]) =>
      segments.length
        ? ref([...(parent.path ? [parent.path] : []), ...segments].join("/"))
        : ref(`${parent.path}/AutoId${String(++firestore.nextAutoId).padStart(14, "0")}`),
    writeBatch: () => ({
      set: (docRef: { path: string }, data: Record<string, unknown>) => firestore.writes.push({ path: docRef.path, data }),
      commit: async () => {
        firestore.committed++;
      },
    }),
    addDoc: async () => ({ id: "audit" }),
  };
});

import { createWorkspace, planRooms, startingRates } from "../../src/lib/onboarding";
import { isPublicHotelId } from "../../src/lib/publicHotel";

const input = {
  hotelName: "Lakeside Inn & Spa",
  city: "Entebbe",
  currency: "UGX",
  phone: "",
  email: "",
  roomCount: 3,
};

beforeEach(() => {
  firestore.writes = [];
  firestore.committed = 0;
  firestore.nextAutoId = 0;
});

describe("planRooms", () => {
  it.each([1, 9, 10, 20, 200])("starts all %i rooms Available — no invented operational state", (count) => {
    const rooms = planRooms(count, "UGX");
    expect(rooms).toHaveLength(count);
    expect(rooms.every((room) => room.status === "Available")).toBe(true);
  });

  it("numbers rooms uniquely and prices each from its type", () => {
    const rooms = planRooms(25, "USD");
    const rates = startingRates("USD");
    expect(new Set(rooms.map((room) => room.number)).size).toBe(25);
    expect(rooms.every((room) => room.price === rates[room.type])).toBe(true);
  });
});

describe("createWorkspace", () => {
  it("writes the hotel, its public id mapping and its rooms in one batch, with matching ids", async () => {
    const result = await createWorkspace(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { hotelId, publicId } = result.data;

    expect(firestore.committed).toBe(1);
    expect(isPublicHotelId(publicId)).toBe(true);
    expect(publicId).toMatch(/^lakeside-inn-spa-[a-z0-9]{8}$/);

    const hotel = firestore.writes.find((w) => w.path === `hotels/${hotelId}`);
    const mapping = firestore.writes.find((w) => w.path === `publicHotels/${publicId}`);
    const rooms = firestore.writes.filter((w) => w.path.startsWith(`hotels/${hotelId}/rooms/`));

    expect(hotel?.data).toMatchObject({ name: "Lakeside Inn & Spa", publicId });
    expect(mapping?.data).toEqual({ hotelId, createdAt: "<serverTimestamp>" });
    expect(rooms).toHaveLength(3);
    expect(firestore.writes).toHaveLength(5);
  });

  it("gives every new workspace its own public id", async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const result = await createWorkspace(input);
      if (result.ok) ids.add(result.data.publicId);
    }
    expect(ids.size).toBe(5);
  });

  it("writes nothing when the input is invalid", async () => {
    const result = await createWorkspace({ ...input, hotelName: "" });
    expect(result.ok).toBe(false);
    expect(firestore.writes).toHaveLength(0);
  });
});
