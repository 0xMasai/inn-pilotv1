/**
 * The public hotel identifier's shape (pure; no emulator needed).
 */
import { describe, expect, it } from "vitest";
import { isPublicHotelId, makePublicHotelId, slugifyHotelName } from "../../src/lib/publicHotel";

describe("makePublicHotelId", () => {
  it("is a slug of the hotel's name plus a random 8-character suffix", () => {
    const id = makePublicHotelId("Lakeside Inn & Spa");
    expect(id).toMatch(/^lakeside-inn-spa-[a-z0-9]{8}$/);
    expect(isPublicHotelId(id)).toBe(true);
  });

  it("gives two hotels with the same name different ids", () => {
    const ids = new Set(Array.from({ length: 50 }, () => makePublicHotelId("Grand Hotel")));
    expect(ids.size).toBe(50);
  });

  it.each(["Hôtel Élysée", "  !!!  ", "Ω Resort", "A".repeat(200), "Kampala--Grand__Hotel"])(
    "always produces a valid id for %o",
    (name) => {
      expect(isPublicHotelId(makePublicHotelId(name))).toBe(true);
    }
  );
});

describe("slugifyHotelName", () => {
  it("folds accents and punctuation", () => {
    expect(slugifyHotelName("Hôtel Élysée, Kigali")).toBe("hotel-elysee-kigali");
  });

  it("falls back to 'hotel' when nothing usable is left", () => {
    expect(slugifyHotelName("Ω")).toBe("hotel");
  });
});

describe("isPublicHotelId", () => {
  it.each([
    "ExistingHotel0000001", // a 20-char Firestore hotelId
    "abcdefghijklmnopqrst", // even an all-lowercase one: no hyphen
    "Lakeside-inn-a1b2c3d4",
    "lakeside-inn-",
    "-lakeside",
    "lakeside--inn",
    "../hotels/x",
    "",
    `a-${"b".repeat(80)}`,
    42,
    null,
  ])("rejects %o", (value) => {
    expect(isPublicHotelId(value)).toBe(false);
  });
});
