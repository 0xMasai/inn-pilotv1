# InnPilot AI Concierge

> InnPilot is an AI booking concierge that lets guests search multiple K Hotels
> properties and turn a natural-language request into a confirmed reservation.

Built for the K Hotels AI Innovation Challenge, which targets two problems:
**slow guest response times** and **low inquiry → booking conversion**.

A guest types *"I need a double room between 10th and 15th October in Western
Uganda."* InnPilot understands the request, searches live inventory across every
participating hotel, shows a few real options with real prices, collects a name
and phone number, shows a booking summary, and — after an explicit yes — creates
the reservation in the hotel's own system and returns the real booking
reference. Hotel staff see the booking in their PMS and the conversation in
their inbox, and can take over at any moment.

## Two experiences

| | Where | Who |
| --- | --- | --- |
| **AI Concierge** | `/#/` — all participating hotels · `/#/c/:publicHotelId` — one hotel's own link | Guests. No account. |
| **Staff PMS** | `/#/staff` — open or create a workspace · `/#/dashboard/*` — Inbox, Accommodation, Settings and the other modules | Hotel teams, by workspace id. |

## How it works

```
Guest ──▶ React concierge ──▶ /api/ai/concierge ──▶ Groq (understands, chooses tools)
                                      │
                                      ▼
            search_hotels · check_availability · get_hotel_info
            calculate_stay_price · prepare_booking · create_reservation
                                      │  Firebase Admin
                                      ▼
            Firestore: hotels · rooms · accomodation · reservations · conversations
                                      ▲
Staff  ──▶ PMS + Inbox (Firestore client, security rules) ─┘
```

**The model provides intelligence; InnPilot provides truth.** Hotels, rooms,
availability, prices and booking references only ever come from tools reading
Firestore. A reservation needs a booking summary the guest saw in an earlier
turn **and** an explicit confirmation in their latest message — enforced on the
server, not just in the prompt. Every booking re-checks availability inside a
Firestore transaction and never books at a price the guest didn't confirm.

Full detail: [`ARCHITECTURE.md`](ARCHITECTURE.md) · decisions:
[`DECISIONS.md`](DECISIONS.md) (D23–D30 for the concierge, D31 for Groq) · scope:
[`MVP_SCOPE.md`](MVP_SCOPE.md) · status and evidence:
[`PROJECT_STATUS.md`](PROJECT_STATUS.md).

## Run it locally

```bash
npm install
cp .env.example .env                                   # add GROQ_API_KEY

npx firebase emulators:start --only firestore          # Java required
npm run seed:k-hotels -- --reset                       # 5 labelled DEMO hotels (emulator only)

FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_PROJECT_ID=innpilot-demo npm run dev:api
VITE_FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 VITE_FIREBASE_PROJECT_ID=innpilot-demo npm run dev
```

- Guest: <http://localhost:5173/#/> — try *"I need a double room between 10th and 15th October in Western Uganda."*
- Staff: <http://localhost:5173/#/staff> → **Open your workspace** → paste a hotel id the seed printed (e.g. `KHotelsKabale0000001`).

The seeded K Hotels properties, prices and bookings are **illustrative demo
data** (every hotel carries `demo: true`), not K Hotels' real inventory. The
seed refuses anything but a local emulator unless given
`--confirm-real-project=<id>`.

A real hotel joins the concierge from **Settings → AI Concierge listing**
(listed, region, amenities, check-in/out times, policies).

## Checks

```bash
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npx vitest run   # rules, server, unit (emulator required)
npm run lint && npm run build
npm run verify:release                                  # nothing secret ships to the browser
npm run verify:vercel                                   # functions bundled the way Vercel does, then called
node scripts/verify/golden-path-ui.mjs                  # the demo, in a real browser (see its header)
```

The model service is behind `server/ai/provider.ts`: `AI_PROVIDER=groq`
(default, `GROQ_MODEL=openai/gpt-oss-120b`) or `gemini`. On Groq's free plan
(8K tokens/minute) the browser run spaces turns 40 s apart and costs ~7 model
requests — run it once per change. Offline alternative: `AI_PROVIDER=gemini`
with the scripted stand-in (`scripts/verify/fake-gemini.mjs` +
`GEMINI_BASE_URL`), which replaces only the model. Groq's `compound` models
can't call tools and are refused (DECISIONS D31).

## Deploying

See [`DEPLOYMENT.md`](DEPLOYMENT.md). Deploying to Vercel, deploying
`firestore.rules`, and writing to a real Firebase project are all gated on an
explicit decision. The concierge needs `GROQ_API_KEY` in Vercel's environment.

Built by Masai Labs.
