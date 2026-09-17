/**
 * Does the API survive the way Vercel actually builds it?
 *
 * `npm run dev:api` runs the handlers through tsx, which resolves anything.
 * Vercel does not: it bundles each file under api/ with esbuild and runs the
 * single ESM artifact on Node, with the packages from package.json installed
 * beside it. `package.json` sets "type": "module", and api/ and server/ use
 * extensionless relative imports — the combination that broke the previous
 * AI layer on Vercel (PROJECT_STATUS, Deployment).
 *
 * So this bundles the handlers the same way, runs the bundles — not the
 * sources — behind a plain Node server, and makes real requests to them.
 * What it proves: every import resolves in a bundle, each function has the
 * default export the platform looks for, and the routes answer. What it
 * cannot prove: anything about Vercel's own infrastructure. That needs a
 * real deployment (DEPLOYMENT.md).
 *
 *   node scripts/verify/vercel-build.mjs
 *
 * With the emulator seeded (npm run seed:emulator), it also checks a real
 * hotel lookup through the bundle:
 *
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_PROJECT_ID=innpilot-ui-verify \
 *     node scripts/verify/vercel-build.mjs
 */
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import http from "node:http";
import { build } from "esbuild";
import { config } from "dotenv";

config();

const ROOT = resolve(import.meta.dirname, "../..");
const OUT = join(ROOT, ".vercel", "verify");
const PORT = Number(process.env.VERIFY_API_PORT ?? 3101);
const PUBLIC_ID = process.env.VERIFY_PUBLIC_ID ?? "k-hotels-kabale-kh26demo";

const results = [];
const check = (name, pass, detail = "") => {
  results.push(pass);
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

/** Every api/**\/*.ts, which is exactly what Vercel turns into a function. */
function handlerFiles(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return handlerFiles(full);
    return entry.endsWith(".ts") ? [full] : [];
  });
}

const sources = handlerFiles(join(ROOT, "api"));
const routeOf = (file) => `/${relative(ROOT, file).replace(/\\/g, "/").replace(/\.ts$/, "")}`;

let server;
try {
  rmSync(OUT, { recursive: true, force: true });

  /* ---------------- Build, the way the platform does ---------------- */
  await build({
    entryPoints: sources,
    outdir: OUT,
    outbase: join(ROOT, "api"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    // Dependencies are installed from package.json beside the function,
    // so they stay external; only our own source is bundled in.
    packages: "external",
    outExtension: { ".js": ".mjs" },
    logLevel: "silent",
  });
  check(`every function bundles for the Node runtime (${sources.length} of them)`, true);

  /* ---------------- Load the bundles, not the sources ---------------- */
  const routes = {};
  for (const source of sources) {
    const bundle = join(OUT, relative(join(ROOT, "api"), source).replace(/\.ts$/, ".mjs"));
    const loaded = await import(pathToFileURL(bundle).href);
    routes[routeOf(source)] = loaded.default;
  }
  const missing = Object.entries(routes).filter(([, handler]) => typeof handler !== "function");
  check(
    "each bundle exports the default handler the platform calls",
    missing.length === 0,
    missing.map(([route]) => route).join(", ")
  );

  // A bundled secret would ship the key to anyone who can read the artifact.
  const leaked = sources
    .map((source) => join(OUT, relative(join(ROOT, "api"), source).replace(/\.ts$/, ".mjs")))
    .filter((bundle) => {
      const code = readFileSync(bundle, "utf8");
      const realGroqKey = process.env.GROQ_API_KEY && process.env.GROQ_API_KEY.length >= 12 ? process.env.GROQ_API_KEY : null;
      return /AIza[A-Za-z0-9_-]{10}|gsk_[A-Za-z0-9]{20,}|BEGIN PRIVATE KEY/.test(code) || (realGroqKey !== null && code.includes(realGroqKey));
    });
  check("no credential is baked into a bundle", leaked.length === 0, leaked.join(", "));

  /* ---------------- Serve the bundles and call them ---------------- */
  const asApiResponse = (res) => {
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
  };

  server = http.createServer((req, res) => {
    const handler = routes[(req.url ?? "").split("?")[0]];
    const api = asApiResponse(res);
    if (!handler) return api.status(404).json({ error: "No such route." });
    handler(req, api).catch((error) => {
      console.error("[verify] handler threw", error);
      try {
        api.status(500).json({ error: "handler threw" });
      } catch {
        // Response already sent.
      }
    });
  });
  await new Promise((ready) => server.listen(PORT, ready));
  const call = async (path, init) => {
    const res = await fetch(`http://127.0.0.1:${PORT}${path}`, init);
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  const health = await call("/api/ai/health");
  check(
    "the built health endpoint answers and reports only status, provider and configured",
    [200, 503].includes(health.status) &&
      typeof health.body.configured === "boolean" &&
      typeof health.body.provider === "string" &&
      JSON.stringify(Object.keys(health.body).sort()) === JSON.stringify(["configured", "provider", "status"]) &&
      !(process.env.GROQ_API_KEY && JSON.stringify(health.body).includes(process.env.GROQ_API_KEY)),
    `${health.status} ${JSON.stringify(health.body)}`
  );

  const badId = await call("/api/ai/concierge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ publicHotelId: "no-such-hotel-00000000", message: "Hello" }),
  });
  // Resolving a hotel is a Firestore read, so which refusal is correct
  // depends on whether this run can reach a database: 400 "no such hotel"
  // when it can, 503 "can't reach the assistant" when there is no usable
  // credential. Both are right, and what matters either way is that a
  // bundled function answers at all, that a guest could be shown the
  // message, and that it carries no id and no stack trace.
  check(
    "the built concierge refuses an unknown hotel safely, with no model call",
    [400, 503].includes(badId.status) &&
      typeof badId.body.error === "string" &&
      !/hotelId|[A-Za-z0-9]{20}|Error:|\s+at\s+\S+:\d+/.test(JSON.stringify(badId.body)),
    `${badId.status} ${badId.status === 400 ? "unknown hotel" : "no database reachable"}`
  );

  const wrongMethod = await call("/api/ai/concierge");
  check("the built concierge rejects the wrong method", wrongMethod.status === 405, String(wrongMethod.status));

  const badThread = await call("/api/ai/conversation?conversationId=nope");
  check("the built polling endpoint refuses an unknown thread", badThread.status === 400, String(badThread.status));

  if (process.env.FIRESTORE_EMULATOR_HOST) {
    const hotel = await call(`/api/ai/hotel?publicHotelId=${PUBLIC_ID}`);
    check(
      "the built hotel endpoint reads Firestore and returns no internal id",
      hotel.status === 200 && typeof hotel.body.name === "string" && !JSON.stringify(hotel.body).includes("hotelId"),
      `${hotel.status} ${hotel.body.name ?? ""}`
    );
    const network = await call("/api/ai/network");
    check(
      "the built network endpoint lists participating hotels with no internal id",
      network.status === 200 && Array.isArray(network.body.hotels) && network.body.hotels.length > 0 && !/KHotels[A-Za-z]+\d+/.test(JSON.stringify(network.body)),
      `${network.status} ${network.body.hotels?.length ?? 0} hotels`
    );
  } else {
    console.log("SKIP  hotel lookup: set FIRESTORE_EMULATOR_HOST (and seed) to check it end to end");
  }
} catch (error) {
  check("the script ran to completion", false, String(error).replace(/\s+/g, " ").slice(0, 400));
} finally {
  if (server) await new Promise((closed) => server.close(closed));
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} Vercel build checks passed`);
process.exit(failed ? 1 : 0);
