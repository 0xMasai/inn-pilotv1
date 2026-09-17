# InnPilot K Hotels AI Challenge build: decisions

Important architectural decisions. Record new ones at the end; don't
rewrite old ones. If a decision is reversed, add a new entry that
supersedes it.

Format: **Context** (why a decision was needed) · **Decision** ·
**Consequences** (what it costs and what it commits us to) · **Where**
(the code that embodies it).

_Entries D1–D13 record decisions already embodied in the baseline code,
written down on 2026-09-15._

---

## D1. Fresh repository; old history not carried over

- **Context:** The previous InnPilot repository had a login-based app and
  an AI layer that its last commit deleted. The rebuild shares almost none
  of that design.
- **Decision:** The challenge build starts as a new Git repository on
  `main`. The working tree of the rebuild is its first commit. It has no
  remote until one is chosen.
- **Consequences:** Nothing is pushed to the old repository. Old history,
  including the local `backup/phase15-post-rebase` branch, is kept only as
  a local backup outside the project, at
  `D:\0xStunna\InnPilot-legacy-git-backup-2026-09-15\.git`.
- **Where:** repository root.

## D2. No user accounts; the workspace id is the key

- **Context:** An independent hotel should be working within a minute,
  with no sign-up.
- **Decision:** There is no authentication. A workspace is a
  `hotels/{hotelId}` document. The browser stores the id in
  `localStorage["innpilot_hotel"]`, and holding the id grants access.
- **Consequences:**
  - The id must be treated like a password. Settings shows it with that
    warning.
  - Anyone holding it can read and write that workspace.
  - Access can't be revoked per person.
  - Firestore rules are the only access control for the browser.
- **Where:** `src/workspace/`, `src/pages/onboarding/`, `firestore.rules`.

## D3. `hotels/{hotelId}` is the tenant boundary, and ids can't be discovered

- **Context:** Under D2, a guessable or listable id would expose every
  hotel.
- **Decision:**
  - A hotel can only be created under a Firestore auto-id (20
    alphanumeric characters).
  - `list` on `/hotels` and collection-group queries are denied.
  - Every document's `hotelId` must match its path.
  - New workspaces must start on `{plan: 'trial', status: 'active'}`.
- **Consequences:** Ids can be shared but not found. Hotels whose ids
  don't match the auto-id format can't be created under these rules.
- **Where:** `firestore.rules`; `tests/rules/workspace.test.ts`.

## D4. Integrity lives in the rules, not only in the app

- **Context:** With no accounts, any client holding an id can write
  anything the rules allow.
- **Decision:**
  - Nothing can be deleted.
  - `barSales`, `barTransfers`, `expenses` and `auditLog` are append-only.
  - Stock can't go negative.
  - Statuses must be in their enums.
  - Documents are capped at 50 fields.
- **Consequences:** Mistakes are corrected with new records, not edits.
  The app's transactions (`src/lib/bar.ts`) and the rules enforce the stock
  floor independently.
- **Where:** `firestore.rules`; `tests/rules/*`.

## D5. One source for every business figure

- **Context:** The same figure (revenue, profit, occupancy) appears on the
  Dashboard, in module KPI strips and in reports, and must agree
  everywhere.
- **Decision:** Every revenue, recognition-date and occupancy calculation
  lives in `src/lib/metrics.ts`, and every screen calls into it.
- **Consequences:** One file to read when a number looks wrong. New
  figures must be added there, not computed inline.
- **Where:** `src/lib/metrics.ts`, `src/lib/useHotelData.ts`.

## D6. AI runs only on the server

- **Context:** A model key in the browser bundle is public, and anyone
  could spend it.
- **Decision:**
  - Gemini is called only from Vercel functions under `api/` (locally,
    `server/dev-server.ts`, proxied by Vite at `/api`).
  - The key is `GEMINI_API_KEY` and never takes a `VITE_` prefix.
  - Browsers are same-origin only unless `ALLOWED_ORIGINS` is set.
- **Consequences:** The concierge needs a server deployment. The frontend
  alone can't use it.
- **Where:** `api/ai/`, `server/ai/config.ts`, `server/ai/http.ts`,
  `vite.config.ts`.

## D7. Gemini through `@google/genai`, configured by env

- **Context:** The provider and limits need to change without code
  changes.
- **Decision:**
  - Default model `gemini-3.6-flash`.
  - 1024 max output tokens, temperature 0.3.
  - 25 s timeout for a whole guest turn.
  - At most 5 tool rounds.
  - All but the tool-round limit can be overridden with `GEMINI_*` env
    vars.
