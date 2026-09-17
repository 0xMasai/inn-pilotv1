# InnPilot K Hotels AI Challenge build: project status

**This file is the single source of truth for implementation progress.**
Scope is defined in [`MVP_SCOPE.md`](MVP_SCOPE.md), architectural choices
in [`DECISIONS.md`](DECISIONS.md), and how each feature is verified in
[`TEST_PLAN.md`](TEST_PLAN.md).

Rule for this file: nothing is marked ✅ without evidence from the
repository or from a check that was actually run. Record the date and the
command.

Legend: ✅ implemented and verified · 🟡 implemented, not verified ·
❌ not implemented · ⛔ blocked

_Last updated: 2026-09-16 local — Phase 7 production readiness built and verified locally (the deployment itself is blocked on account access); Phase 6 Follow-ups built and verified; Phase 5 and Phase 4 re-verified alongside it; the Gemini daily quota had reset, so real Gemini answered guest turns in both browser runs; Phase 2 live verification still blocked on a billed key._

---

## Repository

| Item | Value |
| --- | --- |
| Repository | **No repository.** On 2026-09-16 the user asked for `rm -rf .git` with no backup and no re-initialization, after being shown that all Phase 2–6 work was uncommitted and that the baseline commit existed nowhere else. The working tree is now plain files under version control by nothing. `.gitignore` remains, so `.env` stays ignored whenever the project is initialized again. |
| Branch | None — see above. |
| Remote | None (`git remote -v` is empty). Nothing has been pushed or deployed. |
| Baseline commit | Gone. It was `0d9d471d79d966b330901ec34783a80585d931ea`, "chore: initialize InnPilot K Hotels AI build", and it was deleted with `.git`. There is no diff of the Phase 2–7 work against anything. |
| Working tree | Every phase below exists only as files on disk. There is no commit, no remote and no backup. |
| Excluded from Git (verified with `git status --ignored`) | `.env`, `dist/`, `release/`, `node_modules/`, `firestore-debug.log`, `tsc_output.txt`. |
| Previous repository's history | Not part of this repository. Kept only as a local backup outside the project, at `D:\0xStunna\InnPilot-legacy-git-backup-2026-09-15\.git`. That backup includes the local-only branch `backup/phase15-post-rebase`. |

## Current phase

**Phase 2 (AI foundation) + Phase 2B (public hotel resolution): ⛔ NOT
complete — blocked on two account-level items (see Blockers).**

Everything that can be done without them is implemented and passes its
automated tests. The real Gemini end-to-end flow was **partly** verified:
the per-day free-tier quota on the local Gemini key ran out before the
availability, booking and conflict conversations could run.

Real-integration attempt (TEST_PLAN §5 Part B, requested against the
production project): **not run.** `.env` is unchanged. It still holds the
free-tier Gemini key (a probe at 19:47 UTC returned HTTP 429) and a
service-account *email* rather than key JSON. No Firebase Admin credential
exists for any project. `npm run verify:live -- --real-firestore` is ready
and refuses to start without one.

**Phase 3 (Concierge UI): built, and verified against the real local API
except for the real-Gemini chat success path.** The user approved starting
Phase 3 ("test and proceed to phase 3") with Phase 2's live verification
still open. On 2026-09-15 at 20:27 UTC a single Gemini probe succeeded, but
the next calls hit the same daily limit (`limit: 20`). The service account
is still an email, not key JSON.

**Phase 4 (Unified Inbox): built and verified** against the real local API
and the Firestore emulator. This includes the full web hand-over loop,
which needs no Gemini.

**Phase 5 (Lead scoring): built and verified** — deterministic rules, no
model call (D20).

**Phase 6 (Follow-ups): built and verified** against the real local API and
the emulator (D21). On 2026-09-16 the Gemini daily quota had reset, so the
browser runs included **real Gemini answers to real guest questions**, which
closed one long-standing ⛔ row in the Phase 4 table. The credentials are
otherwise unchanged: the key is still the free-tier one (20 requests/day),
so `npm run verify:live` — which needs 35–45 calls — is still blocked.

## Status by area

### Phase 1: web app (workspace model, no accounts)

