# InnPilot K Hotels AI Challenge build: MVP scope

This defines what the challenge build includes and excludes. Progress
against it is tracked only in [`PROJECT_STATUS.md`](PROJECT_STATUS.md).
Anything not listed under "In scope" is out of scope until this file is
changed on purpose.

_Last updated: 2026-09-16._

---

## Product in one sentence

An account-free operations workspace for an independent hotel, showing
where money moves (rooms, restaurant, bar, parking, expenses), plus an AI
concierge that answers guest questions and takes reservations from the
hotel's own data.

## In scope

### Phase 1: workspace app (built)

- **Get Started:** a three-step wizard (hotel name, city and currency;
  phone, email and room count; review). It creates a workspace with a
  starting room inventory and nightly rates.
- **Workspace resolution:** the browser remembers the workspace id and
  checks it with Firestore before opening the dashboard. There are no user
  accounts.
- **Eight modules:**
  - Dashboard
  - Accommodation (rooms, reservations, check-in/out, occupancy)
  - Restaurant
  - Bar (products, sales and store → bar transfers, with a stock floor)
  - Parking
  - Expenses
  - Reports (daily/weekly/monthly; PDF and CSV export)
  - Settings (hotel profile, currency, workspace id, activity log)
- **One source for every figure:** `src/lib/metrics.ts`.
- **Firestore rules** that serve as the access control for the
  account-free model, tested against the emulator.

### Phase 2: AI tool foundation (built; real-model flow not yet verified)

- `POST /api/ai/concierge`: a guest-facing, login-free gateway with a rate
  limit, payload caps and guest-safe error messages.
- `GET /api/ai/health`: reports configuration, with an optional live probe.
- Gemini, called only from the server. The key never reaches the browser.
- Four tools, bound to exactly one hotel resolved on the server:
  - `get_hotel_info`
  - `check_availability`
  - `get_room_rates`
  - `create_reservation` (transactional, audited, safe under concurrent
    bookings)
- Firebase Admin access for the server, through a service account or ADC,
  or the emulator in tests.

**Phase 2 is complete when** a real Gemini turn calls the tools and a
reservation lands correctly in Firestore, verified per
[`TEST_PLAN.md`](TEST_PLAN.md) §5.

### Phase 2B: public hotel identity (built; see DECISIONS D14)

- Each hotel has a guest-facing `publicId`, separate from its private
  workspace `hotelId`.
- `resolveHotel()` is the one place a public id becomes a hotel. Tools get
  the resolved scope and cannot be pointed at another hotel.
- The concierge API accepts only the public id and never returns a
  `hotelId`. Invalid ids fail safely.
- Automated tenant-isolation tests.

Not included: the per-hotel concierge on/off switch (still deferred).

### Phase 3: guest concierge UI (built; real-Gemini flow not yet verified)

- `/#/c/:publicHotelId`: the hotel's public AI concierge. It has a header
  with the lowest rate, a chat with suggested questions, a date checker, a
  rooms-and-rates list, and contact details.
- Availability comes back as bookable room cards with stay totals. A
  confirmed booking ends on a confirmation card with its reference.
- Loading, not-found, failure-with-retry and mobile layouts.
- A Settings card that shows and copies the concierge link, and creates one
  for an older workspace.
- `GET /api/ai/hotel`, plus structured `availability` and `booking` in the
  concierge reply (DECISIONS D18).

### Phase 4: unified inbox (built)

- `/dashboard/inbox`: every guest conversation, with channel filters and
  search. Each row shows guest, latest message, channel, AI/Human, lead
  score (Phase 5) and booking status.
- Web conversations are real, recorded by the concierge. WhatsApp,
  Instagram and Email are **mocked** sample threads, labelled as simulated.
- Staff can take a conversation over (the AI stops answering), reply, and
  hand it back. On web, the guest's page shows staff replies.
- Not included: real channel integrations, assignment to named staff (the
  app has no staff accounts), notifications (DECISIONS D19).

### Phase 5: lead scoring (built)

