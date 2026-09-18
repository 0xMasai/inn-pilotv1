import type { HotelScope } from "../../hotels.js";
import type { NetworkContext } from "../../network.js";
import type { AiToolDefinition, AiToolResult, PendingBooking } from "../types.js";

/**
 * Everything a tool may know about the turn it runs in.
 *
 * `network` is the only route to hotel data: a tool resolves the public id
 * the model gave it through it and gets a HotelScope, or nothing.
 * `pendingBooking` is the summary the guest was shown in an EARLIER turn and
 * `guestMessage` is what they just wrote — together, what create_reservation
 * needs to know the guest actually agreed (DECISIONS D27).
 */
export interface ToolContext {
  network: NetworkContext;
  guestMessage: string;
  pendingBooking: PendingBooking | null;
  now: Date;
}

/**
 * A concierge tool: what the model sees, and how it runs. Arguments come
 * from the model and are untrusted input.
 */
export interface ConciergeTool {
  definition: AiToolDefinition;
  run(context: ToolContext, args: Record<string, unknown>): Promise<AiToolResult>;
}

/** Test failure with `hotel.ok === false`, not `!hotel.ok`: Vercel type-checks with strict off, where only the former narrows. */
export type HotelArg = { ok: true; scope: HotelScope } | { ok: false; result: AiToolResult };

/** Resolves the `hotel` argument, or the one result every unreachable id gets. */
export async function readHotelArg(context: ToolContext, args: Record<string, unknown>): Promise<HotelArg> {
  const raw = typeof args.hotel === "string" ? args.hotel.trim() : "";
  const scope = raw ? await context.network.resolve(raw) : null;
  if (scope) return { ok: true, scope };
  return {
    ok: false,
    result: {
      error: "unknown_hotel",
      message:
        "That hotel isn't one you can use. Use the exact `hotel` value or hotel name from a search_hotels result; " +
        "if you don't have either, search again.",
    },
  };
}

/** The guest-facing place of a hotel, the same way in every tool result. */
export function placeOf(scope: HotelScope) {
  return {
    hotel: scope.publicId,
    hotelName: scope.profile.name,
    city: scope.profile.location,
    region: scope.profile.region,
  };
}
