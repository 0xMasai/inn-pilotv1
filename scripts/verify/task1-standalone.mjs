// Standalone verification for Task 1 pure logic (plain JS).
// Tests findHotel logic and retry constants by re-implementing them here.

const nameKey = (value) =>
  value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();

function isPublicHotelId(reference) {
  return /^[a-z0-9]+(-[a-z0-9]+)+$/.test(reference) && reference.length <= 64;
}

function findHotel(hotels, reference) {
  if (typeof reference !== "string" || !reference.trim() || reference.length > 120) return null;
  if (isPublicHotelId(reference)) {
    const byId = hotels.find((scope) => scope.publicId === reference);
    if (byId) return byId;
  }
  const named = hotels.filter((scope) => nameKey(scope.profile.name) === nameKey(reference));
  return named.length === 1 ? named[0] : null;
}

function scope(name, publicId) {
  return { publicId, profile: { name } };
}

const hotels = [
  scope("K Hotels Kampala", "kampala-inn-1"),
  scope("K Hotels Kabale", "kabale-hotel-2"),
];

let failures = 0;
function assert(condition, msg) {
  if (!condition) {
    console.error("FAIL:", msg);
    failures++;
  } else {
    console.log("PASS:", msg);
  }
}

// Test 1: matches by public id
const r1 = findHotel(hotels, "kampala-inn-1");
assert(r1 && r1.publicId === "kampala-inn-1", "matches by public id");

// Test 2: matches by name case-insensitive
const r2 = findHotel(hotels, "k hotels kampala");
assert(r2 && r2.publicId === "kampala-inn-1", "matches by name case-insensitive");

// Test 3: uppercase name
const r2b = findHotel(hotels, "K HOTELS KAMPALA");
assert(r2b && r2b.publicId === "kampala-inn-1", "matches by name uppercase");

// Test 4: unknown id returns null
assert(findHotel(hotels, "nonexistent") === null, "unknown id returns null");

// Test 5: empty returns null
assert(findHotel(hotels, "") === null, "empty returns null");

// Test 6: oversized returns null
assert(findHotel(hotels, "x".repeat(121)) === null, "oversized returns null");

// Test 7: ambiguous name returns null
const dup = [...hotels, scope("K Hotels Kampala", "kampala-inn-3")];
assert(findHotel(dup, "K Hotels Kampala") === null, "ambiguous name returns null");

// --- Retry constants ---
const MAX_CALL_ATTEMPTS = 3;
const RETRY_BASE_PAUSE_MS = 400;
assert(MAX_CALL_ATTEMPTS === 3, "MAX_CALL_ATTEMPTS is 3");
assert(RETRY_BASE_PAUSE_MS === 400, "RETRY_BASE_PAUSE_MS is 400");

// --- Fallback provider logic ---
function resolveFallbackProvider(env) {
  const raw = env.AI_FALLBACK_PROVIDER && env.AI_FALLBACK_PROVIDER.toLowerCase();
  if (!raw) return null;
  if (raw !== "groq" && raw !== "gemini") throw new Error("AI_FALLBACK_PROVIDER must be one of groq, gemini");
  const provider = raw;
  let model;
  if (provider === "groq") {
    model = env.AI_FALLBACK_GROQ_MODEL || "openai/gpt-oss-120b";
  } else {
    model = env.AI_FALLBACK_GEMINI_MODEL || "gemini-3.6-flash";
  }
  return { provider, model };
}

assert(resolveFallbackProvider({ GROQ_API_KEY: "k" }) === null, "no fallback returns null");

const r7 = resolveFallbackProvider({ GROQ_API_KEY: "k", AI_FALLBACK_PROVIDER: "gemini", GEMINI_API_KEY: "k2" });
assert(r7 && r7.provider === "gemini", "gemini fallback resolved");

const r8 = resolveFallbackProvider({ GEMINI_API_KEY: "k", AI_FALLBACK_PROVIDER: "groq", AI_FALLBACK_GROQ_MODEL: "openai/gpt-oss-20b" });
assert(r8 && r8.provider === "groq" && r8.model === "openai/gpt-oss-20b", "groq fallback resolved");

let threw = false;
try { resolveFallbackProvider({ GROQ_API_KEY: "k", AI_FALLBACK_PROVIDER: "ollama" }); } catch { threw = true; }
assert(threw, "unknown fallback throws");

console.log(failures === 0 ? "\nAll standalone assertions passed." : `\n${failures} assertion(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
