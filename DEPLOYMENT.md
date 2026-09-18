# InnPilot: deploying the challenge build

**Nothing in this file has been run.** The source is on GitHub
(`0xMasai/inn-pilotv1`), but there is no Vercel project and no deployment. Every step below is written to be followed by a person
holding the accounts, and everything that touches a live project is marked
**GATED** — it needs an explicit decision, because it is hard to undo.

What has been verified locally is listed at the end.

---

> **Restructure note (2026-09-16):** the product is now the network AI Concierge (DECISIONS D23–D30). Demo inventory comes from `npm run seed:k-hotels`; running it against a real project needs `--confirm-real-project=<id>` and is **GATED** like every other production write.

## 1. What deploys

| Part | Where it runs | Built by |
| --- | --- | --- |
| The public AI Concierge (`/#/`), hotel links (`/#/c/:id`) and the staff PMS (`/#/staff`, `/#/dashboard`) | Vercel static hosting, from `dist/` | `npm run build` (Vite) |
| `api/ai/concierge`, `api/ai/conversation`, `api/ai/network`, `api/ai/hotel`, `api/ai/health` | Vercel Node functions, one per file under `api/` | Vercel compiles each `.ts` file to its own `.js` and runs it as an ES module, so relative imports must end in `.js` |
| Firestore data and `firestore.rules` | A Firebase project | `firebase deploy --only firestore:rules` — **GATED**, see §5 |

The app uses `HashRouter`, so every route is a `#` fragment and the host only
ever serves `/`. No rewrite rules are needed. `vite.config.ts` sets
`base: './'` so the same build also runs from `file://` in the Electron
shell; on a root deployment the relative URLs resolve identically.

## 2. Before you start: what only you can provide

These are the standing blockers. The first two stop the concierge working at
all in production.

