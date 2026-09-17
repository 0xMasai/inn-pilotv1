import { defineConfig } from "vitest/config";

// Deliberately separate from the app's vite.config.ts: these are Node
// tests against the Firebase emulator, not browser/React tests, and
// tsconfig.app.json's "include": ["src"] already keeps this whole
// tests/ directory out of the Vite app build.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
