/**
 * GET /api/ai/network — the hotels guests can search, for the concierge home
 * page: name, place, a short description, a few amenities and the lowest
 * configured nightly rate.
 *
 * No model call, so it costs no tokens and works when Gemini doesn't. It uses
 * the same listNetworkHotels() as search_hotels, so the page shows exactly the
 * hotels the concierge searches. Public ids only; never a hotelId.
 */
import { enforceRateLimit } from "../../server/ai/rateLimit.js";
import { loadRooms, rateRange } from "../../server/ai/tools/inventory.js";
import { listNetworkHotels } from "../../server/hotels.js";
import { errorMessage, guestMessageFor, isAiError, isRateLimitError } from "../../server/ai/errors.js";
import {
  applyCors,
  clientKey,
  handlePreflight,
  newRequestId,
  requireMethod,
  sendJson,
  type ApiRequest,
  type ApiResponse,
} from "../../server/ai/http.js";
import type { ConciergeNetwork, NetworkHotel } from "../../server/ai/types.js";

/** A page load, not a chat turn. */
const RATE_LIMIT = { limit: 30, windowMs: 60_000 };
const AMENITIES_SHOWN = 4;

export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  applyCors(req, res);
  if (handlePreflight(req, res)) return;
  if (!requireMethod(req, res, "GET")) return;

  const requestId = newRequestId();
  try {
    enforceRateLimit(`network:${clientKey(req)}`, RATE_LIMIT);
    const scopes = await listNetworkHotels();
    const hotels: NetworkHotel[] = await Promise.all(
      scopes.map(async (scope) => ({
        hotel: scope.publicId,
        name: scope.profile.name,
        city: scope.profile.location,
        region: scope.profile.region,
        country: scope.profile.country,
        description: scope.profile.description,
        currency: scope.profile.currency,
        lowestRate: rateRange(await loadRooms(scope))?.from ?? null,
        amenities: scope.profile.amenities.slice(0, AMENITIES_SHOWN),
      }))
    );
    const body: ConciergeNetwork = { hotels };
    sendJson(res, 200, { ...body, requestId });
  } catch (error) {
    console.error("[network] failed", {
      requestId,
      code: isAiError(error) ? error.code : "unexpected",
      detail: errorMessage(error),
    });
    if (isRateLimitError(error)) res.setHeader("Retry-After", String(error.retryAfterSeconds));
    sendJson(res, isAiError(error) ? error.status : 500, {
      error: guestMessageFor(error),
      code: isAiError(error) ? error.code : "unexpected",
      requestId,
    });
  }
}
