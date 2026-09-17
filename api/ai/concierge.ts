/**
 * POST /api/ai/concierge — the guest-facing AI gateway.
 *
 * HTTP concerns only: method, CORS, rate limit, input validation, status
 * codes. Every decision that matters lives below it — which hotels a
 * conversation may reach in `server/network.ts`, the tools in
 * `server/ai/tools`, the prompt in `server/ai/prompts/concierge.ts`, the
 * model loop behind `server/ai/provider.ts` (Groq by default), the conversation record in
 * `server/guestConversations.ts`.
 *
 * This endpoint takes no login, by design: a guest has no account. What
 * protects it is everything else — an in-memory rate limit, a validated and
 * length-capped payload, a server-held API key the browser never sees, tools
 * that only reach hotels the conversation may reach, and a booking that
 * needs a confirmed summary (DECISIONS D27).
 *
 * With no `publicHotelId` the guest is talking to the network concierge
 * (every listed hotel). With one — a hotel's own concierge link — only that
 * hotel. A workspace hotelId is never accepted and never sent back (D2, D14).
 */
import { generate } from "../../server/ai/provider";
import { conciergeSystemPrompt } from "../../server/ai/prompts/concierge";
import { enforceRateLimit } from "../../server/ai/rateLimit";
import { createToolbox } from "../../server/ai/tools";
import {
  openGuestThread,
  recordGuestTurn,
  scopesFor,
  threadHandledBy,
  type GuestThread,
  type GuestTurn,
} from "../../server/guestConversations";
import type { HotelScope } from "../../server/hotels";
import { createNetworkContext, type NetworkContext } from "../../server/network";
import { isTurnId } from "../../server/conversations";
import { HUMAN_HOLDING_REPLY } from "../../src/lib/conversations";
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
  readJsonBody,
  requireMethod,
  sendJson,
  type ApiRequest,
  type ApiResponse,
} from "../../server/ai/http";
import type {
  AiMessage,
  AiToolExecutor,
  AiToolResult,
  ConciergeAvailability,
  ConciergeBooking,
  ConciergeOption,
  ConciergeQuote,
  ConciergeReply,
  ConciergeSearch,
  PendingBooking,
  TurnTrace,
} from "../../server/ai/types";

/** Generous for a person typing, restrictive for a script. */
const RATE_LIMIT = { limit: 12, windowMs: 60_000 };

const MAX_MESSAGE_CHARS = 2_000;
/** Turns of history accepted from the client, newest kept. */
const MAX_HISTORY_TURNS = 12;

function requireMessage(body: Record<string, unknown>): string {
  const value = body.message;
  if (typeof value !== "string" || !value.trim()) {
    throw new AiInvalidRequestError(
      "'message' is required.",
      "I didn't catch that — could you type your question again?"
    );
  }
  if (value.length > MAX_MESSAGE_CHARS) {
    throw new AiInvalidRequestError(
      `'message' exceeds ${MAX_MESSAGE_CHARS} characters.`,
      "That message is a bit long for me. Could you shorten it?"
    );
  }
  return value.trim();
}

/**
 * The client's transcript, sanitised.
 *
 * Anything here is untrusted: a caller can forge an "assistant" turn. That is
 * tolerable for conversational context and no more — every fact comes from a
 * tool that re-reads the hotels' data, and a booking needs a summary the
 * SERVER recorded in an earlier turn, so a forged turn can't book or price
 * anything. Malformed turns are skipped rather than rejected.
 */
function readHistory(body: Record<string, unknown>): AiMessage[] {
  if (!Array.isArray(body.history)) return [];

  const turns: AiMessage[] = [];
  for (const entry of body.history) {
    if (!entry || typeof entry !== "object") continue;
    const { role, content } = entry as { role?: unknown; content?: unknown };
    if (role !== "user" && role !== "assistant") continue;
    if (typeof content !== "string" || !content.trim()) continue;
    turns.push({ role, content: content.slice(0, MAX_MESSAGE_CHARS) });
  }
  return turns.slice(-MAX_HISTORY_TURNS);
}

/* ------------------------------------------------------------------ */
/* What crosses to the browser                                          */
/* ------------------------------------------------------------------ */

/*
 * Allow-lists: only the named fields cross to the browser, so a field added to
 * a tool result later (say, guidance for the model) is never published by
 * accident.
 */

