/**
 * Which hotels one guest conversation may reach (DECISIONS D25).
 *
 * The network concierge at `/#/` searches every hotel that opted in
 * (`listed: true`). The same concierge opened from a hotel's own link,
 * `/#/c/:publicHotelId`, reaches exactly that hotel and nothing else.
 *
 * Tools never resolve a hotel themselves. They hand the reference the model
 * gave them to `resolve()`, which answers null for anything this
 * conversation may not reach — a malformed id, a workspace hotelId, an
 * unlisted hotel, or (on a hotel's own page) any other hotel — so the model
 * gets one uniform "unknown hotel" whatever it tried.
 *
 * The reference is a public id or, failing that, the hotel's exact name
 * (case and spacing aside) — matched only among the hotels this conversation
 * may already reach, and only when exactly one has that name. A guest turn
 * carries text history, not earlier tool results, so on a later turn the
 * model often knows "K Hotels Kabale" but no longer its id; without this it
 * had to search again, doubling a turn's cost (DECISIONS D31).
 *
 * Built once per guest turn and cached for that turn: a search followed by a
 * price check reads the hotel list once.
 */
import { isPublicHotelId } from "../src/lib/publicHotel.js";
import { listNetworkHotels, resolveHotel, type HotelScope } from "./hotels.js";

export interface NetworkContext {
  /** The one hotel this conversation is limited to, or null for the whole network. */
  readonly scopedPublicId: string | null;
  /** The hotels a search covers. */
  searchableHotels(): Promise<HotelScope[]>;
  /** The hotel behind a public id (or exact name) the model named, or null when it isn't reachable here. */
  resolve(reference: unknown): Promise<HotelScope | null>;
}

const nameKey = (value: string) => value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();

/** The one hotel among `hotels` a reference names: by public id, else by a unique exact name. */
export function findHotel(hotels: HotelScope[], reference: unknown): HotelScope | null {
  if (typeof reference !== "string" || !reference.trim() || reference.length > 120) return null;
  if (isPublicHotelId(reference)) {
    const byId = hotels.find((scope) => scope.publicId === reference);
    if (byId) return byId;
  }
  const named = hotels.filter((scope) => nameKey(scope.profile.name) === nameKey(reference));
  return named.length === 1 ? named[0] : null;
}

/**
 * `scopedPublicId` comes from the request (a hotel's own concierge link).
 * An invalid one throws the same guest-safe error resolveHotel() always has.
 */
export async function createNetworkContext(scopedPublicId?: unknown): Promise<NetworkContext> {
  if (scopedPublicId !== undefined && scopedPublicId !== null && scopedPublicId !== "") {
    const scope = await resolveHotel(scopedPublicId);
    return {
      scopedPublicId: scope.publicId,
      searchableHotels: async () => [scope],
      resolve: async (reference) => findHotel([scope], reference),
    };
  }

  let listed: Promise<HotelScope[]> | null = null;
  const hotels = () => (listed ??= listNetworkHotels());
  return {
    scopedPublicId: null,
    searchableHotels: hotels,
    async resolve(reference) {
      return findHotel(await hotels(), reference);
    },
  };
}