| Item | Status | Evidence |
| --- | --- | --- |
| Routes for Dashboard, Accommodation, Restaurant, Bar (4 screens), Parking, Expenses, Reports, Settings | ✅ | `src/App.tsx`; `npm run build` emits a chunk per route |
| Retired routes redirect (`/login`, `/signup`, `/book-demo`, `/admin/*`, `/super-admin/*`, `/profile`) | ✅ | `src/App.tsx`; no auth code in `src/` |
| Get Started wizard creates the workspace, its starting rooms **and its public id** | ✅ (rules + unit) / 🟡 (browser) | `src/lib/onboarding.ts`; rules test "onboarding can create the hotel with its public id and mapping in one batch". Not clicked through in a browser. |
| Module UIs behave correctly in a browser | 🟡 | Builds and type-checks. Not clicked through. |
| Electron desktop build of the current code | 🟡 | Not rebuilt. |

### Phase 2B: public hotel identity (DECISIONS D14)

| Item | Status | Evidence |
| --- | --- | --- |
| Public id format: name slug + 8 random chars, lowercase, hyphenated, never a 20-char hotelId | ✅ | `src/lib/publicHotel.ts`; `tests/unit/publicHotel.test.ts` |
| `publicHotels/{publicId} → {hotelId}` mapping + set-once `hotels/{hotelId}.publicId`, bound both ways by the rules; mapping unreadable by clients | ✅ | `firestore.rules`; 20 new cases in `tests/rules/workspace.test.ts` (hijack, repoint, takeover, malformed ids, read/list/delete denied, set-once) |
| Onboarding writes the public id and mapping in the same batch as the hotel | ✅ (rules + unit) | `src/lib/onboarding.ts`; `tests/unit/onboarding.test.ts` "createWorkspace" (one batch, matching ids, unique per workspace, nothing written on invalid input) |
| Newly created hotels always get a public id | ✅ | `createWorkspace()` is the only code that creates a hotel document (repo-wide search) |
| Legacy hotels (no public id) migration | 📄 documented | DECISIONS D16: one Admin SDK batch per hotel. No script shipped; running it on a real project needs approval. |
| Centralized `resolveHotel(publicId)`: follows the mapping, requires the hotel to claim the id back, rejects internal hotelIds | ✅ | `server/hotels.ts`; `tests/server/tenantIsolation.test.ts`, `tests/server/tools.test.ts` |
| `POST /api/ai/concierge` accepts `publicHotelId` only; never returns a hotelId | ✅ | `api/ai/concierge.ts`; tests assert no internal id in any response or model request |
| AI tools receive the resolved scope and cannot be redirected by `hotelId`/`publicHotelId` in model arguments | ✅ | `tests/server/tenantIsolation.test.ts` "A Hotel A request cannot access Hotel B" |
| Invalid public ids fail safely: one guest message, 400, no model call, no id leak | ✅ | Automated (13 cases incl. planted mapping, ghost hotel, internal id) and over HTTP via the dev server (see Checks) |
| Tenant isolation: A → A data, B → B data, A cannot reach B (same room number in both hotels) | ✅ | `tests/server/tenantIsolation.test.ts` |
| Mutation check: removing the reciprocal-claim guard in the rules or in `resolveHotel()` makes the tests fail | ✅ | Each guard removed temporarily on 2026-09-15; exactly the intended test failed; restored |
| UI to show a hotel's public id / add one to a workspace created before public ids | ✅ | Settings card; verified in Phase 4 (see the Phase 4 table) |
| Per-hotel concierge on/off switch | ❌ | Still deferred (D13, D14) |

### Phase 2: AI concierge (server tool layer)

