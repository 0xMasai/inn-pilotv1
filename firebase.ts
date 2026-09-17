import { initializeApp } from "firebase/app";
import { connectFirestoreEmulator, memoryLocalCache, initializeFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";

export const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || "local-development-placeholder",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || "localhost",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || "innpilot-dev",
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || "innpilot-dev.appspot.com",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || "000000000000",
  appId: import.meta.env.VITE_FIREBASE_APP_ID || "1:000000000000:web:000000000000",
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID,
};

const app = initializeApp(firebaseConfig);

// Explicitly use Firestore's memory-only cache. The web SDK already defaults
// to memory cache when no persistent cache is configured, but making this
// explicit prevents a future persistence change from causing development
// records to survive a reload unexpectedly.
export const db = initializeFirestore(app, {
  localCache: memoryLocalCache(),
});

// Local verification only: `VITE_FIRESTORE_EMULATOR_HOST=127.0.0.1:8080` with
// `npm run dev` points the app at the Firestore emulator instead of a real
// project. Ignored in production builds, so a stray variable can't ship.
const emulatorHost = import.meta.env.DEV ? import.meta.env.VITE_FIRESTORE_EMULATOR_HOST : undefined;
if (emulatorHost) {
  const [host, port] = String(emulatorHost).split(":");
  connectFirestoreEmulator(db, host, Number(port));
  console.info("[Firebase runtime] using the Firestore emulator at", emulatorHost);
}

if (import.meta.env.DEV) {
  console.info("[Firebase runtime]", {
    projectId: firebaseConfig.projectId,
    authDomain: firebaseConfig.authDomain,
    storageBucket: firebaseConfig.storageBucket,
    firestoreCache: "memory-only",
  });
}

export const storage = getStorage(app);
