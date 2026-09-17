/**
 * Room editing (B1), end to end through the real code path.
 *
 * Runs the app's own room service — addRoom, updateRoom, loadRooms,
 * setRoomStatus — against the emulator with the real firestore.rules, as an
 * unauthenticated client, exactly as the Accommodation screen calls it. The
 * only substitution is the Firestore handle `firebase.ts` would export.
 *
 * "Refresh" is modelled by reading back through a brand-new client
 * instance, so nothing can be served from the writer's local cache.
 *
 *   firebase emulators:start --only firestore   (then)   npm run test:rules
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, doc, getDoc, getDocs, setDoc, type Firestore } from "firebase/firestore";

const firebaseHandle = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../../firebase", () => ({
  get db() {
    return firebaseHandle.db;
  },
}));

import { addRoom, loadRooms, setRoomStatus, updateRoom } from "../../src/lib/roomService";

let env: RulesTestEnvironment;
const HOTEL = "RoomEditHotel0000001";

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: "innpilot-room-editing-test",
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
    await setDoc(doc(ctx.firestore(), "hotels", HOTEL), { name: "Edit Hotel", currency: "UGX" });
  });
  firebaseHandle.db = env.unauthenticatedContext().firestore();
});

/** A fresh client — the equivalent of reloading the page. */
const freshClient = (): Firestore => env.unauthenticatedContext().firestore();

async function createRoom() {
  const created = await addRoom({
    hotelId: HOTEL,
    number: "305",
    type: "Single",
    price: 150000,
    status: "Available",
    existingRooms: [],
  });
  if (!created.ok) throw new Error(created.error);
  const [room] = await loadRooms(HOTEL);
  return { id: created.data.id, room };
}

describe("Editing a room", () => {
  it("changes type, then price, in place — id and unrelated fields survive a reload", async () => {
    const { id, room } = await createRoom();
    const before = (await getDoc(doc(freshClient(), "hotels", HOTEL, "rooms", id))).data()!;

    const typeEdit = await updateRoom(HOTEL, room, { type: "Double", price: room.price });
    expect(typeEdit).toEqual({ ok: true, data: { changed: true } });

    const [afterType] = await loadRooms(HOTEL);
    const priceEdit = await updateRoom(HOTEL, afterType, { type: afterType.type!, price: 185000.5 });
    expect(priceEdit).toEqual({ ok: true, data: { changed: true } });

    // Reload through a new client.
    const reloaded = freshClient();
    const snap = await getDoc(doc(reloaded, "hotels", HOTEL, "rooms", id));
    expect(snap.exists()).toBe(true);
    const after = snap.data()!;
    expect(after.type).toBe("Double");
    expect(after.price).toBe(185000.5);

    // Same document, no new one, nothing else touched.
    const all = await getDocs(collection(reloaded, "hotels", HOTEL, "rooms"));
    expect(all.docs.map((d) => d.id)).toEqual([id]);
    expect(after.number).toBe(before.number);
    expect(after.status).toBe(before.status);
    expect(after.hotelId).toBe(before.hotelId);
    expect(after.createdAt.isEqual(before.createdAt)).toBe(true);
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
  });

  it("records the edit in the activity log", async () => {
    const { room } = await createRoom();
    await updateRoom(HOTEL, room, { type: "Suite", price: 400000 });

    // logAction is fire-and-forget; give the write a moment to land.
    await vi.waitFor(async () => {
      const log = await getDocs(collection(freshClient(), "hotels", HOTEL, "auditLog"));
      expect(log.docs.map((d) => d.data().action)).toContain("Room updated");
    });
  });

  it("reports an unchanged room as a no-op without writing", async () => {
    const { room } = await createRoom();
    expect(await updateRoom(HOTEL, room, { type: "Single", price: 150000 })).toEqual({
      ok: true,
      data: { changed: false },
    });
  });

  it.each([
    [-1, "The nightly rate can't be negative."],
    [Number.NaN, "Enter a nightly rate."],
    [undefined, "Enter a nightly rate."],
  ])("rejects a price of %s and leaves the room untouched", async (price, message) => {
    const { id, room } = await createRoom();
    expect(await updateRoom(HOTEL, room, { type: "Double", price })).toEqual({ ok: false, error: message });

    const stored = (await getDoc(doc(freshClient(), "hotels", HOTEL, "rooms", id))).data()!;
    expect(stored.type).toBe("Single");
    expect(stored.price).toBe(150000);
  });

  it("accepts a zero rate, which is how an unpriced room is stored", async () => {
    const { room } = await createRoom();
    expect((await updateRoom(HOTEL, room, { type: "Single", price: 0 })).ok).toBe(true);
  });

  it("rejects a negative rate when adding a room", async () => {
    const result = await addRoom({
      hotelId: HOTEL,
      number: "999",
      type: "Single",
      price: -5,
      status: "Available",
      existingRooms: [],
    });
    expect(result).toEqual({ ok: false, error: "The nightly rate can't be negative." });
  });

  it("status changes still work on an edited room", async () => {
    const { id, room } = await createRoom();
    await updateRoom(HOTEL, room, { type: "Double", price: 200000 });
    const [edited] = await loadRooms(HOTEL);
    expect((await setRoomStatus(HOTEL, edited, "Cleaning")).ok).toBe(true);

    const stored = (await getDoc(doc(freshClient(), "hotels", HOTEL, "rooms", id))).data()!;
    expect(stored).toMatchObject({ status: "Cleaning", type: "Double", price: 200000 });
  });
});
