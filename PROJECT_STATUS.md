# InnPilot AI Concierge: project status

**Single source of truth for implementation progress.** Scope:
[`MVP_SCOPE.md`](MVP_SCOPE.md) · Architecture: [`ARCHITECTURE.md`](ARCHITECTURE.md) ·
Decisions: [`DECISIONS.md`](DECISIONS.md) · Plan: [`MIGRATION_PLAN.md`](MIGRATION_PLAN.md).

Rule: nothing is ✅ without evidence from a check that was actually run.

Legend: ✅ verified · 🟡 implemented, not verified · ❌ not done · ⛔ blocked

_Last updated: 2026-09-16 — Phase 9 (Groq free-plan migration, D31) done: the full golden path booked a real reservation through **live Groq** in a browser. Open items are account-level: every production/deploy step (gated)._

The status of the pre-restructure build (the single-hotel product) is archived at
[`docs/history/PROJECT_STATUS-pre-restructure-2026-09-16.md`](docs/history/PROJECT_STATUS-pre-restructure-2026-09-16.md).

## Baseline before restructuring

| Check | Result |
| --- | --- |
| `FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npx vitest run` (2026-09-16 18:17) | ✅ 18 files, 354 tests passed |

## Phases

| Phase | Status |
| --- | --- |
| 0 Audit + docs | ✅ |
| 1 Public experience | ✅ |
| 2 Gemini tool layer | ✅ automated · ✅ live Gemini turns 1–2 · ⛔ live turns 3–4 (quota) |
| 3 Multi-hotel search | ✅ |
| 4 Selection + booking conversation | ✅ |
| 5 Real reservation creation | ✅ |
| 6 Inbox + handoff | ✅ |
| 7 End-to-end verification | ✅ browser 37/37 (stand-in model) · ✅ live Gemini turns 1–2 |
| 8 Build + deployment readiness | ✅ locally · ⛔ deploy gated |
| 9 Groq free-plan provider (D31) | ✅ automated · ✅ **live Groq golden path, search → reservation** |

## Phase 0 — audit

| Item | Status | Evidence |
| --- | --- | --- |
| Repository audited; findings, reuse and obsolete items recorded | ✅ | `MIGRATION_PLAN.md` "Starting point" |
| Architecture, scope, decisions D23–D30 | ✅ | `ARCHITECTURE.md`, `MVP_SCOPE.md`, `DECISIONS.md` |
| Previous status and scope archived, not overwritten | ✅ | `docs/history/` |

## Phase 2 — Gemini tool layer (D25, D27)

| Item | Status | Evidence |
| --- | --- | --- |
| Six tools: `search_hotels`, `check_availability`, `get_hotel_info`, `calculate_stay_price`, `prepare_booking`, `create_reservation`; none takes a hotelId | ✅ | `server/ai/tools/`; `tests/server/tools.test.ts` "offers exactly the six concierge tools" |
| Network context: listed hotels only, or exactly one hotel on its own link; public ids only | ✅ | `server/network.ts`; `tests/server/tenantIsolation.test.ts` (22) |
| Concierge system instruction: identity, mission, the 12 rules, booking protocol, date resolution | ✅ | `server/ai/prompts/concierge.ts`; gateway test asserts identity line |
| No example prices in the prompt that a model could copy | ✅ | placeholders only |
| Gateway: allow-listed `search` / `availability` / `quote` / `booking` cards; no hotelId to guest or model | ✅ | `api/ai/concierge.ts`; golden-path test scans every response and model request |
| Real Gemini conversation | ✅ turns 1–2 · ⛔ turns 3–4 | Two runs 2026-09-16 with the real key: the exact demo request → `search_hotels` with 10–15 Oct, Western Uganda, Double → 3 real options (Fort Portal 850,000 · Kabale 900,000 · Mbarara Deluxe Double 1,050,000 UGX), then choosing option 1 → model asked for full name and phone. Turn 3 hit HTTP 429: first the 5/minute limit, then the 20/day free-tier limit (`GenerateRequestsPerDayPerProjectPerModel-FreeTier`). The concierge returned the guest-safe error and recorded the turn. |

## Phase 3 — multi-hotel search (D24)