| Item | Status | Evidence |
| --- | --- | --- |
| `POST /api/ai/concierge`: CORS, rate limit, payload caps, guest-safe errors | ✅ | `api/ai/concierge.ts`; `tests/server/concierge.test.ts`; HTTP checks via dev server |
| `GET /api/ai/health` (config report) | ✅ | `tests/unit/aiHealth.test.ts`; live HTTP 200 via dev server |
| `GET /api/ai/health?probe=1` false negative fixed (D15) | ✅ | Reproduced against real Gemini: 16-token call → `MAX_TOKENS`, 12 thought tokens, no text. After fix, real probe → `reachable: true` (finish `MAX_TOKENS`); invalid key → `false`; unknown model → `false`; quota exhausted → `false` / HTTP 503. Unit tests cover all cases. |
| `API_KEY_INVALID` (HTTP 400 from Google) classified as configuration error | ✅ | `server/ai/gemini.ts`; `tests/unit/aiHealth.test.ts` |
| Tools `get_hotel_info`, `check_availability`, `get_room_rates`, `create_reservation` against the emulator via Firebase Admin | ✅ | `tests/server/tools.test.ts` (Gemini not involved) |
| Booking integrity: `isRoomBookable`/`checkRoomBookable`, `buildBookingDoc`, `makeReservationId`, Admin transaction with availability re-check, `source: "concierge"`, audit entry, persistence | ✅ | `tests/unit/booking.test.ts`; `tests/server/tools.test.ts` ("of two simultaneous bookings exactly one wins", "re-checks at booking time", audit + persisted fields) |
| Booking conflict: second attempt on an unavailable room rejected safely | ✅ (automated, scripted model) / ⛔ (real Gemini) | Automated: 3 concurrent attempts → 1 confirmed, 2 `dates_taken`, 1 document. Real-model conversation not run (quota). |
| **Real Gemini → tool → Firebase Admin → Firestore → Gemini → reply** | 🟡 partial | 2026-09-15, `npm run verify:live` run 1, emulator: *"What kinds of rooms do you have and what do they cost per night?"* → HTTP 200 in 8.5 s; Gemini called `get_hotel_info` and `get_room_rates`; reply quoted exactly the seeded rates (Single 150,000; Double 220,000–240,000; Suite 420,000 UGX). |
| Real Gemini: hotel information answer | ⛔ | One attempt hit the 25 s turn timeout (504, guest-safe); re-run blocked by quota. `get_hotel_info` *was* invoked by the real model in the rates turn above. |
| Real Gemini: availability, reservation creation, conflict, audit, cross-hotel attempt | ⛔ | Blocked: Gemini free-tier quota (Blocker 1). Procedure and assertions ready in `scripts/verify/concierge-live.ts`. |
| Real Firebase project (TEST_PLAN §5 Part B) | ⛔ | Blocker 2. `--real-firestore` mode ready: needs key JSON plus `LIVE_VERIFY_PROJECT` confirmation; fresh random test hotels; `create()` only; no deletes; lists every document it created. Refusals verified (email credential, emulator host set, non-local emulator). |
| Turn latency trace: resolve / each model call / each tool / gateway, logged on success and failure (D17) | ✅ | `api/ai/concierge.ts`, `server/ai/gemini.ts`; `tests/server/concierge.test.ts` (trace on success; hanging model → 504 guest-safe body, trace shows the model call failed with `timeout`) |
| Latency outside Gemini measured | ✅ (emulator) | 15 turns per case, first 3 dropped. Median/p90 totals with an instant model: hotel info 32/48 ms (resolve 31, tool 0); rates 59/89 ms; availability with 0 bookings 56/75 ms; with 500 bookings 116/306 ms (tool 85/228). Production Firestore adds network latency, not seconds. |
| `GEMINI_THINKING_LEVEL` optional setting | ✅ (unit) / ⛔ (live benefit unmeasured) | `server/ai/config.ts`; `tests/unit/aiHealth.test.ts`. Unset leaves behaviour unchanged. |
| Secrets not logged or returned | ✅ | `verify:live` checks (key and service-account value absent from all captured logs and responses); dev-server log grep for `AIza` → 0 |
| Concierge UI | ❌ | Phase 3 |

### Phase 3: guest concierge UI (DECISIONS D18)