- **Consequences:** The timeout must stay below `vercel.json`'s
  `maxDuration` (30 s). The health probe's own 16-token cap is too small
  for this model (known issue).
- **Where:** `server/ai/config.ts`, `server/ai/gemini.ts`.

## D8. The server resolves the hotel once; tools get a scope, not an id

- **Context:** A model can put any value into tool arguments, including
  another hotel's id.
- **Decision:**
  - `resolveHotel()` validates the request's id, confirms the hotel
    exists, and returns a frozen `HotelScope` that can only reach
    `hotels/{hotelId}/…`.
  - `createToolbox(scope)` binds all tools to it.
  - Tools accept no `hotelId`.
- **Consequences:** Cross-hotel access through a tool is impossible by
  construction. A future guest-facing identifier (separate from the
  workspace key) changes only `resolveHotel()`.
- **Where:** `server/hotels.ts`, `server/ai/tools/index.ts`.

## D9. Concierge bookings go through one server transaction

- **Context:** A booking must not double-book a room. Stays exist in two
  places: `accomodation` (the app's bookings) and `reservations`.
- **Decision:**
  - `create_reservation` runs in a Firestore transaction through the Admin
    SDK. It re-reads the room and every overlapping stay in both
    collections, then books into `accomodation` with `source: "concierge"`
    and the room's own rate, and writes an audit entry.
  - `hotels/{hotelId}/reservations` can be read by browsers, so
    availability sees those stays, but only the server can write it.
- **Consequences:**
  - The server needs a Firebase Admin credential with full access, since
    the Admin SDK bypasses rules.
  - Guest input can't skip the availability re-check.
  - A concierge booking appears in the Accommodation module like any other
    booking.
- **Where:** `server/ai/tools/createReservation.ts`,
  `server/ai/tools/inventory.ts`, `firestore.rules`.

## D10. Booking rules are shared between app and server

- **Context:** The app and the concierge must agree on what "available"
  means.
- **Decision:** Date-overlap and availability rules live in
  `src/lib/booking.ts`, imported by both the app and `server/`.
- **Consequences:** `server/` imports from `src/lib`, so those modules
  must stay free of browser-only APIs.
- **Where:** `src/lib/booking.ts`; imported by
  `server/ai/tools/availability.ts`, `createReservation.ts`,
  `roomRates.ts` and `inventory.ts`.

## D11. Firebase Admin init is lazy and has three credential modes

- **Context:** The same code runs in tests, locally and on Vercel.
- **Decision:** `adminDb()` initializes on first use:
  - With `FIRESTORE_EMULATOR_HOST` set, it uses the emulator and ignores
    credentials.
  - Otherwise, with `FIREBASE_SERVICE_ACCOUNT` set, it reads that as JSON
    or base64 of it.
  - Otherwise it uses Application Default Credentials.
- **Consequences:** An invalid credential surfaces as `503 not_configured`
  on the first request, not at boot. Tests need no credentials.
- **Where:** `server/admin.ts`.

## D12. Tests run against the real emulator, with the model scripted

- **Context:** Mocked rules prove nothing, and live model calls make tests
  flaky and cost money.
- **Decision:**
  - Rules and server tools are tested against the Firestore emulator on
    :8080.
  - The concierge endpoint test scripts Gemini's responses.
  - Unit tests need no emulator.
- **Consequences:** Running rules and server tests needs Java and
  firebase-tools. The real-model flow is verified separately, by hand
  (`TEST_PLAN.md` §5).
- **Where:** `tests/`, `vitest.config.ts`.

## D13. Known shortcuts accepted for the baseline

- **Rate limit is in-memory**, so it is per serverless instance. It is
  acceptable until the concierge is public.
- **The `accomodation` collection name keeps its legacy misspelling,**
  because existing booking history uses it.
- **Guest-facing id and per-hotel on/off switch are deferred.** Both must
  exist before a public concierge goes live (`MVP_SCOPE.md`).

## D14. Guests reach a hotel by a public id, never by its hotelId

- **Context:** Under D2 the `hotelId` is the workspace key. A concierge
  link a hotel publishes for guests must not carry it. D13 deferred a
  guest-facing identifier; the public concierge needs it now.
- **Decision:**
  - Each hotel gets a `publicId`: a slug of its name plus 8 random
    characters, e.g. `lakeside-inn-k7m2qp9x`. It is always lowercase with a
    hyphen, so it can never be a 20-character `hotelId`.
  - `publicHotels/{publicId}` holds `{ hotelId }`. Clients can never read
    or list it. `hotels/{hotelId}.publicId` points back, and can be set once
    but never changed or removed.
  - The rules require the two to agree when either is written. Onboarding
    writes both in its batch.
  - `resolveHotel()` accepts only a public id. It follows the mapping and
    requires the hotel to name the same `publicId` back. Every failure
    (malformed, unknown, unbound) gives one guest-facing message.
  - `POST /api/ai/concierge` takes `publicHotelId`. It no longer accepts
    `hotelId`, and never returns it.
- **Consequences:**
  - The workspace key stays out of guest links, API responses, tool
    results and prompts. `HotelScope.hotelId` remains server-internal
    (documents still carry it for the rules).
  - A hotel created before this change has no public id and can't be
    reached by the concierge until one is added (the rules allow that
    update; no UI does it yet).
  - Supersedes the "guest-facing id deferred" part of D13. The per-hotel
    on/off switch is still deferred.
- **Where:** `src/lib/publicHotel.ts`, `src/lib/onboarding.ts`,
  `firestore.rules`, `server/hotels.ts`, `api/ai/concierge.ts`;
  `tests/server/tenantIsolation.test.ts`, `tests/rules/workspace.test.ts`.

## D15. The health probe tests reachability, not the answer

- **Context:** `?probe=1` sent a 16-token request and required answer text.
  `gemini-3.6-flash` spends such a small budget on thinking and stops at
  `MAX_TOKENS` with no text, so a working model was reported unreachable.
- **Decision:** A probe passes when Gemini accepts the key and the model and
  returns a candidate, whatever its finish reason. The cap is 64 tokens, no
  thinking setting is forced (it would break models that don't support
  one), and the finish reason is reported for information.
  `API_KEY_INVALID` (which Google returns as HTTP 400) is classified as a
  configuration error.
- **Consequences:** The probe no longer depends on how a model spends its
  output budget. It does not check answer quality; the live verification
  (`npm run verify:live`) does that.
- **Where:** `server/ai/gemini.ts` (`checkHealth`), `tests/unit/aiHealth.test.ts`.

## D16. Legacy hotels get a public id by a one-time migration

- **Context:** D14 gives public ids only to hotels created by the current
  onboarding (`createWorkspace()`, the only code that creates a hotel; a
  unit test pins that it always writes a matching `publicId` and
  `publicHotels` entry). Hotels that already exist in a Firebase project
  have neither, so the concierge rejects them as unknown.
- **Decision:** Legacy hotels are migrated once, per hotel, with no change
  to any existing field:
  1. Generate `publicId = makePublicHotelId(hotel.name)`.
  2. In one Admin SDK batch or transaction:
     `create publicHotels/{publicId} = { hotelId, createdAt }`, and
     `update hotels/{hotelId}` setting `publicId`, only if it has none.
  3. Check that `resolveHotel(publicId)` returns that hotel.
  It must run through the Admin SDK: the client rules require a 20-character
  `hotelId` for a mapping, and older hotels may not have one (D3).
  `resolveHotel()` accepts any valid document id. No migration script ships
  yet. Running one against a real project is a production data migration
  and needs explicit approval.
- **Consequences:** Nothing is deleted or rewritten, and a hotel that is
  never migrated simply stays unreachable by the concierge.
- **Where:** `src/lib/publicHotel.ts`, `server/hotels.ts`, `firestore.rules`.

## D17. Every concierge turn logs where its time went

- **Context:** A real hotel-information turn hit the 25 s turn timeout (D7)
  with no way to tell which part was slow.
- **Decision:**
  - `generate()` takes an optional `TurnTrace` and fills it as it runs:
    each model call's duration, finish reason, token counts (thinking
    included) and tool calls requested, and each tool call's duration. A
    failed or timed-out call is recorded too.
  - The gateway logs `timing` (`totalMs`, `resolveMs`, `modelMs`, `toolMs`,
    `gatewayMs`, and the per-call lists) on success and failure. It never
    goes to the guest.
  - `GEMINI_THINKING_LEVEL` (`MINIMAL`/`LOW`/`MEDIUM`/`HIGH`) is optional.
    Unset keeps the model's default, so behaviour doesn't change until it is
    measured.
