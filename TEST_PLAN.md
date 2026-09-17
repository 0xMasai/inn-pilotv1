> **2026-09-16 Groq migration (D31):** the deployed provider is Groq (`AI_PROVIDER=groq`). Deterministic coverage: `tests/unit/groq.test.ts` (adapter, 429/timeout/malformed/missing key) and `tests/server/conciergeGroq.test.ts` (gateway golden path + safe failures); the Gemini-scripted suites run with `AI_PROVIDER=gemini`. Live check: one run of `scripts/verify/golden-path-ui.mjs` against real Groq (~7 requests). Evidence: PROJECT_STATUS.md, Phase 9.

> **2026-09-16 restructure:** sections below describe the pre-restructure single-hotel build. The browser scripts `concierge-ui.mjs` and `inbox-ui.mjs` were retired with that page; the current end-to-end check is `scripts/verify/golden-path-ui.mjs` (see PROJECT_STATUS.md, Phase 7). Automated suites are listed in PROJECT_STATUS.md.

# InnPilot K Hotels AI Challenge build: test plan

How each major feature is verified. Results are recorded in
[`PROJECT_STATUS.md`](PROJECT_STATUS.md), with the date and the command
that produced them. A feature is ✅ only when its checks below have
actually passed.

_Last updated: 2026-09-15._

---

## 0. Prerequisites

- Node and `npm install`.
- For emulator suites: Java (JRE) and `firebase-tools`.
- **Never** run any check against production Firestore data. Automated
  suites use the emulator only.

## 1. Baseline gates (every commit)

| Gate | Command | Pass criterion |
| --- | --- | --- |
| Type-check + bundle | `npm run build` | exit 0 |
| Lint | `npm run lint` | exit 0, no findings |
| Unit tests | `npx vitest run tests/unit` | all pass, none skipped |
| Rules + server tests | `npm run test:all`, or with an emulator on :8080: `FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npx vitest run tests/rules tests/server` | all pass, none skipped |

The suites must contain no `.only` or `.skip`.

## 2. Workspace and onboarding (Phase 1)

**Automated**
- `tests/rules/workspace.test.ts`:
  - hotels are created only under 20-char auto-ids;
  - no listing and no collection-group queries;
  - trial-only plan;
  - no delete or re-create;
  - the onboarding batch succeeds;
  - the retired `users` collection is unreachable.
- `tests/unit/onboarding.test.ts`: the starting room inventory.

**Manual (browser, against a non-production Firebase project; the app has
no emulator connection)**
1. Clear site data. Open `/`: the landing page shows.
2. Click Get Started and complete the three steps. You land on
   `/dashboard`, and the rooms exist.
3. Reload. You go straight back to the same workspace.
4. Put a well-formed but unknown id in `localStorage["innpilot_hotel"]`
   and reload. You are not let into the dashboard, and the stored id is
   cleared. With a malformed id, you are also not let in.
5. Visit `/login`, `/super-admin` and `/profile`. Each redirects.

## 3. Modules (Phase 1)

**Automated (rules)**
- `operational-data.test.ts`:
  - writes must target an existing hotel with a matching `hotelId`;
  - enum statuses;
  - `reservations` server-only;
  - immutable expenses and audit entries;
  - no deletes;
  - oversized documents refused.
- `bar-parking.test.ts`: stock floor, archive-not-delete, append-only
  sales and transfers, parking enums.
- `room-editing.test.ts`: room type and rate edited in place.
- `tests/unit/booking.test.ts`: overlap and availability rules.

**Manual (browser, one pass per module)**

| Module | Check |
| --- | --- |
| Dashboard | Figures match Reports for the same period |
| Accommodation | Create a booking; an overlapping booking for the same room is refused; check in and check out change occupancy |
| Restaurant | Create an order and advance its status; revenue appears on Dashboard |
| Bar | Add a product; transfer stock; sell it; selling more than is in stock is refused |
| Parking | Log a vehicle, exit it, and see the fee recorded |
| Expenses | Add an expense; it appears in Dashboard and Reports and cannot be edited |
| Reports | Daily, weekly and monthly views; PDF and CSV exports open |
| Settings | Profile and currency save; workspace id shown; activity log lists recent actions |

## 4. AI tool layer with Gemini scripted (Phase 2)

