# InnPilot AI Concierge: architecture

> InnPilot is an AI booking concierge that lets guests search multiple
> K Hotels properties and turn a natural-language request into a confirmed
> reservation.

This file describes how the system is built **after** the 2026-09-16
restructure. Why each choice was made is in [`DECISIONS.md`](DECISIONS.md)
(D23 onwards). How we got here from the single-hotel build is in
[`MIGRATION_PLAN.md`](MIGRATION_PLAN.md).

---

## 1. The shape of the product

```
                         ┌──────────────────────────────┐
  Guest (no login) ────▶ │  Public AI Concierge   /#/   │  React, HashRouter
                         │  (and /#/c/:publicHotelId)   │  never reads Firestore
                         └──────────────┬───────────────┘
                                        │ fetch
                         ┌──────────────▼───────────────┐
                         │  /api/ai/*  (Vercel functions)│  rate limit, CORS,
                         │  concierge · conversation ·   │  payload caps,
                         │  network · hotel · health     │  guest-safe errors
                         └──────┬───────────────┬────────┘
                                │               │
                 ┌──────────────▼───┐   ┌───────▼──────────────────┐
                 │ Groq (tools)     │   │ Network toolbox           │
                 │ server/ai/groq   │◀─▶│ search_hotels             │
                 │ intelligence     │   │ check_availability        │
                 └──────────────────┘   │ get_hotel_info            │
                                        │ calculate_stay_price      │
                                        │ prepare_booking           │
                                        │ create_reservation        │
                                        └───────┬──────────────────┘
                                                │ Firebase Admin SDK
                         ┌──────────────────────▼───────────────────┐
                         │ Firestore — the source of truth           │
                         │ hotels/{hotelId}  rooms  accomodation     │
                         │ reservations  conversations  auditLog     │
                         │ publicHotels/{publicId}                   │
                         │ conciergeConversations/{id}  (server-only)│
                         └──────────────────────▲───────────────────┘
                                                │ client SDK + rules
                         ┌──────────────────────┴───────────────────┐
  Hotel staff ─────────▶ │ Staff PMS  /#/staff, /#/dashboard/*       │
  (workspace key)        │ Inbox · Accommodation · Settings · …      │
                         └──────────────────────────────────────────┘
```

**The model provides intelligence; InnPilot provides truth.** The model never
sees a price, a room or a booking reference that a tool did not return in
this conversation, and the page renders result cards from tool output, never
from model prose.

## 2. Two experiences

| | Public (guest) | Staff (hotel team) |
| --- | --- | --- |
| Routes | `/#/` concierge; `/#/c/:publicHotelId` concierge scoped to one hotel | `/#/staff` (entry, open or create a workspace), `/#/dashboard/*` (PMS), `/#/pms` → dashboard |
| Identity | none | the workspace `hotelId`, held in `localStorage` (D2) |
| Data access | only through `/api/ai/*` | Firestore client SDK, constrained by `firestore.rules` |
| Writes | server-controlled only (Admin SDK) | rules-validated workspace writes |

A guest has no workspace id, so `/#/dashboard/*` redirects them to `/#/staff`.

## 3. Firestore data model

Existing collections are unchanged in meaning. New fields are additive.

```
hotels/{hotelId}                       workspace + hotel profile
  name, location (city), currency, phone, email, taxId, subscription, publicId
  + listed        boolean   participates in the network concierge search
  + region        string    e.g. "Western"
  + country       string    e.g. "Uganda"
  + description   string
  + amenities     string[]  e.g. ["Free Wi-Fi", "Breakfast included", "Parking"]
  + checkInTime   string    e.g. "14:00"
  + checkOutTime  string    e.g. "10:00"
  + policies      string    free text the hotel wrote

hotels/{hotelId}/rooms/{id}            number, type, price, status
  + capacity      number    guests the room sleeps (optional)
  + amenities     string[]  (optional)

hotels/{hotelId}/accomodation/{id}     bookings (legacy spelling); concierge
                                       bookings carry source:"concierge"
hotels/{hotelId}/reservations/{id}     older stays; read for availability
hotels/{hotelId}/conversations/{id}    the hotel's inbox MIRROR of a guest thread
  existing: channel, guestName, guestContact, handledBy, bookingStatus,
            reservationId, lead, leadSignals, lastMessage, lastGuestAt, …
  + selection        "none" | "this" | "other"
  + selectedHotelName string
  + bookedElsewhere  boolean
  + closed           boolean   staff closed it
  messages/{id}      role, text, at   (append-only)

publicHotels/{publicId} → { hotelId }  server-readable only (D14)

conciergeConversations/{id}            CANONICAL guest thread, server-only
  hotelIds[], selectedHotelId, pendingBooking, reservation, messageCount,
  pendingTurnId, createdAt, updatedAt
  messages/{id}      role, text, at
```

## 4. Server layer

