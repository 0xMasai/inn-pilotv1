/**
 * Network hotel resolution: findHotel matches a reference to a reachable
 * hotel by public id or exact name. No emulator, no network.
 *
 * Network cache tests verify that listNetworkHotels() results are cached
 * per turn with a TTL, so tools don't re-fetch all hotel profiles every
 * concierge turn.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { findHotel } from "../../server/network.js";
import type { HotelScope } from "../../server/hotels.js";

function scope(name: string, publicId: string, hotelId = "hotel_" + publicId): HotelScope {
  return {
    hotelId,
    publicId,
    profile: { name, location: "Kampala", currency: "UGX", phone: "", email: "", country: "Uganda", region: "Central" },
    collection: () => null as any,
    runTransaction: async () => null as any,
    serverTimestamp: () => null as any,
  } as unknown as HotelScope;
}

const mockListNetworkHotels = vi.hoisted(() => vi.fn());

vi.mock("../../server/hotels.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../server/hotels.js")>();
  return {
    ...actual,
    listNetworkHotels: mockListNetworkHotels,
  };
});

describe("findHotel", () => {
  const hotels = [scope("K Hotels Kampala", "kampala-1"), scope("K Hotels Kabale", "kabale-1")];

  it("matches by public id", () => {
    expect(findHotel(hotels, "kampala-1")?.publicId).toBe("kampala-1");
  });

  it("matches by exact hotel name (case-insensitive)", () => {
    expect(findHotel(hotels, "k hotels kampala")?.publicId).toBe("kampala-1");
    expect(findHotel(hotels, "K HOTELS KAMPALA")?.publicId).toBe("kampala-1");
  });

  it("returns null for unknown public id", () => {
    expect(findHotel(hotels, "nonexistent")).toBeNull();
  });

  it("returns null for ambiguous name", () => {
    const dup = [...hotels, scope("K Hotels Kampala", "kampala-2")];
    expect(findHotel(dup, "K Hotels Kampala")).toBeNull();
  });

  it("returns null for empty or oversized reference", () => {
    expect(findHotel(hotels, "")).toBeNull();
    expect(findHotel(hotels, "x".repeat(121))).toBeNull();
  });
});

describe("network cache", () => {
  const hotels = [scope("K Hotels Kampala", "kampala-1")];

  beforeEach(() => {
    // Clear the module cache so the dynamic import picks up the vi.mock
    // replacement of listNetworkHotels (network.ts is imported by other
    // test files first, so it's already cached with the real function).
    vi.resetModules();
    mockListNetworkHotels.mockReset();
    mockListNetworkHotels.mockResolvedValue(hotels);
    vi.useRealTimers();
  });

  it("caches the hotel list so listNetworkHotels is not re-fetched within the TTL", async () => {
    const { createNetworkContext } = await import("../../server/network.js");
    const ctx = await createNetworkContext();
    await ctx.searchableHotels();
    await ctx.searchableHotels();
    expect(mockListNetworkHotels).toHaveBeenCalledTimes(1);
  });

  it("refetches after the TTL expires", async () => {
    vi.useFakeTimers();
    const { createNetworkContext } = await import("../../server/network.js");

    // First call populates the cache.
    const ctx1 = await createNetworkContext();
    await ctx1.searchableHotels();
    expect(mockListNetworkHotels).toHaveBeenCalledTimes(1);

    // Advance time past the 5-minute TTL.
    vi.advanceTimersByTime(5 * 60_000 + 100);

    // A new context re-checks the (now expired) cache and refetches.
    const ctx2 = await createNetworkContext();
    await ctx2.searchableHotels();
    expect(mockListNetworkHotels).toHaveBeenCalledTimes(2);
  });

  it("resetNetworkCache clears the cache so the next call refetches", async () => {
    const { createNetworkContext, resetNetworkCache } = await import("../../server/network.js");
    const ctx1 = await createNetworkContext();

    await ctx1.searchableHotels();
    expect(mockListNetworkHotels).toHaveBeenCalledTimes(1);

    resetNetworkCache();

    // New context re-checks the (now cleared) cache and refetches.
    const ctx2 = await createNetworkContext();
    await ctx2.searchableHotels();
    expect(mockListNetworkHotels).toHaveBeenCalledTimes(2);
  });
});
