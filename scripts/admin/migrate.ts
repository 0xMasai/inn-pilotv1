/**
 * Migrates pre-multi-tenant Firestore data into the hotels/{hotelId}/...
 * tenant structure (see src/lib/hotelScope.ts).
 *
 * Source shape (old, flat, single-tenant): top-level collections
 * `accomodation`, `rooms`, `restaurant`, `conferenceRooms`,
 * `conferenceSpaces`, `expenses`, `auditLog` — all unscoped, all
 * belonging implicitly to "the one hotel" the app used to assume.
 *
 * Target shape (new, multi-tenant): the same documents, same IDs, under
 * hotels/{hotelId}/{collection}/{docId}.
 *
 * SAFETY:
 *   - Defaults to a dry run (reports what it would do, writes nothing).
 *     Pass --execute to actually write.
 *   - Idempotent: re-running (dry or real) after a partial run skips
 *     any destination doc that already exists, so it's safe to re-run
 *     after a failure without creating duplicates.
 *   - Never deletes or modifies the legacy top-level collections
 *     (accomodation/rooms/etc). Those stay in place, untouched, as a
 *     backup — the app's Firestore rules already deny all client access
 *     to unmatched top-level paths, so leaving them doesn't reopen the
 *     old single-tenant surface. Delete them yourself, manually, only
 *     once you've verified the migrated data in the app.
 *
 * Usage (dry run first, always):
 *   GOOGLE_APPLICATION_CREDENTIALS=./serviceAccountKey.json \
 *   npx tsx scripts/admin/migrate.ts --hotel-id=<hotelId>
 *
 * Then, once the report looks right:
 *   GOOGLE_APPLICATION_CREDENTIALS=./serviceAccountKey.json \
 *   npx tsx scripts/admin/migrate.ts --hotel-id=<hotelId> --execute
 *
 * The target hotel must already exist: create it from the app's Get
 * Started wizard and copy its Workspace ID from Settings.
 */
import { adminDb, readArg, requireFlag } from "./lib/adminApp";
import { FieldValue } from "firebase-admin/firestore";

const LEGACY_COLLECTIONS = [
  "accomodation", // misspelling intentional — matches legacy docs (see src/lib/collections.ts)
  "rooms",
  "restaurant",
  "conferenceRooms",
  "conferenceSpaces",
  "expenses",
  "auditLog",
] as const;

const BATCH_LIMIT = 400; // stay under Firestore's 500-write batch cap

async function migrateCollection(name: string, hotelId: string, execute: boolean) {
  const sourceSnap = await adminDb.collection(name).get();
  if (sourceSnap.empty) {
    console.log(`  ${name}: 0 documents — nothing to do.`);
    return { total: 0, copied: 0, skipped: 0 };
  }

  const destCollection = adminDb.collection("hotels").doc(hotelId).collection(name);
  let copied = 0;
  let skipped = 0;
  let batch = adminDb.batch();
  let opsInBatch = 0;

  for (const docSnap of sourceSnap.docs) {
    const destRef = destCollection.doc(docSnap.id);
    const destSnap = execute ? await destRef.get() : null;
    if (execute && destSnap?.exists) {
      skipped++;
      continue;
    }

    if (execute) {
      batch.set(destRef, {
        ...docSnap.data(),
        migratedFrom: `${name}/${docSnap.id}`,
        migratedAt: FieldValue.serverTimestamp(),
      });
      opsInBatch++;
      if (opsInBatch >= BATCH_LIMIT) {
        await batch.commit();
        batch = adminDb.batch();
        opsInBatch = 0;
      }
    }
    copied++;
  }

  if (execute && opsInBatch > 0) {
    await batch.commit();
  }

  console.log(
    `  ${name}: ${sourceSnap.size} found, ${copied} ${execute ? "copied" : "would copy"}${
      skipped ? `, ${skipped} skipped (already migrated)` : ""
    }.`
  );
  return { total: sourceSnap.size, copied, skipped };
}

async function main() {
  const argv = process.argv.slice(2);
  const hotelId = readArg("hotel-id", argv);
  const execute = requireFlag("--execute", argv);

  if (!hotelId) {
    console.error("Missing --hotel-id=<id>. Create the hotel from the app's Get Started wizard, then copy its Workspace ID from Settings.");
    process.exit(1);
  }

  const hotelSnap = await adminDb.collection("hotels").doc(hotelId).get();
  if (!hotelSnap.exists) {
    console.error(`hotels/${hotelId} does not exist. Create it from the app's Get Started wizard before migrating data into it.`);
    process.exit(1);
  }

  console.log(`${execute ? "EXECUTING" : "DRY RUN"} — migrating legacy data into hotels/${hotelId} (${hotelSnap.data()?.name})\n`);

  console.log("Operational collections:");
  for (const name of LEGACY_COLLECTIONS) {
    await migrateCollection(name, hotelId, execute);
  }

  if (!execute) {
    console.log("\nThis was a dry run — nothing was written. Re-run with --execute to apply.");
  } else {
    console.log("\nMigration complete. Legacy top-level collections were left in place, untouched.");
  }
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