| Item | Status | Evidence |
| --- | --- | --- |
| Route `/#/c/:publicHotelId` (HashRouter) | ✅ | `src/App.tsx`; browser check |
| `GET /api/ai/hotel`: public details + room rates, no hotelId or private fields, safe 400s | ✅ | `api/ai/hotel.ts`; `tests/server/hotel.test.ts` (7 tests); live via Vite proxy |
| Concierge reply carries allow-listed `availability` / `booking` from tool results | ✅ (scripted model) | `api/ai/concierge.ts`; `tests/server/concierge.test.ts` |
| Hotel header, rooms & rates, contact, welcome and suggestions from the real API | ✅ | `scripts/verify/concierge-ui.mjs` against dev API + emulator (Edge, headless) |
| Date checker: validation, sends a plain-language question, public id only | ✅ | Same script |
| Failure state: guest-safe error, Try again, "Not delivered", composer re-enabled | ✅ (real) | A real `POST /api/ai/concierge` returned 503 (Gemini quota) and the UI handled it |
| Conversation survives reload; New chat clears it | ✅ | Same script |
| Mobile (390×844): quick-actions toggle, no horizontal overflow | ✅ | Same script + screenshots. Found and fixed a stretched grid gap. |
| Not-found screen for unknown ids and internal hotelIds | ✅ | Same script |
| Availability cards and booking confirmation render (desktop + mobile) | 🟡 render check only | 16/16 checks with a Playwright-supplied reply in the real handler's shape. **Not end to end.** |
| Settings "Guest AI Concierge" card (show, copy, open, create link for an older workspace) | ✅ | Verified in Phase 4 against the emulator (`scripts/verify/inbox-ui.mjs`) |
| **Real guest flow: question → availability → book → confirmation with real Gemini** | 🟡 partial | 2026-09-16, `scripts/verify/concierge-ui.mjs`: the date checker sent a real availability question and **a real Gemini reply rendered in the browser** (200). The script asserts a reply, not availability cards or a booking, so the card → book → confirmation path is still unverified end to end. |
| No server code or secret names in the browser bundle | ✅ | grep over `dist/assets/*.js` |
| Chat state and markdown rendering | ✅ | `tests/unit/concierge.test.ts` (13 tests) |

### Phase 4: unified inbox (DECISIONS D19)

| Item | Status | Evidence |
| --- | --- | --- |
| Conversation model + append-only messages, enums enforced by rules | ✅ | `src/lib/conversations.ts`, `firestore.rules`; `tests/rules/conversations.test.ts` (22) |
| Gateway records each web turn (including failed AI turns); returns `conversationId`; booking progress none → quoted → booked with the guest's name | ✅ (scripted model) | `server/conversations.ts`, `api/ai/concierge.ts`; `tests/server/conversations.test.ts` |
| Human take-over: no model call, holding reply, guest message recorded | ✅ | Server tests; browser: `model: "staff"`, 200 |
| `GET /api/ai/conversation` for staff replies (cursor, isolation, no hotelId) | ✅ | Server tests (5) |
| Inbox screen: rows show guest, latest message, channel, AI/Human, lead score, booking status | ✅ | `src/pages/inbox/`; `scripts/verify/inbox-ui.mjs` |
| Mocked WhatsApp / Instagram / Email sample threads, labelled simulated | ✅ | Same script |
| Channel filter, search, newest first | ✅ | Same script + `tests/unit/conversations.test.ts` |
| Take over → reply → return to AI | ✅ | Same script |
| **Web loop: real guest → inbox live → staff take over → holding reply → staff reply shown on the guest page (5.3 s) → hand back clears the notice** | ✅ | Same script, real API + emulator. The first guest turn hit the Gemini quota (503) and still reached the inbox. |
| Mobile inbox (390 px): list → thread → back, no overflow | ✅ | Same script + screenshot |
| Another hotel's inbox shows none of these conversations | ✅ | Same script (rules + path scoping) |
| Phase 3 Settings concierge link: shown for a published hotel; created for a hotel without one; resolves via API | ✅ | Same script (was 🟡) |
| Dev-only emulator switch for the app (`VITE_FIRESTORE_EMULATOR_HOST`), absent from the production bundle | ✅ | `firebase.ts`; grep over `dist/assets` |
| Staff stepping in with a reply before the guest writes again reaches the guest page (13.5 s) | ✅ | Same script (fixed in review: the page polls while the AI handles the chat too) |
| A retried guest message leaves one copy in the inbox | ✅ | Same script + `tests/server/conversations.test.ts` (fixed in review: `turnId`) |
| A staff reply written during a model call keeps its place and its count | ✅ | `tests/server/conversations.test.ts` (fixed in review: the turn is recorded in a transaction) |
| Phase 3 concierge checks re-run after the Phase 4 changes | ✅ | `scripts/verify/concierge-ui.mjs` 22/22 |
| AI answering web guests with real Gemini inside the inbox | ✅ | 2026-09-16, `scripts/verify/inbox-ui.mjs`: a real guest asked "What rooms do you have and what do they cost?" on `/#/c/…`; Gemini answered 200 with the seeded rates (Single 150,000; Double 220,000–240,000 UGX), and the turn was recorded in the inbox and scored 🌤 Warm |

