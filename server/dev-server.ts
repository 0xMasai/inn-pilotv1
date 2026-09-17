/**
 * Local stand-in for Vercel's function runtime.
 *
 * `npm run dev` serves the app on :5173 and proxies /api to this process
 * (see vite.config.ts), so local development exercises the very same
 * handler files that deploy to Vercel — no mock gateway, no second code
 * path that can drift from production.
 *
 * The only thing it recreates is what the platform adds around a handler:
 * routing by pathname, and the `res.status().json()` helpers. Request
 * parsing stays in the handlers themselves, which is why they need no
 * adapter here.
 *
 * Run it with `npm run dev:api`, alongside `npm run dev` for the app.
 */
import { config } from "dotenv";
config(); // load .env before any module reads process.env

import http from "node:http";
import conciergeHandler from "../api/ai/concierge";
import healthHandler from "../api/ai/health";
import hotelHandler from "../api/ai/hotel";
import conversationHandler from "../api/ai/conversation";
import networkHandler from "../api/ai/network";
import type { ApiRequest, ApiResponse } from "./ai/http";

const PORT = Number(process.env.DEV_API_PORT ?? 3001);

/** The /api routes, exactly as Vercel derives them from api/**. */
const ROUTES: Record<string, (req: ApiRequest, res: ApiResponse) => Promise<void>> = {
  "/api/ai/concierge": conciergeHandler,
  "/api/ai/health": healthHandler,
  "/api/ai/hotel": hotelHandler,
  "/api/ai/conversation": conversationHandler,
  "/api/ai/network": networkHandler,
};

/** Gives a raw Node response the `status().json()` shape handlers expect. */
function asApiResponse(res: http.ServerResponse): ApiResponse {
  let statusCode = 200;
  return {
    setHeader: (name, value) => res.setHeader(name, value),
    status(code) {
      statusCode = code;
      return this;
    },
    json: (body) => {
      res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
    },
    end: () => {
      res.writeHead(statusCode);
      res.end();
    },
  };
}

const server = http.createServer((req, res) => {
  const pathname = (req.url ?? "").split("?")[0];
  const handler = ROUTES[pathname];
  const api = asApiResponse(res);

  if (!handler) {
    api.status(404).json({ error: `No API route for ${pathname}.` });
    return;
  }

  // `req` is an IncomingMessage, which already satisfies ApiRequest — the
  // handlers read the body from the stream themselves.
  handler(req as unknown as ApiRequest, api).catch((error: unknown) => {
    console.error("[dev-api] handler threw", error);
    try {
      api.status(500).json({ error: "The assistant is unavailable right now." });
    } catch {
      // Response already sent; nothing useful left to do.
    }
  });
});

server.listen(PORT, () => {
  console.log(`\n  InnPilot dev API`);
  console.log(`  ➜  http://localhost:${PORT}/api/ai/health`);
  console.log(`  ➜  http://localhost:${PORT}/api/ai/concierge  (POST)`);
  console.log(`  ➜  http://localhost:${PORT}/api/ai/network`);
  console.log(`  ➜  http://localhost:${PORT}/api/ai/hotel?publicHotelId=…`);
  const provider = (process.env.AI_PROVIDER ?? "groq").toLowerCase();
  const keyName = provider === "gemini" ? "GEMINI_API_KEY" : "GROQ_API_KEY";
  console.log(`  AI_PROVIDER: ${provider}`);
  console.log(`  ${keyName}: ${process.env[keyName] ? "set" : "NOT SET — add it to .env"}\n`);
});
