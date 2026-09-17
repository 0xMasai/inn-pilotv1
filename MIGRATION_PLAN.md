# InnPilot: migration plan — single-hotel PMS + concierge → network AI Concierge

_Written 2026-09-16, before any restructuring code was changed._

## Starting point (audited)

Baseline verified before changes: `FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npx vitest run`
→ **18 files, 354 tests passed**.

| Area | What exists | Verdict |
| --- | --- | --- |
| Entry / routing | `src/main.tsx` (HashRouter), `src/App.tsx`. `/` = PMS marketing landing, redirects a returning workspace to `/dashboard`. `/c/:publicHotelId` = one hotel's concierge. | **Restructure**: `/` becomes the network concierge; landing moves to `/staff`. |
| Firebase init | `firebase.ts` (client, memory cache, dev emulator switch); `server/admin.ts` (Admin, lazy). | **Keep.** |
| Data model | `hotels/{hotelId}` + `rooms`, `accomodation` (legacy spelling), `reservations`, `conversations/messages`, `auditLog`, bar/restaurant/parking/expenses; `publicHotels/{publicId}`. No region, amenities, capacity or network flag. | **Keep**, add fields (listed, region, country, amenities, times, policies, room capacity). |
| Availability | `src/lib/booking.ts` `checkRoomBookable/isRoomBookable/bookingOverlaps` shared by app + server; `server/ai/tools/inventory.ts` loads rooms & stays from both stay collections. | **Keep, reuse as-is.** |
| Pricing | Room document `price`; `nightlyRateOf()`; totals = rate × nights in tools. No seasonal pricing exists. | **Keep, reuse.** |
| Reservation creation | `server/ai/tools/createReservation.ts`: Admin transaction, re-check, `buildBookingDoc`, audit entry, `makeReservationId`. Front desk creates via client SDK in `Accommodation.tsx`. | **Keep the transaction**; wrap it to book by room type across candidate rooms. |
| Gemini | `server/ai/gemini.ts` tool loop, `config.ts`, `errors.ts`, trace. | **Keep.** |
| Tools | `get_hotel_info`, `check_availability`, `get_room_rates`, `create_reservation`, bound to ONE `HotelScope`. | **Refactor** into a network toolbox: + `search_hotels`, `calculate_stay_price`, `prepare_booking`; each tool takes a public hotel id. `get_room_rates` folded into search/price. |
| API | `api/ai/concierge.ts` (requires `publicHotelId`), `hotel.ts`, `conversation.ts`, `health.ts`; `server/dev-server.ts`. | **Refactor** concierge + conversation for network threads; **add** `network.ts`. |
| Staff UI | `dashboard.tsx` shell; Dashboard, Inbox, Accommodation, Restaurant, Bar, Parking, Expenses, Reports, Settings. | **Keep.** Inbox gains Selected hotel + Status; Settings gains the concierge listing card. |
| Auth | None by design (D2): the workspace id is the key; rules are the access control. | **Keep.** Guests never hold a workspace id. |
| Inbox / handoff | Per-hotel conversations written by the gateway; take over / reply / hand back; guest page polls. | **Keep**, fed by per-hotel mirrors of a canonical network thread. |
| Lead scoring / follow-ups | Deterministic, `src/lib/leadScoring.ts`, `followUps.ts`. | **Keep** unchanged. |
| Obsolete | PMS marketing copy as the public home; single-hotel concierge side panel (`SidePanel.tsx` date form + rooms list); `get_room_rates` as a separate tool; unused `.env` keys (`VITE_AI_API_BASE`, `AI_*`). | **Retire / move.** |
| Duplicates / conflicts | Two booking write paths (front desk client, concierge server) — both use `buildBookingDoc` + shared rules, so no conflict. `PHONE_PATTERN` duplicated in onboarding + createReservation (minor). | Leave; not worth churn. |

No usable hotel inventory is reachable: the only project is production
(`hotel-management-c183c`), whose writes are gated (D22), and the emulator
holds only test fixtures. A **clearly labelled K Hotels demo seed** is
therefore required for the golden path (D28).

## Phases

| Phase | Work | Done when |
| --- | --- | --- |
| 0 | Audit; write ARCHITECTURE, MIGRATION_PLAN, MVP_SCOPE, PROJECT_STATUS, DECISIONS D23+ | These files exist |
| 1 | Routes: `/` network concierge, `/c/:id` scoped, `/staff` entry + open-workspace, `/pms` alias. New home page UI. | Build passes; guest never sees PMS UI |
| 2 | Network toolbox + prompt; hotel listing fields; `server/network.ts` | Unit + server tests for every tool |
| 3 | `search_hotels`: destination match, availability, pricing, ranking, ≤5 options | Server tests incl. no-hotel / no-room cases |
| 4 | `prepare_booking`, summary card, confirmation guard | Server tests: no booking without earlier summary + confirmation |
| 5 | `create_reservation` by room type via existing transaction; confirmation card | Booking visible in `accomodation`; concurrency test |
| 6 | Canonical conversation + mirrors; handoff across hotels; Inbox Selected hotel/Status/Close | Server tests; staff sees conversation + booking |
| 7 | End-to-end: gateway tests with scripted Gemini for the exact demo; browser check; live Gemini attempt | PROJECT_STATUS evidence |
| 8 | lint, build, `verify:vercel`, `verify:release`; rules deploy remains gated | All green |

## Data migration for existing hotels

Nothing is rewritten. A hotel joins the network search only when
`listed: true` (Settings → AI Concierge listing, or the seed). Hotels without
a `publicId` still need D16's one-time mapping before they can be listed.
Rooms without `capacity` are still searchable; capacity is simply not
claimed for them.

## Rollback

Every change is additive in Firestore. Reverting the code restores the
single-hotel concierge; the extra hotel fields and `conciergeConversations`
are ignored by the old code.