| Item | Status | Evidence |
| --- | --- | --- |
| Destination matching on city / region / country ("Western Uganda" ≠ Kampala) | ✅ | `src/lib/hotelListing.ts`; `tests/unit/hotelListing.test.ts` |
| Availability from the shared `isRoomBookable()` over `accomodation` + `reservations` | ✅ | `server/ai/tools/inventory.ts` `offersFor()`; tools tests incl. numeric legacy room numbers |
| Price = nightly rate × nights; rooms with no rate never offered | ✅ | tools tests (Suite with rate 0 never offered) |
| Room type: exact for price/booking, "includes" for search ("double" finds "Deluxe Double") | ✅ | tools + unit tests |
| Capacity filter uses recorded capacity only | ✅ | "only offers rooms recorded as big enough for the party" |
| ≤ 5 options, ≤ 2 per hotel, ranked by type match → fit → price | ✅ | tools tests |
| No hotels in destination → served destinations; nothing free → no_availability; invalid/past dates → refused | ✅ | tools tests |
| Unlisted hotel and a listed hotel with a broken mapping never searchable | ✅ | tools + isolation tests |

## Phase 4 — selection and booking conversation (D27)

| Item | Status | Evidence |
| --- | --- | --- |
| `prepare_booking` validates name / phone / email, re-checks availability and price, writes nothing | ✅ | tools tests |
| `create_reservation` requires a summary from an EARLIER turn that matches, and an explicit yes | ✅ | tools tests (5 non-confirmations, 5 mismatches, stale summary); gateway "prepares and books in the same turn books nothing" |
| A client-forged history can't book | ✅ | isolation test |
| Confirmation detection is conservative (negations win) | ✅ | `tests/unit/hotelListing.test.ts` (18 cases) |
| **Mutation checks** — each guard removed temporarily, tests fail, restored | ✅ | explicit-yes: 6 failed · pending summary: 4 · summary match: 5 · listed filter: 7 · thread scope: 6 · price guard: 1 (2026-09-16) |

## Phase 5 — real reservation creation (D26)

| Item | Status | Evidence |
| --- | --- | --- |
| Books by room type; the existing single-room transaction per candidate, cheapest first | ✅ | `server/ai/tools/createReservation.ts` `bookRoom()` |
| `accomodation` doc via shared `buildBookingDoc()`, `source: "concierge"`, `quotedTotal`, guest email, audit entry, real `RSV-…` reference | ✅ | tools test "books the confirmed stay…" |
| Falls through to an equally priced room taken meanwhile | ✅ | tools test |
| Never books at a price the guest didn't confirm (`price_changed`) | ✅ | tools test |
| Room out of service / taken since the summary → not booked | ✅ | tools + gateway tests |
| 3 simultaneous confirmations for the last room → exactly one booking | ✅ | tools test |
| A booking made before the model's reply failed still reaches the guest | ✅ | gateway test (503 carries `booking`) |

## Phase 6 — inbox and handoff (D29)

| Item | Status | Evidence |
| --- | --- | --- |
| Canonical server-only thread `conciergeConversations/{id}` + per-hotel mirrors, back-filled on attach | ✅ | `server/guestConversations.ts`; golden-path test checks both mirrors and the canonical doc |
| Mirror fields: selection, selected hotel, booked elsewhere, closed; derived status New / Active / Booked / Closed | ✅ | `src/lib/conversations.ts`; unit tests |
| Hotel's own link: the guest is in that hotel's inbox from the first message | ✅ | `tests/server/conversations.test.ts` (23) |
| A thread is only continued / polled in the scope it started in | ✅ | conversation + gateway tests; mutation check |
| Staff take over at any attached hotel → no model call, holding reply in every mirror; poll merges staff replies; hand back resumes AI | ✅ | gateway "human handoff" test |
| Rules: listing fields, capacity, mirror fields validated; `conciergeConversations` client-denied | ✅ | `tests/rules` 144 passed |
| Inbox UI: status filter, status badge, selected-hotel badge, Close / Reopen | ✅ | browser run: row shows "Amina Okello · Web · AI · ⭐ VIP · Booked · K Hotels Kabale"; a guest who booked at another hotel shows Closed |

## Phase 1 — public experience (D23, D30)

| Item | Status | Evidence |
| --- | --- | --- |
| `/#/` AI Concierge home: "Find your stay with AI", explanation, large composer, the 4 suggested searches, participating properties from `/api/ai/network`, how-it-works | ✅ | browser checks; `src/pages/concierge/ConciergePage.tsx` |
| Result cards: hotel, location, room type, capacity, price/night, nights, total, availability, amenities, Choose | ✅ | browser checks |
| Booking summary card with Confirm / Change; "Booking Confirmed" card with reference, hotel, room, guest, dates, total | ✅ | browser checks + screenshots |
| `/#/c/:publicHotelId` scoped concierge; unknown id → safe not-found | ✅ | browser checks |
| No PMS navigation or workspace id anywhere on guest pages | ✅ | browser checks |
| Mobile 390px: no horizontal overflow | ✅ | browser check |
| Staff entry `/#/staff` (old landing, repositioned) with "Open your workspace"; `/pms`, `/get-started`, `/landing` redirect | ✅ | browser: workspace opens by id |
| Guest opening `/#/dashboard` is sent to `/#/staff` | ✅ | browser check |
| Settings → AI Concierge listing (listed, region, country, amenities, times, policies) | 🟡 | compiles; rules tested; not clicked through |