**Automated (emulator on :8080; no Gemini key needed)**
- `tests/server/tools.test.ts` covers each tool through the real Admin
  SDK:
  - `resolveHotel`: unknown ids are rejected, and the scope stays inside
    its hotel;
  - rates straight from room documents;
  - availability: out-of-service rooms and overlapping stays are excluded,
    legacy `reservations` stays are seen, and no other guest is revealed;
  - `create_reservation`:
    - books into `accomodation` with `source: "concierge"`, the room's
      real rate, and an audit entry;
    - the booking immediately blocks the room;
    - availability is re-checked at booking time;
    - of two simultaneous bookings, exactly one wins;
    - unset rates, and past or malformed dates, are refused;
    - another hotel's room can't be reached;
  - the toolbox offers exactly four tools, none of which takes a
    `hotelId`.
- `tests/server/concierge.test.ts` runs `POST /api/ai/concierge` end to
  end with a scripted model:
  - looks up availability, books through the tool, and answers from the
    results;
  - ignores a `hotelId` put into tool arguments by the model;
  - refuses a missing or nonexistent hotel before any model call;
  - stops a model that keeps calling tools, with a guest-safe error;
  - answers without tools when none are needed.
- `tests/server/tenantIsolation.test.ts` (Phase 2B), real handler with a
  model scripted to misbehave; both hotels have a room "101":
  - Hotel A's public id → every tool answers from Hotel A, and a booking
    lands only in Hotel A;
  - Hotel B's public id → Hotel B's data;
  - a Hotel A request ignores `hotelId`/`publicHotelId` in tool arguments
    and in the request body, can't book a room only Hotel B has, and books
    its own "101" at its own rate;
  - invalid public ids (missing, wrong type, uppercase, traversal, too
    long, unknown, an internal hotelId, the legacy `hotelId` field, a
    planted mapping the hotel doesn't claim, a mapping to a missing hotel,
    a malformed mapping) → 400, one guest message, no model call, no id
    in the body;
  - no internal hotelId in any response or model request.
- `tests/rules/workspace.test.ts` "Public hotel identity": the mapping is
  created only together with a hotel that claims it; it can't be read,
  listed, repointed, deleted or taken over; `publicId` is set once.
- `tests/unit/aiHealth.test.ts` (no emulator): the probe counts a
  `MAX_TOKENS` finish with no text as reachable; a rejected key, unknown
  model or no candidate as unreachable; the endpoint answers 200/503.

## 5. Real Gemini → tools → Firestore reservation flow (Phase 2 exit)

**Status (2026-09-15): Part A partly run, then blocked by the Gemini
free-tier quota. Part B blocked: no non-production Firebase project.**
See `PROJECT_STATUS.md`.

Part A is the first run. Part B runs only once Part A passes.

### Part A: real model, emulator data (no Firebase credential needed)

`server/admin.ts` ignores `FIREBASE_SERVICE_ACCOUNT` when
`FIRESTORE_EMULATOR_HOST` is set. That makes this the safe first run: no
real Firestore is touched.

**Automated form:** `npm run verify:live`
(`scripts/verify/concierge-live.ts`). With the emulator running, it seeds
two hotels with public ids, holds real conversations through the real
handler, and checks every step below against the emulator, including which
tools Gemini called. It refuses to run against anything but a local
emulator. It paces itself to `LIVE_VERIFY_RPM` (default 5) and needs about
35–45 Gemini requests, which is more than a free-tier key allows per day.

The manual steps it automates:

1. Start the emulator: `npx firebase emulators:start --only firestore`.
2. Seed a test hotel, its public id mapping and its rooms directly in the
   emulator, modelled on the fixtures in
   `tests/server/tenantIsolation.test.ts`. The web app has no emulator
   connection in `firebase.ts`, so Get Started can't seed it.
3. Run `npm run dev:api`, with `GEMINI_API_KEY` set and
   `FIRESTORE_EMULATOR_HOST=127.0.0.1:8080`.
4. `POST /api/ai/concierge` with that `publicHotelId`, in this order:
   - "What rooms do you have and what do they cost?" Expect a 200 reply
     with rates that match the seeded rooms.
   - "Is a room free from <date> to <date>?" Expect an answer that agrees
     with the seeded bookings.
   - A booking request with guest name and dates. Expect a 200 reply that
     confirms it.
5. Check the emulator, with an Admin SDK read or the emulator REST API:
   - one new document in `hotels/{hotelId}/accomodation` with
     `source: "concierge"`, and the right room, dates, guest and rate;
   - one new audit entry.
6. Repeat the same booking. Expect it to be refused as unavailable, with
   no second document.
7. Send another hotel's public id, an unknown one, or an internal hotelId.
   Expect a guest-safe 4xx and no data from another hotel.
8. Check the server log: the `tools` array shows the tools that were
   called, and neither the key nor the credential is logged.

### Part B: real Firebase Admin credential

Use a non-production project or a dedicated test hotel. Never touch
production data.

