/**
 * The server's Firestore handle (Firebase Admin SDK).
 *
 * The Admin SDK bypasses firestore.rules entirely, which is why only two
 * modules import this one: `server/hotels.ts`, which hands out hotel scopes
 * (every read and write of hotel data goes through one), and
 * `server/guestConversations.ts`, which owns the server-only
 * `conciergeConversations` threads (DECISIONS D29). Tools never get a raw
 * database handle.
 *
 * Initialization is lazy. A missing or malformed credential then surfaces
 * as a handled error inside a request — a clean 503 with a request id —
 * instead of an import-time throw that crashes the whole serverless
 * function, preflight included.
 *
 * Credentials, in order:
 *   1. FIREBASE_SERVICE_ACCOUNT — the service-account JSON (or base64 of
 *      it) as an environment variable; what Vercel's secret store holds.
 *   2. Application Default Credentials — GOOGLE_APPLICATION_CREDENTIALS or
 *      ambient Google credentials.
 * With FIRESTORE_EMULATOR_HOST set, the SDK talks to the emulator, needs
 * only a project id (FIREBASE_PROJECT_ID), and any credential is ignored.
 */
import { applicationDefault, cert, getApps, initializeApp, type App, type AppOptions } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { AiConfigurationError } from "./ai/errors";

type Env = Record<string, string | undefined>;

function parseServiceAccount(raw: string): Record<string, unknown> {
  const text = raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Never echo the value: it is a private key.
    throw new AiConfigurationError(
      "FIREBASE_SERVICE_ACCOUNT is not valid service-account JSON (or base64 of it)."
    );
  }
}

function appOptions(env: Env): AppOptions {
  const projectId = env.FIREBASE_PROJECT_ID?.trim() || undefined;
  // The emulator ignores credentials, so don't let a stale one break local runs.
  if (env.FIRESTORE_EMULATOR_HOST) return { projectId };

  const raw = env.FIREBASE_SERVICE_ACCOUNT?.trim();
  if (raw) {
    const serviceAccount = parseServiceAccount(raw);
    return {
      credential: cert(serviceAccount),
      projectId: projectId ?? (serviceAccount.project_id as string | undefined),
    };
  }
  return { credential: applicationDefault(), projectId };
}

let cachedDb: Firestore | null = null;

export function adminDb(env: Env = process.env): Firestore {
  if (cachedDb) return cachedDb;
  try {
    const app: App = getApps()[0] ?? initializeApp(appOptions(env));
    cachedDb = getFirestore(app);
    return cachedDb;
  } catch (error) {
    if (error instanceof AiConfigurationError) throw error;
    throw new AiConfigurationError(
      `Firebase Admin could not initialize: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
