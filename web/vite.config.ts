import { defineConfig } from 'vite';

// `npm run dev` serves the UI on :5173 and forwards /ws to the Go server on :3000
// (start it with INSECURE_ORIGIN=1 so the proxied origin is accepted).
export default defineConfig({
  server: { proxy: { '/ws': { target: 'ws://localhost:3000', ws: true } } },
  build: { outDir: 'dist', emptyOutDir: true },
});