- **Consequences:** The emulator benchmark shows everything except Gemini
  takes about 30–120 ms per turn at the median (about 300 ms at p90 with 500
  bookings), so the timeout was Gemini's time. The guest-facing timeout
  (504) is unchanged. The default thinking level should change only after a
  real latency comparison.
- **Where:** `server/ai/gemini.ts`, `server/ai/config.ts`,
  `api/ai/concierge.ts`, `tests/server/concierge.test.ts`.

## D18. The guest concierge is a hash route fed only by the server

- **Context:** Phase 3 needs a public page that shows a hotel's rooms and
  books through the AI, without accounts and without the workspace key
  (D2, D14).
- **Decision:**
  - The page lives at `/#/c/:publicHotelId`. The app already uses
    `HashRouter`, so the link works on any static host, and in Electron,
    with no server rewrites. The Settings "Guest AI Concierge" card shows
    and copies it, and can create a public id for an older workspace.
  - The page never reads Firestore. `GET /api/ai/hotel` returns the hotel's
    public details and room rates (no model call). `POST /api/ai/concierge`
    returns the reply, plus `availability` and `booking` taken from that
    turn's tool results through an allow-list, so the cards show the
    system's own figures rather than parsing the model's text.
  - Reply text is rendered as bold and bullet lists only, never as HTML.
    The conversation lives in `sessionStorage` for the tab.
