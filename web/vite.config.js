import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// We don't run a separate Vite dev server. Express on :3002 serves
// the built dist/, which keeps the OAuth redirect URI single-target
// and means cookies land where they're expected. `npm run dev` here
// is `vite build --watch` so saves trigger a rebuild.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
});