| Module | Responsibility |
| --- | --- |
| `server/admin.ts` | Lazy Firebase Admin init (service account / ADC / emulator). |
| `server/hotels.ts` | `resolveHotel(publicId)` → `HotelScope`; `scopeForHotelId()` (server-internal, for inbox mirrors); `listNetworkHotels()` (hotels with `listed: true`). A scope can only reach `hotels/{hotelId}/…`. |
| `server/network.ts` | `NetworkContext`: which hotels this conversation may reach (all listed hotels, or exactly one hotel for `/c/:publicHotelId`), destination matching, option ranking. |
| `server/ai/tools/*` | The six tools. Each resolves the hotel through the network context from a **public id**, never a hotelId. |
| `server/ai/prompts/concierge.ts` | The concierge system instruction (identity, rules, booking protocol). |
| `server/ai/provider.ts` | Picks the model service per request from `AI_PROVIDER` (D31). |
| `server/ai/groq.ts` | Default provider (`groq-sdk`, `GROQ_MODEL`): tool rounds, turn timeout, one bounded retry, 429 `retry-after` handling, malformed-output checks. |
| `server/ai/gemini.ts` | Alternative provider, same contract. |
| `server/guestConversations.ts` | Canonical thread + per-hotel inbox mirrors; handoff state; pending booking. |
| `server/conversations.ts` | Writes one turn into one hotel's mirror (lead score, follow-up clock). |
| `api/ai/concierge.ts` | `POST` guest turn. |
| `api/ai/conversation.ts` | `GET` staff replies for the guest page (polling). |
| `api/ai/network.ts` | `GET` participating destinations for the home page (no model call). |
| `api/ai/hotel.ts` | `GET` one hotel's public header (scoped page). |
| `api/ai/health.ts` | `GET` configuration / probe. |

Shared, pure domain rules live in `src/lib/` and are imported by both the app
and the server: `booking.ts` (overlap, bookability, nightly rate, booking
document), `conversations.ts`, `leadScoring.ts`, `followUps.ts`,
`publicHotel.ts`, `hotelListing.ts` (destination matching, amenities).

## 5. The golden path, step by step

1. Guest: *"I need a double room between 10th and 15th October in Western Uganda."*
2. Gateway opens (or creates) the canonical conversation, checks that no
   staff member has taken it over, and calls the configured model (Groq) with the toolbox.
3. The model calls `search_hotels({destination:"Western Uganda", checkIn:"2026-10-10", checkOut:"2026-10-15", roomType:"Double"})`.
4. The tool lists `listed` hotels, matches the destination against city,
   region and country, loads each hotel's rooms and stays, applies the shared
   `isRoomBookable()` rule, prices with `nightlyRateOf() × nights`, and returns
   up to 5 ranked options. The gateway allow-lists them into `options` for the
   page's result cards and attaches those hotels to the conversation (their
   inbox now shows the lead).
5. Guest: *"I'll take the first one."* The model asks for name and phone.
6. Guest gives them. The model calls `prepare_booking`: details validated,
   availability re-checked, price re-calculated. Nothing is written except the
   conversation's `pendingBooking`. The page shows a **Booking summary** card
   with a Confirm button.
7. Guest: *"Confirm."* The model calls `create_reservation`. The server refuses
   unless (a) a pending booking from an **earlier** turn matches the
   arguments and (b) the guest's current message is an explicit confirmation.
   Then one Admin transaction per candidate room re-reads the room and its
   stays, books the cheapest free room of that type, writes the
   `accomodation` document (`source: "concierge"`) and an audit entry, and
   returns the real `reservationId`. If the price moved, nothing is booked.
8. The page shows **Booking confirmed** with the reference. The booked hotel's
   inbox mirror is `booked`; other hotels' mirrors are marked booked
   elsewhere (status Closed). Staff open Accommodation and see the booking.

## 6. Human handoff

Staff take over from the hotel's inbox (`handledBy: "human"` on their mirror).
On the next guest turn the gateway reads the mirrors of every attached hotel;
if any is human-handled it makes **no model call**, records the guest's
message and returns a holding reply. The guest page polls
`GET /api/ai/conversation` (5 s while staff handle it, 15 s otherwise), which
merges staff messages from every attached mirror by server time. Handing back
sets `handledBy: "ai"`.

## 7. Security model

- The model key and Admin credential exist only in server env (`GROQ_API_KEY` / `GEMINI_API_KEY`,
  `FIREBASE_SERVICE_ACCOUNT`); nothing `VITE_`-prefixed is secret.
- Guests cannot write Firestore at all: `conciergeConversations` and
  `publicHotels` are client-denied, `reservations` is server-only, and every
  other write needs a workspace id the guest never sees.
- Tools accept public ids only; an unlisted hotel is unreachable from the
  network concierge, and a scoped `/c/` conversation can reach only its hotel.
- A booking needs two server-enforced conditions beyond the model's intent:
  a summary shown in an earlier turn, and an explicit confirmation message.
- Staff access is the unchanged workspace-key model (D2/D3): unguessable,
  unlistable hotel ids, rules-validated writes.

## 8. Running it

```bash
npx firebase emulators:start --only firestore        # Java required
npm run seed:k-hotels                                 # demo network, emulator only
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_PROJECT_ID=innpilot-demo npm run dev:api
VITE_FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 VITE_FIREBASE_PROJECT_ID=innpilot-demo npm run dev
```

Guest: `http://localhost:5173/#/` · Staff: `http://localhost:5173/#/staff`
(paste a workspace id the seed printed).
