/**
 * What ships to the browser, checked before anything is deployed.
 *
 * The browser bundle is world-readable: anyone who loads the app can read
 * every byte of it. The one thing that must never be in there is a server
 * credential, and the one switch that must never survive a production build
 * is the emulator pointer — a deployed app talking to 127.0.0.1 looks, to a
 * hotel, exactly like an app with no data.
 *
 * This runs against `dist/`, so build first:
 *
 *   npm run build && node scripts/verify/release-check.mjs
 *
 * It checks for the real values from .env too, not just their names, so a
 * key that reached the bundle by any route at all is caught.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { config } from "dotenv";

config();

const ROOT = resolve(import.meta.dirname, "../..");
const DIST = join(ROOT, "dist");

const results = [];
const check = (name, pass, detail = "") => {
  results.push(pass);
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

function filesUnder(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? filesUnder(full) : [full];
  });
}

if (!existsSync(DIST)) {
  console.log("FAIL  dist/ exists — run `npm run build` first");
  process.exit(1);
}

const files = filesUnder(DIST);
const text = files.filter((f) => /\.(js|css|html|json|map)$/.test(f));
const named = (f) => f.slice(DIST.length + 1).replace(/\\/g, "/");
const contents = new Map(text.map((f) => [f, readFileSync(f, "utf8")]));
const findIn = (pattern) => text.filter((f) => pattern.test(contents.get(f)));

/* ---------------- Server-only names ---------------- */
const serverNames = /GROQ_API_KEY|GEMINI_API_KEY|FIREBASE_SERVICE_ACCOUNT|GOOGLE_APPLICATION_CREDENTIALS|VITE_FIRESTORE_EMULATOR_HOST/;
const withNames = findIn(serverNames);
check("no server-only environment name reaches the browser bundle", withNames.length === 0, withNames.map(named).join(", "));

/* ---------------- The emulator switch ---------------- */
const withEmulator = findIn(/127\.0\.0\.1:8080|localhost:8080|FIRESTORE_EMULATOR/);
check("no emulator host survives a production build", withEmulator.length === 0, withEmulator.map(named).join(", "));

/* ---------------- The actual secrets, by value ---------------- */
// Names can be renamed; values cannot. If .env holds real credentials, the
// strongest check available is that none of them appears in what ships.
const secrets = [
  ["GROQ_API_KEY", process.env.GROQ_API_KEY],
  ["GEMINI_API_KEY", process.env.GEMINI_API_KEY],
  ["FIREBASE_SERVICE_ACCOUNT", process.env.FIREBASE_SERVICE_ACCOUNT],
];
let checkedValues = 0;
for (const [name, value] of secrets) {
  if (!value || value.length < 12) continue;
  checkedValues++;
  const leaked = findIn(new RegExp(value.slice(0, 24).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  check(`the real ${name} value is nowhere in the bundle`, leaked.length === 0, leaked.map(named).join(", "));
}
if (checkedValues === 0) console.log("SKIP  value checks: no real credentials in .env to look for");

const privateKeys = findIn(/BEGIN (RSA )?PRIVATE KEY|"private_key"/);
check("no private key material ships", privateKeys.length === 0, privateKeys.map(named).join(", "));

/* ---------------- The one key that belongs here ---------------- */
// The Firebase Web API key is public by design: it identifies the project
// and is protected by firestore.rules, not by secrecy. Any OTHER Google key
// in the bundle is a mistake.
const publicWebKey = process.env.VITE_FIREBASE_API_KEY ?? "";
const googleKeys = new Set();
for (const body of contents.values()) for (const match of body.matchAll(/AIza[A-Za-z0-9_-]{20,}/g)) googleKeys.add(match[0]);
const unexpected = [...googleKeys].filter((key) => key !== publicWebKey);
check(
  "the only Google key in the bundle is the public Firebase Web key",
  unexpected.length === 0,
  unexpected.map((key) => `${key.slice(0, 10)}…`).join(", ")
);

// No Groq key belongs in the browser at all, whatever its value (D31).
const groqKeys = findIn(/gsk_[A-Za-z0-9]{20,}/);
check("no Groq API key, of any value, is in the bundle", groqKeys.length === 0, groqKeys.map(named).join(", "));

/* ---------------- Build hygiene ---------------- */
const maps = files.filter((f) => f.endsWith(".map"));
check("no source maps ship (they would republish the source)", maps.length === 0, maps.map(named).join(", "));

const assets = files.filter((f) => /\.(js|css)$/.test(f));
const unhashed = assets.filter((f) => !/-[A-Za-z0-9_-]{8}\.(js|css)$/.test(f));
check("every asset is content-hashed, so a deploy can't serve a stale one", unhashed.length === 0, unhashed.map(named).join(", "));

const html = contents.get(join(DIST, "index.html")) ?? "";
check(
  "the entry page is present and loads a hashed bundle",
  /<script[^>]+src="\.?\/assets\/[^"]+-[A-Za-z0-9_-]{8}\.js"/.test(html),
  html.match(/<script[^>]*>/)?.[0] ?? "no script tag"
);
check("the entry page points at no local development server", !/localhost|127\.0\.0\.1/.test(html));

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} release checks passed`);
process.exit(failed ? 1 : 0);