- **Consequences:** Adding a field to a tool result doesn't publish it.
  Nothing in the page can reveal a `hotelId`. Shared links contain `#`.
- **Where:** `src/pages/concierge/`, `src/lib/concierge.ts`, `api/ai/hotel.ts`,
  `api/ai/concierge.ts`, `src/pages/Settings.tsx`.

## D19. One inbox for every channel; web is real, the others are mocked

- **Context:** Phase 4 needs a unified inbox (Web, WhatsApp, Instagram,
  Email) showing guest, latest message, channel, AI/Human status, lead
  score and booking status. No real messaging integrations are in scope.
- **Decision:**
  - `hotels/{hotelId}/conversations/{id}` holds the summary (channel,
    guestName, guestContact, handledBy, bookingStatus, reservationId,
    `lead` = null until Phase 5, lastMessage, messageCount, `mock`). Its
    `messages` subcollection is append-only. The domain lives in
    `src/lib/conversations.ts`, shared by app, server and tests.
  - Web conversations are written by the concierge gateway, through the
    hotel scope, on every turn. That includes turns the AI failed to answer,
    so staff see missed guests. The guest's tab keeps the `conversationId`.
    Booking progress only moves forward (none → quoted → booked), and the
    booked guest's name and phone come from the confirmed reservation.
  - WhatsApp, Instagram and Email are MOCKED: sample threads added from the
    inbox, flagged `mock: true`, and labelled as simulated. Staff replies on
    them are recorded, not sent.
  - Staff can take a conversation over. While `handledBy` is `human`, the
    gateway doesn't call Gemini: it records the guest's message and returns
    a holding reply. The guest page polls `GET /api/ai/conversation` for
    staff replies (deduplicated by message id, server-time cursor): every
    5 s while staff handle the chat, and every 15 s while the AI does,
    because staff can step in before the guest writes again. A hidden tab
    doesn't poll, and a thread the hotel no longer has ends the polling.
  - Every message carries a server clock: the gateway's for the AI's side,
    `serverTimestamp()` for staff replies, since a staff browser's clock
    can be off and the guest reads by server time. Each poll re-reads the
    last 30 s so a small clock difference can't drop a reply.
  - A turn is recorded in a transaction, not a batch: model time is long
    enough for staff to reply meanwhile, so the count and booking progress
    are derived from the thread as it is at write time. The guest's message
    keeps the time it arrived, so a staff reply sent during the turn still
    reads after it.
  - The browser sends a `turnId` with each guest message. A failed turn
    records the message and keeps that id in `pendingTurnId`, so retrying
    the same message doesn't record it twice.
  - For local verification only, `VITE_FIRESTORE_EMULATOR_HOST` in dev
    points the app's client SDK at the emulator. Production builds strip it.
- **Consequences:**
  - A conversation id is looked up only under the resolved hotel, so
    another hotel's id starts a new thread. Only web threads can be
    continued from the concierge.
  - Polling costs one request per open guest tab: every 5 s while staff
    handle that chat, every 15 s otherwise, and none while the tab is
    hidden. That is the price of staff being able to start a conversation.
  - A guest's conversation id is the only key to their thread, so a
    browser that loses it (a new tab) starts a new thread.
- **Where:** `src/lib/conversations.ts`, `src/lib/inbox.ts`,
  `server/conversations.ts`, `api/ai/concierge.ts`,
  `api/ai/conversation.ts`, `src/pages/inbox/`, `firestore.rules`,
  `firebase.ts`.

## D20. Lead scoring is deterministic, not a model call

- **Context:** Phase 5 needs each conversation scored 🔥 Hot, 🌤 Warm,
  ❄ Cold or ⭐ VIP, with filters, so staff can see who to chase first.
