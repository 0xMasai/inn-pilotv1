/**
 * The concierge's tools, bound to one guest turn.
 *
 * createToolbox() is the only way to get a runnable tool: it closes over the
 * turn's ToolContext, whose network context decides which hotels a public
 * id may resolve to (DECISIONS D25). No tool takes a hotelId argument, and
 * no result carries one.
 */
import { errorMessage } from "../errors";
import type { AiToolDefinition, AiToolExecutor } from "../types";
import { availabilityTool } from "./availability";
import { createReservationTool } from "./createReservation";
import { hotelInfoTool } from "./hotelInfo";
import { prepareBookingTool } from "./prepareBooking";
import { stayPriceTool } from "./price";
import { searchHotelsTool } from "./search";
import type { ConciergeTool, ToolContext } from "./types";

export const CONCIERGE_TOOLS: readonly ConciergeTool[] = [
  searchHotelsTool,
  availabilityTool,
  hotelInfoTool,
  stayPriceTool,
  prepareBookingTool,
  createReservationTool,
];

export interface Toolbox {
  definitions: AiToolDefinition[];
  execute: AiToolExecutor;
}

export function createToolbox(context: ToolContext, requestId = ""): Toolbox {
  return {
    definitions: CONCIERGE_TOOLS.map((tool) => tool.definition),

    async execute({ name, args }) {
      const tool = CONCIERGE_TOOLS.find((candidate) => candidate.definition.name === name);
      if (!tool) {
        return { error: "unknown_tool", message: `There is no tool named "${name}".` };
      }

      try {
        const result = await tool.run(context, args ?? {});
        // Outcome only: arguments carry guest details and stay out of logs.
        const booking = result.booking as { reservationId?: string } | undefined;
        console.info("[concierge] tool", {
          requestId,
          tool: name,
          outcome: result.status ?? result.error ?? "ok",
          ...(result.reason ? { reason: result.reason } : {}),
          ...(booking?.reservationId ? { reservationId: booking.reservationId } : {}),
        });
        return result;
      } catch (error) {
        console.error("[concierge] tool failed", { requestId, tool: name, detail: errorMessage(error) });
        return {
          error: "tool_failed",
          message:
            "The hotel system couldn't be reached, so nothing was checked or booked. Tell the guest you can't confirm " +
            "this right now and ask them to try again in a moment.",
        };
      }
    },
  };
}

export type { ToolContext } from "./types";
