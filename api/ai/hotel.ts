/**
 * GET /api/ai/hotel?publicHotelId=… — what the guest concierge page shows
 * before anyone types: the hotel's public details and its room types with
 * nightly rates.
 *
 * No model call, so it costs no tokens and works when Gemini doesn't. It
 * goes through the same resolveHotel() as the chat, so it serves exactly
 * the hotels the chat serves, and it never returns the workspace hotelId
 * (DECISIONS D14). Figures come from the same room documents and rate
 * rules as the get_room_rates tool.
 */
import { enforceRateLimit } from "../../server/ai/rateLimit";
import { capacityRange, groupByType, loadRooms, rateRange } from "../../server/ai/tools/inventory";
import { resolveHotel } from "../../server/hotels";
import { errorMessage, guestMessageFor, isAiError, isRateLimitError } from "../../server/ai/errors";
import {
  applyCors,
  clientKey,
  handlePreflight,
  newRequestId,
  requireMethod,
  sendJson,
  type ApiRequest,
  type ApiResponse,
} from "../../server/ai/http";
import type { ConciergeHotel } from "../../server/ai/types";

/** A page load, not a chat turn: looser than the concierge's limit. */
const RATE_LIMIT = { limit: 30, windowMs: 60_000 };

function queryParam(req: ApiRequest, name: string): string | null {
  const url = (req as { url?: string }).url ?? "";
  const queryStart = url.indexOf("?");
  return queryStart === -1 ? null : new URLSearchParams(url.slice(queryStart + 1)).get(name);
}

export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  applyCors(req, res);
  if (handlePreflight(req, res)) return;
  if (!requireMethod(req, res, "GET")) return;

  const requestId = newRequestId();
  try {
    enforceRateLimit(`hotel:${clientKey(req)}`, RATE_LIMIT);
    const scope = await resolveHotel(queryParam(req, "publicHotelId"));
    const rooms = await loadRooms(scope);

    const body: ConciergeHotel = {
      publicHotelId: scope.publicId,
      name: scope.profile.name,
      city: scope.profile.location || null,
      region: scope.profile.region || null,
      country: scope.profile.country || null,
      description: scope.profile.description || null,
      phone: scope.profile.phone || null,
      email: scope.profile.email || null,
      currency: scope.profile.currency,
      amenities: scope.profile.amenities,
      roomTypes: [...groupByType(rooms)].map(([roomType, ofType]) => ({
        roomType,
        roomCount: ofType.length,
        nightlyRate: rateRange(ofType),
        capacity: capacityRange(ofType),
      })),
    };
    sendJson(res, 200, { ...body, requestId });
  } catch (error) {
    console.error("[hotel] failed", {
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