- **Decision:**
  - The rules are plain and deterministic (`src/lib/leadScoring.ts`): no
    model call, no cost, no quota, and the same conversation always scores
    the same. A hotel can be told exactly why a guest is Hot.
  - Scoring reads **signals the guest gave** — asked to book, gave dates,
    asked prices, left contact details, a group or long stay, an occasion,
    a suite — plus what the concierge did: showed live availability, took a
    booking. The hotel's own words are never read: a lead is what the guest
    showed, not what the AI said.
  - Signals accumulate on the conversation (`leadSignals`) and only ever
    turn on, so a guest who gave dates ten messages ago still counts as
    one. `guestMessages` counts the guest's turns.
  - The order is: ⭐ VIP (booked, and a suite, group, long stay or special
    occasion) → 🔥 Hot (booked; asked to book; saw availability and left
    contact details; or a group enquiry already talking dates or money) →
    🌤 Warm (saw availability, gave dates or asked prices) → ❄ Cold.
  - Every score carries its reasons, capped at 8, shown in the badge's
    tooltip and written out at the top of the thread. They are also what
    Phase 6 follow-ups will have to work with.
  - The gateway scores web conversations inside the same transaction that
    records the turn, including turns the AI failed to answer. The app
    scores the mocked sample threads by the same rules when they are added.
- **Consequences:**
  - A conversation recorded before Phase 5 reads "not scored" until its
    next message; nothing backfills. Sample threads are re-added scored.
  - Scoring is word-based and English-only. It can be wrong: "book" in
    "bookshop" reads as intent. Reasons are always shown so staff can see
    what it went on, and the score changes nothing on its own.
  - `firestore.rules` validates `lead` (one of the four scores, a list of
    at most 8 reasons). `leadSignals` is not validated field by field: it
    is a workspace's own working note, capped by the document size rule.
- **Where:** `src/lib/leadScoring.ts`, `src/lib/conversations.ts`,
  `server/conversations.ts`, `src/lib/inbox.ts`, `src/pages/inbox/`,
  `firestore.rules`.

## D21. Follow-ups are suggested, never sent on their own

- **Context:** Phase 6 turns a lead score into the thing that actually
  converts an enquiry: a reply that goes out. Two guests are worth chasing —
  the one nobody answered, and the interested one who stopped writing.
- **Decision:**
  - Which conversations need a follow-up is worked out from the thread, by
    plain rules (`src/lib/followUps.ts`), the same way scoring is (D20):
    **waiting** when the guest's message is the last one and the wait has
    passed the threshold for how hot they are (VIP and Hot 1h, Warm 2h,
    Cold 6h); **quiet** when the hotel wrote last, the guest is Hot or Warm,
    has not booked, and 24 hours have passed.
  - The wait is measured from `lastGuestAt`, written by the gateway when it
    records a guest message, so a retry of a failed turn doesn't restart the
    clock on a guest who has been waiting since they first wrote.
  - A guest is chased once until they answer: `followUpSentAt` keeps a quiet
    guest off the list until a newer guest message exists. "Not now" writes
    `followUpSnoozedUntil`, a day ahead.
  - The suggested message is deterministic too, built from the signals the
    guest gave (D20): the suite, their group, their celebration, the dates
    they mentioned, the rates they asked about. It names nothing the hotel
    would have to honour — no price, no room, no date, no promise that
    anything is free — it offers to check.
  - **Nothing is ever sent automatically.** The draft is loaded into an
    editable box in the thread; a person reads it, changes it and presses
    Send. There is no scheduler, no queue and no background job in this
    build.
  - Sending a follow-up does **not** take the conversation over. A reply
    does (D19), because staff are then in the conversation; a follow-up is
    the opposite — the point is that the guest answers, and the AI concierge
    should be there to take that answer through to a booking.
  - The inbox gets a "Needs follow-up" toggle with a live count, and rows
    and threads carry the wait. Ordering is hottest first, then longest
    wait: the money a hotel loses by missing someone, in order.
- **Consequences:**
  - The list moves with the clock, not with a stored flag, so it is right
    the moment a page is open and needs nothing to keep it up to date.
  - Thresholds are fixed in code. A hotel cannot tune them in this build.
  - A conversation recorded before this phase has no `lastGuestAt`; the
    wait then falls back to the last message when the guest wrote it.
  - A follow-up on WhatsApp, Instagram or Email is recorded in the thread
    only — those channels are still MOCKED (D19). On web it reaches the
    guest's page like any staff message.
  - `firestore.rules` checks that `lastGuestAt`, `followUpSentAt` and
    `followUpSnoozedUntil` are times or nothing.
- **Where:** `src/lib/followUps.ts`, `src/lib/conversations.ts`,
  `src/lib/inbox.ts`, `src/pages/inbox/`, `server/conversations.ts`,
  `firestore.rules`.

