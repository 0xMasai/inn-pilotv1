/**
 * Shared Firebase Admin SDK initialization for one-off operator scripts
 * (migrate.ts). These run OUTSIDE the client app — they are never bundled
 * by Vite (tsconfig.app.json only includes "src") and must never be
 * imported from anything under src/.
 *
 * Why Admin SDK and not the client SDK: bulk-copying legacy top-level
 * collections into hotels/{hotelId}/... needs to read collections the
 * rules deny to every client, and write with server authority (arbitrary
 * doc IDs, batched writes).
 *
 * Auth: relies on Application Default Credentials. Provide a service
 * account key via one of:
 *   - GOOGLE_APPLICATION_CREDENTIALS=/path/to/serviceAccountKey.json
 *   - Running inside an environment that already has ADC configured
 *     (gcloud auth application-default login, Cloud Shell, etc.)
 *
 * NEVER commit a service account key. See scripts/admin/README.md.
 */
import { readFileSync } from "node:fs";
import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

function loadApp(): App {
  const existing = getApps()[0];
  if (existing) return existing;

  const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const projectId = process.env.FIREBASE_PROJECT_ID;

  if (keyPath) {
    const serviceAccount = JSON.parse(readFileSync(keyPath, "utf8"));
    return initializeApp({
      credential: cert(serviceAccount),
      projectId: projectId ?? serviceAccount.project_id,
    });
  }

  // Falls back to Application Default Credentials (e.g. gcloud ADC).
  return initializeApp({ projectId });
}

export const adminApp = loadApp();
export const adminDb = getFirestore(adminApp);

/** Simple confirmation gate so destructive/mutating scripts don't run by accident. */
export function requireFlag(flagName: string, argv: string[]): boolean {
  return argv.includes(flagName);
}

export function readArg(name: string, argv: string[]): string | undefined {
  const prefix = `--${name}=`;
  const found = argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}