1. Put the service-account **key JSON** (or its base64) in the local
   `.env` as `FIREBASE_SERVICE_ACCOUNT`. The file is git-ignored; confirm
   with `git check-ignore .env`.
2. Unset `FIRESTORE_EMULATOR_HOST`. Run `npm run dev:api`.
3. Repeat steps 4–7 from Part A against the test hotel, and confirm the
   concierge booking also shows in the app's Accommodation module.
4. Afterwards, confirm `git status` shows no credential file.

**Pass criterion:** every step in Part A passes, and Part B passes
against a non-production hotel.

## 6. Health endpoint

- `GET /api/ai/health` returns `configured: true` when the key is set.
- `GET /api/ai/health?probe=1` makes one small real call. It returns 200
  with `reachable: true` when Gemini accepts the key and model, whatever
  the finish reason (DECISIONS D15). It returns 503 with
  `reachable: false` for a rejected key, an unknown model or exhausted
  quota. Automated in `tests/unit/aiHealth.test.ts`; verified live on
  2026-09-15.

## 7. Security checks (before any commit that touches config)

- `git check-ignore -v .env` succeeds.
- `git ls-files | grep -iE '\.env$|serviceAccount|adminsdk|\.pem$|\.p12$|\.pfx$'`
  returns nothing (`.env.example` only has empty placeholders).
- No `VITE_`-prefixed variable holds a secret.
- `grep -rE 'GEMINI_API_KEY|FIREBASE_SERVICE_ACCOUNT' src/` returns
  nothing: the browser code never reads server secrets.

## 8. Not covered yet

- Browser/UI automated tests (there are none).
- Deployment checks: Vercel ESM import resolution, env vars, deployed
  rules. Not scheduled until deployment is.
- Electron build of the current code.
- Concierge UI, Inbox, lead scoring and follow-ups (later work).
- A real-Gemini booking conversation (§5), until the quota blocker is resolved.

## 9. Guest concierge UI (Phase 3)

**Automated**
- `tests/unit/concierge.test.ts`: reply rendering (bold and bullets, never
  HTML), the messages buttons send, history without failed turns, and the
  API client's error mapping (guest message, retryable or not, network).
- `tests/server/hotel.test.ts`: `GET /api/ai/hotel` returns public details
  and rates, no hotelId or private fields, each hotel only its own, safe
  400s, GET only.
- `tests/server/concierge.test.ts`: the reply's `availability` and
  `booking` are the tools' own figures, allow-listed; no booking card when
  the booking is refused.

**Browser, against the real local API** (`scripts/verify/concierge-ui.mjs`;
setup in `scripts/verify/seed-emulator-demo.ts`): the page loads hotel and
rates from the API; the date form validates and sends; the request carries
only the public id; a failed turn shows a guest-safe error with Try again
and marks the message; the chat survives a reload and New chat clears it;
mobile has no horizontal overflow and a working quick-actions toggle;
unknown ids and internal hotelIds get the not-found screen; no console
errors.

**Still required: real Gemini.** Ask a question, see an availability card,
press Book, give name and phone, and confirm. Expect a booking card whose
reference matches the `accomodation` document. This waits on the Gemini
quota (see `PROJECT_STATUS.md`).

## 10. Unified inbox (Phase 4)

**Automated**
- `tests/rules/conversations.test.ts` (22): the workspace lists and reads
  its threads; sample thread and first message in one batch; take over and
  hand back; channel, handler, booking state and name length are
  validated; the channel can't change; no deletes; messages are
  append-only, need an existing thread, a valid role, 1–4000 characters, a
  timestamp and the right hotelId.
- `tests/server/conversations.test.ts` (14): the first turn opens a web
  conversation with both sides; later turns continue it; quoted → booked
  with the guest's name, never moving back; a failed AI turn still records
  the guest; an invalid hotel records nothing; human mode makes no model
  call and returns the holding reply; another hotel's or a mocked thread's
  id starts a fresh thread; a retried message isn't recorded twice while a
  new one still is; a staff reply written during the model call keeps its
  place in the thread and its place in the count; the polling endpoint
  returns messages after a cursor, refuses other hotels' and unknown ids,
  and has no hotelId.
- `tests/unit/conversations.test.ts` (15): document reading and fallbacks,
  booking progress, sort, filter, search, counts, snippets, relative
  times, id format, sample threads (one per mocked channel, no prices) and
  staff-reply deduplication.