### Phase 5: lead scoring (DECISIONS D20)

| Item | Status | Evidence |
| --- | --- | --- |
| Deterministic rules, no model call: 🔥 Hot, 🌤 Warm, ❄ Cold, ⭐ VIP | ✅ | `src/lib/leadScoring.ts`; `tests/unit/leadScoring.test.ts` (20) |
| Signals read from the guest's own words: booking intent, dates, prices, contact details, group or long stay, occasion, suite | ✅ | Unit tests, including "three nights" in words and an ISO date that must not read as a phone number |
| Signals accumulate across turns; a confirmed booking counts for itself | ✅ | Unit + server tests (warm on dates and prices → hot on asking to book, earlier signals still counted) |
| Every score carries its reasons (capped at 8), in the badge and at the top of the thread | ✅ | `src/pages/inbox/parts.tsx`; browser check reads them back |
| The gateway scores each web turn inside the recording transaction, including turns the AI failed | ✅ | `server/conversations.ts`; server tests; browser: a real guest scored 🌤 Warm on a turn Gemini refused (503) |
| Sample threads scored by the same rules: 🌤 Warm, 🔥 Hot, ⭐ VIP | ✅ | `src/lib/inbox.ts`; browser checks |
| Inbox filters by score, with counts, alongside channel filter and search | ✅ | `scripts/verify/inbox-ui.mjs`; `tests/unit/conversations.test.ts` |
| `lead` validated by rules (four scores, ≤ 8 reasons, no extra keys) | ✅ | `firestore.rules`; `tests/rules/conversations.test.ts` (3 new) |
| Conversations recorded before Phase 5 read "not scored" until their next message | ✅ by design | D20; nothing backfills |

### Phase 6: follow-ups (DECISIONS D21)

| Item | Status | Evidence |
| --- | --- | --- |
| Deterministic rules, no model call: who is waiting on a reply, and who went quiet | ✅ | `src/lib/followUps.ts`; `tests/unit/followUps.test.ts` (17) |
| Waiting thresholds by lead score (VIP/Hot 1h, Warm 2h, Cold 6h); quiet after 24h for an unbooked Hot or Warm guest | ✅ | Unit tests cross each threshold from both sides |
| The wait is measured from when the guest wrote (`lastGuestAt`), and a retried message doesn't restart it | ✅ | `server/conversations.ts`; `tests/server/conversations.test.ts` (3) |
| A guest is chased once until they write back; "Not now" holds for a day | ✅ | Unit tests; browser check writes nothing to the snoozed guest |
| Suggested message built from the guest's own signals, naming no price, room or date | ✅ | Unit tests assert no digits in a draft with no booking, and a cap of 600 characters |
| Nothing is sent automatically: the draft is editable and a person presses Send | ✅ by design | `src/pages/inbox/Inbox.tsx`; browser check edits the draft and that edited text is what lands |
| Sending a follow-up leaves the AI concierge on the chat | ✅ | `src/lib/inbox.ts`; browser check reads the thread back |
| "Needs follow-up" toggle with a live count; hottest first, then longest wait | ✅ | `scripts/verify/inbox-ui.mjs` |
| Rows and threads show how long the guest has been left | ✅ | Same script |
| `lastGuestAt`, `followUpSentAt`, `followUpSnoozedUntil` validated by rules | ✅ | `firestore.rules`; `tests/rules/conversations.test.ts` (2) |
| Follow-ups on WhatsApp / Instagram / Email are recorded, not sent | ✅ by design | Those channels are MOCKED (D19); the thread carries the simulated-channel notice |
| Conversations recorded before Phase 6 have no `lastGuestAt` | ✅ by design | The wait falls back to the last message when the guest wrote it (D21) |

