/**
 * GET /api/ai/conversation?conversationId=…&after=<ms>
 *
 * The guest's page polls this for replies from hotel staff: every few seconds
 * while staff handle the chat, now and then while the AI does. It returns
 * staff messages newer than `after` from every hotel inbox the thread is
 * mirrored into (DECISIONS D29), and whether staff are handling it.
 *
 * The id is a 20-character auto-id only that guest's tab holds; it grants
 * nothing but reading staff replies in that one thread. No model call, no
 * hotelId in the response. A thread started on a hotel's own link is only
 * readable with that hotel's `publicHotelId`; a network thread, without one.
 */
import { enforceRateLimit } from "../../server/ai/rateLimit";
import { readGuestThreadUpdates } from "../../server/guestConversations";
import {
  AiInvalidRequestError,
  errorMessage,
  guestMessageFor,
  isAiError,
  isRateLimitError,
} from "../../server/ai/errors";
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

/** A guest page polls every few seconds while staff reply. */
const RATE_LIMIT = { limit: 40, windowMs: 60_000 };

function query(req: ApiRequest): URLSearchParams {
  const url = (req as { url?: string }).url ?? "";
  const start = url.indexOf("?");
  return new URLSearchParams(start === -1 ? "" : url.slice(start + 1));
}

export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  applyCors(req, res);
  if (handlePreflight(req, res)) return;
  if (!requireMethod(req, res, "GET")) return;

  const requestId = newRequestId();
  try {
    enforceRateLimit(`conversation:${clientKey(req)}`, RATE_LIMIT);
    const params = query(req);
    const after = Number(params.get("after") ?? 0);
    const thread = await readGuestThreadUpdates(
      params.get("conversationId"),
      Number.isFinite(after) ? after : 0,
      params.get("publicHotelId")?.trim() ?? ""
    );
    if (!thread) {
      throw new AiInvalidRequestError(
        "No concierge conversation with that id.",
        "This conversation has ended. Send a new message to start again."
      );
    }
    sendJson(res, 200, {
      handledBy: thread.handledBy,
      messages: thread.messages.map((m) => ({ id: m.id, role: m.role, text: m.text, at: m.at?.getTime() ?? 0 })),
      requestId,
    });
  } catch (error) {
    console.error("[conversation] failed", {
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