**Browser, against the real local API and the emulator**
(`scripts/verify/inbox-ui.mjs`, 51 checks in total with §11 and §12; setup in its header and
`scripts/verify/seed-emulator-demo.ts`): the empty state; sample threads
with every required field; ordering; channel filter; search; thread view
with the simulated-channel notice; take over, reply, return to AI; a real
web guest reaching the inbox live; human mode's holding reply; the guest's
message reaching staff; the staff reply reaching the guest page, once; a
retried message leaving one copy in the inbox; staff stepping in with a
reply before the guest writes again and still reaching them; the
notice clearing on hand-back; mobile list and thread; another hotel's inbox
isolated; the Settings concierge link, shown and created, resolving through
the API.

## 11. Lead scoring (Phase 5)

**Automated**
- `tests/unit/leadScoring.test.ts` (20): what each signal looks like in a
  guest's own words — booking intent, dates in six forms, price questions,
  contact details (and an ISO date that must not read as a phone number),
  groups and long stays in digits and in words, suites and occasions;
  signals accumulating across turns; a confirmed booking speaking for
  itself; stored signals read back, malformed ones ignored; each of the
  four scores with the reasons it gives; the same conversation always
  scoring the same.
- `tests/unit/conversations.test.ts`: filtering by score, combining that
  with the channel filter and search, and counts per score (an unscored
  conversation counts only in the total).
- `tests/server/conversations.test.ts`: a general question scores cold; a
  guest warms up on dates and prices, then runs hot on asking to book, with
  the earlier signals still counted; a confirmed suite booking for an
  anniversary is VIP; a turn the AI couldn't answer is still scored.
- `tests/rules/conversations.test.ts`: a score and its reasons can be
  stored and cleared; an unknown score, a missing or malformed `reasons`,
  an extra key or more than 8 reasons are all refused.

**Browser, against the real local API and the emulator**
(`scripts/verify/inbox-ui.mjs`): the sample threads score 🌤 Warm, 🔥 Hot
and ⭐ VIP by the documented rules, with none left unscored; the lead
filter shows one score at a time, carries counts, and combines with the
channel filter; a thread spells out why the guest scored as they did; and a
real web guest is scored from what they asked, on a turn Gemini refused.

## 12. Follow-ups (Phase 6)

**Automated**
- `tests/unit/followUps.test.ts` (17): each score's waiting threshold,
  crossed and not crossed; the wait measured from when the guest wrote, not
  from the thread's last change; a booked guest still chased for an
  unanswered question; the quiet rule a day after the hotel's last word, and
  the four reasons it does not apply; a guest not chased twice until they
  write back; a snooze holding and expiring; the order to work down
  (hottest, then longest wait); and the suggested message — the guest's
  name, the hotel's name, what they asked about, no figure a hotel would
  have to honour, the booking reference when there is one, and the same
  text every time.
- `tests/unit/conversations.test.ts`: the follow-up moments read back from a
  document and defaulting to nothing; the sample threads standing for the
  three states (just written, waiting, went quiet).
- `tests/server/conversations.test.ts` (3): the gateway records when the
  guest last wrote; a later guest message moves it forward; a retried
  message does not, so a guest who has been waiting keeps their wait.
- `tests/rules/conversations.test.ts` (2): the three moments can be stored
  and cleared; anything that isn't a time is refused.

**Browser, against the real local API and the emulator**
(`scripts/verify/inbox-ui.mjs`): the count of guests owed something; the
waiting guest and the quiet guest marked, and the one who has just written
left alone; the filter showing only those two, hottest first; the suggested
message built from what that guest actually said, with their booking
reference; the wait shown in the thread; staff editing the draft and that
edited text being what reaches the thread; the row's latest message and the
reminder clearing; the AI concierge still on the chat afterwards; the count
dropping; and "Not now" taking a guest off the list without writing
anything to them.

## 13. Production readiness (Phase 7)

**Automated, no account needed**
- `npm run verify:vercel` (8 checks with the emulator, 7 without): every
  file under `api/` bundles for the Node runtime; each bundle exports the
  default handler the platform calls; no credential is baked into a bundle;
  and the bundles — not the sources — answer over HTTP: health reports its
  configuration, an unknown hotel is refused safely with no id or stack in
  the body, the wrong method is 405, an unknown thread is 400, and with the
  emulator seeded a real hotel lookup returns no internal id.
- `npm run verify:release` (10 checks): no server-only environment name and
  no emulator host in `dist/`; the real `GEMINI_API_KEY` and
  `FIREBASE_SERVICE_ACCOUNT` values from `.env` appear nowhere in it; no
  private key material; the only Google key is the public Firebase Web key;
  no source maps; every asset content-hashed; the entry page loads a hashed
  bundle and points at no development server.

**Manual, gated on accounts** — `DEPLOYMENT.md` §6: health, then a probe,
then a workspace, a concierge link, a real guest question, a booking, the
inbox, and a search of the deployed page for `AIza`. None of it has been
run: there is no deployment.
