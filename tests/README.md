# Security rules tests

The suites under `tests/rules/` exercise the real `firestore.rules` file
against the Firestore emulator (not a mock). Every request is made
unauthenticated, exactly as the app makes them: InnPilot has no user
accounts, so these tests pin down what stands in for authentication.

## Run it

One-time: the Firestore emulator needs a JRE available on your machine
(the emulator itself is a Java process). Then:

```bash
# everything at once, with the emulator started for you
npm run test:all

# or, with an emulator already running on :8080
npx firebase emulators:start --only firestore
npm run test:rules
```

`npm run test:rules:watch` re-runs on file changes if you're iterating
on the rules themselves.

## What's covered

- **`workspace.test.ts` — the workspace itself.** A workspace can only be
  created under an unguessable Firestore-generated id; it can never be
  discovered by listing `/hotels` or by a collection-group query; it
  starts on the trial plan and cannot upgrade itself; it cannot be
  deleted or overwritten by re-creation; onboarding's hotel + rooms batch
  succeeds; the retired `users` collection is unreachable.
- **`operational-data.test.ts` — rooms, bookings, reservations, restaurant,
  expenses, audit log.** Writes must land in a hotel that exists and carry
  that hotel's id; statuses stay within their enums; `reservations` is
  server-written only; expenses and audit entries are immutable; nothing
  the app never deletes can be deleted; oversized documents are refused.
- **`bar-parking.test.ts` — bar and parking.** Stock can never go
  negative; products are archived rather than deleted; sales and stock
  transfers are append-only; parking statuses stay within their enum.
- **`room-editing.test.ts` — editing a room.** The app's own room service
  changes a room's type and rate in place: same id, no new document,
  unrelated fields untouched, invalid rates refused.

## Other suites

- **`tests/unit/`** (`npm run test:unit`, no emulator) — the shared booking
  rules in `src/lib/booking.ts` and onboarding's starting inventory.
- **`tests/server/`** (`npm run test:server`, emulator on :8080) — the AI
  concierge's server tools through the real Firebase Admin SDK (hotel
  isolation, availability, the booking transaction under concurrent
  bookings), and `POST /api/ai/concierge` end to end with Gemini scripted.
  No Gemini key or network call is needed.

## Adding a case

New rule → new test, in the suite that covers that collection. Each
`it()` should assert exactly one allow/deny outcome — that's what makes a
failure point straight at the rule that broke, instead of requiring
someone to puzzle through a multi-assertion test.