## D22. Production readiness is proved locally; deploying stays gated

- **Context:** Phase 7 is "production readiness and a Vercel preview". The
  preview needs an account this build does not have, and the previous AI
  layer failed *on Vercel* for a reason that never shows up locally:
  `"type": "module"` plus extensionless relative imports across `api/` and
  `server/`.
- **Decision:**
  - Reproduce the platform's build shape instead of trusting it. The
    functions are bundled with esbuild exactly as Vercel bundles them — ESM,
    Node target, packages external — and then **the bundles are served and
    called**, not the sources (`scripts/verify/vercel-build.mjs`). A broken
    import fails here rather than on a deployment.
  - Check the browser bundle by value, not just by name
    (`scripts/verify/release-check.mjs`): the real `GEMINI_API_KEY` and
    `FIREBASE_SERVICE_ACCOUNT` strings from `.env` must appear nowhere in
    `dist/`, no emulator host may survive, no source map may ship, and the
    only `AIza…` key allowed is the public Firebase Web key.
  - Handlers stay framework-free (structural `ApiRequest`/`ApiResponse`), so
    the same files run under `npm run dev:api`, under the bundle check, and
    on Vercel, with no adapter and no second code path.
  - Configuration lives in the repository: `vercel.json` (30s function
    duration, immutable caching for hashed assets, no-cache for the entry
    page, and the standard security headers), `package.json` engines.
  - **Nothing is deployed.** `DEPLOYMENT.md` marks every account-touching
    step GATED, especially deploying `firestore.rules`: under the
    account-free model those rules decide who can read a workspace, and
    hotels created before this build may have short ids and no `publicId`.
- **Consequences:**
  - The bundle check is a faithful proxy, not proof about Vercel. The
    headers in `vercel.json` cannot be verified until something is deployed,
    which is stated where they are claimed.
  - Adding a dependency that must be bundled rather than installed would
    need the `packages: "external"` choice revisited.
  - `base: './'` stays (Electron needs it); on a root deployment the
    relative asset URLs resolve the same, and every app route is a
    `#` fragment, so the document path is always `/`.
- **Where:** `scripts/verify/vercel-build.mjs`,
  `scripts/verify/release-check.mjs`, `vercel.json`, `package.json`,
  `index.html`, `DEPLOYMENT.md`.

---

_Entries D23 onwards record the 2026-09-16 restructure into the network AI
Concierge (see `MIGRATION_PLAN.md`)._

## D23. The public product is the network AI Concierge; the PMS is infrastructure

- **Context:** The K Hotels challenge is about response time and
  inquiry-to-booking conversion. The build presented itself as a hotel PMS
  with a per-hotel chat bolted on.
- **Decision:**
  - `/#/` is the guest-facing AI Concierge that searches every participating
    hotel. `/#/c/:publicHotelId` is the same concierge limited to one hotel.
  - The PMS marketing landing and onboarding move under `/#/staff`
    (`/#/get-started` and `/#/pms` redirect). `/#/dashboard/*` is unchanged.
  - `/` no longer redirects a browser holding a workspace id to the
    dashboard: guests and staff can share a device, and the product is the
    concierge.
- **Consequences:** Staff reach their workspace via `/#/staff`. Nothing in
  the PMS modules changes. Shared concierge links from Settings keep working.
- **Where:** `src/App.tsx`, `src/pages/concierge/`, `src/pages/home.tsx`.

## D24. Hotels opt in to the network search with `listed: true`

- **Context:** "Search all participating hotels" needs a definition of
  participating, and a hotel must not appear to guests by accident.
- **Decision:** A hotel is searchable when `hotels/{hotelId}.listed == true`
  and it has a `publicId` (D14). The server lists them with the Admin SDK
  (`where("listed","==",true)`); clients still cannot list `/hotels` (D3).
  Guest-facing profile fields are added to the hotel document: `region`,
  `country`, `description`, `amenities[]`, `checkInTime`, `checkOutTime`,
  `policies`; rooms may carry `capacity` and `amenities[]`. The rules allow
  the workspace to edit them with type and size checks.
- **Consequences:** Existing hotels are unaffected until they opt in.
  `get_hotel_info` and result cards report only fields that exist; anything
  missing is stated as "not recorded", never guessed.
- **Where:** `server/hotels.ts`, `src/lib/hotelListing.ts`,
  `src/pages/Settings.tsx`, `firestore.rules`.

## D25. Tools take a public hotel id and resolve it through a network context

- **Context:** D8 bound every tool to one pre-resolved `HotelScope`. A network
  search must reach many hotels while keeping the guarantee that the model
  can't reach data it shouldn't.