### Phase 7: production readiness (DECISIONS D22)

| Item | Status | Evidence |
| --- | --- | --- |
| Every function bundles for the platform's Node runtime and the **bundles** answer real requests | ✅ | `scripts/verify/vercel-build.mjs`; `npm run verify:vercel` → 8/8 with the emulator, 7/7 without |
| The extensionless-import risk that broke the previous AI layer on Vercel | ✅ addressed | The bundle check is exactly that failure mode; it passes. A real Vercel build is still unverified. |
| Browser bundle checked for credentials **by value**, the emulator switch, source maps and unhashed assets | ✅ | `scripts/verify/release-check.mjs`; `npm run verify:release` → 10/10 |
| `vercel.json`: function duration, immutable caching for hashed assets, no-cache entry page, security headers | 🟡 written, unverifiable locally | Headers only apply once deployed (D22) |
| Node runtime pinned (`engines.node >= 20`) | ✅ | `package.json` |
| Stale origin-trial token for another deployment removed from `index.html` | ✅ | It was issued to `hotel-ms-six.vercel.app` and did nothing here |
| Page description no longer advertises housekeeping (out of scope) | ✅ | `index.html` |
| `DEPLOYMENT.md`: what deploys, variables, preview steps, post-deploy checks, rollback, remaining risks | ✅ | `DEPLOYMENT.md` |
| README architecture map brought up to date (inbox, concierge, scoring, follow-ups, verify scripts) | ✅ | `README.md` |
| **The Vercel preview deployment itself** | ⛔ | Blocker 3: needs the user's Vercel account |
| Deploying `firestore.rules` to any real project | ⛔ GATED | Needs an explicit decision; `DEPLOYMENT.md` §5 |

### Later phases

| Item | Status |
| --- | --- |
| Phase 3 Concierge UI | 🟡 built; see the Phase 3 table below |
| Phase 4 Inbox | ✅ built and verified; see the Phase 4 table below |
| Phase 5 Lead scoring | ✅ built and verified; see the Phase 5 table above |
| Phase 6 Follow-ups | ✅ built and verified; see the Phase 6 table above |
| Phase 7 Production readiness | ✅ built and verified locally; the preview deployment is ⛔ (Blocker 3) |
| Phase 8 Final QA | ❌ not started |

## Checks run on 2026-09-15 (working tree with Phase 2 / 2B changes)

| Check | Result |
| --- | --- |
| `npm run build` (`tsc -b` app + node + server incl. `scripts/verify`, then `vite build`) | ✅ exit 0 |
| `npm run lint` | ✅ exit 0, no findings |
| `npx vitest run tests/unit` | ✅ 8 files, 137 tests passed (after Phase 6) |
| `FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npx vitest run tests/rules tests/server` | ✅ 10 files, 217 tests passed, none skipped (after Phase 6). Whole suite: 18 files, 354 tests. |
| `node scripts/verify/inbox-ui.mjs` (2026-09-16, real local API + emulator) | ✅ 51/51 inbox checks, including every Phase 6 check |
| `node scripts/verify/concierge-ui.mjs` (2026-09-16) | ✅ 20/20 — the model-answered path; the two failure-state checks of the earlier 22 didn't apply because Gemini answered |
| `npm run lint`, `npm run build` after Phase 6 | ✅ exit 0 and exit 0 |
| `npm run verify:vercel` (2026-09-16) | ✅ 8/8 with the emulator; 7/7 without one (the unknown-hotel refusal is 400 with a database and 503 without, and both are guest-safe) |
| `npm run verify:release` (2026-09-16) | ✅ 10/10 |
| `npm run lint`, `npm run build` after Phase 7 | ✅ exit 0 and exit 0 |
| Whole suite after Phase 7 | ✅ 18 files, 354 tests |
| Production bundle scan after Phase 6 (`dist/`) | ✅ no `GEMINI_API_KEY`, `FIREBASE_SERVICE_ACCOUNT`, `VITE_FIRESTORE_EMULATOR_HOST` or emulator host. The only `AIza…` match is the public Firebase Web API key, which belongs in a browser bundle. |
| `grep` for `.only`/`.skip` in `tests/` | ✅ none |
| TEST_PLAN §7 security checks | ✅ `.env` ignored; no secret-like tracked files; no server secret names in `src/`; no key material in changed/new files; no secret `VITE_` vars |
| HTTP via `server/dev-server.ts` + emulator: `GET /api/ai/health` | ✅ 200 `{configured:true}` |
| HTTP: `GET /api/ai/health?probe=1` while quota exhausted | ✅ 503 `reachable:false` (correct report) |
| HTTP: `POST /api/ai/concierge` unknown public id / legacy `hotelId` body / malformed JSON / GET | ✅ 400 / 400 / 400 / 405, guest-safe bodies, no ids |
| Real Gemini probe (script) | ✅ reachable (before quota ran out) |
| `npm run verify:live` run 1 | 🟡 15/33 checks; 1 real tool turn fully passed; rest failed on HTTP 429 per-minute then per-day quota, and one 25 s timeout |
| `npm run verify:live` run 2 | ⛔ stopped: `GenerateRequestsPerDayPerProjectPerModel-FreeTier` limit 20 exhausted |
| Gemini probe, 19:47 UTC | ⛔ HTTP 429, daily quota still exhausted (resets at midnight Pacific time) |
| `verify:live -- --real-firestore` with the current `.env` | ✅ refused: "FIREBASE_SERVICE_ACCOUNT is not service-account key JSON" |