## Phase 7 — end-to-end verification

`scripts/verify/golden-path-ui.mjs`, Edge headless, real UI → real API → real tools → emulator:

| Run | Model | Result |
| --- | --- | --- |
| 1 and 2 (2026-09-16) | **real Gemini** | turns 1–2 all checks pass; turn 3 blocked by quota (see Phase 2) |
| 3 (2026-09-16) | scripted stand-in (`scripts/verify/fake-gemini.mjs`, only the model replaced) | ✅ **37/37**: home → demo request → 3 Western options → choose → details → summary (nothing booked) → Confirm → real `RSV-…` → staff opens Kabale workspace → reservation in Accommodation → inbox row Booked + selected hotel → take over → staff reply reaches guest → AI stays quiet → guest can't reach /dashboard → mobile → hotel link → not-found → no console errors |

Failure handling (automated, scripted Gemini + emulator): no hotels in destination, no availability, invalid/past dates, room taken between summary and yes, price changed, incomplete guest details, model books without summary or without yes, Gemini failure (503), Gemini timeout (504), a booking made before the reply failed still reaches the guest.

## Phase 9 — Groq free-plan migration (D31)

| Item | Status | Evidence |
| --- | --- | --- |
| `groq/compound-mini` evaluated as the brief asked | ❌ unusable | Groq docs: "Custom user-provided tools are not supported"; live request with `tools` → **HTTP 400 "`tool calling` is not supported with this model"**. Default is `openai/gpt-oss-120b` (same key: 30 RPM, 1K RPD, 8K TPM, read from `x-ratelimit-*` headers); Compound models refused as configuration error |
| Provider seam `AI_PROVIDER` (groq default, gemini kept) | ✅ | `server/ai/provider.ts`; `tests/unit/groq.test.ts` "provider selection" |
| Groq adapter: tool loop, one bounded retry, SDK retries off, 429 `retry-after`, timeout, malformed output, no key/body in logs | ✅ | `tests/unit/groq.test.ts` 28 tests; mutation checks: SDK retries on → 1 fail, 429 always retried → 1 fail, non-JSON args accepted → 2 fail, Compound allowed → 1 fail (all restored) |
| Gateway on Groq end to end (scripted Groq + emulator): golden path, confirmation barrier, missing key / 429 / timeout / invalid response / outage → safe response, no leak | ✅ | `tests/server/conciergeGroq.test.ts` 8 tests; removing the explicit-yes guard → 1 fail (restored) |
| Hotel by exact unique name within reachable hotels (live run 1 showed a re-search doubling turn cost) | ✅ | `tests/server/tools.test.ts`: name works, unlisted / broken / partial / other-hotel-on-scoped-link / duplicate names refused; create_reservation mismatch by another hotel's name refused |
| **Live Groq browser run 1** | ⚠️ 19/23 | turns 1–2 ✅; turn 3: model lacked the hotel id → `unknown_hotel` → re-search → 4th model call hit 429 retry-after 25s → safe message shown, nothing booked (behaved as designed). Led to the name-resolution fix |
| **Live Groq browser run 2** (`openai/gpt-oss-120b`, emulator, Edge) | ✅ **38/39** + fixed check ✅ | request → 3 Western options (Fort Portal 850,000 · Kabale 900,000 · Mbarara Deluxe Double 1,050,000 UGX; 10–15 Oct, 5 nights) → choose → name/phone → summary (Firestore: 0 reservations) → Confirm → `RSV-20260916-D5FA90` → staff Accommodation + inbox Booked → handoff → security/mobile/hotel link, no console errors. The one FAIL was the new Firestore check's own date arithmetic (stays are stored at 12:00Z); corrected and re-run against the stored row: ✅ 1 reservation, Confirmed, 10→15 Oct, 850,000, source concierge |
| `groq/compound-mini` re-tested as default (2026-09-17, owner request) | ❌ | built-in tools off + JSON text tool protocol: empty reply, then **5 invented hotels with USD prices**. Owner chose `openai/gpt-oss-120b` |
| Health endpoint returns only `{status, provider, configured}` | ✅ | `tests/unit/aiHealth.test.ts` (exact bodies for ok / unreachable / not_configured / error); `verify:vercel` asserts exactly those three keys |
| **Live Groq browser run 3** (2026-09-17, after health change) | ✅ **39/39** | same golden path, `RSV-20260917-55492F`, Firestore 0 before / 1 after confirmation, 0 retries, 0 failures |
| Live token cost | ✅ measured | tools per turn exactly: search_hotels · none · prepare_booking · create_reservation; input tokens 5,175 · 2,456 · 5,262 · 5,458; 7 requests; 0 retries |