- **Decision:**
  - The gateway builds a `NetworkContext` per turn: either "every listed
    hotel" or "exactly this one hotel" (scoped `/c/` page).
  - Tools that act on a hotel take `hotel` = a **public id** and resolve it
    via the context, which rejects internal hotelIds (format), unknown ids,
    unlisted hotels (network mode) and any other hotel (scoped mode) with one
    uniform `unknown_hotel` result.
  - Tool set: `search_hotels`, `check_availability`, `get_hotel_info`,
    `calculate_stay_price`, `prepare_booking`, `create_reservation`.
    `get_room_rates` is retired (search and price cover it).
  - Results never contain a hotelId. The gateway allow-lists what reaches the
    browser (D18 unchanged).
- **Consequences:** Supersedes D8's "tools get a scope, not an id" in form,
  not in substance: tools still only touch data through a `HotelScope`, now
  obtained from a validated public id.
- **Where:** `server/network.ts`, `server/ai/tools/`.

## D26. Book by room type; the server picks the room inside the transaction

- **Context:** Guests choose "a Double at K Hotels Kabale", not room 204. Room
  numbers are PMS detail.
- **Decision:** `create_reservation` takes hotel + room type. The server
  ranks that type's free rooms by price, then runs D9's single-room
  transaction on each candidate in turn until one books. The booked room's
  total must equal the total the guest confirmed; otherwise nothing is booked
  and `price_changed` is returned with the new figure.