## Blockers

1. **Gemini API quota (account).** The local `GEMINI_API_KEY` is on the
   free tier for `gemini-3.6-flash`: **5 requests/minute and 20
   requests/day**. One tool-using guest turn makes 2–4 model calls; the
   live verification needs about 35–45, and a single demo booking
   conversation about 10. The daily limit was exhausted on 2026-09-15; it
   had reset by 2026-09-16, and the Phase 6 browser runs used part of that
   day's allowance answering real guest turns (which is how the Phase 4 row
   above became ✅). A day's free allowance still cannot cover
   `npm run verify:live`, so this needs a key on a billing-enabled Google AI
   project (or an explicit decision to verify with a different model).
2. **Firebase Admin credential (account).** A later instruction asked for
   Part B against the production project; that is still impossible without
   a key. As first written: `firebase projects:list`
   shows only `hotel-management-c183c` for InnPilot, which is the `prod`
   alias and the frontend's configured project. `FIREBASE_SERVICE_ACCOUNT`
   in `.env` is still a service-account *email*, not key JSON. No
   non-production project or key exists, so TEST_PLAN §5 Part B cannot
   run, and production must not be used.

3. **Vercel account access (account).** Phase 7's readiness work is done
   and verified locally, but creating the project and running
   `npx vercel` (preview) or `npx vercel --prod` needs the user's Vercel
   account. Nothing can be deployed without it. `DEPLOYMENT.md` §4 is the
   procedure, ready to follow.

## Deployment

**Not deployed.** No repository, no remote and no Vercel project. The
readiness work is done (Phase 7) and the runbook is
[`DEPLOYMENT.md`](DEPLOYMENT.md).

Resolved in Phase 7:

- `package.json` has `"type": "module"`, and `api/` + `server/` use
  extensionless relative imports with no bundling step — the combination
  that failed on Vercel for the previous AI layer. `npm run verify:vercel`
  now bundles each function the way the platform does and calls the result;
  every import resolves and every route answers.
- Nothing secret reaches the browser bundle, checked by value as well as by
  name (`npm run verify:release`).
- Caching and security headers, and the function duration, are pinned in
  `vercel.json`; the Node runtime is pinned in `package.json`.

Still true, and documented rather than fixed:

- The rate limit is in-memory, per serverless instance. It is a budget
  guard, not a security control.
- Deploying these rules to a project with existing data gives read/write
  access to anyone holding a hotel id. Hotels created under an older model
  may not have 20-character auto-ids, and none have a `publicId`. **GATED**
  — `DEPLOYMENT.md` §5.
- The free-tier Gemini quota (Blocker 1) would make a deployed concierge
  fail after a few conversations.
- The headers in `vercel.json` cannot be verified until something is
  deployed.

## Known issues