function pickSearch(result: AiToolResult): ConciergeSearch {
  const options = (result.options as ConciergeOption[]).map(
    (option): ConciergeOption => ({
      optionNumber: Number(option.optionNumber),
      hotel: String(option.hotel),
      hotelName: String(option.hotelName),
      city: String(option.city ?? ""),
      region: String(option.region ?? ""),
      roomType: String(option.roomType),
      capacity: typeof option.capacity === "number" ? option.capacity : null,
      availableRooms: Number(option.availableRooms),
      nightlyRate: Number(option.nightlyRate),
      nights: Number(option.nights),
      stayTotal: Number(option.stayTotal),
      currency: String(option.currency),
      amenities: Array.isArray(option.amenities) ? option.amenities.map(String) : [],
      matchesRequestedRoomType: option.matchesRequestedRoomType !== false,
    })
  );
  return {
    destination: String(result.destination ?? ""),
    checkIn: String(result.checkIn),
    checkOut: String(result.checkOut),
    nights: Number(result.nights),
    roomType: String(result.roomType ?? ""),
    guests: typeof result.guests === "number" ? result.guests : null,
    hotelsSearched: Number(result.hotelsSearched),
    options,
  };
}

function pickAvailability(result: AiToolResult): ConciergeAvailability {
  const types = result.roomTypes as ConciergeAvailability["roomTypes"];
  return {
    hotel: String(result.hotel),
    hotelName: String(result.hotelName),
    city: String(result.city ?? ""),
    checkIn: String(result.checkIn),
    checkOut: String(result.checkOut),
    nights: Number(result.nights),
    currency: String(result.currency),
    totalAvailable: Number(result.totalAvailable),
    roomTypes: types.map((type) => ({
      roomType: String(type.roomType),
      availableRooms: Number(type.availableRooms),
      capacity: typeof type.capacity === "number" ? type.capacity : null,
      nightlyRate: Number(type.nightlyRate),
      stayTotal: Number(type.stayTotal),
    })),
  };
}

function pickQuote(summary: ConciergeQuote): ConciergeQuote {
  return {
    hotel: String(summary.hotel),
    hotelName: String(summary.hotelName),
    city: String(summary.city ?? ""),
    roomType: String(summary.roomType),
    checkIn: String(summary.checkIn),
    checkOut: String(summary.checkOut),
    nights: Number(summary.nights),
    numberOfGuests: Number(summary.numberOfGuests),
    guestName: String(summary.guestName),
    guestPhone: String(summary.guestPhone),
    guestEmail: String(summary.guestEmail ?? ""),
    nightlyRate: Number(summary.nightlyRate),
    totalPrice: Number(summary.totalPrice),
    currency: String(summary.currency),
  };
}

function pickBooking(booking: ConciergeBooking): ConciergeBooking {
  return {
    reservationId: String(booking.reservationId),
    hotel: String(booking.hotel),
    hotelName: String(booking.hotelName),
    city: String(booking.city ?? ""),
    hotelPhone: String(booking.hotelPhone ?? ""),
    hotelEmail: String(booking.hotelEmail ?? ""),
    roomType: String(booking.roomType),
    checkIn: String(booking.checkIn),
    checkOut: String(booking.checkOut),
    nights: Number(booking.nights),
    numberOfGuests: Number(booking.numberOfGuests),
    guestName: String(booking.guestName),
    nightlyRate: Number(booking.nightlyRate),
    totalPrice: Number(booking.totalPrice),
    currency: String(booking.currency),
    paymentStatus: String(booking.paymentStatus),
  };
}

/* ------------------------------------------------------------------ */
/* One turn's outcome                                                   */
/* ------------------------------------------------------------------ */

/**
 * What this turn's tools did, gathered as they run: the cards for the page,
 * and the hotels, summary and booking for the conversation record.
 */
class TurnOutcome {
  search?: ConciergeSearch;
  availability?: ConciergeAvailability;
  quote?: ConciergeQuote;
  booking?: ConciergeBooking;
  pendingBooking?: PendingBooking | null;
  selected?: HotelScope;
  bookedScope?: HotelScope;
  bookedGuestPhone = "";
  readonly attach = new Map<string, HotelScope>();
  readonly quotedHotelIds = new Set<string>();

  private readonly network: NetworkContext;

  constructor(network: NetworkContext) {
    this.network = network;
  }

  private async scopeOf(publicId: unknown): Promise<HotelScope | null> {
    return this.network.resolve(publicId);
  }

  private add(scope: HotelScope | null, quoted = false): HotelScope | null {
    if (!scope) return null;
    this.attach.set(scope.hotelId, scope);
    if (quoted) this.quotedHotelIds.add(scope.hotelId);
    return scope;
  }

  /** A hotel's own concierge link: the guest is that hotel's guest from the first message. */
  focus(scope: HotelScope): void {
    this.add(scope);
    this.selected ??= scope;
  }

