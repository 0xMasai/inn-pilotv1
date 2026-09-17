import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss()
  ],
  base: './', // <-- important for Electron
  server: {
    watch: {
      // electron-builder writes and deletes temp files under these while
      // packaging. Vite's watcher would try to read one after it vanished
      // and take the whole dev server down with an ENOENT.
      ignored: ['**/release/**', '**/dist-electron/**'],
    },
    proxy: {
      // In production Vercel serves the app and api/** from one origin. This
      // proxy reproduces that locally, so the browser calls /api/... in dev
      // exactly as it does in production — no environment-specific base URL
      // in the client, and no CORS to configure. Start the other half with
      // `npm run dev:api`.
      '/api': {
        target: process.env.DEV_API_URL ?? 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Split the heavy vendors out of the app bundle. Without this
        // everything lands in one ~1.8 MB chunk that a manager on a slow
        // connection downloads in full before the login screen paints —
        // and re-downloads whenever we ship any change. These vendors move
        // rarely, so browsers can cache them across deploys.
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          firebase: ['firebase/app', 'firebase/firestore', 'firebase/storage'],
          charts: ['recharts'],
          motion: ['framer-motion'],
          // Every route pulls a handful of icons. Left alone, Rollup emits
          // one ~200-byte file per icon and the browser opens twenty extra
          // connections to draw a toolbar; one shared chunk is cheaper.
          icons: ['lucide-react'],
        },
      },
    },
    // The remaining chunks are genuinely near this size; warn if one grows.
    chunkSizeWarningLimit: 700,
  },
})
