# InnPilot AI Concierge: MVP scope

_Restructured 2026-09-16 for the K Hotels AI Innovation Challenge. The
previous scope (single-hotel operations workspace + per-hotel concierge) is
archived at [`docs/history/MVP_SCOPE-pre-restructure-2026-09-16.md`](docs/history/MVP_SCOPE-pre-restructure-2026-09-16.md)._

Progress against this file is tracked only in
[`PROJECT_STATUS.md`](PROJECT_STATUS.md).

## Product in one sentence

InnPilot is an AI booking concierge that lets guests search multiple K Hotels
properties and turn a natural-language request into a confirmed reservation.

## The problem it solves

K Hotels' challenge: **slow guest response times** and **low conversion from
inquiry to booking**. A guest today messages hotel after hotel, waits, and
compares by hand. InnPilot answers instantly, searches every participating
property's live inventory at once, and books in the same conversation.

**Core metric: inquiry → booking conversion.**

## The one job

> Turn a natural-language hotel inquiry into a confirmed reservation.

### The golden path (must work exactly)

1. Guest opens InnPilot (no login) and types *"I need a double room between
   10th and 15th October in Western Uganda."*
2. The AI extracts region, dates, room type (and guests if given), searches
   live inventory across all participating hotels, and shows 3–5 options:
   hotel, location, room type, capacity, price/night, nights, total,
   availability, amenities.
3. Guest: *"I'll take the first one."* The AI asks for name and phone.
4. The AI re-checks availability and price and shows a booking summary.
5. Guest: *"Confirm."* The AI re-checks again, creates the reservation in the
   real reservation system, and shows **Booking confirmed** with the real
   reference.
6. Staff open that hotel's InnPilot workspace: the reservation is in
   Accommodation and the conversation is in the Inbox as Booked.

## In scope

### Public experience (primary product)
- `/#/` — AI Concierge home: headline *Find your stay with AI*, explanation,
  large conversation area, suggested searches, participating destinations,
  result cards, booking summary card, confirmation card; mobile first.
- `/#/c/:publicHotelId` — the same concierge limited to one hotel (the link a
  hotel shares from Settings).
- No guest account. Conversation survives a reload in the same tab.

### AI layer
- Gemini (server-only) with a dedicated concierge system instruction.
- Tools: `search_hotels`, `check_availability`, `get_hotel_info`,
  `calculate_stay_price`, `prepare_booking`, `create_reservation`.
- Minimal clarification: dates are essential; destination and room type are
  asked for only when they genuinely block a useful search.
- Server-enforced booking safety: re-check before summary, re-check inside the
  booking transaction, summary shown in an earlier turn, explicit guest
  confirmation, price must match.

### Hotel data
- Participation flag and guest-facing profile per hotel: region, country,
  description, amenities, check-in/out times, policies. Room capacity.
- Editable by staff in Settings → AI Concierge listing.
- K Hotels demo seed for the emulator (and, only with explicit confirmation,
  a real project).

### Staff experience
- `/#/staff` entry: create a workspace or open one by its id.
- Existing PMS modules unchanged.
- Inbox: guest, conversation, last message, **selected hotel**, **status**
  (New / Active / Booked / Closed), lead (🔥 Hot / 🌤 Warm / ❄ Cold / ⭐ VIP),
  AI/Human. Take over, reply, hand back to AI, close.

## Out of scope (do not build)

Payment processing · OTA / channel manager integrations · loyalty · housekeeping ·
restaurant management changes · accounting · complex analytics · marketing
automation · native mobile apps · multilingual AI · advanced recommendation
algorithms · guest accounts · staff user accounts/roles · real WhatsApp /
Instagram / Email channels (the existing mocked sample threads stay as they are).

## Present but not a deliverable

- Existing PMS modules (Restaurant, Bar, Parking, Expenses, Reports) — kept
  working, not extended.
- Electron desktop shell.
- Deploying to Vercel, deploying `firestore.rules`, and writing to the
  production Firebase project — each **gated** on explicit approval.