- **Consequences:** No double booking (each attempt is D9's transaction); the
  guest never pays a price they didn't confirm; a room taken between summary
  and confirmation falls through to an equal-priced sibling.
- **Where:** `server/ai/tools/createReservation.ts`.

## D27. A reservation needs a summary from an earlier turn and an explicit yes

- **Context:** The prompt tells Gemini to confirm before booking, but a prompt
  is not a control. A model that books on "I'll take the first one" creates a
  real reservation the guest never agreed to.
- **Decision:**
  - `prepare_booking` validates details, re-checks availability and price,
    writes nothing but `pendingBooking` on the canonical conversation, and its
    result drives the page's Booking summary card.
  - `create_reservation` refuses (`needs_confirmation`) unless a pending
    booking **from a previous turn** matches hotel, room type, dates, name and
    phone, **and** the guest's current message is an explicit confirmation
    (`isExplicitConfirmation()`: yes / confirm / book it / go ahead, not
    negated).
- **Consequences:** The model cannot prepare and book in one turn, so the
  guest has always seen the summary. A guest who changes a detail gets a new
  summary. Confirmation detection is English-only, like lead scoring (D20).
- **Where:** `src/lib/confirmation.ts`, `server/ai/tools/createReservation.ts`,
  `server/guestConversations.ts`.

## D28. K Hotels demo inventory is seeded, and labelled as such

- **Context:** The only real Firebase project is production and writing to it
  is gated (D22). The emulator has only test fixtures. The golden path needs
  several hotels in Western Uganda with live inventory.
- **Decision:** `npm run seed:k-hotels` writes five K Hotels properties
  (Kabale, Mbarara, Fort Portal in the Western Region; Kampala; Jinja), rooms
  with capacity and UGX rates, a few existing bookings (so availability is
  real, not "everything free"), public ids and `listed: true`, through the
  Admin SDK. It refuses anything but a local emulator unless given
  `--confirm-real-project=<id>`. Every seeded hotel carries `demo: true`.
  Names and prices are illustrative, not K Hotels' real data.
- **Consequences:** The app never hardcodes a hotel or a price: the seed is
  data in Firestore, read through the same code a real hotel's data is.
- **Where:** `scripts/seed/k-hotels.ts`.

## D29. One canonical guest thread, mirrored into each involved hotel's inbox

- **Context:** A network conversation isn't one hotel's until the guest
  chooses, but the inbox, lead scoring, follow-ups and handoff (D19–D21) are
  per hotel and client-read under the workspace rules.
- **Decision:**
  - `conciergeConversations/{id}` (+ `messages`) is the canonical thread:
    server-only, client-denied by the catch-all rule. It holds attached
    `hotelIds`, `selectedHotelId`, `pendingBooking` and the reservation.
  - A hotel is attached when it appears in the guest's search results or is
    selected (capped at 10). Its inbox gets a mirror at
    `hotels/{hotelId}/conversations/{same id}`, back-filled with the thread so
    far, then updated every turn by the existing `recordTurn()`.
  - Mirrors carry `selection` (none/this/other), `selectedHotelName`,
    `bookedElsewhere`, and staff-set `closed`. Inbox status is derived:
    Booked (booked here) → Closed (closed, or booked elsewhere) → Active
    (quoted or selected) → New.
  - Handoff: if **any** attached mirror is `handledBy: "human"`, the gateway
    makes no model call. The guest page's poll merges staff messages from all
    attached mirrors.
- **Consequences:** A conversation that never reaches search results (e.g.
  no hotel matches) is recorded canonically but is in no hotel's inbox. A
  staff reply from one hotel is not copied into other hotels' mirrors.
  Writes per turn grow with attached hotels (at most 10).
- **Where:** `server/guestConversations.ts`, `server/conversations.ts`,
  `src/lib/conversations.ts`, `src/pages/inbox/`.

## D30. Staff open a workspace by pasting its id at `/#/staff`

- **Context:** A judge (or a second staff device) must open the booked
  hotel's workspace; until now only the browser that created it could.
- **Decision:** `/#/staff` offers "Open your workspace": paste the workspace
  id, which is verified against Firestore exactly like a stored one (D2).
- **Consequences:** Same trust model as D2: the id is the key.
- **Where:** `src/pages/home.tsx`, `src/workspace/`.

## D31. The deployed concierge runs on Groq's free plan, behind a provider seam

- **Context:** The Gemini free tier (5 requests/minute, 20/day) could not
  carry one full booking conversation. The MVP must deploy on a free Groq
  plan, and the brief named `groq/compound-mini` (30 RPM, 250 RPD, 70K TPM).
- **Finding (verified 2026-09-16, docs and a live request):** Groq's Compound
  systems do not accept custom tools. `groq/compound-mini` with `tools`
  answers HTTP 400 "`tool calling` is not supported with this model". The
  concierge reads hotels, availability and prices *only* through tools, so a
  Compound model could never search or book. Re-tested 2026-09-17 at the
  owner's request with built-in tools disabled
  (`compound_custom.tools.enabled_tools: []`) and the tools described in the
  prompt as a JSON text protocol: one reply was empty, the next **invented
  five hotels with USD prices** despite the instruction that tools are the
  only source. The owner chose to keep `openai/gpt-oss-120b` as the default.
  (Briefly switched to `groq/compound-mini` on 2026-09-17; reverted the same
  day after 19 tests failed on the gateway's no-tool-calling refusal.)
- **Decision:**
  - `server/ai/provider.ts` picks the provider per request from
    `AI_PROVIDER` (`groq` default, `gemini` kept). Both implement the same
    `generate()`/`checkHealth()` over the vendor-neutral types; prompt, tools,
    booking guards and conversation record are unchanged.
  - `server/ai/groq.ts` uses the official `groq-sdk`. The model is
    `GROQ_MODEL`, read in one place (`config.ts`), default
    `openai/gpt-oss-120b` (tool calling; 30 RPM, 1K RPD, 8K TPM free).
    `groq/compound*` is refused as a configuration error before any request.
  - `GET /api/ai/health` answers only `{ status, provider, configured }`
    (status `ok` | `not_configured` | `unreachable` | `error`); model,
    latency and failure reason are logged, not returned.
  - Quota-aware failure policy: SDK retries off; at most one retry per model
    call, only for 5xx, dropped connection, `tool_use_failed`, or a 429 whose
    `retry-after` is ≤ 10 s and fits the turn deadline. Anything else fails
    straight to the standard guest-safe message. Operator logs carry HTTP
    status, Groq error code, retry-after and remaining-quota headers — never
    the key or Groq's message body.
  - Malformed output (no choice, blank text, tool arguments that aren't a
    JSON object, a call without id) fails the turn before any tool runs.
  - Tools resolve a hotel by public id **or its exact, unique name** among
    the hotels the conversation may already reach, and `create_reservation`
    accepts the summary's hotel by either. Turn history is text only, so on
    a later turn the model often knows the name but not the id; without this
    it re-searched, doubling a turn to ~10K tokens and tripping the 8K TPM
    limit. The reachable set, and every consent guard, are unchanged.
- **Consequences:** A tool turn costs ~5K input tokens over two model calls,
  so on the free plan one guest can sustain roughly one tool turn per 40 s;
  two guests typing at once will see the safe "try again" message. The full
  booking conversation is 7 requests (~18K tokens), ~140 per day on 1K RPD /
  200K TPD. A paid Groq tier, or `AI_PROVIDER=gemini` with a billed key, is an
  environment change.
- **Where:** `server/ai/provider.ts`, `server/ai/groq.ts`, `server/ai/config.ts`,
  `server/network.ts`, `tests/unit/groq.test.ts`, `tests/server/conciergeGroq.test.ts`.