1. **A Groq API key** (https://console.groq.com/keys), set as `GROQ_API_KEY`.
   The free plan is enough for a demo, with limits worth knowing (D31): on
   `openai/gpt-oss-120b` it is 30 requests/minute, 1,000/day and **8,000
   tokens/minute**. A tool turn is ~5K tokens, so one guest can sustain about
   one search/booking turn every 40 s; a full booking conversation is 7
   requests. Past that, guests get the safe "try again in a moment" message.
   Do **not** set `GROQ_MODEL=groq/compound-mini`: Compound models cannot
   call tools (HTTP 400), and the gateway refuses them.
2. **A Firebase service-account key (JSON).** The functions read and write
   Firestore through the Admin SDK. Note what this key is: it **bypasses
   `firestore.rules` entirely**. It belongs in Vercel's encrypted
   environment variables and nowhere else — never in the repository, never
   in a `VITE_` variable, never in a log.
3. **A decision about which Firebase project to deploy against.** Today
   `.firebaserc` names only `hotel-management-c183c`, which is the frontend's
   configured project. Read §5 before pointing anything at a project that
   already holds real data.

## 3. Environment variables

Set these in the Vercel project (Settings → Environment Variables), for both
Preview and Production. `.env.example` is the annotated master list.

**Public — bundled into the browser, world-readable by design:**

```
VITE_FIREBASE_API_KEY, VITE_FIREBASE_AUTH_DOMAIN, VITE_FIREBASE_PROJECT_ID,
VITE_FIREBASE_STORAGE_BUCKET, VITE_FIREBASE_MESSAGING_SENDER_ID,
VITE_FIREBASE_APP_ID, VITE_FIREBASE_MEASUREMENT_ID
```

The Firebase Web API key is *meant* to be public: it identifies the project.
What protects the data is `firestore.rules`, which is why §5 matters.

**Secret — read only by the functions, never prefixed `VITE_`:**

```
AI_PROVIDER                groq (default) | gemini
GROQ_API_KEY               required for groq
GROQ_MODEL                 openai/gpt-oss-120b (default; must support tool calling —
                           groq/compound-mini cannot, and invented hotels when tried; D31)
FIREBASE_SERVICE_ACCOUNT   required — the service-account JSON, or base64 of it
ALLOWED_ORIGINS            optional — only if the app is served from another origin
GROQ_REASONING_EFFORT, GROQ_MAX_OUTPUT_TOKENS, GROQ_TEMPERATURE,
GROQ_TIMEOUT_MS            optional — defaults in server/ai/config.ts
GEMINI_API_KEY, GEMINI_*   only for AI_PROVIDER=gemini
```

Never set `VITE_FIRESTORE_EMULATOR_HOST` or `FIRESTORE_EMULATOR_HOST` on
Vercel. `npm run verify:release` fails the build output if either reaches the
bundle.

`GROQ_TIMEOUT_MS` (or `GEMINI_TIMEOUT_MS`) must stay below the `maxDuration` in `vercel.json`
(currently 30s, with the timeout at 25s) or the platform kills the function
before the handler can return a guest-safe message.

## 4. Deploying a preview

```bash
npm ci
npm run lint && npm run build          # must both exit 0
node scripts/verify/release-check.mjs  # what ships to the browser
npm run verify:vercel                  # the functions, built the way Vercel builds them

npx vercel login
npx vercel link                        # creates .vercel/ (git-ignored)
npx vercel                             # preview deployment, NOT production
```

`npx vercel --prod` is the production deploy. **GATED** — do not run it until
a preview has been checked against §6 and the Firestore project question in
§5 is settled.

## 5. Firestore rules — read this before deploying them

**GATED. This is the step that can expose or destroy real data.**

`firestore.rules` implements the account-free model: there is no login, and
**holding a 20-character `hotelId` is what grants access to that workspace**.
The rules are written around that (unguessable ids, no listing of `/hotels`,
no cross-hotel queries, nothing deletable), and they are tested against the
emulator — but deploying them to a project that already has data changes who
can read that data.

Before `firebase deploy --only firestore:rules`:

- **Deploy to a scratch project first.** A new Firebase project costs
  nothing and makes this reversible.
- **If the target project has existing hotels**, check them: hotels created
  under an older model may not have 20-character auto-ids, and none of them
  will have a `publicId`. A short or guessable id under these rules is a
  workspace anyone can open. `DECISIONS.md` D16 describes the one-batch
  migration; no script ships with this build.
- **Never deploy rules over a production project without a backup** and an
  explicit decision to do so.

`storage.rules` is deny-all; Storage is not used.

## 6. Checking a deployment

In this order. Stop at the first failure.

1. `GET /api/ai/health` → `{"status": "ok", "provider": "groq", "configured": true}`.
   `"not_configured"` (503) means `GROQ_API_KEY` did not reach the function, or
   `GROQ_MODEL` names a model that cannot call tools; the function log
   (`[health] not ok`) says which. The response never names the model.
2. `GET /api/ai/health?probe=1` → `{"status": "ok", …}`. This spends one real
   model request from the daily allowance and proves the key and model are
   accepted; `"unreachable"` (503) otherwise. It never retries.
3. Open the app, create a workspace, and confirm Settings shows a concierge
   link.
4. Open that link in a private window, ask a question, and confirm a reply.
   Check the browser's network tab: the request body must carry only the
   **public** id, and no response may contain the workspace `hotelId`.
5. Ask for availability, then book. Confirm the reservation appears in
   Accommodation with `source: "concierge"`.
6. Open the Inbox: the conversation should be there, scored, with the
   follow-up state that matches how long it has been sitting.
7. View source on the deployed page and search it for `AIza`. The only match
   may be `VITE_FIREBASE_API_KEY`.

## 7. Rolling back

Vercel keeps every deployment. Promote the previous one from the dashboard —
that is the fastest rollback and it needs no rebuild. Rules are separate:
redeploy the previous `firestore.rules` from the repository. **Data is not
rolled back by either**, and this build never deletes documents, which is
deliberate.

## 8. Risks that remain in production

- **The rate limit is in one function instance's memory**
  (`server/ai/rateLimit.ts`). Across cold starts a burst gets more headroom
  than the nominal limit, and a redeploy resets it. It is a budget guard, not
  a security control.
- **The concierge cannot be turned off per hotel.** The switch is still
  deferred (D13, D14). Every hotel with a public id has a live concierge.
- **Anyone holding a workspace id can use that workspace.** That is the
  account-free trade-off (D2), not a defect — but it means a leaked id is a
  leaked workspace, and Settings says so.
- **WhatsApp, Instagram and Email are simulated** (D19). The inbox labels
  them; nothing is sent on those channels, including follow-ups.
- **Nothing schedules or sends a follow-up on its own** (D21) — a person
  presses Send. There is no background job to misfire.

## 9. What has actually been verified, locally

| Check | Command | Result |
| --- | --- | --- |
| Functions build and answer as bundled ESM (health reports provider=groq) | `npm run verify:vercel` | 9/9 |
| Nothing secret ships to the browser (incl. any `gsk_` Groq key) | `npm run verify:release` | 11/11 |
| Unit, rules and server tests (Groq and Gemini scripted) | `npx vitest run` (emulator running) | see PROJECT_STATUS |
| Golden path on **real Groq**: request → options → summary → confirmed booking → staff sees it → handoff | `node scripts/verify/golden-path-ui.mjs` | see PROJECT_STATUS |

Not verified, and not verifiable without the accounts in §2: anything on
Vercel's own infrastructure, the headers in `vercel.json` (they only apply
once deployed), and a real Firestore project.
