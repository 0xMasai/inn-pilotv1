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
import { AiConfigurationError } from "./ai/errors.js";

type Env = Record<string, string | undefined>;

/**
 * Why a FIREBASE_SERVICE_ACCOUNT value is unusable, in terms of its shape
 * only. Never echo the value itself: it is a private key.
 */
function serviceAccountProblem(raw: string, text: string): string {
  const prefix = `FIREBASE_SERVICE_ACCOUNT is not valid service-account JSON (or base64 of it); the value is ${raw.length} characters`;
  if (raw.startsWith("{")) {
    // dotenv ends an unquoted value at the line break, so a key file pasted
    // as-is arrives as just "{" or its first line.
    return raw.length < 200
      ? `${prefix} and starts with "{" — the JSON looks cut off at its first line. Put it on one line as base64 (see .env.example).`
      : `${prefix} and starts with "{" but does not parse as JSON.`;
  }
  if (/^['"]/.test(raw)) return `${prefix} and starts with a quote — remove the quotes around it.`;
  if (!/^[A-Za-z0-9+/=_-]+$/.test(raw)) return `${prefix} and is neither JSON nor base64 — it may span lines or contain spaces.`;
  if (!text.trimStart().startsWith("{")) return `${prefix} and is base64, but not of a JSON file — encode the whole key file.`;
  return `${prefix}; it decodes from base64 but the JSON inside is incomplete — encode the key file again.`;
}

function parseServiceAccount(raw: string): Record<string, unknown> {
  const text = raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AiConfigurationError(serviceAccountProblem(raw, text));
  }
  const account = parsed as Record<string, unknown> | null;
  if (typeof account?.private_key !== "string" || typeof account?.client_email !== "string") {
    throw new AiConfigurationError(
      "FIREBASE_SERVICE_ACCOUNT parses, but has no private_key or client_email — it is not a service-account key file."
    );
  }
  return account;
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