  async observe(name: string, args: Record<string, unknown>, result: AiToolResult): Promise<void> {
    if (name === "search_hotels" && result.status === "ok" && Array.isArray(result.options)) {
      this.search = pickSearch(result);
      for (const option of this.search.options) this.add(await this.scopeOf(option.hotel), true);
    }
    if (name === "check_availability" && Array.isArray(result.roomTypes)) {
      this.availability = pickAvailability(result);
      this.add(await this.scopeOf(result.hotel), this.availability.totalAvailable > 0);
    }
    if (name === "calculate_stay_price" && result.available === true) {
      this.add(await this.scopeOf(result.hotel), true);
    }
    if (name === "get_hotel_info" && typeof result.hotel === "string") {
      this.add(await this.scopeOf(result.hotel));
    }
    if (name === "prepare_booking" && result.status === "ready" && result.summary) {
      const summary = result.summary as ConciergeQuote;
      this.quote = pickQuote(summary);
      this.pendingBooking = { ...this.quote, preparedAt: Date.now() };
      this.selected = this.add(await this.scopeOf(summary.hotel), true) ?? this.selected;
    }
    if (name === "create_reservation" && result.status === "confirmed" && result.booking) {
      const booking = result.booking as ConciergeBooking;
      this.booking = pickBooking(booking);
      this.pendingBooking = null;
      this.quote = undefined;
      this.bookedScope = this.add(await this.scopeOf(booking.hotel), true) ?? undefined;
      this.selected = this.bookedScope ?? this.selected;
      this.bookedGuestPhone = typeof args.guestPhoneNumber === "string" ? args.guestPhoneNumber.trim().slice(0, 40) : "";
    }
  }

  /** The conversation record for this turn. */
  record(base: Pick<GuestTurn, "guestText" | "receivedAt" | "turnId" | "replyText">): GuestTurn {
    return {
      ...base,
      attach: [...this.attach.values()],
      quotedHotelIds: this.quotedHotelIds,
      ...(this.selected ? { selected: this.selected } : {}),
      ...(this.pendingBooking !== undefined ? { pendingBooking: this.pendingBooking } : {}),
      ...(this.booking && this.bookedScope
        ? {
            booking: {
              scope: this.bookedScope,
              reservationId: this.booking.reservationId,
              guestName: this.booking.guestName,
              guestPhone: this.bookedGuestPhone,
              nights: this.booking.nights,
              guests: this.booking.numberOfGuests,
              roomType: this.booking.roomType,
            },
          }
        : {}),
    };
  }
}

/**
 * The turn's latency split: network resolution (Firestore), each model call
 * (the configured provider) and each tool (Firestore through a scope). Whatever is left of
 * `totalMs` is the gateway itself.
 */
function timingOf(startedAt: number, resolveMs: number | undefined, trace: TurnTrace) {
  const modelMs = trace.modelCalls.reduce((sum, call) => sum + call.ms, 0);
  const toolMs = trace.toolCalls.reduce((sum, call) => sum + call.ms, 0);
  const totalMs = Date.now() - startedAt;
  return {
    totalMs,
    resolveMs,
    modelMs,
    toolMs,
    gatewayMs: totalMs - (resolveMs ?? 0) - modelMs - toolMs,
    modelCalls: trace.modelCalls,
    toolCalls: trace.toolCalls,
  };
}