## Phase 8 — build and deployment readiness

| Check (2026-09-16, after all changes) | Result |
| --- | --- |
| `FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npx vitest run` (2026-09-17) | ✅ 21 files, **498 tests** (457 before Groq; baseline 354) |
| `npm run lint` · `tsc -b` · `tsc -p tsconfig.server.json` | ✅ clean |
| `npm run build` (tsc app + node + server, vite) | ✅ |
| `npm run verify:release` | ✅ 11/11 — no Groq key (by value and any `gsk_…`), Gemini key, service account or private key in the bundle; `grep GROQ|gsk_|groq-sdk dist` empty |
| `npm run verify:vercel` (emulator) | ✅ 9/9 — all 5 functions bundle and answer; health reports `provider=groq model=openai/gpt-oss-120b`, no key in any bundle or response |
| Vercel deployment, `firestore.rules` deploy, production Firestore writes | ⛔ GATED — not done; needs explicit approval and account access |

## Production-readiness audit (2026-09-17)

| Check | Result |
| --- | --- |
| `npm test` (emulator running) | ✅ 21 files, 498 tests |
| `npm run lint` · `npm run build` | ✅ clean |
| `npm run verify:release` | ✅ 11/11 |
| `npm run verify:vercel` (emulator) | ✅ 9/9 — health `{"status":"ok","provider":"groq","configured":true}` |
| Credentials | ✅ `serviceAccountKey.json` moved outside the project; `.env`/`.env.*` and key-file patterns git-ignored; client calls only relative `/api/*` paths |
| Firebase rules deploy, Vercel deploy | ⛔ GATED — not done |

## Demo data (D28)

| Item | Status | Evidence |
| --- | --- | --- |
| `npm run seed:k-hotels` — 5 labelled demo properties, emulator only unless `--confirm-real-project` | ✅ | ran 2026-09-16 against emulator project `innpilot-demo` (workspace ids e.g. `KHotelsKabale0000001`) |
| Production Firebase project | ⛔ GATED | not written; needs explicit approval |

## Checks run on 2026-09-16 (after Phases 2–6, superseded by Phase 8 above)

| Check | Result |
| --- | --- |
| `npx tsc -p tsconfig.server.json --noEmit` | ✅ no errors |
| `FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npx vitest run tests/server tests/unit` | ✅ 13 files, 264 tests (before new unit tests) |
| `npx vitest run tests/unit` | ✅ 9 files, 182 tests |
| `FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npx vitest run tests/rules` | ✅ 5 files, 144 tests |

## Known issues

1. `serviceAccountKey.json` (production, `hotel-management-c183c`) was moved out of the project on 2026-09-17 (it was never committed). It is still a full-access key on the machine; revoke it when no longer needed.
2. A network conversation that never reaches search results (e.g. no hotel in the destination) is recorded canonically but appears in no hotel's inbox (D29).
3. A staff reply at one hotel is not copied into other hotels' mirrors of the same guest (D29).
4. Confirmation detection and lead scoring are English-only.
5. Groq free plan (D31): 8K tokens/minute means about one tool turn per 40 s across **all** guests; concurrent guests will get the safe "try again" message. 1K requests/day ≈ 140 full booking conversations.
6. The deployed rules have not changed on any real project; the new listing and mirror fields need the updated `firestore.rules` deployed (gated).
7. Settings → AI Concierge listing has not been clicked through in a browser.
8. `scripts/verify/concierge-live.ts` (`npm run verify:live`) predates the network restructure and was not re-run; the browser golden path is the live check.
9. Six old screenshots (`01-…06-*.png`) remain in the repository root from the previous build.

## Next actions (need the user)

1. Add `GROQ_API_KEY` (and optionally `AI_PROVIDER=groq`, `GROQ_MODEL=openai/gpt-oss-120b`) to the Vercel project's environment variables.
2. Decide the Firebase project for the demo; then deploy `firestore.rules` and run `npm run seed:k-hotels -- --confirm-real-project=<id>` (or list real hotels from Settings).
3. Vercel access to deploy (`DEPLOYMENT.md`).
4. ~~Move `serviceAccountKey.json` out of the project directory.~~ Done 2026-09-17.