- Every conversation is scored 🔥 Hot, 🌤 Warm, ❄ Cold or ⭐ VIP from what
  the guest said and did — asked to book, gave dates, asked prices, left
  contact details, a group or long stay, an occasion, a suite — plus what
  the concierge did: showed availability, took a booking.
- Deterministic rules, no model call, so the score is free, instant, always
  the same, and explainable. Every score carries its reasons, shown in the
  badge and written out at the top of the thread (DECISIONS D20).
- The inbox filters by score, with counts, alongside the channel filter and
  search.
- Web conversations are scored by the gateway as they happen, including
  turns the AI failed to answer. Sample threads are scored by the same
  rules when they are added.
- Not included: backfilling conversations recorded before Phase 5, scoring
  in other languages, and anything acting on a score by itself (follow-ups
  are Phase 6).

### Phase 6: follow-ups (built)

- The inbox shows which guests the hotel still owes something: a guest
  whose message nobody answered (sooner the hotter the lead — VIP and Hot
  after 1 hour, Warm 2, Cold 6), and an interested guest who went quiet for
  a day without booking.
- A "Needs follow-up" toggle with a live count, hottest first and longest
  wait first. Rows and threads show how long the guest has been left.
- Each one comes with a suggested message, written by the same
  deterministic rules as the scoring, from what that guest asked about. It
  promises nothing — no price, no room, no date — it offers to check.
- **Nothing is sent automatically.** Staff read the draft, edit it and
  press Send. "Not now" puts a guest off for a day (DECISIONS D21).
- Sending a follow-up leaves the AI concierge on the chat, so it can take
  the guest's answer through to a booking. A guest is chased once until
  they write back.
- Not included: scheduling or sending anything unattended, thresholds a
  hotel can tune, follow-ups on a real WhatsApp/Instagram/Email channel
  (still mocked), and any reminder outside the app (no email or push).

### Phase 7: production readiness (built; the deployment itself is gated)

- The functions under `api/` are built and run the way the platform builds
  them — bundled to ESM and called for real — so the extensionless imports
  that broke the previous AI layer on Vercel are proved to resolve
  (`npm run verify:vercel`).
- What ships to the browser is checked for credentials by value as well as
  by name, for the emulator switch, for source maps and for unhashed assets
  (`npm run verify:release`).
- `vercel.json` pins the function duration and sets caching and security
  headers; `package.json` pins the Node runtime.
- `index.html` no longer carries an origin-trial token issued to another
  deployment, and its description matches what this build actually does.
- [`DEPLOYMENT.md`](DEPLOYMENT.md): what deploys, the environment variables
  and which are public, the preview steps, how to check a deployment, how to
  roll back, and the risks that remain in production.
- **Not included, and gated on an explicit decision:** creating the Vercel
  project, deploying anything (preview or production), and deploying
  `firestore.rules` to any project that holds real data. Also not included:
  a custom domain, a content-security policy, monitoring or alerting.

### Later work (named, not started; order and detail to be defined)

Do not start any of these until the phase before is complete and this
file describes the item:

- **Final QA** (Phase 8)

Known prerequisite before a public concierge goes live, listed as "Not
yet" in `api/ai/concierge.ts`:

- a per-hotel on/off switch for the concierge.

(The guest-facing hotel identifier is now built: Phase 2B.)

## Out of scope

- **User accounts, login, sign-up, roles and super-admin.** These were
  removed on purpose (see `DECISIONS.md`).
- **Full PMS features:** housekeeping board, room-service ticketing,
  maintenance queue, staff rota, guest CRM.
- **Billing, payments and plan upgrades.** Every workspace is on the trial
  plan, and the rules forbid changing it.
- **Channel managers / OTA integrations.**
- **File uploads.** Firebase Storage is deny-all.
- **Deleting data.** Trails are append-only, and products are archived.
- **Pushing to a remote, deploying to Vercel, and deploying rules or
  touching production Firestore data.** None happens until it is
  explicitly scheduled.

## Present in the code but not a deliverable

- **Electron desktop shell** (`electron/`, `npm run desktop`). It is kept
  working but is not verified for this build.
- **`scripts/admin/migrate.ts`:** an operator script. It is not part of
  the product.
