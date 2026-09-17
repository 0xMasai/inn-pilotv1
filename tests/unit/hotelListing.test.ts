import { describe, expect, it } from "vitest";
import { isExplicitConfirmation } from "../../src/lib/confirmation";
import {
  matchesDestination,
  normalizeRoomType,
  parseAmenityList,
  readAmenities,
  roomCapacityOf,
  roomTypeIncludes,
  roomTypeMatches,
  toHotelListing,
} from "../../src/lib/hotelListing";

const KABALE = { city: "Kabale", region: "Western", country: "Uganda" };
const KAMPALA = { city: "Kampala", region: "Central", country: "Uganda" };
const FORT_PORTAL = { city: "Fort Portal", region: "Western Region", country: "Uganda" };

describe("matchesDestination", () => {
  it.each([
    ["Western Uganda", KABALE, true],
    ["Western Uganda", KAMPALA, false],
    ["western region", FORT_PORTAL, true],
    ["the west", KABALE, true],
    ["Kabale town", KABALE, true],
    ["kabale", KAMPALA, false],
    ["Fort Portal", FORT_PORTAL, true],
    ["Uganda", KAMPALA, true],
    ["Kenya", KABALE, false],
    ["", KAMPALA, true],
    ["somewhere in the area", KABALE, true],
    ["Lake Bunyonyi", KABALE, false],
  ])("%o in %o → %s", (destination, place, expected) => {
    expect(matchesDestination(destination, place)).toBe(expected);
  });

  it("lets a south-western hotel answer to both south-western and western", () => {
    const place = { city: "Kisoro", region: "South-Western", country: "Uganda" };
    expect(matchesDestination("southwestern Uganda", place)).toBe(true);
    expect(matchesDestination("Western Uganda", place)).toBe(true);
  });
});

describe("room types", () => {
  it("normalises the way guests say them", () => {
    expect(normalizeRoomType("a Double room")).toBe("double");
    expect(normalizeRoomType("Family rooms")).toBe("family");
  });

  it("matches exactly for pricing and booking, loosely for search", () => {
    expect(roomTypeMatches("double room", "Double")).toBe(true);
    expect(roomTypeMatches("double", "Deluxe Double")).toBe(false);
    expect(roomTypeIncludes("double", "Deluxe Double")).toBe(true);
    expect(roomTypeIncludes("family", "Double")).toBe(false);
    expect(roomTypeMatches("", "Suite")).toBe(true);
  });
});

describe("listing fields", () => {
  it("reads only what the hotel recorded, never a default", () => {
    expect(toHotelListing({})).toEqual({
      listed: false,
      region: "",
      country: "",
      description: "",
      amenities: [],
      checkInTime: "",
      checkOutTime: "",
      policies: "",
    });
    expect(toHotelListing({ listed: "yes" }).listed).toBe(false);
  });

  it("cleans amenity lists: trimmed, deduplicated, strings only", () => {
    expect(readAmenities([" Wi-Fi ", "wi-fi", 3, "", "Parking"])).toEqual(["Wi-Fi", "Parking"]);
    expect(parseAmenityList("Free Wi-Fi, Parking\nPool,,")).toEqual(["Free Wi-Fi", "Parking", "Pool"]);
  });

  it("reports capacity only when it is a sensible whole number", () => {
    expect(roomCapacityOf({ capacity: 2 })).toBe(2);
    for (const capacity of [undefined, 0, 2.5, "2", 99]) expect(roomCapacityOf({ capacity })).toBeNull();
  });
});

describe("isExplicitConfirmation (D27)", () => {
  it.each(["Confirm.", "Yes", "yes please", "Yes, confirm this booking.", "Go ahead", "OK book it", "That's correct", "Looks good, proceed"])(
    "%o confirms",
    (message) => expect(isExplicitConfirmation(message)).toBe(true)
  );

  it.each([
    "I'll take the first one",
    "Amina Okello, +256 772 123 456",
    "No",
    "Not yet",
    "Don't book it",
    "Wait, can I change the dates?",
    "Yes, but change it to the suite",
    "Can you confirm?",
    "Actually, the second one",
    "",
  ])("%o does not confirm", (message) => expect(isExplicitConfirmation(message)).toBe(false));
});