1. Blockers 1 and 2.
2. One real-Gemini turn (hotel info, no prior history) hit the 25 s turn
   timeout (D7). Everything else in that turn measures about 30–50 ms locally
   (D17), so the time was Gemini's. The Gemini share can't be re-measured
   until quota allows. Candidate fix: `GEMINI_THINKING_LEVEL=LOW`, once
   compared live.
3. The gateway's single 400 ms retry is useless against Gemini 429s, which
   ask for 1–60 s. Guests get a safe 503; no change made.
4. Concierge UI built (Phase 3). A real Gemini reply now renders in a
   browser (2026-09-16), but the availability-card → book → confirmation
   path with a real model is still unverified end to end.
5. Lead scoring reads English words, so it can misread: "book" inside
   another word counts as intent, and a guest writing in another language
   scores cold. The reasons are always shown, and a score does nothing on
   its own (D20).
6. Pre-existing: React 19 logs "Accessing element.ref was removed" from the
   app shell's `@tippyjs/react` sidebar tooltips, on every dashboard page
   (seen on the untouched Parking page too). Harmless for now.
7. At the inbox list's maximum width, the channel and lead filter tabs
   are partly clipped. Both strips scroll horizontally.
8. The holding reply is recorded again for every guest message while staff
   handle a chat, which repeats in the thread. Cosmetic; left as is.
9. Six screenshots from an earlier verification run sit in the repository
   root (`01-`…`06-*.png`, untracked). Later runs write to a temporary
   directory via `SHOTS=`.
10. `.env` still sets unused `VITE_AI_API_BASE` and `AI_*` keys (local file,
    not touched).
11. `.firebaserc` defines only a `prod` alias (no `default`).
12. Follow-up thresholds (VIP/Hot 1h, Warm 2h, Cold 6h, quiet 24h) are
    fixed in code. A hotel cannot tune them in this build (D21).
13. A conversation recorded before Phase 6 has no `lastGuestAt`, so its wait
    is measured from its last message instead. It self-corrects on the
    guest's next message.
14. A follow-up sent on WhatsApp, Instagram or Email is recorded in the
    thread only — those channels are still MOCKED (D19). Only web follow-ups
    reach a guest.
15. Unreferenced assets are committed: `src/assets/hotel.jpeg`, `hotel.jpg`,
    `jamiz.jpg`, `preview.png`, `preview1.png`, `react.svg`, and
    `brand/innpilot-logo-full-dark.png`.

Fixed in the Phase 4 review (all re-verified): staff replies and `updatedAt`
now use `serverTimestamp()`, so a staff browser's clock can't hide a reply
from the guest's page or misorder a thread; the guest page polls while the AI
handles the chat too, so staff can start a conversation; a turn is recorded in
a transaction with the guest's arrival time, so a staff reply sent during a
model call keeps its place and its count; a retried message is recorded once
(`turnId`); polling stops for a thread the hotel no longer has; Enter on an
empty or in-flight staff composer no longer errors; a failed inbox load no
longer reads as an empty inbox.

Fixed this session: health probe false negative; stale `npm run bootstrap`
(`.env.example`), `npm run dev:full` (`server/dev-server.ts`) and
`isStaffOf` (`storage.rules`) references.

## Next action

**Phase 7's readiness work is built and verified locally. The preview
deployment itself cannot be done here: it needs the user's Vercel account
(Blocker 3).** Two ways forward, both the user's call:

1. Provide Vercel access, or follow `DEPLOYMENT.md` §4 and report what the
   preview does; then check it against §6.
2. Proceed to Phase 8 (final QA) with the preview deferred.

The other account items are unchanged: `npm run verify:live` with a billed
Gemini key (the free tier's 20 requests/day cannot cover its 35–45 calls),
the real-model booking flow in a browser, and TEST_PLAN §5 Part B.

### Previous next action (Phase 2)

**Resolve Blockers 1 and 2, then finish Phase 2 verification:**

1. `npm run verify:live` with a billed Gemini key against the emulator
   (TEST_PLAN §5 Part A). All 33+ checks must pass.
2. TEST_PLAN §5 Part B against a non-production Firebase project.
3. Update this file; then ask for approval for Phase 3.