export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  applyCors(req, res);
  if (handlePreflight(req, res)) return;
  if (!requireMethod(req, res, "POST")) return;

  const requestId = newRequestId();
  const startedAt = Date.now();
  // Where the turn's time goes, logged on success and failure alike.
  const trace: TurnTrace = { modelCalls: [], toolCalls: [] };
  let resolveMs: number | undefined;
  // Known once the thread is open: lets a failed turn still reach the inboxes.
  let thread: GuestThread | undefined;
  let outcome: TurnOutcome | undefined;
  let guestText = "";
  let turnId: string | undefined;

  try {
    enforceRateLimit(`concierge:${clientKey(req)}`, RATE_LIMIT);

    const body = await readJsonBody(req);
    if (!body) {
      throw new AiInvalidRequestError(
        "Request body must be a JSON object.",
        "Something went wrong sending that message. Please try again."
      );
    }
    if ("hotelId" in body) {
      // The workspace key never travels in a guest request (D14).
      throw new AiInvalidRequestError(
        "'hotelId' is not accepted; use 'publicHotelId' or nothing.",
        "I'm not sure which hotel this chat belongs to. Please reopen it from the hotel's page."
      );
    }

    const message = requireMessage(body);
    guestText = message;
    // Optional: lets a retried message be recognised rather than recorded twice.
    turnId = isTurnId(body.turnId) ? body.turnId : undefined;
    const history = readHistory(body);

    // The one place a request decides which hotels it may reach.
    const resolveStarted = Date.now();
    const network = await createNetworkContext(body.publicHotelId);
    const openThread = await openGuestThread(body.conversationId, network.scopedPublicId ?? "");
    thread = openThread;
    const attachedScopes = await scopesFor(openThread.hotelIds);
    const scopedHotel = network.scopedPublicId ? (await network.searchableHotels())[0] : undefined;
    resolveMs = Date.now() - resolveStarted;
    outcome = new TurnOutcome(network);
    if (scopedHotel) outcome.focus(scopedHotel);

    // A member of staff took this conversation over: the AI stays quiet.
    if ((await threadHandledBy(openThread, attachedScopes)) === "human") {
      await recordGuestTurn(openThread, {
        ...outcome.record({ guestText: message, receivedAt: startedAt, turnId, replyText: HUMAN_HOLDING_REPLY }),
        replyRole: "ai",
      });
      console.info("[concierge] handed to staff", { requestId, conversationId: openThread.id });
      const held: ConciergeReply = {
        reply: HUMAN_HOLDING_REPLY,
        model: "staff",
        requestId,
        conversationId: openThread.id,
        handledBy: "human",
      };
      sendJson(res, 200, held);
      return;
    }

    const turn = outcome;
    const toolbox = createToolbox(
      {
        network,
        guestMessage: message,
        // Only a summary recorded in an EARLIER turn can be confirmed (D27).
        pendingBooking: openThread.pendingBooking,
        now: new Date(startedAt),
      },
      requestId
    );
    const executeTool: AiToolExecutor = async (call) => {
      const result = await toolbox.execute(call);
      await turn.observe(call.name, call.args ?? {}, result);
      return result;
    };

    const generation = await generate({
      system: conciergeSystemPrompt({ hotelName: scopedHotel?.profile.name, now: new Date(startedAt) }),
      messages: [...history, { role: "user", content: message }],
      tools: toolbox.definitions,
      executeTool,
      trace,
    });

    // The guest already has their answer (and maybe a booking): a record that
    // fails to write is logged, never turned into a failed reply.
    await recordGuestTurn(
      openThread,
      turn.record({ guestText: message, receivedAt: startedAt, turnId, replyText: generation.text })
    ).catch((error: unknown) =>
      console.error("[concierge] conversation write failed", { requestId, conversationId: openThread.id, detail: errorMessage(error) })
    );

    const reply: ConciergeReply = {
      reply: generation.text,
      model: generation.model,
      requestId,
      conversationId: openThread.id,
      handledBy: "ai",
      ...(turn.search ? { search: turn.search } : {}),
      ...(turn.availability ? { availability: turn.availability } : {}),
      ...(turn.quote ? { quote: turn.quote } : {}),
      ...(turn.booking ? { booking: turn.booking } : {}),
    };

    console.info("[concierge] ok", {
      requestId,
      scopedPublicHotelId: network.scopedPublicId,
      conversationId: openThread.id,
      model: generation.model,
      tools: generation.toolCalls,
      hotelsAttached: turn.attach.size,
      ...(turn.booking ? { reservationId: turn.booking.reservationId } : {}),
      inputTokens: generation.usage.inputTokens,
      outputTokens: generation.usage.outputTokens,
      timing: timingOf(startedAt, resolveMs, trace),
    });

    sendJson(res, 200, reply);
  } catch (error) {
    // Guests get `guestMessage`; operators get the detail, in the log only.
    // Provider text can carry hotel data, so it never crosses this line.
    console.error("[concierge] failed", {
      requestId,
      code: isAiError(error) ? error.code : "unexpected",
      detail: errorMessage(error),
      timing: timingOf(startedAt, resolveMs, trace),
    });

    // A guest the assistant couldn't answer is exactly who staff need to see.
    // Tools may have run (and even booked) before the failure: keep that too.
    let conversationId: string | undefined;
    if (thread && guestText) {
      const failedThread = thread;
      conversationId = failedThread.id;
      const record = outcome
        ? outcome.record({ guestText, receivedAt: startedAt, turnId })
        : { guestText, receivedAt: startedAt, turnId };
      await recordGuestTurn(failedThread, record).catch((writeError: unknown) =>
        console.error("[concierge] conversation write failed", { requestId, detail: errorMessage(writeError) })
      );
    }

    const status = isAiError(error) ? error.status : 500;
    if (isRateLimitError(error)) {
      res.setHeader("Retry-After", String(error.retryAfterSeconds));
    }
    sendJson(res, status, {
      error: guestMessageFor(error),
      code: isAiError(error) ? error.code : "unexpected",
      requestId,
      ...(conversationId ? { conversationId } : {}),
      // A booking made before the reply failed is real: the guest must still see it.
      ...(outcome?.booking ? { booking: outcome.booking } : {}),
    });
  }
}
