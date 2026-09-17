# Admin scripts

One-off, privileged operator scripts that run **outside** the client app,
using the Firebase Admin SDK (never the public `apiKey`, never shipped to
the browser).

There is one: **migrating legacy single-tenant data** into a hotel
workspace. Firestore rules deny client access to the old flat top-level
collections entirely (nothing in the ruleset addresses them, and the
catch-all at the bottom of `firestore.rules` denies anything unmatched), and
a client-side loop isn't the right tool for a one-time bulk copy anyway.

Hotels themselves need no script: anyone can create a workspace from the
app's **Get Started** wizard.

Not part of the Vite build — `tsconfig.app.json` only includes `src`, so
nothing here is bundled or shipped.

## Setup

1. In the Firebase console → Project Settings → Service Accounts, generate
   a new private key. Save it locally as e.g. `serviceAccountKey.json` —
   **do not commit it** (already covered by `.gitignore`).
2. Every command below needs the credential in the environment:
   ```bash
   export GOOGLE_APPLICATION_CREDENTIALS=./serviceAccountKey.json
   ```

## Migrate legacy single-tenant data into a workspace

1. Create the hotel from the app's **Get Started** wizard.
2. Copy its **Workspace ID** from **Settings → Hotel**.
3. **Always dry-run first.** It writes nothing, just reports what it would do:

   ```bash
   npx tsx scripts/admin/migrate.ts --hotel-id=<workspace id>
   ```

4. Once the report looks right:

   ```bash
   npx tsx scripts/admin/migrate.ts --hotel-id=<workspace id> --execute
   ```

This copies `accomodation`, `rooms`, `restaurant`, `conferenceRooms`,
`conferenceSpaces`, `expenses`, and `auditLog` from their old top-level
locations into `hotels/{hotelId}/...`, preserving document IDs.

It is safe to re-run: any destination document that already exists is
skipped, so an interrupted run can just be re-run.

**The old top-level collections are never deleted or modified.** Verify
the migrated data in the app first. Deleting the legacy collections
afterward is a deliberate, separate, manual step — not something this
script does for you.
